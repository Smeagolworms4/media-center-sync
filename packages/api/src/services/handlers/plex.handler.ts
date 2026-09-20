import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaServiceType,
	type MediaFileInfo,
	type MediaServiceProbe,
} from '@mcs/shared';
import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { CacheService } from '../cache.service';
import { normalizeTitle, parseTitle } from '../title-normalizer';
import { MediaHandler } from './handler.decorator';
import { buildUrl, relativeTo, requestJson, requestStream } from './handler.http';
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
import { asNumber, asRecord, asRecordArray, asString, firstOf, pick, type Payload } from './payload';

/**
 * Plex identifies clients rather than users, and refuses some routes without it.
 *
 * The identifier has to be stable across restarts or the account's device list
 * fills up with one entry per boot; the registered service's own identifier is
 * exactly that, and is already unique per server the gateway talks to.
 */
const PRODUCT_NAME = 'Media Center Sync';
const PRODUCT_VERSION = '0.1.0';

/** Where Plex accounts actually live. The media server never sees the password. */
const PLEX_ACCOUNT_URL = 'https://plex.tv';

/** Plex numbers its metadata types, and the section listing filters on the number. */
const PLEX_TYPE_BY_KIND: Record<MediaKind, number> = {
	[MediaKind.MOVIE]: 1,
	[MediaKind.SERIES]: 2,
	[MediaKind.SEASON]: 3,
	[MediaKind.EPISODE]: 4,
	[MediaKind.COLLECTION]: 18,
};

const KIND_BY_PLEX_TYPE: Record<string, MediaKind> = {
	movie: MediaKind.MOVIE,
	show: MediaKind.SERIES,
	season: MediaKind.SEASON,
	episode: MediaKind.EPISODE,
	collection: MediaKind.COLLECTION,
};

const LIBRARY_KIND_BY_SECTION_TYPE: Record<string, LibraryKind> = {
	movie: LibraryKind.MOVIES,
	show: LibraryKind.SHOWS,
	artist: LibraryKind.MUSIC,
};

/** How long a resolved part key stays usable. See `_partKey` for why it is cached. */
const PART_KEY_TTL_SECONDS = 300;

/**
 * Plex, over its HTTP API.
 *
 * The shape is the same contract as Jellyfin's, but almost nothing else is: Plex
 * wraps every answer in a `MediaContainer`, numbers its item types, keeps the real
 * file behind a `Part` whose key is not the path, and nests shows into seasons into
 * episodes. The nesting is the part that leaks: a flat listing of a show section by
 * episode type works on current servers and returns nothing on older ones, so the
 * scan falls back to walking `/children` when the flat path comes up empty.
 */
@Injectable()
@MediaHandler(MediaServiceType.PLEX)
export class PlexHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.PLEX;

	public constructor(private readonly _cache: CacheService) {}

	public async probe(connection: ServiceConnection): Promise<MediaServiceProbe> {
		const empty: MediaServiceProbe = {
			reachable: false,
			authenticated: false,
			type: MediaServiceType.PLEX,
			version: null,
			serverName: null,
			libraries: [],
			error: null,
		};

		let identity: Payload;

		try {
			// `/identity` answers without a token, which is what separates "wrong
			// address" from "wrong token" in one request.
			identity = await this._container(connection, '/identity');
		} catch {
			return { ...empty, error: ErrorKey.SERVICE_UNREACHABLE };
		}

		const version = asString(identity.version);

		try {
			const root = await this._container(connection, '/');
			const libraries = await this.listLibraries(connection);

			return {
				...empty,
				reachable: true,
				authenticated: true,
				version: asString(root.version) ?? version,
				serverName: asString(firstOf(root, 'friendlyName', 'machineIdentifier')),
				libraries,
			};
		} catch (error) {
			return {
				...empty,
				reachable: true,
				authenticated: false,
				version,
				serverName: null,
				error:
					error instanceof UnauthorizedException
						? ErrorKey.SERVICE_UNAUTHORIZED
						: ErrorKey.SERVICE_UNREACHABLE,
			};
		}
	}

	/**
	 * Signs in against plex.tv, not against the server.
	 *
	 * Plex has no local account database: the media server only ever validates
	 * tokens minted by the account service. Pointing this at `connection.baseUrl`
	 * looks tidier and simply does not work.
	 */
	public async authenticate(
		connection: ServiceConnection,
		username: string,
		password: string,
	): Promise<ExternalIdentity> {
		const answer = await requestJson<Payload>(PLEX_ACCOUNT_URL, '/api/v2/users/signin', {
			method: 'POST',
			body: { login: username, password },
			headers: this._headers(connection, { withToken: false }),
			timeoutMs: connection.timeoutMs,
		}).catch((error: unknown) => {
			if (error instanceof UnauthorizedException) {
				throw new UnauthorizedException({ key: ErrorKey.AUTH_INVALID_CREDENTIALS });
			}

			throw error;
		});

		const user = asRecord(firstOf(answer, 'user') ?? answer);
		const externalUserId = asString(firstOf(user, 'id', 'uuid'));

		if (!externalUserId) {
			throw new UnauthorizedException({ key: ErrorKey.AUTH_INVALID_CREDENTIALS });
		}

		return {
			externalUserId,
			username: asString(user.username) ?? username,
			displayName: asString(firstOf(user, 'title', 'friendlyName')),
			email: asString(user.email),
			avatarUrl: asString(user.thumb),
			token: asString(firstOf(user, 'authToken', 'authentication_token')),
		};
	}

	public async listLibraries(connection: ServiceConnection): Promise<NormalisedLibrary[]> {
		const container = await this._container(connection, '/library/sections');

		return asRecordArray(container.Directory).flatMap((section) => {
			const externalId = asString(firstOf(section, 'key', 'uuid'));

			if (!externalId) {
				return [];
			}

			const type = asString(section.type)?.toLowerCase() ?? '';

			return [
				{
					externalId,
					name: asString(section.title) ?? externalId,
					kind: LIBRARY_KIND_BY_SECTION_TYPE[type] ?? LibraryKind.OTHER,
					paths: asRecordArray(section.Location)
						.map((location) => asString(location.path))
						.filter((path): path is string => !!path),
				},
			];
		});
	}

	public async *scanLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		options: LibraryScanOptions = {},
	): AsyncIterable<NormalisedMediaItem> {
		const kinds = options.kinds ?? this._defaultKinds(library);
		const pageSize = Math.min(Math.max(options.pageSize ?? 200, 20), 500);

		for (const kind of kinds) {
			let yielded = 0;

			for await (const item of this._scanSection(connection, library, kind, pageSize, options)) {
				yielded += 1;
				yield item;
			}

			// Older servers refuse to list seasons and episodes flat from a section and
			// answer an empty container instead of an error. Walking the tree is slower
			// — one request per show, one per season — so it stays a fallback rather
			// than the default.
			if (yielded === 0 && (kind === MediaKind.SEASON || kind === MediaKind.EPISODE)) {
				yield* this._scanByChildren(connection, library, kind, options);
			}
		}
	}

	public async refreshLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		cursor: string | null,
	): Promise<LibraryRefresh> {
		const since = cursor === null ? null : asNumber(cursor);
		const kinds = this._defaultKinds(library);
		const items: NormalisedMediaItem[] = [];
		let newest = since ?? 0;

		for (const kind of kinds) {
			// Plex filters on `updatedAt>=<epoch seconds>`; the operator is part of the
			// parameter name, which looks wrong and is what the API actually wants.
			// Without a cursor we ask `/newest` instead, because an unfiltered section
			// listing sorted by date is the full library again.
			const container =
				since === null
					? await this._container(connection, `/library/sections/${library.externalId}/newest`, {
						type: PLEX_TYPE_BY_KIND[kind],
						'X-Plex-Container-Start': 0,
						'X-Plex-Container-Size': 100,
					})
					: await this._container(connection, `/library/sections/${library.externalId}/all`, {
						type: PLEX_TYPE_BY_KIND[kind],
						'updatedAt>=': since,
						sort: 'updatedAt:asc',
						'X-Plex-Container-Start': 0,
						'X-Plex-Container-Size': 200,
					});

			for (const raw of asRecordArray(container.Metadata)) {
				const normalised = this._toItem(connection, raw);

				if (normalised) {
					items.push(normalised);
				}

				const updatedAt = asNumber(firstOf(raw, 'updatedAt', 'addedAt')) ?? 0;

				newest = Math.max(newest, updatedAt);
			}
		}

		// The cursor is inclusive on the next call, so the newest item comes back once
		// more. That is deliberate: moving it forward by a second to avoid the repeat
		// loses anything saved within the same second, and re-indexing one item costs
		// nothing.
		return {
			items,
			cursor: String(newest > 0 ? newest : Math.floor(Date.now() / 1000)),
		};
	}

	/**
	 * Tell Plex to re-read a section we have just written into.
	 *
	 * `GET /library/sections/{key}/refresh` and not a POST, which looks wrong and is
	 * what Plex actually exposes — its whole API is verbs over GET. It answers an empty
	 * body, which `requestJson` degrades to an empty object rather than choking on.
	 *
	 * A section is always addressable when we hold one, so the server-wide form has no
	 * counterpart worth reaching for here: `/library/sections/all/refresh` walks every
	 * section on the server, which on the deployment this exists for — a file dropped
	 * in a folder outside every registered library — would re-read terabytes to find
	 * something no section contains. Saying the refresh could not be aimed is the more
	 * useful answer, and the landing simply waits.
	 */
	public async requestRescan(
		connection: ServiceConnection,
		library: NormalisedLibrary | null,
	): Promise<RescanOutcome> {
		if (library === null || library.externalId === '') {
			return RescanOutcome.UNSUPPORTED;
		}

		await requestJson<Payload>(
			connection.baseUrl,
			`/library/sections/${library.externalId}/refresh`,
			{ headers: this._headers(connection), timeoutMs: connection.timeoutMs },
		);

		return RescanOutcome.LIBRARY;
	}

	public async getItem(
		connection: ServiceConnection,
		externalId: string,
	): Promise<NormalisedMediaItem | null> {
		/*
		 * Only the not-found is swallowed, and that distinction is the whole point.
		 *
		 * A blanket `.catch(() => null)` reported a Plex that was merely rebooting as
		 * a Plex that no longer holds the item, so revalidation concluded the source
		 * was gone and abandoned it — dropping a perfectly good source because a
		 * server took thirty seconds to come back. A transport failure has to reach
		 * the caller as a failure.
		 */
		const container = await this._container(
			connection,
			`/library/metadata/${encodeURIComponent(externalId)}`,
		).catch((error: unknown) => {
			if (error instanceof NotFoundException) {
				return null;
			}

			throw error;
		});

		const raw = container ? asRecordArray(container.Metadata)[0] : undefined;

		return raw ? this._toItem(connection, raw) : null;
	}

	/**
	 * Plex answers `401` for a poster without `X-Plex-Token`, unlike Jellyfin.
	 *
	 * Fetching it unauthenticated would leave every Plex item with a broken image and
	 * nothing anywhere saying why — it looks like a missing poster, not a missing
	 * credential.
	 */
	public openArtwork(
		connection: ServiceConnection,
		item: MediaItemRef & { artworkUrl: string },
	): Promise<MediaStream> {
		return requestStream(connection.baseUrl, relativeTo(connection.baseUrl, item.artworkUrl), {
			headers: this._headers(connection),
			timeoutMs: connection.timeoutMs,
		});
	}

	public async openStream(
		connection: ServiceConnection,
		item: MediaItemRef,
		range?: ByteRange,
	): Promise<MediaStream> {
		const partKey = await this._partKey(connection, item.externalId);

		if (!partKey) {
			throw new UnauthorizedException({ key: ErrorKey.MEDIA_NOT_FOUND });
		}

		return requestStream(connection.baseUrl, partKey, {
			headers: this._headers(connection),
			// `download=1` asks Plex for the original file rather than a transcode,
			// which is the difference between the bytes we checksummed and a new
			// encode of them.
			query: { download: 1 },
			range,
			timeoutMs: connection.timeoutMs,
		});
	}

	public async getDownloadUrl(
		connection: ServiceConnection,
		item: MediaItemRef,
	): Promise<string | null> {
		if (!connection.token) {
			return null;
		}

		const partKey = await this._partKey(connection, item.externalId);

		return partKey
			? buildUrl(connection.baseUrl, partKey, {
				download: 1,
				'X-Plex-Token': connection.token,
			})
			: null;
	}

	/**
	 * The `/library/parts/...` key that actually serves bytes.
	 *
	 * It is not derivable from anything we store — it carries an internal part
	 * identifier — so it costs a metadata request. Cached for a few minutes because a
	 * multi-connection transfer asks for it once per connection and a repair asks
	 * again; the key only changes when the file is replaced, at which point the
	 * transfer is going to fail its checksum and revalidate anyway.
	 */
	private async _partKey(
		connection: ServiceConnection,
		externalId: string,
	): Promise<string | null> {
		return this._cache.wrap(
			`plex:part:${connection.id}:${externalId}`,
			PART_KEY_TTL_SECONDS,
			async () => {
				const container = await this._container(
					connection,
					`/library/metadata/${encodeURIComponent(externalId)}`,
				).catch(() => null);

				const raw = container ? asRecordArray(container.Metadata)[0] : undefined;
				const part = asRecordArray(pick(asRecordArray(raw?.Media)[0], 'Part'))[0];

				return asString(part?.key);
			},
		);
	}

	private async *_scanSection(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		kind: MediaKind,
		pageSize: number,
		options: LibraryScanOptions,
	): AsyncIterable<NormalisedMediaItem> {
		let start = 0;

		for (;;) {
			const container = await this._container(
				connection,
				`/library/sections/${library.externalId}/all`,
				{
					type: PLEX_TYPE_BY_KIND[kind],
					// Paging happens through these two parameters rather than through
					// headers, because a header-paged request that loses its headers to
					// a proxy silently returns the first page forever.
					'X-Plex-Container-Start': start,
					'X-Plex-Container-Size': pageSize,
					sort: 'titleSort:asc',
				},
				options.signal,
			);

			const rows = asRecordArray(container.Metadata);

			for (const raw of rows) {
				const normalised = this._toItem(connection, raw);

				if (normalised) {
					yield normalised;
				}
			}

			start += rows.length;

			const total = asNumber(firstOf(container, 'totalSize', 'size'));

			if (rows.length === 0 || rows.length < pageSize) {
				break;
			}

			if (total !== null && total > 0 && start >= total) {
				break;
			}
		}
	}

	/**
	 * Walk show → season → episode, for the servers that will not list them flat.
	 *
	 * Deliberately depth-first and sequential: a Plex server answers one request at a
	 * time under load anyway, and hammering it with parallel children requests during
	 * a scan is how a library scan becomes a support ticket about buffering.
	 */
	private async *_scanByChildren(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		kind: MediaKind,
		options: LibraryScanOptions,
	): AsyncIterable<NormalisedMediaItem> {
		const shows = this._scanSection(connection, library, MediaKind.SERIES, 200, options);

		for await (const show of shows) {
			const seasons = await this._children(connection, show.externalId);

			for (const season of seasons) {
				const normalisedSeason = this._toItem(connection, season);

				if (kind === MediaKind.SEASON && normalisedSeason) {
					yield normalisedSeason;

					continue;
				}

				if (kind !== MediaKind.EPISODE) {
					continue;
				}

				const seasonId = asString(season.ratingKey);

				if (!seasonId) {
					continue;
				}

				for (const episode of await this._children(connection, seasonId)) {
					const normalised = this._toItem(connection, episode);

					if (normalised) {
						yield normalised;
					}
				}
			}
		}
	}

	private async _children(connection: ServiceConnection, ratingKey: string): Promise<Payload[]> {
		const container = await this._container(
			connection,
			`/library/metadata/${encodeURIComponent(ratingKey)}/children`,
		).catch(() => null);

		return container ? asRecordArray(container.Metadata) : [];
	}

	/** Unwraps the `MediaContainer` every Plex answer is wrapped in. */
	private async _container(
		connection: ServiceConnection,
		path: string,
		query?: Record<string, string | number | boolean | null | undefined>,
		signal?: AbortSignal,
	): Promise<Payload> {
		const answer = await requestJson<Payload>(connection.baseUrl, path, {
			headers: this._headers(connection),
			query,
			timeoutMs: connection.timeoutMs,
			signal,
		});

		return asRecord(answer.MediaContainer);
	}

	private _headers(
		connection: ServiceConnection,
		options: { withToken?: boolean } = {},
	): Record<string, string> {
		const headers: Record<string, string> = {
			// Without this Plex answers XML, whatever the path says.
			Accept: 'application/json',
			'X-Plex-Product': PRODUCT_NAME,
			'X-Plex-Version': PRODUCT_VERSION,
			'X-Plex-Client-Identifier': connection.id,
			'X-Plex-Device': PRODUCT_NAME,
			'X-Plex-Platform': 'Node',
		};

		if (connection.token && options.withToken !== false) {
			headers['X-Plex-Token'] = connection.token;
		}

		return headers;
	}

	private _defaultKinds(library: NormalisedLibrary): MediaKind[] {
		if (library.kind === LibraryKind.MOVIES) {
			return [MediaKind.MOVIE];
		}

		if (library.kind === LibraryKind.SHOWS) {
			// Parents before children, so the indexing layer can resolve a parent
			// reference against something it has already stored.
			return [MediaKind.SERIES, MediaKind.SEASON, MediaKind.EPISODE];
		}

		return [MediaKind.MOVIE, MediaKind.SERIES, MediaKind.SEASON, MediaKind.EPISODE];
	}

	private _toItem(connection: ServiceConnection, raw: Payload): NormalisedMediaItem | null {
		const externalId = asString(raw.ratingKey);
		const kind = KIND_BY_PLEX_TYPE[asString(raw.type)?.toLowerCase() ?? ''];

		if (!externalId || !kind) {
			return null;
		}

		const file = this._toFile(raw);
		const fromPath = file?.path ? parseTitle(file.path) : null;
		const title = asString(raw.title) ?? fromPath?.title ?? externalId;
		const addedAt = asNumber(raw.addedAt);

		/*
		 * The normalised form of a season or an episode is the SHOW's title, never its
		 * own.
		 *
		 * Correlation joins on normalised title plus season plus episode number, and
		 * Plex names an unmatched episode `Episode 1`: every episode of every show in
		 * the library would normalise to the same handful of strings, and a title match
		 * would pair them with each other. The display title stays what it is; the form
		 * used for comparison has to identify the show, because that is what two
		 * libraries can be expected to agree on.
		 *
		 * `grandparentTitle` is the show behind an episode, `parentTitle` the show
		 * behind a season.
		 */
		const showTitle =
			kind === MediaKind.EPISODE
				? (asString(raw.grandparentTitle) ?? fromPath?.title ?? title)
				: kind === MediaKind.SEASON
					? (asString(raw.parentTitle) ?? fromPath?.title ?? title)
					: title;

		return {
			externalId,
			// A season points at its show, an episode at its season. Plex fills
			// `parentRatingKey` on both, and `grandparentRatingKey` is the show behind
			// an episode — useful when the season row itself never got indexed.
			parentExternalId:
				asString(firstOf(raw, 'parentRatingKey', 'grandparentRatingKey')) ?? null,
			kind,
			title,
			normalizedTitle: normalizeTitle(showTitle),
			year: asNumber(raw.year) ?? fromPath?.year ?? null,
			// `index` is the season number on a season and the episode number on an
			// episode, which is why it cannot be read without knowing the kind.
			seasonNumber: this._seasonNumber(raw, kind) ?? fromPath?.seasonNumber ?? null,
			episodeNumber:
				kind === MediaKind.EPISODE
					? (asNumber(raw.index) ?? fromPath?.episodeNumber ?? null)
					: null,
			externalIds: this._toExternalIds(raw, externalId),
			overview: asString(raw.summary),
			artworkUrl: asString(raw.thumb)
				? buildUrl(connection.baseUrl, asString(raw.thumb) as string)
				: null,
			file,
			// Plex counts in epoch seconds; the rest of the gateway speaks ISO.
			addedAt: addedAt === null ? null : new Date(addedAt * 1000).toISOString(),
		};
	}

	private _bitsPerSecond(kilobits: number | null): number | null {
		return kilobits === null ? null : Math.round(kilobits * 1000);
	}

	private _seasonNumber(raw: Payload, kind: MediaKind): number | null {
		if (kind === MediaKind.SEASON) {
			return asNumber(raw.index);
		}

		if (kind === MediaKind.EPISODE) {
			return asNumber(raw.parentIndex);
		}

		return null;
	}

	private _toExternalIds(raw: Payload, externalId: string) {
		const ids: Record<string, string> = {};

		// The modern shape is a `Guid` array of `tvdb://121361` entries; the legacy one
		// is a single `guid` string like
		// `com.plexapp.agents.thetvdb://121361/1/2?lang=en`. Libraries built years apart
		// carry one or the other, and both are the most reliable match we will get.
		for (const entry of asRecordArray(raw.Guid)) {
			const value = asString(entry.id) ?? '';
			const match = /^(\w+):\/\/([^/?]+)/.exec(value);

			if (match) {
				ids[match[1].toLowerCase()] = match[2];
			}
		}

		const legacy = asString(raw.guid) ?? '';
		const legacyMatch = /agents\.(\w+):\/\/([^/?]+)/.exec(legacy);

		if (legacyMatch) {
			const agent = legacyMatch[1].toLowerCase().replace('the', '');

			ids[agent] = ids[agent] ?? legacyMatch[2];
		}

		return {
			tvdb: ids.tvdb,
			tmdb: ids.tmdb ?? ids.themoviedb,
			imdb: ids.imdb,
			musicbrainz: ids.musicbrainz,
			provider: externalId,
		};
	}

	private _toFile(raw: Payload): MediaFileInfo | null {
		const media = asRecordArray(raw.Media)[0];
		const part = asRecordArray(media?.Part)[0];
		const path = asString(part?.file);

		if (!path) {
			return null;
		}

		const duration = asNumber(firstOf(media ?? {}, 'duration')) ?? asNumber(raw.duration);

		return {
			path,
			size: asNumber(part?.size) ?? 0,
			container: asString(firstOf(part ?? {}, 'container')) ?? asString(media?.container),
			videoCodec: asString(media?.videoCodec),
			audioCodec: asString(media?.audioCodec),
			width: asNumber(media?.width),
			height: asNumber(media?.height),
			// Plex already counts in milliseconds here, unlike everything else it dates.
			durationMs: duration,
			// Plex reports kilobits per second where Jellyfin reports bits. The quality
			// comparator ranks on this number, so a thousandfold difference between two
			// services would make every Plex copy look worse than every Jellyfin one.
			bitrate: this._bitsPerSecond(asNumber(media?.bitrate)),
			quickHash: null,
			contentId: null,
			checksum: null,
			// Plex is the only service either handler talks to that has a word for the
			// cut, and it is worth taking: a library whose two copies of one film are
			// told apart by a Plex edition rather than by a `{edition-…}` in the
			// filename would otherwise arrive here as two nameless versions.
			edition: asString(firstOf(raw, 'editionTitle', 'edition')),
		};
	}
}
