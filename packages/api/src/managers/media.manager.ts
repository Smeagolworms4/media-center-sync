import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
	ErrorKey,
	MediaKind,
	MediaServiceMode,
	MatchStrategy,
	SyncState,
	type MediaItem,
	type MediaMatch,
	type MediaOverride,
	type MediaNode,
	type MediaSearchQuery,
	type RequestEpisode,
	type ResultList,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, MediaMatch as MediaMatchEntity } from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	type Placement,
} from '@/repositories';
import {
	CacheService,
	CorrelationService,
	type WalkProgress,
	HandlerRegistry,
	applyOverride,
	breathe,
	episodesCovered,
	normalizeTitle,
	RemoteFingerprintService,
	serviceMode,
	SettingsService,
	toLocalPath,
	WorkerPoolService,
} from '@/services';
import { JobKind } from '@/worker/protocol';
import { RequestSourceRegistry } from '@/services/requests';
import {
	pageBounds,
	paginate,
	toConnection,
	toMediaItem,
	toMediaMatch,
	toMediaNode,
} from './mappers';

/**
 * A cancelled search order is an absent one, and the stored instruction must say so.
 *
 * `null` at a level means "I have no order of my own here" — `resolveReleasePreference`
 * chooses a level on presence and never on emptiness — so a blob that kept the key with
 * a null in it would resolve exactly as an absent key while still counting as a
 * correction: the dialog would offer to restore an item nobody had corrected, the media
 * would be labelled as corrected for ever, and every rescan would dutifully re-apply an
 * instruction that says nothing. Dropping the key is also what lets cancelling the last
 * correction remove the correction, since an empty instruction is already spelled "none".
 */
const withoutCancelledPreference = (override: MediaOverride | null): MediaOverride | null => {
	if (override === null || override.releasePreference !== null) {
		return override;
	}

	const kept = { ...override };

	delete kept.releasePreference;

	return kept;
};

/** Artwork, once fetched: bytes rather than a stream, because it is cached. */
export interface Artwork {
	body: Buffer;
	contentType: string;
}

/** Artwork changes when a library is rescanned, not between two page loads. */
const ARTWORK_TTL_SECONDS = 3600;

/**
 * An image large enough to be a mistake.
 *
 * Artwork is a poster; anything past this is either a video somebody put in the
 * poster field or a service answering with the wrong thing entirely, and buffering it
 * would be the gateway spending its memory on somebody else's error.
 */
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;

/**
 * How many rows the twin-finding pass reads per statement. See `_fileIdentities`.
 *
 * The same two thousand the correlation uses, for the same reason: large enough that a
 * catalogue is tens of statements rather than thousands, small enough that one of them
 * sits between two turns of the event loop instead of owning it.
 */
const IDENTITY_PAGE = 2000;

/**
 * What the identifier of a row the gateway invented starts with.
 *
 * `externalId` is not nullable — the unique index on `(serviceId, externalId)` is what
 * stops a scan writing the same item twice — so an invented row still needs a value,
 * and the prefix is there so it can never be mistaken for a Jellyfin identifier or a
 * Plex rating key. It is a courtesy to whoever reads the table, not a test: the
 * `synthetic` column is what code checks.
 */
const SYNTHETIC_PREFIX = 'mcs:synthetic:';

/**
 * Whether a date a metadata provider states has already happened.
 *
 * Absent is read as "not aired", which is the cautious half of the answer: a row that
 * proposes a search for an episode nobody can have yet sends somebody looking for
 * something that does not exist, and the cost of the opposite mistake is one episode
 * appearing a day late.
 *
 * Compared as calendar days rather than as instants, because that is what a provider
 * states: `2026-09-25` with no zone is the day it airs somewhere, and a gateway an hour
 * on the wrong side of midnight should not disagree with the household's own screen.
 */
const hasAired = (airDate: string | null): boolean => {
	if (airDate === null) {
		return false;
	}

	const day = airDate.slice(0, 10);

	return day !== '' && day <= new Date().toISOString().slice(0, 10);
};

/** A trailing number, which is what a season's title almost always ends with. */
const TRAILING_NUMBER = /(\d+)\s*$/;

/**
 * Whether a row under a series is worth drawing.
 *
 * A season with nothing in it is not, and that is not a cosmetic rule — it is the
 * visible half of filing episodes by their numbers. A server publishes `Bonus`,
 * `Saison inconnue`, `HD - VOST` as seasons of a show and stamps the episodes inside
 * them with the season they really belong to; once those episodes are filed where
 * their numbers say, the folder is left holding nothing and has no business claiming a
 * line on the show's page.
 *
 * The row itself is kept rather than deleted. The server reports it, so a scan would
 * write it again on the next pass and the one after — deleting it would mean creating
 * and destroying the same row on a loop, taking its correlations with it each time. A
 * row nobody can see costs nothing; a row that keeps being rebuilt costs its matches.
 *
 * A season that is genuinely empty on a server — announced but with no episode yet —
 * disappears by the same rule, which is the right answer for it too: there is nothing
 * under it to show and nothing to fetch.
 */
const drawable = (child: MediaItemEntity): boolean =>
	child.kind !== MediaKind.SEASON || child.childCount > 0;

/**
 * Name an invented season the way its siblings are named.
 *
 * The gateway has no idea what words the server would have used, and it matters: a
 * household running Jellyfin in French has `Saison 1` on screen, and putting
 * `Season 2` next to it announces that something else made this row. So the title is
 * taken from a sibling that already exists and only its number is replaced —
 * `Saison 1` becomes `Saison 2`, `Season 01` becomes `Season 02`, padding included.
 *
 * Only a sibling whose trailing number really is its season number is copied; a season
 * called `Specials` or `Miniseries 2012` would otherwise lend its year to a season
 * number. With nothing to copy — the first season anybody corrects into a show that
 * reports no season level at all — English is the fallback, like every other string
 * this codebase produces without asking a service.
 */
const seasonTitleBeside = (siblings: MediaItemEntity[], seasonNumber: number): string => {
	for (const sibling of siblings) {
		if (sibling.kind !== MediaKind.SEASON || sibling.seasonNumber === null) {
			continue;
		}

		const found = TRAILING_NUMBER.exec(sibling.title);

		if (found === null || Number(found[1]) !== sibling.seasonNumber) {
			continue;
		}

		return sibling.title.slice(0, found.index) + String(seasonNumber).padStart(found[1].length, '0');
	}

	return `Season ${seasonNumber}`;
};

/**
 * Browsing the index, and the correlations under it.
 *
 * The interface never queries a media service: it reads these rows. That is what
 * makes a library of forty thousand episodes browsable at all, and it is why the only
 * thing here that leaves the machine is artwork.
 *
 * Artwork is proxied rather than linked because an `<img>` tag carries no
 * `Authorization` header — the browser would fetch the remote URL itself, anonymously,
 * against a server that wants a token. The gateway fetches it once and caches it.
 */
@Injectable()
export class MediaManager {
	private readonly _logger = new Logger(MediaManager.name);

	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		/** The correlation pass, which this manager decides where to run. */
		private readonly _correlation: CorrelationService,
		/** The thread it runs on, when this process is allowed to use one. */
		private readonly _workers: WorkerPoolService,
		private readonly _settings: SettingsService,
		private readonly _cache: CacheService,
		private readonly _handlers: HandlerRegistry,
		/** Read to turn a path a service reported into one this gateway can unlink. */
		private readonly _libraries: LibraryRepository,
		/** Identifies a copy on a server whose files this gateway has no mount for. */
		private readonly _remote: RemoteFingerprintService,
		/**
		 * Asked which episodes exist, which no media server here can answer.
		 *
		 * The registry rather than `RequestManager`: the whole of the question is one call
		 * on one source, and pulling in the manager that owns requests, their fulfilment
		 * and their holdings would couple a media page to all of it.
		 */
		private readonly _sources: RequestSourceRegistry,
	) {}

	/**
	 * Identify the copies whose size says they are a file we already hold.
	 *
	 * The household case, and it cost the owner a twenty-gigabyte transfer: Jellyfin and
	 * Plex indexing the same file on the same disk, with only one of them mounted. The
	 * mounted copy is fingerprinted at every scan and the other never can be, so two
	 * records of one file never meet — and the gateway offers to fetch, over the
	 * network, a file that is already on the disk it would write it to.
	 *
	 * **On demand and never in bulk.** Three windows of a quarter of a megabyte is
	 * nothing per file and four gigabytes across a catalogue, so nothing is read unless
	 * it would settle a real question: a copy with no identity of its own, whose byte
	 * count matches a copy that has one, exactly. That pair is a handful of rows on a
	 * real gateway and thousands of rows on none.
	 *
	 * **Exact equality and nothing looser.** Not a tolerance, not a duration, not a
	 * title: two files of the same byte count are either the same file or a coincidence
	 * worth one cheap read to rule out. A near-match is a different cut, and calling two
	 * cuts one copy is how somebody ends up without the version they wanted.
	 *
	 * Answers how many copies it identified, which is what the scan logs.
	 */
	public async identifyTwins(serviceId: string): Promise<number> {
		const services = await this._services.find();
		const service = services.find((one) => one.id === serviceId);

		// Only a service we cannot read from a disk. A mounted one is fingerprinted by
		// the scan itself, for free, and asking its own server for bytes it has already
		// read would be paying twice for the same answer.
		if (service === undefined || serviceMode(service) === MediaServiceMode.LOCAL) {
			return 0;
		}

		/*
		 * Identities and files only — see `findFileIdentities`. This pass reads a size and
		 * a content identifier and decides about a handful of rows, and it was holding the
		 * whole catalogue with every column to do it.
		 */
		const everything = await this._fileIdentities();
		const identified = new Set<number>();

		for (const item of everything) {
			const size = item.file?.size;

			if (item.serviceId !== serviceId && size !== undefined && item.file?.contentId) {
				identified.add(size);
			}
		}

		const wanted = everything.filter(
			(item) =>
				item.serviceId === serviceId
				&& item.file !== null
				&& item.file !== undefined
				&& !item.file.contentId
				&& identified.has(item.file.size),
		);

		if (wanted.length === 0) {
			return 0;
		}

		const withSecrets = await this._services.findWithSecrets(serviceId);

		if (withSecrets === null) {
			return 0;
		}

		const connection = toConnection(withSecrets);
		let counted = 0;

		for (const item of wanted) {
			const file = item.file;

			if (!file) {
				continue;
			}

			const fingerprint = await this._remote.fingerprint(
				connection,
				{ externalId: item.externalId, file },
				file.size,
			);

			if (fingerprint === null) {
				continue;
			}

			/*
			 * The row is re-read in full before it is written. `item` here came from a
			 * projection, and saving one back is a row with every unselected column
			 * blanked — the overview, the quality summary, the artwork, gone on a pass
			 * that was only meant to add a hash.
			 */
			const row = await this._items.findOne({ where: { id: item.id } });

			if (row === null) {
				continue;
			}

			row.file = {
				...file,
				quickHash: fingerprint.quickHash,
				contentId: fingerprint.contentId,
			};

			await this._items.save(row);
			counted += 1;
		}

		if (counted > 0) {
			this._logger.log(`Identified ${counted} copies of ${service.name} by fetching three windows`);
		}

		return counted;
	}

	/**
	 * Every row's identity, read a page at a time.
	 *
	 * The last whole-table read left on the gateway thread, and it sat in the middle of a
	 * scan: three columns are cheap per row, but tens of thousands of rows is still one
	 * statement, and a synchronous driver answers nothing for as long as it lasts. Moving
	 * the correlation to a worker left this one in place, which is how a scan went from
	 * stalling for minutes to stalling once, briefly, for no reason anybody could name.
	 *
	 * Here rather than on a worker because the rest of this pass is network: it fetches
	 * three windows from a media server per candidate, and an `await` on a socket already
	 * leaves this loop free. It is the read that had to be broken up, not the pass.
	 */
	private async _fileIdentities(): Promise<MediaItemEntity[]> {
		const everything: MediaItemEntity[] = [];

		for (let page = 0; ; page += 1) {
			const rows = await this._items.findFileIdentities(page * IDENTITY_PAGE, IDENTITY_PAGE);

			everything.push(...rows);

			if (rows.length < IDENTITY_PAGE) {
				return everything;
			}

			await breathe(0);
		}
	}

	/**
	 * Correlate everything one service holds, on a thread of its own when there is one.
	 *
	 * The pass itself moved out — see `CorrelationService`, which is five dependencies and
	 * no Nest, so the gateway and a worker can each build it. What stays here is the one
	 * decision this name has always stood for: where the work runs.
	 *
	 * On a worker, because `better-sqlite3` is synchronous. A pass over a real catalogue is
	 * minutes of statements, and a synchronous statement does not share this thread — it
	 * owns it. Measured on the owner's gateway: eight seconds to answer an API call while a
	 * static file from the same proxy came back in a tenth of one. Awaiting a thread is the
	 * opposite of that: the `await` below leaves this event loop entirely free, so every
	 * other connection is served while the correlation runs.
	 *
	 * No fallback to running it here, deliberately. A worker that will not start is a
	 * deployment that is broken and has to say so — swallowing it would restore the stall
	 * this exists to remove, and nothing on any screen would explain the eight seconds.
	 * Inside a worker `available` is false, which is what stops a thread spawning a thread.
	 *
	 * The threshold is read here rather than in there: it is a setting, this side owns the
	 * settings, and a worker has no cache and no Nest config to read one with.
	 */
	/**
	 * Re-correlate a service after a correction, without making anybody wait for it.
	 *
	 * Renumbering one episode changes what it matches, and leaving that until the next
	 * scan means the screen that made the correction still shows the old state. So it is
	 * run — but it was run *awaited*, which made correcting one episode a request held
	 * open for a pass over the whole catalogue. Sixty-five thousand rows on the owner's
	 * gateway, for a dialog about one of them: "l'édition d'une corrélation est hyper
	 * lente", and it was, by construction.
	 *
	 * The correction itself is already written when this is called, so there is nothing in
	 * the answer that depends on the pass. This is the second of the two shapes a worker
	 * offers, and the one it is for: the caller takes a run identifier instead of waiting,
	 * and the result arrives on the event stream — where the screens are already listening
	 * for the catalogue to change.
	 *
	 * Without a worker it still runs here, and it still blocks, because that is the truth
	 * about a gateway with no thread to put it on. It is not awaited even then: the dialog
	 * has no reason to hold the request open for work whose answer it does not use.
	 */
	public recorrelate(serviceId: string): void {
		void this._settings
			.getValue('matchThreshold')
			.then(async (threshold) => {
				if (this._workers.available) {
					// Handed over and not awaited: `start` answers with the identifier the
					// result will carry, and pushes it to the stream when the pass is done.
					this._workers.start(JobKind.CORRELATE, { serviceId, threshold });

					return;
				}

				await this._correlation.correlate(serviceId, threshold);
			})
			.catch((error: unknown) => {
				// Nobody is waiting for this, which is exactly why it has to be said out
				// loud: a correction whose re-correlation failed in silence leaves a screen
				// showing the old state with nothing to explain it.
				this._logger.error(`Re-correlating ${serviceId} failed: ${String(error)}`);
			});
	}

	public async correlateService(serviceId: string, onProgress?: WalkProgress): Promise<number> {
		const threshold = await this._settings.getValue('matchThreshold');

		if (this._workers.available) {
			return this._workers.run<number>(
				JobKind.CORRELATE,
				{ serviceId, threshold },
				// The thread's position, handed back to whoever asked for the pass rather
				// than only pushed to the stream. A scan turns it into the progress bar the
				// services screen already draws, which is where somebody is watching.
				(payload) => {
					if (typeof payload.done === 'number' && typeof payload.total === 'number') {
						onProgress?.(payload.done, payload.total);
					}
				},
			);
		}

		return this._correlation.correlate(serviceId, threshold, onProgress);
	}

	public async search(query: MediaSearchQuery): Promise<ResultList<MediaItem>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [items, total] = await this._items.search({ ...query, page, limit });

		return paginate(items.map(toMediaItem), total, page, limit);
	}

	/** One node with the children it has, which is what a series or a season page is. */
	public async node(id: string): Promise<MediaNode> {
		const item = await this._require(id);
		const children = await this._items.findChildren(item.id);

		return toMediaNode(item, children.filter(drawable));
	}

	public async children(id: string, query: MediaSearchQuery): Promise<ResultList<MediaItem>> {
		await this._require(id);

		const { page, limit } = pageBounds(query.page, query.limit);
		// The parent is the route's, never the query string's: a caller who sent both
		// would otherwise be browsing a different subtree than the one they asked for.
		const [items, total] = await this._items.search({ ...query, parentId: id, page, limit });

		return paginate(items.map(toMediaItem), total, page, limit);
	}

	/**
	 * Every correlation this item takes part in, from both sides.
	 *
	 * An item is the local side of some matches and the remote side of others — the
	 * same episode on a friend's gateway is the remote half of ours and the local half
	 * of theirs. Listing only one side would make half the correlations invisible from
	 * the page they concern.
	 */
	public async matches(id: string): Promise<MediaMatch[]> {
		await this._require(id);

		const local = await this._matches.findForLocalItem(id);
		const remote = await this._matches.findForRemoteItem(id);
		const unique = new Map<string, MediaMatchEntity>();

		for (const match of [...local, ...remote]) {
			unique.set(match.id, match);
		}

		return [...unique.values()]
			.sort((left, right) => right.confidence - left.confidence)
			.map(toMediaMatch);
	}

	/**
	 * A human overruling the score.
	 *
	 * Recorded rather than applied silently: `confirmedAt` is what lets the review
	 * screen stop proposing it, and the strategy becomes `MANUAL` because that is what
	 * it now is — keeping the score that did not convince anybody would leave the row
	 * looking like the algorithm had made the call.
	 */
	public async confirmMatch(
		itemId: string,
		matchId: string,
		localItemId?: string | null,
	): Promise<MediaMatch> {
		await this._require(itemId);

		const match = await this._requireMatch(itemId, matchId);

		if (localItemId !== undefined) {
			match.localItemId = localItemId;
		}

		match.strategy = MatchStrategy.MANUAL;
		match.confidence = 1;
		match.confirmedAt = new Date();

		return toMediaMatch(await this._matches.save(match));
	}

	/** Undoing one. A correlation nobody can undo is one nobody will trust. */
	public async deleteMatch(itemId: string, matchId: string): Promise<void> {
		await this._require(itemId);

		const match = await this._requireMatch(itemId, matchId);

		await this._matches.delete({ id: match.id });
	}

	/**
	 * Correct what a media server got wrong, here and only here.
	 *
	 * The correction is written into the fields everything reads, so it reaches
	 * correlation, filing and the category an item appears under — a season reassigned
	 * by hand that only changed a label would be worse than nothing. The instruction is
	 * kept alongside so the next rescan re-applies it, and the service's own answer is
	 * kept so the change can be shown and undone.
	 *
	 * The item is then re-filed and re-correlated, in that order. Re-filed because a
	 * number is not a place: the tree, the missing counts and the gap detection all
	 * navigate by `parentId`, so an episode moved to season two that stays among season
	 * one's children has been relabelled rather than corrected. Re-correlated because
	 * renumbering an episode changes what it matches, and leaving that until the next
	 * scan means the screen that made the correction still shows the old state.
	 *
	 * **Nothing here asks whether we hold the media.** A correction is about what the
	 * index says a thing is, not about where its bytes are, and the case that matters
	 * most is precisely the one we do not hold: a film seen on a friend's server that
	 * belongs on the documentaries shelf has to be reclassified *before* it is pulled,
	 * or the pull lands in the wrong folder and the correction becomes a tidy-up
	 * afterwards. Refusing a row with no local file would also refuse every row a peer
	 * reported, which is most of what a gateway with one server can see.
	 */
	public async setOverride(id: string, override: MediaOverride | null): Promise<MediaItem> {
		const item = await this._require(id);

		applyOverride(item, withoutCancelledPreference(override), normalizeTitle);

		const saved = await this._items.save(item);

		await this.refile(saved);
		this.recorrelate(saved.serviceId);

		return toMediaItem(await this._require(id));
	}

	/**
	 * Fill in the episodes a metadata source knows about and no server here has.
	 *
	 * The gap this closes, in the owner's words: an episode that has just aired does not
	 * appear anywhere. Our index is a mirror of what the media servers declare — that is
	 * the one structural rule of this product — so an episode nobody holds exists on no
	 * server, has no row, is counted by nothing, and a season that is three short reads as
	 * complete. Seerr has known all along: it sits on the metadata provider the household
	 * browses, and the gateway only ever asked it which *seasons* exist.
	 *
	 * The rows it writes are `synthetic`, which is the mechanism a correction already uses
	 * to create a season no service reports: they survive the stale pass at the end of a
	 * scan, they are ordinary rows everywhere else, and everything that makes an episode
	 * useful therefore comes for free — it can be hidden with the same `ignored`
	 * correction as a special, corrected in the same dialog as anything else, and searched
	 * for on the indexer from its own page.
	 *
	 * **Only what has aired.** An episode nobody can have yet is not missing from a
	 * library; it is missing from the world, and a row proposing a search for it sends
	 * somebody looking for something that does not exist. A provider that states no date
	 * is read as "not aired", which is the cautious half of that answer.
	 *
	 * **Only a series, and only one.** This costs one call per season against somebody
	 * else's metadata server, so it is asked for rather than run over a library: thirty
	 * thousand rows would be a morning of requests and a provider that stops answering.
	 *
	 * Answers how many rows it created, which is what the interface says back.
	 */
	public async discoverEpisodes(id: string): Promise<number> {
		const asked = await this._require(id);

		if (asked.kind !== MediaKind.SERIES && asked.kind !== MediaKind.SEASON) {
			throw new ConflictException(ErrorKey.MEDIA_NOT_IDENTIFIED);
		}

		/*
		 * Asked of a season as readily as of a show, because that is where the question
		 * gets asked: somebody looking at season one and wondering where the rest of it is
		 * is standing on the page the answer belongs to. It costs one call instead of one
		 * per season, which is the better bargain of the two.
		 *
		 * The identifier still comes from the series — a season carries none of its own —
		 * so the walk up happens either way and only the list of seasons narrows.
		 */
		const series = asked.kind === MediaKind.SERIES
			? asked
			: (asked.parentId === null ? null : await this._items.findOne({ where: { id: asked.parentId } }));

		if (series === null) {
			throw new ConflictException(ErrorKey.MEDIA_NOT_IDENTIFIED);
		}

		const providerId = series.externalIds?.tmdb;

		if (!providerId) {
			// No identifier, nothing to ask about. Its own answer rather than a silent
			// zero: a show nobody has matched to a provider is a fixable state, and the
			// screen can say which of the two nothings this is.
			throw new ConflictException(ErrorKey.MEDIA_NOT_IDENTIFIED);
		}

		const configured = (await this._settings.get()).requestSource ?? null;

		if (configured === null || !configured.enabled) {
			throw new ConflictException(ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED);
		}

		const source = this._sources.get(configured.type);
		const seasons = (asked.kind === MediaKind.SEASON ? [asked] : await this._items.findChildren(series.id))
			// Season zero is specials, and nobody is missing a behind-the-scenes clip.
			.filter((season) => (season.seasonNumber ?? 0) > 0);
		let created = 0;

		for (const season of seasons) {
			const known = await this._items.findChildren(season.id);
			const held = episodesCovered(known);
			const listed = await source.episodes(configured, providerId, season.seasonNumber as number);

			for (const episode of listed) {
				if (held.has(episode.episodeNumber) || !hasAired(episode.airDate)) {
					continue;
				}

				await this._createEpisode(series, season, episode);
				created += 1;
			}
		}

		if (created > 0) {
			this._logger.log(`Added ${created} aired episode(s) of ${series.title} nothing here reports`);

			await this._settle(series.id);
		}

		return created;
	}

	/**
	 * One episode nobody here reports, hung under the season it belongs to.
	 *
	 * Synthetic and minted the same way a synthetic season is — see `_createSeason` for
	 * why the identifier carries a prefix and a UUID — so the stale pass at the end of a
	 * scan keeps it and no server's own identifier can ever collide with it.
	 *
	 * It holds no file, which is the entire point: it reads as `missing` wherever an
	 * episode's state is read, which is what makes it appear in a season's missing count
	 * and in what a search offers to fill.
	 */
	private async _createEpisode(
		series: MediaItemEntity,
		season: MediaItemEntity,
		episode: RequestEpisode,
	): Promise<void> {
		await this._items.save(
			this._items.create({
				serviceId: series.serviceId,
				libraryId: series.libraryId,
				externalId: `${SYNTHETIC_PREFIX}${randomUUID()}`,
				synthetic: true,
				parentId: season.id,
				parentExternalId: season.externalId,
				kind: MediaKind.EPISODE,
				title: episode.title ?? `Episode ${episode.episodeNumber}`,
				// Under the show's name, exactly as the handlers normalise an episode: two
				// libraries agree about the name of a show far more often than about the
				// name of anything under it.
				normalizedTitle: series.normalizedTitle,
				year: null,
				seasonNumber: season.seasonNumber,
				episodeNumber: episode.episodeNumber,
				externalIds: {},
				overview: null,
				artworkUrl: null,
				file: null,
				/*
				 * `missing`, which is what this row exists to say, and not `unknown`.
				 *
				 * A series' gap count is over its *seasons*, so an episode-shaped hole only
				 * reaches the show's poster — the news screen, the episode watch, anything
				 * that asks what is actionable — by being in a state that says somebody
				 * should fetch it. `unknown` says correlation has not run yet, which every
				 * one of those readers takes for "nothing to do here", so an episode
				 * discovered this way was written down and then never mentioned again.
				 */
				syncState: SyncState.MISSING,
				/*
				 * The air date, which is the only date this row has and the one the new
				 * releases screen is ordered by. Not when a server added it — no server has
				 * it, which is the whole reason this row exists — so a reader must not take
				 * it for a shelf date.
				 */
				addedAt: episode.airDate === null ? null : new Date(episode.airDate),
				ignored: false,
				childCount: 0,
			}),
		);
	}

	/**
	 * Hang an episode under the season its numbers say it belongs to.
	 *
	 * This is the other half of a correction, and the half that was missing: everything
	 * a person sees of this product is reached through `parentId`. The tree walks it,
	 * the missing counts group by it, the gap detection lists a season's children to
	 * find the holes. An episode that reads `S2E1` from inside season one is not merely
	 * untidy — it shows up under the wrong season, and because children are ordered by
	 * season and then episode it sorts after every episode of season one, at the bottom
	 * of a list nobody scrolls. Both of the owner's words for it, "it doesn't show up
	 * under season 2" and "it disappeared", are that one missing write.
	 *
	 * **A corrected episode number alone needs nothing.** The place an episode lives is
	 * decided by its season and nothing else, and the ordering inside a season already
	 * follows `episodeNumber` in the query. Renumbering within a season therefore moves
	 * the row on screen without moving it in the tree, which is the correct outcome —
	 * so this walks out early for every correction that leaves the season alone, rather
	 * than writing the same parent back and moving `updatedAt` on rows nothing happened
	 * to.
	 *
	 * **Only episodes.** A season's parent is its series, and no correction changes
	 * which series a season belongs to — renumbering a season moves it among its
	 * siblings, where the same ordering rule already puts it. A film has no parent to
	 * reconsider.
	 *
	 * Answers whether it moved anything, which is what the functional tests and the
	 * scan's logging read.
	 */
	public async refile(item: MediaItemEntity): Promise<boolean> {
		if (item.kind !== MediaKind.EPISODE) {
			return false;
		}

		/*
		 * One question, whether or not a correction is in force: which season does this
		 * episode's effective number name?
		 *
		 * An earlier version asked a second question — with no correction it filed the
		 * episode under the parent the service *named*, read from `parentExternalId`, so
		 * that withdrawing a correction put it back in the server's own folder. That was
		 * wrong, and the owner's libraries are where it showed: his servers file
		 * episodes in folders called `Bonus`, `Saison inconnue` or `HD - VOST` while
		 * stamping each one with the season it really belongs to. Following the folder
		 * meant a numbered episode sitting under a folder that is not a season, which is
		 * the same defect this method exists to fix, arrived at from the other side.
		 *
		 * So the metadata decides, always. Withdrawing a correction is still an undo:
		 * with no override the effective number *is* the reported one, so the episode
		 * goes back to the season the server's own metadata names. What it no longer
		 * does is go back to the server's folder when that folder contradicts the
		 * server's own numbers — because between those two the numbers are what the
		 * server knows and the folder is how somebody happened to store it.
		 */
		const parentId = await this._seasonFor(item);

		if (parentId === null || parentId === item.parentId) {
			return false;
		}

		const left = item.parentId;

		item.parentId = parentId;

		await this._items.save(item);
		await this._settle(left);
		await this._settle(parentId);

		return true;
	}

	/**
	 * File every episode one service holds under the season its own numbers name.
	 *
	 * The same rule as `refile`, applied to a whole service at the end of a scan rather
	 * than to one row after a correction — because the folders a server puts episodes in
	 * are not the seasons its metadata says they belong to, and that is the ordinary
	 * case rather than the exception. The owner's Jellyfin publishes `Bonus`,
	 * `Saison inconnue`, `HD - VOST` and `SD` as seasons of a show while stamping every
	 * episode inside them with the season it really belongs to. Reading the folder gives
	 * a show whose episodes are scattered across levels that mean nothing; reading the
	 * numbers gives the show.
	 *
	 * Written as one pass over a projection rather than a call to `refile` per row. The
	 * per-row path costs a `findChildren` of the series and up to two `findOne` climbs
	 * *each*, which on a forty-thousand-episode library is six figures of queries every
	 * scan. Here the tree is read once, the whole decision is made in memory, and only
	 * the rows that actually move are written.
	 *
	 * **An episode with no season number is left exactly where it is.** It has nothing
	 * to file it by, and a real extra — a making-of, an interview — belongs under the
	 * folder somebody put it in rather than swept into season one. That is also what
	 * keeps a folder of genuine bonuses on screen: it still has children, so it is still
	 * drawn.
	 *
	 * Answers how many episodes moved, which is what the scan logs.
	 */
	public async refileService(serviceId: string): Promise<number> {
		const rows = await this._items.findPlacements(serviceId);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const seasonsBySeries = new Map<string, Map<number, string>>();

		for (const row of rows) {
			if (row.kind !== MediaKind.SEASON || row.parentId === null || row.seasonNumber === null) {
				continue;
			}

			const seasons = seasonsBySeries.get(row.parentId) ?? new Map<number, string>();

			/*
			 * First one wins when a series carries the same season number twice, which
			 * happens on a library holding two cuts of one show. Choosing arbitrarily is
			 * still better than splitting the episodes between them: they end up
			 * together, and together is what lets anybody see there are two.
			 */
			if (!seasons.has(row.seasonNumber)) {
				seasons.set(row.seasonNumber, row.id);
			}

			seasonsBySeries.set(row.parentId, seasons);
		}

		const moved: { id: string; from: string | null; to: string }[] = [];

		for (const row of rows) {
			if (row.kind !== MediaKind.EPISODE || row.seasonNumber === null) {
				continue;
			}

			const seriesId = this._seriesIdOf(row, byId);

			if (seriesId === null) {
				continue;
			}

			const target = seasonsBySeries.get(seriesId)?.get(row.seasonNumber) ?? null;

			if (target === null || target === row.parentId) {
				continue;
			}

			moved.push({ id: row.id, from: row.parentId, to: target });
		}

		let written = 0;

		for (const move of moved) {
			await this._items.update({ id: move.id }, { parentId: move.to });
			written += 1;

			// A refile of a large library is tens of thousands of writes in a row, and
			// `better-sqlite3` is synchronous: without this the server is deaf for as long
			// as it takes. See `breathe`.
			await breathe(written);
		}

		/*
		 * Both ends of every move, and only those. A season that gained or lost an
		 * episode has a child count that is now a lie, and one the gateway invented and
		 * emptied has to go — `_settle` decides which of the two it is looking at.
		 */
		const touched = new Set<string>();

		for (const move of moved) {
			if (move.from !== null) {
				touched.add(move.from);
			}

			touched.add(move.to);
		}

		for (const id of touched) {
			await this._settle(id);
		}

		if (moved.length > 0) {
			this._logger.log(`Refiled ${moved.length} episodes onto the season their numbers name`);
		}

		return moved.length;
	}

	/**
	 * The series an episode hangs from, climbing at most one level, in memory.
	 *
	 * The same shape as `_seriesOf` reads from the database: an episode hangs from a
	 * season, or straight from its series on the services that report no season level at
	 * all. An episode under neither has no series to file it in and is left alone.
	 */
	private _seriesIdOf(episode: Placement, byId: Map<string, Placement>): string | null {
		const parent = episode.parentId === null ? undefined : byId.get(episode.parentId);

		if (parent === undefined) {
			return null;
		}

		if (parent.kind === MediaKind.SERIES) {
			return parent.id;
		}

		const grandparent = parent.parentId === null ? undefined : byId.get(parent.parentId);

		return grandparent?.kind === MediaKind.SERIES ? grandparent.id : null;
	}

	/**
	 * Erase one copy from a disk this gateway can write to, and say what it erased.
	 *
	 * The only operation in this product that destroys something no scan can bring
	 * back, which is why every one of its refusals is a refusal rather than a quiet
	 * success:
	 *
	 * - **a row with no file** is a show, a season or a folder. Nothing on it to erase,
	 *   and walking its subtree to erase what is under it is a different feature with a
	 *   different confirmation — one that says how many files and how many bytes.
	 * - **a copy on somebody else's server**, or on one of ours whose folders nobody has
	 *   mapped, cannot be reached. The gateway is not going to ask a media server to
	 *   delete it either: a token that can browse is not a token anybody handed over to
	 *   destroy things with.
	 * - **a path that does not resolve** through the library's mappings means the row
	 *   and the mounts disagree, and erasing the wrong file is worse than erasing none.
	 *
	 * The row is left exactly as it is. The media server still lists the file it no
	 * longer has, and the truth is restored by the thing that establishes truth here —
	 * the next scan. Writing `missing` onto the row now would be the gateway asserting
	 * something about a server it has not asked.
	 *
	 * `ENOENT` is success, not an error. The file being already gone is the state the
	 * caller asked for, and failing then would leave somebody unable to tidy an index
	 * whose file somebody else had removed by hand.
	 */
	public async deleteFile(id: string): Promise<{ path: string }> {
		const item = await this._require(id);
		const reported = item.file?.path ?? null;

		if (reported === null) {
			throw new ConflictException(ErrorKey.MEDIA_HAS_NO_FILE);
		}

		const service = await this._services.findOne({ where: { id: item.serviceId } });

		if (service === null || serviceMode(service) !== MediaServiceMode.LOCAL) {
			throw new ConflictException(ErrorKey.MEDIA_NOT_ON_OUR_DISK);
		}

		const library = await this._libraries.findOne({ where: { id: item.libraryId } });
		const path = library === null ? null : toLocalPath(library, reported);

		if (path === null) {
			throw new ConflictException(ErrorKey.MEDIA_NOT_ON_OUR_DISK);
		}

		try {
			await unlink(path);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}

			this._logger.warn(`Asked to erase ${path}, which was already gone`);
		}

		this._logger.log(`Erased ${path} on request`);

		return { path };
	}

	/**
	 * The poster, fetched once and kept.
	 *
	 * The cache is what makes this bearable: a grid of sixty posters is sixty requests
	 * from the browser, and without it every one of them would be a request to
	 * somebody's Raspberry Pi.
	 */
	public async artwork(id: string): Promise<Artwork> {
		const item = await this._require(id);

		if (item.artworkUrl === null || item.artworkUrl === '') {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const key = `artwork:${item.id}:${item.updatedAt.getTime()}`;
		const cached = await this._cache.get<{ body: string; contentType: string }>(key);

		if (cached !== null) {
			return { body: Buffer.from(cached.body, 'base64'), contentType: cached.contentType };
		}

		const artwork = await this._fetchArtwork(item);

		await this._cache.set(
			key,
			{ body: artwork.body.toString('base64'), contentType: artwork.contentType },
			ARTWORK_TTL_SECONDS,
		);

		return artwork;
	}

	private async _fetchArtwork(item: MediaItemEntity): Promise<Artwork> {
		const service = await this._services.findOne({ where: { id: item.serviceId } });

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		// Through the handler, because only it knows how its service wants to be asked:
		// Jellyfin serves images to anyone, Plex answers 401 without its token. Fetched
		// unauthenticated, every Plex poster would be a broken image with nothing
		// anywhere saying it was a credential rather than a missing file.
		//
		// The row has to come back with its secrets; read the ordinary way it would
		// produce a connection with no token and fail as an authentication error.
		const withSecrets = await this._services.findWithSecrets(service.id);
		const handler = this._handlers.get(service.type);
		const response = await handler.openArtwork(toConnection(withSecrets ?? service), {
			externalId: item.externalId,
			artworkUrl: item.artworkUrl as string,
		});

		return {
			body: await this._collect(response.stream),
			contentType: response.contentType ?? 'application/octet-stream',
		};
	}

	private async _collect(stream: Readable): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let size = 0;

		for await (const chunk of stream) {
			const buffer = Buffer.from(chunk as Buffer);

			size += buffer.length;

			if (size > MAX_ARTWORK_BYTES) {
				stream.destroy();
				this._logger.warn('Artwork response exceeded the ceiling and was dropped');

				throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
			}

			chunks.push(buffer);
		}

		return Buffer.concat(chunks);
	}

	/**
	 * The season of this episode's series that carries the effective season number,
	 * created when there is none — which is the owner's case and the ordinary one.
	 *
	 * Creating it is unavoidable. The season a correction names is a season the service
	 * does not believe in, so asking the server for it — which is what
	 * `_reconcileParents` does for a parent a walk merely skipped — answers nothing.
	 * Either the gateway makes the node or the correction has nowhere to land.
	 *
	 * The series is found by climbing at most one level, because that is the depth this
	 * model has: an episode hangs from a season, or straight from its series on the
	 * services that report no season level at all. An episode hanging from nothing has
	 * no series to file it in and is left alone.
	 */
	private async _seasonFor(item: MediaItemEntity): Promise<string | null> {
		const series = await this._seriesOf(item);

		if (series === null) {
			return null;
		}

		// A correction that removed the season number entirely means the episode belongs
		// to no season, and the show itself is the only honest place for it.
		if (item.seasonNumber === null) {
			return series.id;
		}

		const siblings = await this._items.findChildren(series.id);
		const existing = siblings.find(
			(one) => one.kind === MediaKind.SEASON && one.seasonNumber === item.seasonNumber,
		);

		if (existing !== undefined) {
			return existing.id;
		}

		return (await this._createSeason(series, item.seasonNumber, siblings)).id;
	}

	/** The series an episode belongs to, through its season or directly. */
	private async _seriesOf(item: MediaItemEntity): Promise<MediaItemEntity | null> {
		const parent = item.parentId === null ? null : await this._items.findOne({ where: { id: item.parentId } });

		if (parent === null) {
			return null;
		}

		if (parent.kind === MediaKind.SERIES) {
			return parent;
		}

		const grandparent =
			parent.parentId === null
				? null
				: await this._items.findOne({ where: { id: parent.parentId } });

		return grandparent?.kind === MediaKind.SERIES ? grandparent : null;
	}

	/**
	 * A season row the gateway invents, because no server will ever report it.
	 *
	 * It is marked `synthetic` so the stale pass at the end of a scan leaves it alone —
	 * without that the very next scan deletes it as a row the service dropped, and the
	 * episode is filed back under season one. The identifier is ours and prefixed, so
	 * that the unique index on `(serviceId, externalId)` still holds and no server's own
	 * identifier can collide with it; `parentExternalId` is the series', so the link
	 * repair at the end of a scan understands the row like any other.
	 *
	 * It is filed in the series' library and not the episode's. A parent lives where its
	 * children do, and the child here is a whole show: the child-count and quality
	 * rollup at the end of a scan is computed one library at a time, so a season sitting
	 * in another library than its series would simply be missing from its series'
	 * summary.
	 */
	private async _createSeason(
		series: MediaItemEntity,
		seasonNumber: number,
		siblings: MediaItemEntity[],
	): Promise<MediaItemEntity> {
		const season = await this._items.save(
			this._items.create({
				serviceId: series.serviceId,
				libraryId: series.libraryId,
				externalId: `${SYNTHETIC_PREFIX}${randomUUID()}`,
				synthetic: true,
				parentId: series.id,
				parentExternalId: series.externalId,
				kind: MediaKind.SEASON,
				title: seasonTitleBeside(siblings, seasonNumber),
				// A season compares under its series' name, exactly as the handlers
				// normalise one: two libraries agree about the name of a show far more
				// often than about the name of anything under it.
				normalizedTitle: series.normalizedTitle,
				year: series.year,
				seasonNumber,
				episodeNumber: null,
				externalIds: {},
				overview: null,
				artworkUrl: null,
				file: null,
				syncState: SyncState.UNKNOWN,
				addedAt: null,
				ignored: false,
				childCount: 0,
			}),
		);

		this._logger.log(
			`Created season ${seasonNumber} of ${series.title}: the service does not report it`,
		);

		return season;
	}

	/**
	 * Bring one end of a move back into line: the child count, and litter.
	 *
	 * The count is written here rather than left to the next scan because the tree draws
	 * it immediately — a season that has just gained an episode and still says it holds
	 * none is the correction looking as though it had not worked. The quality rollup
	 * above it is not recomputed here on purpose: it is a walk of the whole subtree per
	 * node, which is what `_recompute` does once per library at the end of a scan, and
	 * paying for it on every correction would make a screen wait on a number nobody is
	 * reading yet.
	 *
	 * An invented season nobody is under any more is removed rather than left standing.
	 * It would otherwise appear on the tree and be counted for the rest of the gateway's
	 * life, with no way for anybody to delete it — the season is not something a service
	 * will stop reporting, because no service ever reported it. Its correlations go with
	 * it, or they would point at a row that no longer exists.
	 */
	private async _settle(id: string | null): Promise<void> {
		if (id === null) {
			return;
		}

		const row = await this._items.findOne({ where: { id } });

		if (row === null) {
			return;
		}

		const children = await this._items.findChildren(id);

		if (children.length === 0 && row.synthetic) {
			await this._matches.deleteForItems([row.id]);
			await this._items.remove(row);

			return;
		}

		if (row.childCount !== children.length) {
			await this._items.update({ id }, { childCount: children.length });
		}
	}

	private async _require(id: string): Promise<MediaItemEntity> {
		const item = await this._items.findOne({ where: { id } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return item;
	}

	/**
	 * The match, checked against the item the route named.
	 *
	 * Without that check any identifier would do for the first half of the path, and a
	 * confirmation would be recorded against a correlation somebody was not looking at.
	 */
	private async _requireMatch(itemId: string, matchId: string): Promise<MediaMatchEntity> {
		const match = await this._matches.findOne({ where: { id: matchId } });

		if (match === null || (match.localItemId !== itemId && match.remoteItemId !== itemId)) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return match;
	}
}
