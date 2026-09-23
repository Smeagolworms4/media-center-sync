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
	type ResultList,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, MediaMatch as MediaMatchEntity } from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	type Placement,
} from '@/repositories';
import {
	CacheService,
	contentKeys,
	HandlerRegistry,
	identifierValue,
	alignAbsoluteNumbering,
	episodeIdentifierKeys,
	landingSyncState,
	MatchingService,
	applyOverride,
	normalizeTitle,
	RemoteFingerprintService,
	sameContent,
	serviceMode,
	SettingsService,
	toLocalPath,
	WORK_IDENTIFIERS,
	type MatchCandidate,
	type MatchProposal,
} from '@/services';
import {
	pageBounds,
	paginate,
	toConnection,
	toMediaItem,
	toMediaMatch,
	toMediaNode,
} from './mappers';

/** Everything a correlation pass needs, read once rather than per item. */
interface CorrelationContext {
	threshold: number;
	peers: Map<string, string | null>;
	/** Services whose libraries the gateway can write into. */
	local: Set<string>;
	everything: MediaItemEntity[];
	byContent: Map<string, MediaItemEntity[]>;
	/** Films and series by work identifier; see `_indexByWork`. */
	byWork: Map<string, MediaItemEntity[]>;
	/** Every row by identifier, so a pair worked out elsewhere can be scored. */
	byId: Map<string, MediaItemEntity>;
	/**
	 * The identifiers that name one episode rather than the show it belongs to.
	 *
	 * Worked out per service and per series, because that is the only scope where the
	 * count means anything — see `episodeIdentifierKeys`. It is what lets an identifier
	 * pair `E153` with `S06E12`, and what stops the same rule merging episode 3 with
	 * episode 47 on a library that stamps the show's number onto all four hundred rows.
	 */
	episodeIdentifiers: Map<string, Set<string>>;
	/**
	 * Episodes related across two numbering conventions, both ways round.
	 *
	 * Built once per pass rather than per item, and it has to be: the conversion needs
	 * every episode of both copies of the series in hand at once — the season lengths,
	 * the holes, the totals — and correlation scores one pair at a time. Anything
	 * derived per pair would be a formula, which is exactly what must not decide this.
	 */
	absolutePairs: Map<string, Set<string>>;
	/**
	 * Items whose file the gateway has already put on the disk, and the state that
	 * makes. Read once per pass rather than per item — the table holds one row per
	 * download nobody has indexed yet, which is tens, and a query per item would be
	 * tens of thousands of them to answer a question that is almost always "no".
	 */
	landed: Map<string, SyncState>;
	/**
	 * Every match row already on record, by each of the two items it joins.
	 *
	 * Read once per pass, for the same reason `landed` is: a pass over a real
	 * catalogue is thousands of items, and asking the match table twice per item to
	 * answer a question about a few hundred rows is thousands of queries for nothing.
	 *
	 * It is a snapshot taken before the pass writes anything, and only ever used to
	 * decide about rows that existed when it was taken — which claim a person settled,
	 * and which pair the identifiers now contradict. Nothing here is read back as the
	 * current state of a row this pass has since rewritten.
	 */
	settled: Map<string, MediaMatchEntity[]>;
}

/** A person's decision about a pair, which no later pass is allowed to overturn. */
const decidedByHand = (match: MediaMatchEntity): boolean =>
	match.strategy === MatchStrategy.MANUAL || match.confirmedAt !== null;

/** Artwork, once fetched: bytes rather than a stream, because it is cached. */
export interface Artwork {
	body: Buffer;
	contentType: string;
}

/**
 * How far below a series the walk that collects its episodes goes.
 *
 * Three is series, season, episode with one level spare. Bounded rather than
 * unbounded because a parent chain that loops — which nothing stops a media server
 * from reporting — would otherwise hang the correlation pass instead of failing
 * somewhere a stack trace could name.
 */
const SUBTREE_DEPTH = 3;

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
 * What the identifier of a row the gateway invented starts with.
 *
 * `externalId` is not nullable — the unique index on `(serviceId, externalId)` is what
 * stops a scan writing the same item twice — so an invented row still needs a value,
 * and the prefix is there so it can never be mistaken for a Jellyfin identifier or a
 * Plex rating key. It is a courtesy to whoever reads the table, not a test: the
 * `synthetic` column is what code checks.
 */
const SYNTHETIC_PREFIX = 'mcs:synthetic:';

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
		/**
		 * What the gateway put on the disk and no media server has indexed yet.
		 *
		 * Read here because this is the one place an item's state is written, and it
		 * writes it from scratch every pass. Without this the very first scan after a
		 * download would recompute `missing` over a file sitting in the library folder —
		 * the bug, restored on a timer, and harder to see the second time because
		 * something had briefly shown the right answer.
		 */
		private readonly _landings: MediaLandingRepository,
		private readonly _matching: MatchingService,
		private readonly _settings: SettingsService,
		private readonly _cache: CacheService,
		private readonly _handlers: HandlerRegistry,
		/** Read to turn a path a service reported into one this gateway can unlink. */
		private readonly _libraries: LibraryRepository,
		/** Identifies a copy on a server whose files this gateway has no mount for. */
		private readonly _remote: RemoteFingerprintService,
	) {}

	/**
	 * Correlate everything one service holds against every other service.
	 *
	 * Candidates come from two places, and both are needed. The normalised title plus
	 * the episode coordinates narrow tens of thousands of rows to a handful, which is
	 * the only thing that makes correlation finish at all — comparing everything with
	 * everything is quadratic. But that lookup is blind to exactly the case that
	 * matters most: two libraries holding the same bytes under names and numbers that
	 * do not agree. So the content identity is indexed too, and an item is compared
	 * with whatever shares its fingerprint whether or not the titles could ever have
	 * met.
	 */
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

		const everything = await this._items.find();
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

			item.file = {
				...file,
				quickHash: fingerprint.quickHash,
				contentId: fingerprint.contentId,
			};

			await this._items.save(item);
			counted += 1;
		}

		if (counted > 0) {
			this._logger.log(`Identified ${counted} copies of ${service.name} by fetching three windows`);
		}

		return counted;
	}

	public async correlateService(serviceId: string): Promise<number> {
		const threshold = await this._settings.getValue('matchThreshold');
		const services = await this._services.find();
		const peers = new Map(services.map((service) => [service.id, service.peerId]));
		const local = new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
		const everything = await this._items.find();
		const byContent = this._indexByContent(everything);
		const byWork = this._indexByWork(everything);
		const landed = new Map(
			(await this._landings.findOpen()).map((landing) => [
				landing.itemId,
				landingSyncState(landing.state),
			]),
		);
		const settled = this._indexMatches(await this._matches.find());
		const byId = new Map(everything.map((item) => [item.id, item]));
		const byParent = this._indexByParent(everything);
		const episodesOfSeries = this._episodesBySeries(everything, byParent);
		const episodeIdentifiers = this._episodeIdentifiers(episodesOfSeries);
		const absolutePairs = this._absolutePairs(
			everything,
			episodesOfSeries,
			{ threshold, peers, byWork },
		);
		const context = {
			threshold,
			peers,
			local,
			everything,
			byContent,
			byWork,
			byId,
			episodeIdentifiers,
			absolutePairs,
			landed,
			settled,
		};

		const mine = everything.filter((item) => item.serviceId === serviceId);
		const touched = new Set<string>();
		let written = 0;

		for (const item of mine) {
			written += await this._correlateItem(item, context, touched);
		}

		/*
		 * The other side of every pair, refreshed in the same pass.
		 *
		 * A match is symmetric and a state is not: scanning one service tells us
		 * something about items on the others, and leaving those alone means the
		 * answer depends on the order the services happened to be scanned in. Measured
		 * against the lab: both servers scanned seconds apart, and the first one
		 * correlated against an index the second had not filled yet — so every one of
		 * its episodes stayed `local_only` while the second one knew about all of
		 * them.
		 *
		 * Their counterparts are not re-collected: one extra pass settles the pairs
		 * this scan created, and going further would be a walk of the whole index
		 * dressed up as an incremental update.
		 */
		const counterparts = everything.filter(
			(item) => item.serviceId !== serviceId && touched.has(item.id),
		);

		for (const item of counterparts) {
			await this._correlateItem(item, context, null);
		}

		return written;
	}

	/**
	 * One item against everything else the gateway knows about.
	 *
	 * `touched` collects the far side of each proposal so the caller can settle those
	 * items too; passing null means this call is that settling pass and must not grow
	 * the set.
	 */
	private async _correlateItem(
		item: MediaItemEntity,
		context: CorrelationContext,
		touched: Set<string> | null,
	): Promise<number> {
		const byTitle = await this._items.findCandidatesForMatch(
			item.normalizedTitle,
			item.seasonNumber,
			item.episodeNumber,
			item.serviceId,
		);

		const candidates = new Map<string, MediaItemEntity>();

		for (const candidate of [
			...byTitle,
			...this._sameContentAs(item, context.byContent),
			...this._sameWorkAs(item, context.byWork),
			...this._alignedWith(item, context),
		]) {
			if (candidate.id !== item.id && candidate.serviceId !== item.serviceId) {
				candidates.set(candidate.id, candidate);
			}
		}

		const proposals = this._matching
			.correlate(
				this._candidate(item, context.peers),
				[...candidates.values()].map((candidate) => this._candidate(candidate, context.peers)),
				{
					threshold: context.threshold,
					episodeIdentifiers: context.episodeIdentifiers,
					absolutePairs: context.absolutePairs,
				},
			)
			.map((proposal) =>
				this._overruleMislabelled(item, candidates.get(proposal.remoteItemId), proposal),
			)
			.map((proposal) => this._respectHumanDecision(item, proposal, context));

		let written = 0;

		for (const proposal of proposals) {
			await this._matches.upsertPair(proposal);
			touched?.add(proposal.remoteItemId);
			written += 1;
		}

		await this._revokeContradicted(item, context);

		const state = this._landed(
			item,
			this._matching.deriveItemState(proposals, context.local.has(item.serviceId)),
			context,
		);

		if (state !== item.syncState) {
			await this._items.setSyncState([item.id], state);
		}

		return written;
	}

	/**
	 * Two files that are the same bytes under labels that disagree.
	 *
	 * This is neither a match to apply nor a pair to call unrelated. The content is
	 * proof they are the same file; the numbers are proof that one of the two libraries
	 * has it filed wrong, or that two files were swapped. Applying the match silently
	 * would renumber somebody's library on the strength of a guess about which side is
	 * right, and dropping the pair would have the gateway offer to fetch a file it
	 * already holds. So it becomes a conflict carrying the disagreement in words, and a
	 * person decides.
	 *
	 * The reverse — the same numbers over different content — is an ordinary
	 * comparison and goes through the quality comparator like anything else.
	 */
	public labelDisagreement(local: MediaItemEntity, remote: MediaItemEntity): string | null {
		if (!sameContent(local.file, remote.file)) {
			return null;
		}

		if (local.episodeNumber !== remote.episodeNumber) {
			return `content identical, episode numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		if (local.seasonNumber !== remote.seasonNumber) {
			return `content identical, season numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		return null;
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
	 */
	public async setOverride(id: string, override: MediaOverride | null): Promise<MediaItem> {
		const item = await this._require(id);

		applyOverride(item, override, normalizeTitle);

		const saved = await this._items.save(item);

		await this.refile(saved);
		await this.correlateService(saved.serviceId);

		return toMediaItem(await this._require(id));
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

		for (const move of moved) {
			await this._items.update({ id: move.id }, { parentId: move.to });
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

	/**
	 * The state a media gets when its bytes are already here and the server is not.
	 *
	 * Applied only over `missing`, and that narrowness is the point. `missing` is the
	 * only derived state the landing contradicts: it means nothing local holds this,
	 * and a file we moved into a library folder an hour ago makes that false. Every
	 * other state — outdated, conflict, in sync — was reached by comparing real copies
	 * and knows more than a landing does; overwriting one of them would replace a fact
	 * with a note about a download.
	 */
	private _landed(
		item: MediaItemEntity,
		derived: SyncState,
		context: CorrelationContext,
	): SyncState {
		// A copy on one of our own services is already held and already says something
		// true about a file that plays; a pull from one of our servers into another is
		// ordinary, and painting its source "waiting for an index" would take a good
		// state off a good copy. `LandingManager` draws the same line, for the same
		// reason, when it writes the state at the moment the file lands.
		if (derived !== SyncState.MISSING || context.local.has(item.serviceId)) {
			return derived;
		}

		return context.landed.get(item.id) ?? derived;
	}

	/**
	 * Turn a scored proposal into a conflict when the labels contradict the bytes.
	 *
	 * The proposal is rewritten rather than dropped so the row still exists: the pair
	 * has to be visible somewhere for anybody to arbitrate it, and a correlation the
	 * gateway silently refused to record is one nobody can act on.
	 */
	private _overruleMislabelled(
		local: MediaItemEntity,
		remote: MediaItemEntity | undefined,
		proposal: MatchProposal,
	): MatchProposal {
		const disagreement = remote === undefined ? null : this.labelDisagreement(local, remote);

		if (disagreement === null) {
			return proposal;
		}

		this._logger.warn(`${local.title}: ${disagreement}`);

		return { ...proposal, state: SyncState.CONFLICT, reason: disagreement };
	}

	/** Every match row filed under both of the items it joins, for lookup by either. */
	private _indexMatches(matches: MediaMatchEntity[]): Map<string, MediaMatchEntity[]> {
		const index = new Map<string, MediaMatchEntity[]>();

		for (const match of matches) {
			for (const side of [match.localItemId, match.remoteItemId]) {
				if (side !== null) {
					index.set(side, [...(index.get(side) ?? []), match]);
				}
			}
		}

		return index;
	}

	/** The row already on record for this exact pair, in whichever direction it was written. */
	private _recorded(
		itemId: string,
		otherId: string,
		context: CorrelationContext,
	): MediaMatchEntity | undefined {
		return context.settled
			.get(itemId)
			?.find(
				(match) =>
					(match.localItemId === itemId && match.remoteItemId === otherId) ||
					(match.localItemId === otherId && match.remoteItemId === itemId),
			);
	}

	/**
	 * A pair somebody settled keeps what they said about it.
	 *
	 * The two halves of a match row answer two different questions and only one of them
	 * belongs to a person. *Are these the same media* is `strategy` and `confidence`:
	 * confirming a proposal is precisely the act of overruling the score, and a later
	 * pass that recomputed it would undo the confirmation the next time a scan ran —
	 * silently, because nothing on the screen would say the machine had changed its
	 * mind back. *What is the state of the two copies* is `state` and `reason`, and
	 * that is nobody's opinion: a remote copy re-encoded in 2160p is newer than ours
	 * whoever confirmed the pair, and freezing it would leave a confirmed match
	 * reporting a quality comparison from the day it was confirmed.
	 *
	 * So the human half is restored onto the fresh proposal and the measured half is
	 * let through. Dropping the proposal entirely was the other option and is worse for
	 * exactly that reason: it would have been the shorter code and would have frozen
	 * the sync state of every confirmed pair on the gateway.
	 *
	 * A decision is a person's when the strategy is `MANUAL` or `confirmedAt` is set.
	 * Both are tested rather than either: `confirmMatch` writes the two together, but a
	 * row detached and re-pointed by hand carries the confirmation without the strategy
	 * ever having been rewritten, and reading only the strategy would lose it.
	 */
	private _respectHumanDecision(
		item: MediaItemEntity,
		proposal: MatchProposal,
		context: CorrelationContext,
	): MatchProposal {
		const recorded = this._recorded(item.id, proposal.remoteItemId, context);

		if (recorded === undefined || !decidedByHand(recorded)) {
			return proposal;
		}

		return {
			...proposal,
			strategy: recorded.strategy,
			confidence: recorded.confidence,
			applied: recorded.confidence >= context.threshold || recorded.confirmedAt !== null,
		};
	}

	/**
	 * Unpick the matches this item's identifiers now contradict.
	 *
	 * Reading Plex's `Guid` list only ever helps the pairs correlated *after* the
	 * reading. Everything already on the gateway was decided when a Plex item carried
	 * nothing but its own row key, which meant every Plex-to-Jellyfin pair was decided
	 * on the title — the one strategy that can be confidently wrong. Leaving those rows
	 * alone would have the feature change nothing at all on a catalogue that already
	 * exists, and would leave the wrong ones applied for good.
	 *
	 * So each pass asks the question the other way round: of the pairs already on
	 * record for this item, which ones do the identifiers now say are two different
	 * works? Those are deleted rather than downgraded — a match nothing vouches for is
	 * not a weaker match, it is not a match — and a deleted row is re-proposed by the
	 * very next pass if the evidence ever comes back, which is what makes this safe to
	 * run twice.
	 *
	 * Three things it deliberately does not do. It never revokes a pair where only one
	 * side carries an identifier: the ordinary house has one library that scrapes and
	 * one that does not, and absence is not disagreement — see
	 * `MatchingService.contradicted`. It never touches a decision somebody made by
	 * hand. And it works from the whole match table rather than from the candidates
	 * this pass happened to look at, because a pair whose two titles no longer meet in
	 * the title index would otherwise never be re-examined by anybody.
	 */
	private async _revokeContradicted(
		item: MediaItemEntity,
		context: CorrelationContext,
	): Promise<void> {
		const recorded = context.settled.get(item.id);

		// The overwhelming majority of a catalogue takes part in no match at all, and
		// this runs once per item on every pass: leaving before the candidate shape is
		// built keeps the whole thing off the hot path.
		if (recorded === undefined) {
			return;
		}

		const mine = this._candidate(item, context.peers);

		for (const match of recorded) {
			const otherId = match.localItemId === item.id ? match.remoteItemId : match.localItemId;
			// The pass's own index, never a fresh one built here: this runs once per item
			// and a map rebuilt from every row each time would turn a walk of a
			// thirty-thousand-item catalogue into a quadratic one.
			const other = otherId === null ? undefined : context.byId.get(otherId);

			if (other === undefined || decidedByHand(match)) {
				continue;
			}

			if (!this._matching.contradicted(mine, this._candidate(other, context.peers))) {
				continue;
			}

			this._logger.warn(
				`${item.title}: dropping a match with ${other.title}, their identifiers name two different works`,
			);

			await this._matches.delete({ id: match.id });
			// Struck off the snapshot as well as the table. A pass settles both halves of
			// every pair it touched, so the far side reaches this loop with the same row
			// still in hand, and without this it would delete an identifier that no longer
			// exists and log the same sentence about the same pair a second time.
			MediaManager._forget(context.settled, match);
		}
	}

	/** Drop one match row from both of the sides the snapshot filed it under. */
	private static _forget(
		settled: Map<string, MediaMatchEntity[]>,
		match: MediaMatchEntity,
	): void {
		for (const side of [match.localItemId, match.remoteItemId]) {
			const rows = side === null ? undefined : settled.get(side);

			if (side !== null && rows !== undefined) {
				settled.set(side, rows.filter((row) => row.id !== match.id));
			}
		}
	}

	/**
	 * Every item by the parent it hangs from, so a subtree can be walked in memory.
	 *
	 * Built once per pass because the alternative is a query per series, and the
	 * question — "which episodes are under this show" — is asked of every series the
	 * gateway holds.
	 */
	private _indexByParent(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			if (item.parentId !== null) {
				index.set(item.parentId, [...(index.get(item.parentId) ?? []), item]);
			}
		}

		return index;
	}

	/**
	 * The episodes under each series, however deep the service files them.
	 *
	 * Walked down from the series rather than up from each episode, because the depth
	 * is not fixed: most servers put a season between the two and some report episodes
	 * directly under the show. The descent is bounded because a parent chain that loops
	 * — two rows naming each other, which a service has no reason not to report — would
	 * otherwise spin here rather than fail somewhere a stack trace could name it.
	 *
	 * A group is one series on one service by construction, since a row's children are
	 * rows of the same service. That matters: it is the scope the identifier count in
	 * `episodeIdentifierKeys` has to be taken in.
	 */
	private _episodesBySeries(
		items: MediaItemEntity[],
		byParent: Map<string, MediaItemEntity[]>,
	): Map<string, MediaItemEntity[]> {
		const groups = new Map<string, MediaItemEntity[]>();

		for (const series of items) {
			if (series.kind !== MediaKind.SERIES) {
				continue;
			}

			const episodes: MediaItemEntity[] = [];
			let level = byParent.get(series.id) ?? [];

			for (let depth = 0; depth < SUBTREE_DEPTH && level.length > 0; depth += 1) {
				episodes.push(...level.filter((item) => item.kind === MediaKind.EPISODE));
				level = level.flatMap((item) => byParent.get(item.id) ?? []);
			}

			if (episodes.length > 0) {
				groups.set(series.id, episodes);
			}
		}

		return groups;
	}

	/** The `provider:value` keys one row carries that are worth comparing at all. */
	private _identifierKeys(item: MediaItemEntity): string[] {
		return WORK_IDENTIFIERS.map(
			(provider) => [provider, identifierValue(item.externalIds, provider)] as const,
		)
			.filter(([, value]) => value !== null)
			.map(([provider, value]) => `${provider}:${value as string}`);
	}

	private _episodeIdentifiers(
		groups: Map<string, MediaItemEntity[]>,
	): Map<string, Set<string>> {
		const distinctive = new Map<string, Set<string>>();

		for (const episodes of groups.values()) {
			const keys = episodeIdentifierKeys(
				episodes.map((episode) => ({ id: episode.id, keys: this._identifierKeys(episode) })),
			);

			for (const [id, values] of keys) {
				distinctive.set(id, values);
			}
		}

		return distinctive;
	}

	/**
	 * The series this gateway has already decided are the same show, both ways round.
	 *
	 * Worked out in the pass rather than read back from the match table, and that is a
	 * choice worth explaining. The rows are written as the same pass walks, so reading
	 * them would answer with the *previous* pass's conclusions — episodes under a series
	 * matched for the first time would stay unrelated until a second scan happened to
	 * run, and nothing on any screen would say why. Asking the correlation itself costs
	 * one comparison per series, which is a few hundred against the tens of thousands
	 * the pass already does, and gives the answer this pass would give.
	 */
	private _seriesPairs(
		items: MediaItemEntity[],
		context: { threshold: number; peers: Map<string, string | null>; byWork: Map<string, MediaItemEntity[]> },
	): Map<string, Set<string>> {
		const series = items.filter((item) => item.kind === MediaKind.SERIES);
		const byTitle = new Map<string, MediaItemEntity[]>();

		for (const one of series) {
			byTitle.set(one.normalizedTitle, [...(byTitle.get(one.normalizedTitle) ?? []), one]);
		}

		const pairs = new Map<string, Set<string>>();

		for (const one of series) {
			const candidates = new Map<string, MediaItemEntity>();

			for (const candidate of [
				...(byTitle.get(one.normalizedTitle) ?? []),
				...this._sameWorkAs(one, context.byWork),
			]) {
				if (candidate.id !== one.id && candidate.serviceId !== one.serviceId) {
					candidates.set(candidate.id, candidate);
				}
			}

			const proposals = this._matching.correlate(
				this._candidate(one, context.peers),
				[...candidates.values()].map((candidate) => this._candidate(candidate, context.peers)),
				{ threshold: context.threshold },
			);

			for (const proposal of proposals) {
				// Proposed is not matched. A correlation the score did not apply is one
				// nobody has agreed to, and building a numbering conversion on top of it
				// would let a doubtful series pairing quietly renumber four hundred
				// episodes.
				if (proposal.applied) {
					MediaManager._link(pairs, one.id, proposal.remoteItemId);
					MediaManager._link(pairs, proposal.remoteItemId, one.id);
				}
			}
		}

		return pairs;
	}

	/**
	 * Episodes related across two numbering conventions, for every matched series.
	 *
	 * Every guard lives in `alignAbsoluteNumbering`; this only decides which two sets of
	 * episodes are handed to it, which is the part that needs the index. Each pair of
	 * series is aligned once — the relation is symmetric, and aligning it twice would
	 * do the same arithmetic to reach the same answer.
	 */
	private _absolutePairs(
		items: MediaItemEntity[],
		groups: Map<string, MediaItemEntity[]>,
		context: { threshold: number; peers: Map<string, string | null>; byWork: Map<string, MediaItemEntity[]> },
	): Map<string, Set<string>> {
		const pairs = new Map<string, Set<string>>();
		const aligned = new Set<string>();

		for (const [seriesId, others] of this._seriesPairs(items, context)) {
			for (const otherId of others) {
				const key = seriesId < otherId ? `${seriesId}|${otherId}` : `${otherId}|${seriesId}`;

				if (aligned.has(key)) {
					continue;
				}

				aligned.add(key);

				const left = groups.get(seriesId) ?? [];
				const right = groups.get(otherId) ?? [];

				for (const pair of alignAbsoluteNumbering(
					left.map((item) => this._numbered(item)),
					right.map((item) => this._numbered(item)),
				)) {
					MediaManager._link(pairs, pair.absoluteId, pair.splitId);
					MediaManager._link(pairs, pair.splitId, pair.absoluteId);
				}
			}
		}

		return pairs;
	}

	private _numbered(item: MediaItemEntity): {
		id: string;
		seasonNumber: number | null;
		episodeNumber: number | null;
	} {
		return {
			id: item.id,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
		};
	}

	/**
	 * The rows the numbering alignment paired this one with.
	 *
	 * Added to the candidate set because nothing else would ever bring them together:
	 * the candidate lookup joins on the normalised title and the episode coordinates,
	 * and the whole point of this pair is that neither of those agrees.
	 */
	private _alignedWith(item: MediaItemEntity, context: CorrelationContext): MediaItemEntity[] {
		const related: MediaItemEntity[] = [];

		for (const id of context.absolutePairs.get(item.id) ?? []) {
			const candidate = context.byId.get(id);

			if (candidate !== undefined) {
				related.push(candidate);
			}
		}

		return related;
	}

	private static _link(pairs: Map<string, Set<string>>, from: string, to: string): void {
		const existing = pairs.get(from);

		if (existing === undefined) {
			pairs.set(from, new Set([to]));

			return;
		}

		existing.add(to);
	}

	private _indexByContent(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			for (const key of contentKeys(item.file)) {
				index.set(key, [...(index.get(key) ?? []), item]);
			}
		}

		return index;
	}

	private _sameContentAs(
		item: MediaItemEntity,
		index: Map<string, MediaItemEntity[]>,
	): MediaItemEntity[] {
		return contentKeys(item.file).flatMap((key) => index.get(key) ?? []);
	}

	/**
	 * Films and series by the identifiers that name a work.
	 *
	 * The title lookup only ever puts two copies side by side when their normalised
	 * titles are identical, so a film filed as *Le Fabuleux Destin d'Amélie Poulain* on
	 * one server and *Amélie* on another was never compared at all, however loudly their
	 * IMDb numbers agreed. If the identifier decides the work, it has to be able to
	 * introduce the two copies too.
	 *
	 * Films and series only. A season and an episode routinely carry their series'
	 * identifier rather than their own, so indexing them would make every episode of a
	 * show a candidate for every other — a quadratic walk to be told no — and a season
	 * has no number check in the identifier strategy to stop season one meeting season
	 * two.
	 */
	private _indexByWork(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			for (const key of this._workKeys(item)) {
				index.set(key, [...(index.get(key) ?? []), item]);
			}
		}

		return index;
	}

	private _sameWorkAs(
		item: MediaItemEntity,
		index: Map<string, MediaItemEntity[]>,
	): MediaItemEntity[] {
		return this._workKeys(item).flatMap((key) => index.get(key) ?? []);
	}

	private _workKeys(item: MediaItemEntity): string[] {
		if (item.kind !== MediaKind.MOVIE && item.kind !== MediaKind.SERIES) {
			return [];
		}

		// The kind is part of the key because TMDB and TVDB number films and series
		// separately: film 1399 and series 1399 are two works.
		return WORK_IDENTIFIERS.map((provider) => [provider, identifierValue(item.externalIds, provider)])
			.filter(([, value]) => value !== null)
			.map(([provider, value]) => `${item.kind}:${provider}:${value}`);
	}

	/** `S01E05`, with a question mark where a library told us nothing. */
	private _label(item: MediaItemEntity): string {
		const season = item.seasonNumber === null ? '??' : String(item.seasonNumber).padStart(2, '0');
		const episode = item.episodeNumber === null ? '??' : String(item.episodeNumber).padStart(2, '0');

		return `S${season}E${episode}`;
	}

	private _candidate(
		item: MediaItemEntity,
		peers: Map<string, string | null>,
	): MatchCandidate {
		return {
			id: item.id,
			serviceId: item.serviceId,
			peerId: peers.get(item.serviceId) ?? null,
			parentId: item.parentId,
			kind: item.kind,
			title: item.title,
			normalizedTitle: item.normalizedTitle,
			year: item.year,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
			externalIds: item.externalIds,
			file: item.file,
		};
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
