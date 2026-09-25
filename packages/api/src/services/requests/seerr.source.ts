import {
	type RequestDetails,
	type RequestEpisode,
	ErrorKey,
	MediaKind,
	MediaRequestState,
	RequestSourceType,
	type MediaRequest,
	type RequestOrder,
	type RequestQuery,
	type RequestSourceSettings,
	type RequestedSeason,
} from '@mcs/shared';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CLIENT_TIMEOUT_MS, releaseJson } from '../releases/release-http';
import { RequestSourceFor } from './request-source.decorator';
import type { RequestSource } from './request-source.interface';

/**
 * Seerr's own shape, as much of it as is read.
 *
 * Deliberately partial and deliberately all optional, for the reason `ProwlarrRelease`
 * is: this is somebody else's JSON over a version nobody pins, and a field that moves in
 * their next release must cost a missing label rather than a screen that throws.
 */
interface SeerrMedia {
	/** The media row, which is what `markAvailable` addresses. Not the TMDB identifier. */
	id?: number;
	tmdbId?: number | null;
	tvdbId?: number | null;
	mediaType?: string;
	status?: number;
	/** Absent in Overseerr and Jellyseerr. Read anyway, because a fork may add it. */
	title?: string;
}

interface SeerrSeason {
	seasonNumber?: number;
	status?: number;
}

interface SeerrUser {
	displayName?: string;
	username?: string;
	plexUsername?: string;
	email?: string;
}

interface SeerrRequest {
	id?: number;
	status?: number;
	type?: string;
	media?: SeerrMedia;
	seasons?: SeerrSeason[];
	requestedBy?: SeerrUser;
	createdAt?: string;
}

interface SeerrPage {
	results?: SeerrRequest[];
}

/**
 * Where a *request* has got to, which is a person's decision.
 *
 * Numbers on the wire, and not the same scale as the media's below — a fact worth
 * spelling out, because both fields are called `status` and both are small integers, so
 * reading one with the other's vocabulary is a mistake that compiles and runs.
 */
const REQUEST_PENDING = 1;
const REQUEST_APPROVED = 2;
const REQUEST_DECLINED = 3;

/** Where the *media* behind it has got to, which is what a fetcher did or did not do. */
const MEDIA_UNKNOWN = 1;
const MEDIA_PENDING = 2;
const MEDIA_PROCESSING = 3;
const MEDIA_PARTIAL = 4;
const MEDIA_AVAILABLE = 5;

/** How many requests a listing asks for when nobody says. Overseerr's own default is 10. */
const DEFAULT_TAKE = 100;

/** Above this a page is somebody's whole history, which no screen reads in one go. */
const MAX_TAKE = 500;

/**
 * The status Seerr actually answered, dug back out of what `release-http` raised.
 *
 * Every bad status but a 401 arrives as one `SERVICE_UNAVAILABLE` carrying `HTTP nnn` in
 * its detail. That is the right answer for a search, and not enough here: a request
 * somebody deleted while the screen was open (404) and an ask Seerr already holds open
 * (409) are both ordinary outcomes of this loop rather than an outage, and reporting them
 * as one would have the interface tell a household its request server is down. Widening
 * `release-http` would change what the indexer and the download client report, so the
 * status is read back out instead — and a detail this does not recognise stays an outage,
 * which is the safe way to be wrong.
 */
const statusOf = (cause: unknown): number | null => {
	if (!(cause instanceof HttpException)) {
		return null;
	}

	const response = cause.getResponse();
	const detail =
		typeof response === 'object' && response !== null
			? (response as { detail?: unknown }).detail
			: null;
	const match = typeof detail === 'string' ? /^HTTP (\d{3})$/.exec(detail) : null;

	return match === null ? null : Number(match[1]);
};

/**
 * One of Seerr's numeric identifiers as a string, or nothing.
 *
 * Absent, null and zero are all "it does not have one": a film has no TVDB number and
 * Seerr says so explicitly, and zero is what a fork writes when it has nothing to write.
 */
const identifierOf = (value: number | null | undefined): string | null =>
	value === undefined || value === null || value === 0 ? null : String(value);

/**
 * Where the provider's posters actually live.
 *
 * Overseerr answers a **bare path** — `/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg` — and not a URL,
 * which was verified against a running Seerr rather than assumed. Handing that to an
 * `artworkUrl` would produce an image element pointing at a path on the gateway's own
 * origin: a broken poster on every card, with nothing in any log to say why, because
 * fetching `/v1tRX….jpg` from the interface is a perfectly ordinary 404 on a route nobody
 * declared.
 *
 * So the base belongs here, next to the field that needs it, rather than in an interface
 * that would be guessing. `w600_and_h900_bestv2` is the size the source's own screens ask
 * for, so the household's browser has it cached already.
 *
 * A path that is already absolute is passed through: a fork that starts answering full
 * URLs must not end up with two bases glued together.
 */
const POSTER_BASE = 'https://image.tmdb.org/t/p/w600_and_h900_bestv2';

const artworkUrlOf = (posterPath: string | undefined): string | null => {
	const path = posterPath?.trim() ?? '';

	if (path === '') {
		return null;
	}

	return /^https?:\/\//i.test(path) ? path : `${POSTER_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
};

/**
 * Reading the household's asks from Seerr, and telling it what became of them.
 *
 * One class for Seerr, Overseerr and Jellyseerr because they are one API — see
 * `RequestSourceType.SEERR`. It reads requests, marks a media held, and pushes an ask the
 * other way, and that is the whole surface.
 *
 * Nothing here decides anything and nothing here fetches media. Whether we hold what was
 * asked for is a question about the catalogue, which this layer has never heard of; that
 * it is not wired to a download is the product's central choice about this feature, not
 * an unfinished edge — see `RequestSource`.
 */
@Injectable()
@RequestSourceFor(RequestSourceType.SEERR)
export class SeerrRequestSource implements RequestSource {
	public async list(
		settings: RequestSourceSettings,
		query: RequestQuery,
	): Promise<MediaRequest[]> {
		const page = await releaseJson<SeerrPage>(settings.baseUrl, '/api/v1/request', {
			query: {
				take: Math.min(Math.max(query.take ?? DEFAULT_TAKE, 1), MAX_TAKE),
				skip: 0,
				// Seerr's own filters are asked for none of the narrowing, on purpose: its
				// vocabulary is not ours. Its `approved` includes requests whose media is
				// already available, and a list of open asks showing completed ones is a
				// list nobody can act on. Newest first, because that is where the open
				// ones are, and the state is decided here from both statuses at once.
				filter: 'all',
				sort: 'added',
			},
			headers: this._headers(settings),
			timeoutMs: CLIENT_TIMEOUT_MS,
			unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
			unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
		});

		// A JSON answer of the wrong shape is an empty list rather than a crash: a URL
		// somebody typed lands on a reverse proxy answering its own body often enough.
		// A body that is not JSON at all never reaches here — `release-http` parses before
		// returning, and that is its call to make, not this one's.
		const rows = Array.isArray(page?.results) ? page.results : [];

		return rows
			.map((row) => this._toRequest(row))
			.filter((one): one is MediaRequest => one !== null)
			.filter((one) => this._wanted(one, query.state));
	}

	public async find(
		settings: RequestSourceSettings,
		requestId: string,
	): Promise<MediaRequest | null> {
		try {
			const row = await releaseJson<SeerrRequest>(
				settings.baseUrl,
				`/api/v1/request/${encodeURIComponent(requestId)}`,
				{
					headers: this._headers(settings),
					timeoutMs: CLIENT_TIMEOUT_MS,
					unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
					unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
				},
			);

			return this._toRequest(row);
		} catch (cause) {
			if (statusOf(cause) === HttpStatus.NOT_FOUND) {
				return null;
			}

			throw cause;
		}
	}

	public async markAvailable(settings: RequestSourceSettings, mediaId: string): Promise<void> {
		await releaseJson<unknown>(
			settings.baseUrl,
			`/api/v1/media/${encodeURIComponent(mediaId)}/available`,
			{
				// An empty object rather than no body at all: the route reads `is4k` off it,
				// and it is left unset on purpose — this gateway does not hold a separate
				// 4k catalogue, so claiming to have completed the 4k ask would close a
				// request nothing here answers.
				body: {},
				headers: this._headers(settings),
				timeoutMs: CLIENT_TIMEOUT_MS,
				unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
				unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
			},
		);
	}

	/**
	 * What the thing asked for actually is, from the metadata the source already browses.
	 *
	 * Overseerr proxies its provider under `/api/v1/movie/{tmdbId}` and
	 * `/api/v1/tv/{tmdbId}`, which is why this is one request and not a second API key
	 * for somebody else's metadata service: the household already trusts this server
	 * with exactly this question, and it answers in the language its own screens use.
	 *
	 * Every failure answers null rather than raising. A provider that has renamed or
	 * withdrawn an entry leaves one request nobody can label, and a listing that refused
	 * to load because of it would hide every other ask alongside it — which is the
	 * opposite of what a screen about outstanding asks is for.
	 */
	public async details(
		settings: RequestSourceSettings,
		kind: MediaKind.MOVIE | MediaKind.SERIES,
		providerId: string,
	): Promise<RequestDetails | null> {
		const path = kind === MediaKind.MOVIE ? 'movie' : 'tv';

		try {
			const row = await releaseJson<{
				title?: string;
				name?: string;
				releaseDate?: string;
				firstAirDate?: string;
				overview?: string;
				posterPath?: string;
				seasons?: { seasonNumber?: number }[];
			}>(settings.baseUrl, `/api/v1/${path}/${providerId}`, {
				headers: { 'X-Api-Key': settings.apiKey ?? '' },
				timeoutMs: CLIENT_TIMEOUT_MS,
				unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
				unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
			});

			// A film answers `title`, a show answers `name`. Both are sometimes absent on
			// an entry a provider has withdrawn, and an untitled card is worse than none.
			const title = (row.title ?? row.name ?? '').trim();

			if (title === '') {
				return null;
			}

			const dated = row.releaseDate ?? row.firstAirDate ?? '';
			const year = Number.parseInt(dated.slice(0, 4), 10);

			return {
				title,
				year: Number.isNaN(year) ? null : year,
				overview: row.overview?.trim() || null,
				artworkUrl: artworkUrlOf(row.posterPath),
				// Season zero is specials, and asking for "the whole show" should not mean
				// asking for a folder of behind-the-scenes clips.
				seasonNumbers: (row.seasons ?? [])
					.map((season) => season.seasonNumber)
					.filter((number): number is number => typeof number === 'number' && number > 0),
			};
		} catch {
			return null;
		}
	}

	public async create(
		settings: RequestSourceSettings,
		order: RequestOrder,
	): Promise<MediaRequest | null> {
		const isSeries = order.kind === MediaKind.SERIES;

		try {
			const row = await releaseJson<SeerrRequest>(settings.baseUrl, '/api/v1/request', {
				body: {
					mediaType: isSeries ? 'tv' : 'movie',
					// `mediaId` here is the **TMDB** identifier, and in `markAvailable` it is
					// Seerr's own media row. Same word, two numbering schemes, both small
					// integers on a fresh install — so crossing them succeeds and asks for
					// the wrong film. Named by TMDB is the only thing that can work: a work
					// nobody has ever requested has no row for us to name.
					mediaId: Number(order.tmdbId),
					// A show with no seasons named asks for all of them; `[]` would be an ask
					// for nothing, which Seerr accepts and nobody ever sees arrive.
					...(isSeries
						? { seasons: order.seasons !== undefined && order.seasons.length > 0 ? order.seasons : 'all' }
						: {}),
				},
				headers: this._headers(settings),
				timeoutMs: CLIENT_TIMEOUT_MS,
				unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
				unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
			});

			return this._toRequest(row);
		} catch (cause) {
			// Seerr already has the same ask open, which is exactly the state the press was
			// asking for. Reporting it as a failure would have somebody press again.
			if (statusOf(cause) === HttpStatus.CONFLICT) {
				return null;
			}

			throw cause;
		}
	}

	/**
	 * The episodes of one season, from the same metadata the household browses.
	 *
	 * `/api/v1/tv/{tmdbId}/season/{n}` — one call, no second API key, and the answer is in
	 * the language the source's own screens use. It was there the whole time: the show
	 * lookup above already reads this provider and only ever took the *season numbers* off
	 * it, which is why an episode that aired last night appeared nowhere in this product.
	 *
	 * Everything the provider lists, dates included. Deciding what has aired is the
	 * caller's, not this class's: the source states a fact and the manager decides what to
	 * do about a date in the future.
	 *
	 * Empty on every failure rather than a throw: this fills a catalogue in, and a metadata
	 * provider having a bad afternoon must not turn a media page into an error.
	 */
	public async episodes(
		settings: RequestSourceSettings,
		providerId: string,
		seasonNumber: number,
	): Promise<RequestEpisode[]> {
		try {
			const row = await releaseJson<{
				episodes?: {
					episodeNumber?: number;
					name?: string;
					airDate?: string;
				}[];
			}>(settings.baseUrl, `/api/v1/tv/${providerId}/season/${seasonNumber}`, {
				headers: { 'X-Api-Key': settings.apiKey ?? '' },
				timeoutMs: CLIENT_TIMEOUT_MS,
				unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
				unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
			});

			return (row.episodes ?? [])
				.filter(
					(episode): episode is { episodeNumber: number; name?: string; airDate?: string } =>
						typeof episode.episodeNumber === 'number' && episode.episodeNumber > 0,
				)
				.map((episode) => ({
					seasonNumber,
					episodeNumber: episode.episodeNumber,
					title: episode.name?.trim() || null,
					airDate: episode.airDate?.trim() || null,
				}));
		} catch (error: unknown) {
			new Logger(SeerrRequestSource.name).warn(
				`${settings.baseUrl} would not list season ${seasonNumber} of ${providerId}: ${String(error)}`,
			);

			return [];
		}
	}

	public async probe(settings: RequestSourceSettings): Promise<boolean> {
		// The request count rather than `/api/v1/status`, which answers without a key at
		// all: probing that would go green on a key that authenticates nothing, and the
		// first listing would then be the thing that failed.
		await releaseJson<unknown>(settings.baseUrl, '/api/v1/request/count', {
			headers: this._headers(settings),
			timeoutMs: CLIENT_TIMEOUT_MS,
			unreachable: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
			unauthorized: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED,
		});

		return true;
	}

	private _headers(settings: RequestSourceSettings): Record<string, string> {
		return { 'X-Api-Key': settings.apiKey ?? '' };
	}

	/**
	 * Which rows a listing keeps.
	 *
	 * With no state asked for, the open ones — and "open" excludes the declined as well
	 * as the available, because both are asks nobody has anything left to do about. The
	 * page was asked for whole, so this is the only place the ceiling bites: a household
	 * with five hundred completed requests may need `take` raised to see an old open one.
	 */
	private _wanted(request: MediaRequest, state: MediaRequestState | undefined): boolean {
		if (state !== undefined) {
			return request.state === state;
		}

		return (
			request.state !== MediaRequestState.AVAILABLE
			&& request.state !== MediaRequestState.DECLINED
		);
	}

	private _toRequest(row: SeerrRequest | null | undefined): MediaRequest | null {
		const media = row?.media;

		// Both identifiers or nothing. A row with no request identifier cannot be
		// addressed by a route, and one with no media row can neither be matched to our
		// catalogue nor marked complete — showing it would be a line that does nothing.
		if (row?.id === undefined || media?.id === undefined) {
			return null;
		}

		// A row carrying seasons is a show whatever its `mediaType` says, which is how a
		// missing or renamed type field costs a label rather than filing a series as a
		// film and losing every season with it.
		const isSeries =
			media.mediaType === 'tv' || row.type === 'tv' || (row.seasons?.length ?? 0) > 0;

		return {
			id: String(row.id),
			mediaId: String(media.id),
			kind: isSeries ? MediaKind.SERIES : MediaKind.MOVIE,
			title: media.title ?? null,
			// `?? null` and not a check for `undefined`: Seerr answers an explicit
			// `"tvdbId": null` on every film, and `String(null)` is the four characters
			// `null` — an identifier that is not one. It would be carried into a catalogue
			// lookup, match nothing, and there is no failure anywhere to notice; the day
			// something does hold the string, it matches the wrong media instead.
			tmdbId: identifierOf(media.tmdbId),
			tvdbId: identifierOf(media.tvdbId),
			state: this._state(row),
			seasons: this._seasons(row),
			requestedBy:
				row.requestedBy?.displayName
				?? row.requestedBy?.plexUsername
				?? row.requestedBy?.username
				?? row.requestedBy?.email
				?? null,
			requestedAt: row.createdAt ?? null,
		};
	}

	private _seasons(row: SeerrRequest): RequestedSeason[] {
		if (!Array.isArray(row.seasons)) {
			return [];
		}

		return row.seasons
			.filter((season) => typeof season.seasonNumber === 'number')
			.map((season) => ({
				seasonNumber: season.seasonNumber as number,
				state: this._mediaState(season.status),
			}));
	}

	/**
	 * The two statuses folded into the one scale a screen reads.
	 *
	 * The person's decision comes first and the fetcher's progress second, because that
	 * is the order they happen in: a declined request whose media is somehow available is
	 * still declined, and an approved one says nothing about itself — everything after
	 * approval is a fact about the media.
	 */
	private _state(row: SeerrRequest): MediaRequestState {
		if (row.status === REQUEST_DECLINED) {
			return MediaRequestState.DECLINED;
		}

		if (row.status === REQUEST_PENDING) {
			return MediaRequestState.PENDING;
		}

		// Overseerr's fourth status is `failed`, and a later version may add a fifth. Both
		// are shown as-is rather than guessed at: a request this build cannot read is not
		// a request it should be closing.
		if (row.status !== REQUEST_APPROVED) {
			return MediaRequestState.UNKNOWN;
		}

		return this._mediaState(row.media?.status);
	}

	/**
	 * A media status, which is also a season's.
	 *
	 * `unknown` and `pending` both read as approved because that is what they mean inside
	 * an approved request: somebody said yes and nothing has happened yet. They are only
	 * ever reached from there — see `_state`.
	 */
	private _mediaState(status: number | undefined): MediaRequestState {
		switch (status) {
			case MEDIA_AVAILABLE:
				return MediaRequestState.AVAILABLE;
			case MEDIA_PARTIAL:
				return MediaRequestState.PARTIAL;
			case MEDIA_PROCESSING:
				return MediaRequestState.PROCESSING;
			case MEDIA_PENDING:
			case MEDIA_UNKNOWN:
				return MediaRequestState.APPROVED;
			default:
				return MediaRequestState.UNKNOWN;
		}
	}
}
