import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaServiceType,
	type MediaFileInfo,
	type MediaServiceProbe,
} from '@mcs/shared';
import { Injectable, UnauthorizedException } from '@nestjs/common';
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
 * How the gateway introduces itself to Jellyfin.
 *
 * Jellyfin refuses `/Users/AuthenticateByName` without a well-formed
 * `Authorization` header, and it shows the device name in its "active devices"
 * screen — which is how somebody eventually works out that the thing hammering
 * their server every five minutes is their own gateway.
 */
const CLIENT_NAME = 'Media Center Sync';
const CLIENT_VERSION = '0.1.0';

/** Fields that have to be asked for explicitly; Jellyfin omits them otherwise. */
const ITEM_FIELDS = 'Path,MediaSources,ProviderIds,DateCreated,Overview,ParentId';

const KIND_BY_JELLYFIN_TYPE: Record<string, MediaKind> = {
	Movie: MediaKind.MOVIE,
	Series: MediaKind.SERIES,
	Season: MediaKind.SEASON,
	Episode: MediaKind.EPISODE,
	BoxSet: MediaKind.COLLECTION,
};

const JELLYFIN_TYPE_BY_KIND: Record<MediaKind, string> = {
	[MediaKind.MOVIE]: 'Movie',
	[MediaKind.SERIES]: 'Series',
	[MediaKind.SEASON]: 'Season',
	[MediaKind.EPISODE]: 'Episode',
	[MediaKind.COLLECTION]: 'BoxSet',
};

const LIBRARY_KIND_BY_COLLECTION_TYPE: Record<string, LibraryKind> = {
	movies: LibraryKind.MOVIES,
	tvshows: LibraryKind.SHOWS,
	music: LibraryKind.MUSIC,
};

/**
 * Jellyfin, over its HTTP API.
 *
 * Written defensively throughout: Jellyfin changes field casing between releases,
 * omits whole sections for items it has not analysed yet, and answers with an empty
 * `MediaSources` for anything it considers virtual. A scan that throws on one such
 * item has failed for the whole library, so every read degrades to null.
 */
@Injectable()
@MediaHandler(MediaServiceType.JELLYFIN)
export class JellyfinHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.JELLYFIN;

	public async probe(connection: ServiceConnection): Promise<MediaServiceProbe> {
		const empty: MediaServiceProbe = {
			reachable: false,
			authenticated: false,
			type: MediaServiceType.JELLYFIN,
			version: null,
			serverName: null,
			libraries: [],
			error: null,
		};

		try {
			const info = await requestJson<Payload>(connection.baseUrl, '/System/Info', {
				headers: this._headers(connection),
				timeoutMs: connection.timeoutMs,
			});

			const libraries = await this.listLibraries(connection).catch(() => []);

			return {
				...empty,
				reachable: true,
				authenticated: true,
				version: asString(info.Version),
				serverName: asString(info.ServerName),
				libraries: libraries.map((library) => ({
					externalId: library.externalId,
					name: library.name,
					kind: library.kind,
					paths: library.paths,
				})),
			};
		} catch (error) {
			// A rejected token still proves the server is there, and the settings
			// screen renders those two situations very differently: one offers to fix
			// the address, the other to fix the credentials.
			if (error instanceof UnauthorizedException) {
				const publicInfo = await requestJson<Payload>(
					connection.baseUrl,
					'/System/Info/Public',
					{ timeoutMs: connection.timeoutMs },
				).catch(() => ({}) as Payload);

				return {
					...empty,
					reachable: true,
					authenticated: false,
					version: asString(publicInfo.Version),
					serverName: asString(publicInfo.ServerName),
					error: ErrorKey.SERVICE_UNAUTHORIZED,
				};
			}

			return { ...empty, error: ErrorKey.SERVICE_UNREACHABLE };
		}
	}

	public async authenticate(
		connection: ServiceConnection,
		username: string,
		password: string,
	): Promise<ExternalIdentity> {
		const answer = await requestJson<Payload>(
			connection.baseUrl,
			'/Users/AuthenticateByName',
			{
				method: 'POST',
				// `Pw` is the plain password field; the older `Password` field expected
				// a SHA-1 and is gone from current Jellyfin.
				body: { Username: username, Pw: password },
				headers: this._headers(connection),
				timeoutMs: connection.timeoutMs,
			},
		).catch((error: unknown) => {
			// A rejected password is an ordinary answer for a sign-in form, and the
			// key has to be the credentials one rather than the service one, or the
			// person is told their server is down when they mistyped.
			if (error instanceof UnauthorizedException) {
				throw new UnauthorizedException({ key: ErrorKey.AUTH_INVALID_CREDENTIALS });
			}

			throw error;
		});

		const user = asRecord(answer.User);
		const externalUserId = asString(user.Id);

		if (!externalUserId) {
			throw new UnauthorizedException({ key: ErrorKey.AUTH_INVALID_CREDENTIALS });
		}

		return {
			externalUserId,
			username: asString(user.Name) ?? username,
			displayName: asString(user.Name),
			// Jellyfin holds no email of its own; leaving it null is honest, and the
			// gateway never needs one.
			email: null,
			avatarUrl: asString(pick(user, 'PrimaryImageTag'))
				? buildUrl(connection.baseUrl, `/Users/${externalUserId}/Images/Primary`)
				: null,
			token: asString(answer.AccessToken),
		};
	}

	public async listLibraries(connection: ServiceConnection): Promise<NormalisedLibrary[]> {
		const folders = await requestJson<unknown>(connection.baseUrl, '/Library/VirtualFolders', {
			headers: this._headers(connection),
			timeoutMs: connection.timeoutMs,
		});

		return asRecordArray(folders).flatMap((folder) => {
			// `ItemId` is what `/Items?ParentId=` wants. A virtual folder without one
			// cannot be scanned, so it is dropped rather than listed as an empty
			// library nobody can explain.
			const externalId = asString(firstOf(folder, 'ItemId', 'Id'));

			if (!externalId) {
				return [];
			}

			const collectionType = asString(folder.CollectionType)?.toLowerCase() ?? '';

			return [
				{
					externalId,
					name: asString(folder.Name) ?? externalId,
					kind: LIBRARY_KIND_BY_COLLECTION_TYPE[collectionType] ?? LibraryKind.OTHER,
					paths: this._locations(folder),
				},
			];
		});
	}

	public async *scanLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		options: LibraryScanOptions = {},
	): AsyncIterable<NormalisedMediaItem> {
		const pageSize = Math.min(Math.max(options.pageSize ?? 200, 20), 500);
		let start = 0;

		for (;;) {
			const page = await requestJson<Payload>(connection.baseUrl, '/Items', {
				headers: this._headers(connection),
				timeoutMs: connection.timeoutMs,
				signal: options.signal,
				query: {
					ParentId: library.externalId,
					Recursive: true,
					IncludeItemTypes: this._includeTypes(library, options.kinds),
					Fields: ITEM_FIELDS,
					// Paging by index is only stable under a stable sort, and Jellyfin
					// defaults to something the library's own settings can change. An
					// unstable sort silently skips and duplicates items across pages.
					SortBy: 'SortName',
					SortOrder: 'Ascending',
					StartIndex: start,
					Limit: pageSize,
				},
			});

			const items = asRecordArray(page.Items);

			for (const item of items) {
				const normalised = this._toItem(connection, item);

				if (normalised) {
					yield normalised;
				}
			}

			start += items.length;

			const total = asNumber(page.TotalRecordCount);

			// Stop on a short page as well as on the announced total: some Jellyfin
			// versions answer `TotalRecordCount: 0` when the count is disabled, and
			// trusting it alone ends the scan after one page.
			if (items.length === 0 || items.length < pageSize) {
				break;
			}

			if (total !== null && total > 0 && start >= total) {
				break;
			}
		}
	}

	public async refreshLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		cursor: string | null,
	): Promise<LibraryRefresh> {
		// `DateLastSaved` moves whenever Jellyfin rewrites an item — an added file, a
		// refreshed artwork, a corrected episode number. It is the only field that
		// catches a change to an item we already hold; `DateCreated` would only ever
		// find additions.
		const page = await requestJson<Payload>(connection.baseUrl, '/Items', {
			headers: this._headers(connection),
			timeoutMs: connection.timeoutMs,
			query: {
				ParentId: library.externalId,
				Recursive: true,
				IncludeItemTypes: this._includeTypes(library),
				Fields: `${ITEM_FIELDS},DateLastSaved`,
				sortBy: 'DateLastSaved',
				sortOrder: 'Descending',
				minDateLastSaved: cursor ?? undefined,
				// A refresh is meant to be cheap. If more than this changed, the next
				// full scan is the right tool and the cursor stays where it was so
				// nothing is lost in between.
				Limit: 200,
			},
		});

		const raw = asRecordArray(page.Items);
		const items: NormalisedMediaItem[] = [];
		let newest = cursor;

		for (const entry of raw) {
			const normalised = this._toItem(connection, entry);

			if (normalised) {
				items.push(normalised);
			}

			const savedAt = asString(firstOf(entry, 'DateLastSaved', 'DateCreated'));

			if (savedAt && (newest === null || savedAt > newest)) {
				newest = savedAt;
			}
		}

		// With no cursor and nothing returned, the cursor has to start somewhere or
		// every refresh re-reads the whole library forever.
		return { items, cursor: newest ?? new Date().toISOString() };
	}

	/**
	 * Tell Jellyfin to re-read a folder we have just written into.
	 *
	 * `POST /Items/{id}/Refresh` against the library's own item is the narrow form and
	 * the one worth reaching for: it walks one shelf instead of the whole server, which
	 * on a household library is the difference between seconds and several minutes of
	 * a Raspberry Pi doing nothing else.
	 *
	 * `Recursive` is not optional here. Without it Jellyfin re-reads the metadata of
	 * the library node itself and never descends, so the episode that has just landed
	 * three directories down is not seen and the refresh looks like it did nothing.
	 * `ImageRefreshMode=None` keeps it from re-fetching artwork for the entire shelf,
	 * which is a fan-out to the metadata providers nobody asked for over one new file.
	 *
	 * `/Library/Refresh` is the fallback rather than the first choice: it is the whole
	 * server, and it is what remains when we hold no handle for the library — which is
	 * the ordinary case for a landing in the fallback folder that belongs to no library
	 * at all.
	 */
	public async requestRescan(
		connection: ServiceConnection,
		library: NormalisedLibrary | null,
	): Promise<RescanOutcome> {
		if (library !== null && library.externalId !== '') {
			await requestJson<Payload>(connection.baseUrl, `/Items/${library.externalId}/Refresh`, {
				method: 'POST',
				headers: this._headers(connection),
				query: {
					Recursive: true,
					ImageRefreshMode: 'None',
					MetadataRefreshMode: 'Default',
					ReplaceAllImages: false,
					ReplaceAllMetadata: false,
				},
				timeoutMs: connection.timeoutMs,
			});

			return RescanOutcome.LIBRARY;
		}

		await requestJson<Payload>(connection.baseUrl, '/Library/Refresh', {
			method: 'POST',
			headers: this._headers(connection),
			timeoutMs: connection.timeoutMs,
		});

		return RescanOutcome.SERVER;
	}

	public async getItem(
		connection: ServiceConnection,
		externalId: string,
	): Promise<NormalisedMediaItem | null> {
		// `/Items?Ids=` rather than `/Users/{userId}/Items/{id}`: the gateway holds an
		// API key, not a user session, and the user-scoped route would force us to
		// pick somebody's account to impersonate.
		const page = await requestJson<Payload>(connection.baseUrl, '/Items', {
			headers: this._headers(connection),
			timeoutMs: connection.timeoutMs,
			query: { Ids: externalId, Recursive: true, Fields: ITEM_FIELDS },
		});

		const first = asRecordArray(page.Items)[0];

		return first ? this._toItem(connection, first) : null;
	}

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
		try {
			return await requestStream(
				connection.baseUrl,
				`/Items/${encodeURIComponent(item.externalId)}/Download`,
				{ headers: this._headers(connection), range, timeoutMs: connection.timeoutMs },
			);
		} catch {
			// `/Download` is refused when the server disables downloads, and absent on
			// older versions. The static stream route serves the original file
			// untouched, which is the same bytes by a longer name.
			return requestStream(
				connection.baseUrl,
				`/Videos/${encodeURIComponent(item.externalId)}/stream`,
				{
					headers: this._headers(connection),
					query: { static: true },
					range,
					timeoutMs: connection.timeoutMs,
				},
			);
		}
	}

	public async getDownloadUrl(
		connection: ServiceConnection,
		item: MediaItemRef,
	): Promise<string | null> {
		if (!connection.token) {
			return null;
		}

		// The token travels in the query here on purpose: this URL exists to be handed
		// to something that cannot set headers. It is only ever given to a peer we
		// already trust with the file itself.
		return buildUrl(
			connection.baseUrl,
			`/Items/${encodeURIComponent(item.externalId)}/Download`,
			{ api_key: connection.token },
		);
	}

	private _headers(connection: ServiceConnection): Record<string, string> {
		const authorization = [
			`Client="${CLIENT_NAME}"`,
			`Device="${CLIENT_NAME}"`,
			`DeviceId="${connection.id}"`,
			`Version="${CLIENT_VERSION}"`,
			...(connection.token ? [`Token="${connection.token}"`] : []),
		].join(', ');

		const headers: Record<string, string> = {
			Authorization: `MediaBrowser ${authorization}`,
		};

		if (connection.token) {
			// Both spellings, because which one a given Jellyfin version honours has
			// changed more than once and sending both has never hurt.
			headers['X-Emby-Token'] = connection.token;
			headers['X-MediaBrowser-Token'] = connection.token;
		}

		return headers;
	}

	private _locations(folder: Payload): string[] {
		const locations = firstOf(folder, 'Locations', 'LibraryOptions');

		if (Array.isArray(locations)) {
			return locations.map((entry) => asString(entry)).filter((entry): entry is string => !!entry);
		}

		// Newer versions nest the paths under `LibraryOptions.PathInfos`, each with a
		// `Path` and the network path the server advertises.
		return asRecordArray(pick(folder, 'LibraryOptions', 'PathInfos'))
			.map((info) => asString(info.Path))
			.filter((path): path is string => !!path);
	}

	private _includeTypes(library: NormalisedLibrary, kinds?: MediaKind[]): string {
		if (kinds && kinds.length > 0) {
			return kinds.map((kind) => JELLYFIN_TYPE_BY_KIND[kind]).join(',');
		}

		// Asking for the kinds the library cannot hold wastes nothing, but asking for
		// episodes in a film library makes Jellyfin walk a tree that is not there.
		if (library.kind === LibraryKind.MOVIES) {
			return 'Movie,BoxSet';
		}

		if (library.kind === LibraryKind.SHOWS) {
			return 'Series,Season,Episode';
		}

		return 'Movie,Series,Season,Episode,BoxSet';
	}

	private _toItem(connection: ServiceConnection, raw: Payload): NormalisedMediaItem | null {
		const externalId = asString(raw.Id);
		const kind = KIND_BY_JELLYFIN_TYPE[asString(raw.Type) ?? ''];

		// An item of a type we do not model — a photo, a playlist, a music video — is
		// skipped rather than mapped to something close, which would put it in a
		// browsing tree where it makes no sense.
		if (!externalId || !kind) {
			return null;
		}

		const file = this._toFile(raw);
		const path = file?.path ?? asString(raw.Path);
		const title = asString(raw.Name) ?? (path ? parseTitle(path).title : externalId);
		const fromPath = path ? parseTitle(path) : null;

		/*
		 * The normalised form of a season or an episode is the SHOW's title, never its
		 * own.
		 *
		 * Correlation joins on normalised title plus season plus episode number, so an
		 * episode carrying its own name matches nothing: `the meadow` here against
		 * `episode 1` on the other server, for the same episode of the same show. The
		 * display title stays what it is — people read episode names — but the form
		 * used for comparison has to identify the show, because that is what the two
		 * libraries can be expected to agree on.
		 */
		const showTitle =
			kind === MediaKind.EPISODE || kind === MediaKind.SEASON
				? (asString(raw.SeriesName) ?? fromPath?.title ?? title)
				: title;

		return {
			externalId,
			// An episode belongs to its season, a season to its series; `ParentId` says
			// so too, but only on the items Jellyfin bothered to fill it on.
			parentExternalId:
				asString(firstOf(raw, 'SeasonId', 'SeriesId', 'ParentId')) ?? null,
			kind,
			title,
			normalizedTitle: normalizeTitle(showTitle),
			year: asNumber(raw.ProductionYear) ?? fromPath?.year ?? null,
			// `ParentIndexNumber` is the season of an episode and `IndexNumber` its
			// number. Both are missing often enough on badly named files that the path
			// is worth consulting as a fallback.
			seasonNumber:
				asNumber(kind === MediaKind.SEASON ? raw.IndexNumber : raw.ParentIndexNumber) ??
				fromPath?.seasonNumber ??
				null,
			episodeNumber:
				(kind === MediaKind.EPISODE ? asNumber(raw.IndexNumber) : null) ??
				(kind === MediaKind.EPISODE ? (fromPath?.episodeNumber ?? null) : null),
			externalIds: this._toExternalIds(raw, externalId),
			overview: asString(raw.Overview),
			artworkUrl: pick(raw, 'ImageTags', 'Primary')
				? buildUrl(connection.baseUrl, `/Items/${externalId}/Images/Primary`)
				: null,
			file,
			addedAt: asString(raw.DateCreated),
		};
	}

	private _toExternalIds(raw: Payload, externalId: string) {
		const providers = asRecord(raw.ProviderIds);

		// Casing of these keys has changed between releases and differs between the
		// metadata plugins, and a missed provider identifier costs the most reliable
		// correlation strategy there is.
		return {
			tvdb: asString(firstOf(providers, 'Tvdb', 'tvdb', 'TVDB')) ?? undefined,
			tmdb: asString(firstOf(providers, 'Tmdb', 'tmdb', 'TMDB')) ?? undefined,
			imdb: asString(firstOf(providers, 'Imdb', 'imdb', 'IMDB')) ?? undefined,
			musicbrainz:
				asString(
					firstOf(providers, 'MusicBrainzTrack', 'MusicBrainzAlbum', 'MusicBrainzArtist'),
				) ?? undefined,
			provider: externalId,
		};
	}

	private _toFile(raw: Payload): MediaFileInfo | null {
		const source = asRecordArray(raw.MediaSources)[0];
		const path = asString(source?.Path) ?? asString(raw.Path);

		// No path means nothing can ever be pulled from it: a series node, a
		// collection, or an item Jellyfin has not analysed. That is a null file, not
		// an empty one, and the difference drives the whole browsing tree.
		if (!path) {
			return null;
		}

		/*
		 * A series and a season have a path too — their directory — and Jellyfin
		 * returns it exactly like a file's.
		 *
		 * Taking it produced a file with a path, no codec, no dimensions and a size of
		 * zero, which is worse than none: the quality summary counts files, so every
		 * series and every season contributed a phantom variant, and a season whose
		 * episodes all shared one encoding came out `mixed`. Nothing failed, and the
		 * chip simply lied. `IsFolder` is on every item Jellyfin returns, and a
		 * playable item always carries a media source.
		 */
		if (raw.IsFolder === true || !source) {
			return null;
		}

		const streams = asRecordArray(source?.MediaStreams);
		const video = streams.find((stream) => asString(stream.Type) === 'Video');
		const audio = streams.find((stream) => asString(stream.Type) === 'Audio');
		const ticks = asNumber(firstOf(source ?? {}, 'RunTimeTicks')) ?? asNumber(raw.RunTimeTicks);

		return {
			path,
			size: asNumber(source?.Size) ?? 0,
			container: asString(source?.Container),
			videoCodec: asString(video?.Codec),
			audioCodec: asString(audio?.Codec),
			width: asNumber(video?.Width),
			height: asNumber(video?.Height),
			// Jellyfin counts in ticks of 100 nanoseconds, which is ten thousand to
			// the millisecond.
			durationMs: ticks === null ? null : Math.round(ticks / 10_000),
			bitrate: asNumber(source?.Bitrate) ?? asNumber(video?.BitRate),
			// The three identity fields are ours to compute, never the service's: a
			// remote Jellyfin has no idea what our fingerprinting considers a file.
			quickHash: null,
			contentId: null,
			checksum: null,
		};
	}
}
