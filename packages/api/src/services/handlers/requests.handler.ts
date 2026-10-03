import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaServiceType,
	RequestLibrary,
	ServerStructureSupport,
	type MediaServiceProbe,
	type RequestSourceSettings,
	type ServerStructure,
} from '@mcs/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requestStream } from './handler.http';
import { RequestSourceRegistry } from '../requests/request-source.registry';
import { SettingsService } from '../settings.service';
import { normalizeTitle } from '../title-normalizer';
import { MediaHandler } from './handler.decorator';
import {
	RescanOutcome,
	type ByteRange,
	type ExternalIdentity,
	type LibraryRefresh,
	type LibraryScanOptions,
	type MediaItemRef,
	type MediaServiceHandler,
	type MediaStream,
	type NormalisedLibrary,
	type NormalisedMediaItem,
	type ServiceConnection,
} from './media-handler.interface';

/**
 * How long a poster fetch waits on the provider.
 *
 * Shorter than the source's own timeout, because the cost of being wrong is different: a
 * scan that gives up early loses rows, while a poster that gives up early loses a poster
 * on a card that still says everything else. Ten seconds is generous for an image on a
 * CDN and short enough that a provider having a bad day does not hold a wall of sixty
 * cards open.
 */
const ARTWORK_TIMEOUT_MS = 10_000;

/**
 * What the household has asked for, read as if it were a media server.
 *
 * The complaint this answers, in the owner's words: requests and the shows he follows on
 * Seerr should come up like everything else, like a local series — the only difference
 * being that there is no local file. They did not, and could not: the index is a mirror of
 * what media servers declare, so a show waiting on a request had no row anywhere. It
 * appeared in no library, was counted by nothing, could not be filtered, corrected,
 * matched against a local copy or searched for on a tracker. It had a screen of its own,
 * listing numbers.
 *
 * So it is a service. Everything below answers the same questions a Jellyfin answers, and
 * the rows that come out are ordinary rows that happen to carry no file — which is exactly
 * what a missing media is everywhere else in this product. Nothing else had to change for
 * the library wall, the filters, the missing counts, the corrections, the rematching or
 * the release search to work on them, and that is the whole reason for doing it this way.
 *
 * **The stale pass is a feature here, not a hazard.** These rows are reported by a scan
 * like any other, so a request somebody withdraws on Seerr stops being reported and the
 * next pass removes it. That is right, and it is why they are not written as `synthetic`
 * rows the way `discoverEpisodes` writes an aired episode under a show a server does
 * report — those have nobody to re-report them.
 *
 * **It holds no bytes.** No artwork is proxied, no stream is opened, nothing is
 * downloadable: a request is a statement that nobody has the file. The methods that would
 * serve one refuse rather than answering an empty result, because an empty result here
 * would be read as "the file is there and is zero bytes long".
 */
@Injectable()
@MediaHandler(MediaServiceType.REQUESTS)
export class RequestsHandler implements MediaServiceHandler {
	/**
	 * One library, and its identifier is fixed.
	 *
	 * Fixed because the gateway keys a library on what the service called it: a value that
	 * changed between two scans would orphan every row under the old one and write them
	 * all again under the new, which reads as the whole request list vanishing and coming
	 * back.
	 */
	/**
	 * Two libraries, because the source keeps two lists that mean different things.
	 *
	 * A request is "fetch me this" and is answered once. A watchlist entry is "tell me when
	 * there is more of this" and never is. Keeping them apart here is what lets the new
	 * releases screen read one and the library filter read the other, without inventing a
	 * flag on a media row for something that is really a question of where it came from.
	 *
	 * The identifiers are fixed: the gateway keys a library on what the service called it,
	 * and a value that changed between two scans would orphan every row under the old one
	 * and write them all again under the new — which reads as the whole list vanishing and
	 * coming back.
	 */
	/**
	 * Four libraries, not two: each list split by what the source already tells us.
	 *
	 * Seerr says `movie` or `tv` on every row, and the two lists were nonetheless written
	 * as one mixed shelf each — so every request landed in a catch-all that no category
	 * could sort and no default destination could be set on. Splitting them costs nothing,
	 * because the information was already on the wire, and it buys the two things a
	 * household actually asks for: films filed as films, and "send my films here, my
	 * series there" as a setting rather than a correction made row by row.
	 */
	private static readonly LIBRARIES: {
		externalId: RequestLibrary;
		name: string;
		kind: LibraryKind;
		watchlist: boolean;
		mediaKind: MediaKind.MOVIE | MediaKind.SERIES;
	}[] = [
			{
				externalId: RequestLibrary.REQUESTS_MOVIES,
				name: 'Requests — Movies',
				kind: LibraryKind.MOVIES,
				watchlist: false,
				mediaKind: MediaKind.MOVIE,
			},
			{
				externalId: RequestLibrary.REQUESTS_SHOWS,
				name: 'Requests — Shows',
				kind: LibraryKind.SHOWS,
				watchlist: false,
				mediaKind: MediaKind.SERIES,
			},
			{
				externalId: RequestLibrary.WATCHLIST_MOVIES,
				name: 'Watchlist — Movies',
				kind: LibraryKind.MOVIES,
				watchlist: true,
				mediaKind: MediaKind.MOVIE,
			},
			{
				externalId: RequestLibrary.WATCHLIST_SHOWS,
				name: 'Watchlist — Shows',
				kind: LibraryKind.SHOWS,
				watchlist: true,
				mediaKind: MediaKind.SERIES,
			},
		];

	public readonly type = MediaServiceType.REQUESTS;

	public constructor(
		private readonly _settings: SettingsService,
		private readonly _sources: RequestSourceRegistry,
	) {}

	public async probe(connection: ServiceConnection): Promise<MediaServiceProbe> {
		const empty: MediaServiceProbe = {
			reachable: false,
			authenticated: false,
			type: MediaServiceType.REQUESTS,
			version: null,
			serverName: null,
			libraries: [],
			error: null,
		};

		const configured = await this._configured().catch(() => null);

		if (configured === null) {
			return { ...empty, error: ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED };
		}

		const reachable = await this._sources.get(configured.type).probe(configured);

		if (!reachable) {
			return { ...empty, error: ErrorKey.REQUEST_SOURCE_UNREACHABLE };
		}

		return {
			...empty,
			reachable: true,
			// One fact for this service: the key in the settings is what proves who we
			// are, so a source that answers at all has accepted it.
			authenticated: true,
			serverName: connection.baseUrl,
			libraries: this._libraries(),
		};
	}

	/**
	 * Nothing to authenticate against.
	 *
	 * The address and the key live in the settings, beside everything else that talks to
	 * the request source, and asking for them a second time here would let the two
	 * disagree — with the service quietly reading a stale key and reporting an empty
	 * request list rather than an error.
	 */
	public authenticate(): Promise<ExternalIdentity> {
		throw new ConflictException(ErrorKey.SERVICE_AUTH_UNSUPPORTED);
	}

	public async listLibraries(): Promise<NormalisedLibrary[]> {
		return this._libraries();
	}

	/**
	 * No directories, because there is no server with disks behind this.
	 *
	 * Answered rather than thrown: the screen that picks a destination asks every service
	 * what it can offer, and a refusal there would be an error dialog over a question that
	 * has a perfectly good answer — this one cannot receive files.
	 */
	public async listServerDirectories(): Promise<ServerStructure> {
		return {
			support: ServerStructureSupport.UNSUPPORTED,
			path: null,
			parent: null,
			entries: [],
		};
	}

	/**
	 * Everything the household has asked for or is following, as media.
	 *
	 * A film is one row. A show is a row, plus a row per season, plus a row per episode
	 * that has aired — which is what makes a requested series read like a series somebody
	 * holds: it opens, it has seasons, the seasons have episodes, and every one of them is
	 * missing until a copy arrives.
	 *
	 * **Only what has aired.** An episode nobody can have yet is not missing from a
	 * library, it is missing from the world, and a row offering to search for it sends
	 * somebody hunting for something that does not exist. A provider that states no date
	 * is read as "not aired", which is the cautious half of that answer — the same reading
	 * `discoverEpisodes` already makes.
	 *
	 * A request the source cannot name is skipped rather than written under a placeholder:
	 * a wall of "Unknown" posters is worse than a wall that is three shows short, and the
	 * next scan picks it up once the provider answers again.
	 */
	public async *scanLibrary(
		_connection: ServiceConnection,
		library: NormalisedLibrary,
		_options?: LibraryScanOptions,
	): AsyncIterable<NormalisedMediaItem> {
		const configured = await this._configured();
		const source = this._sources.get(configured.type);
		const shelf = RequestsHandler.LIBRARIES.find(
			(one) => one.externalId === library.externalId,
		);

		if (shelf === undefined) {
			// A library this handler never declared, which a stale row could still ask for.
			// Nothing is the honest answer: inventing a list would write rows under a shelf
			// that is about to be swept away.
			return;
		}

		const watchlist = shelf.watchlist;

		/*
		 * Two lists, and which one is read depends on which library is being scanned.
		 *
		 * Requests include the settled ones, because the default drops what the source
		 * calls available — precisely a series the household follows and already holds, and
		 * the whole reason this catalogue exists. Left on the default the scan wrote almost
		 * nothing and reported it as "0 items", which reads as a feature that does not work.
		 */
		const asked: { kind: MediaKind.MOVIE | MediaKind.SERIES; tmdbId: string | null; tvdbId: string | null; seasons: { seasonNumber: number }[]; requestedAt: string | null }[] =
			watchlist
				? (await source.watchlist(configured)).map((entry) => ({
					kind: entry.kind,
					tmdbId: entry.tmdbId,
					tvdbId: null,
					// A watchlist says nothing about seasons: following a show is following
					// all of it, which is the difference between it and a request.
					seasons: [],
					requestedAt: null,
				}))
				: (await source.list(configured, { includeSettled: true })).map((one) => ({
					kind: one.kind,
					tmdbId: one.tmdbId,
					tvdbId: one.tvdbId,
					seasons: one.seasons,
					requestedAt: one.requestedAt,
				}));

		for (const request of asked) {
			// The shelf decides what belongs on it, from the word the source already sent.
			// Both lists carry films and shows together; each library holds one of the two.
			if (request.kind !== shelf.mediaKind) {
				continue;
			}

			const providerId = request.tmdbId;

			if (providerId === null) {
				// Nothing to ask the provider about, and nothing to match a local copy on
				// either: an identifier is the only thing a catalogue can be matched by.
				continue;
			}

			const details = await source.details(configured, request.kind, providerId);

			if (details === null) {
				continue;
			}

			/*
			 * Prefixed by the list it came from, because a show can be on both and the
			 * gateway keys a row on what the service called it: one identifier across two
			 * libraries would collide into a single row that changed library on every scan
			 * and belonged properly to neither.
			 */
			const seriesId = `${library.externalId}:${request.kind}:${providerId}`;
			const externalIds = {
				...(request.tmdbId === null ? {} : { tmdb: request.tmdbId }),
				...(request.tvdbId === null ? {} : { tvdb: request.tvdbId }),
			};

			yield {
				externalId: seriesId,
				parentExternalId: null,
				kind: request.kind,
				title: details.title,
				normalizedTitle: normalizeTitle(details.title),
				year: details.year,
				seasonNumber: null,
				episodeNumber: null,
				externalIds,
				overview: details.overview,
				artworkUrl: details.artworkUrl,
				// The whole point: no file. It reads as missing everywhere a state is read.
				file: null,
				addedAt: request.requestedAt,
			};

			if (request.kind !== MediaKind.SERIES) {
				continue;
			}

			/*
			 * The seasons somebody asked for when they named any, and every season the show
			 * has when they asked for it whole. A request for seasons two and three must not
			 * fill the library with season one — they did not ask for it — while a request
			 * with no seasons named is a request for the show.
			 */
			const asked = new Set(request.seasons.map((season) => season.seasonNumber));
			const wanted = details.seasonNumbers
				.filter((number) => number > 0 && (asked.size === 0 || asked.has(number)));

			for (const seasonNumber of wanted) {
				const seasonId = `${seriesId}:s${seasonNumber}`;

				yield {
					externalId: seasonId,
					parentExternalId: seriesId,
					kind: MediaKind.SEASON,
					title: `Season ${seasonNumber}`,
					normalizedTitle: normalizeTitle(details.title),
					year: null,
					seasonNumber,
					episodeNumber: null,
					externalIds: {},
					overview: null,
					artworkUrl: null,
					file: null,
					addedAt: null,
				};

				for (const episode of await source.episodes(configured, providerId, seasonNumber)) {
					if (!hasAired(episode.airDate)) {
						continue;
					}

					yield {
						externalId: `${seasonId}:e${episode.episodeNumber}`,
						parentExternalId: seasonId,
						kind: MediaKind.EPISODE,
						title: episode.title ?? `Episode ${episode.episodeNumber}`,
						// Under the show's name, as every handler normalises an episode: two
						// libraries agree about a show's name far more often than about the
						// name of anything under it.
						normalizedTitle: normalizeTitle(details.title),
						year: null,
						seasonNumber,
						episodeNumber: episode.episodeNumber,
						externalIds: {},
						overview: null,
						artworkUrl: null,
						file: null,
						addedAt: episode.airDate,
					};
				}
			}
		}
	}

	/**
	 * The same list, every time, and no cursor.
	 *
	 * A request source has nothing resembling a change feed, and inventing one from the
	 * request dates would miss the case that matters most: an episode airing changes
	 * nothing about the request it belongs to. So the refresh is the scan — it costs a
	 * handful of calls against a service the household already runs, and it is the path
	 * that makes a newly aired episode turn up on its own.
	 */
	public async refreshLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
	): Promise<LibraryRefresh> {
		const entries: NormalisedMediaItem[] = [];

		for await (const item of this.scanLibrary(connection, library)) {
			entries.push(item);
		}

		return { items: entries, cursor: new Date().toISOString() };
	}

	/**
	 * Nothing to ask: there is no server here that indexes anything.
	 *
	 * `UNSUPPORTED` rather than a refusal, because this is asked after every file this
	 * gateway places — a throw would turn "your copy has landed" into an error about a
	 * service that had nothing to do with it.
	 */
	public async requestRescan(): Promise<RescanOutcome> {
		return RescanOutcome.UNSUPPORTED;
	}

	/** Nothing indexes these rows, so there is no one item to re-read. */
	public async refreshItem(): Promise<boolean> {
		return false;
	}

	public async getItem(
		connection: ServiceConnection,
		externalId: string,
	): Promise<NormalisedMediaItem | null> {
		for await (const item of this._everything(connection)) {
			if (item.externalId === externalId) {
				return item;
			}
		}

		return null;
	}

	public async identify(): Promise<ExternalIdentity | null> {
		return null;
	}

	/*
	 * The three that would serve bytes, and the reason they refuse rather than answer
	 * nothing: a request is the statement that nobody has the file. An empty stream here
	 * would be read one level up as a file that exists and is zero bytes long, which is
	 * how an empty file gets written into somebody's library and indexed as real.
	 */
	/**
	 * The poster, fetched from the provider the request source named.
	 *
	 * This used to refuse, on the principle written at the top of this class: the service
	 * holds no bytes, so it relays nothing. The principle is right about *files* and was
	 * wrong about this. A request is a row with a title and no copy, and a wall of such
	 * rows with no posters is not an austere wall — it is a wall of grey rectangles with
	 * two letters on them, which is what a household actually saw.
	 *
	 * The source does not host the image either: it answers TMDB's path, and the url was
	 * built and stored when the row was written — see `artworkUrlOf`. So this is a plain
	 * fetch of a public image, with no connection, no token and nothing of the source's in
	 * it. It goes through the gateway rather than straight from the browser because every
	 * poster in this product does, which is the only reason worth having: one route, one
	 * cache, and an interface that never has to know which service a card came from.
	 *
	 * A row with no url still refuses, and that answer is honest — a season and an episode
	 * carry none, and the group above them is what has the poster.
	 */
	public openArtwork(
		_connection: ServiceConnection,
		item: MediaItemRef & { artworkUrl?: string | null },
	): Promise<MediaStream> {
		const url = item.artworkUrl ?? '';

		if (url === '') {
			throw new NotFoundException(ErrorKey.MEDIA_HAS_NO_FILE);
		}

		/*
		 * Split into origin and path rather than handed over whole, because the helper
		 * joins the two and would otherwise ask the provider for `…/poster.jpg/`. Parsing
		 * also settles what a stored url actually is: anything that is not one refuses
		 * here, where the answer is a missing poster, instead of reaching the network as a
		 * request nobody can read.
		 */
		let parsed: URL;

		try {
			parsed = new URL(url);
		} catch {
			throw new NotFoundException(ErrorKey.MEDIA_HAS_NO_FILE);
		}

		// The provider's own host, never the source's: this carries no token and no
		// connection, because the image is public and none of it is the source's business.
		return requestStream(parsed.origin, `${parsed.pathname}${parsed.search}`, {
			timeoutMs: ARTWORK_TIMEOUT_MS,
		});
	}

	public openStream(_connection: ServiceConnection, _item: MediaItemRef, _range?: ByteRange): Promise<MediaStream> {
		throw new NotFoundException(ErrorKey.MEDIA_HAS_NO_FILE);
	}

	public async getDownloadUrl(): Promise<string | null> {
		return null;
	}

	/** Both lists, for the one caller that addresses an item without saying which. */
	private async *_everything(connection: ServiceConnection): AsyncIterable<NormalisedMediaItem> {
		for (const library of this._libraries()) {
			yield* this.scanLibrary(connection, library);
		}
	}

	private _libraries(): NormalisedLibrary[] {
		// No path, which is what keeps them out of every placement: a destination has to be
		// a directory this gateway can write into, and none of these is one.
		return RequestsHandler.LIBRARIES.map((one) => ({
			externalId: one.externalId,
			name: one.name,
			kind: one.kind,
			paths: [],
		}));
	}

	private async _configured(): Promise<RequestSourceSettings> {
		const configured = (await this._settings.get()).requestSource ?? null;

		if (configured === null || !configured.enabled) {
			throw new ConflictException(ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED);
		}

		return configured;
	}
}

/**
 * Whether an episode has come out, read the cautious way.
 *
 * No date is "not yet": a provider that has not filled the field in is not evidence that
 * the episode exists, and a row for an episode nobody can have sends somebody searching
 * for something that has not been made.
 */
const hasAired = (airDate: string | null): boolean => {
	if (airDate === null) {
		return false;
	}

	const aired = new Date(airDate);

	return !Number.isNaN(aired.getTime()) && aired.getTime() <= Date.now();
};
