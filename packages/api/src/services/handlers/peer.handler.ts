import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaServiceType,
	PeerCapability,
	ServerStructureSupport,
	type CatalogueEntry,
	type ExternalIds,
	type MediaFileInfo,
	type MediaServiceProbe,
	type ServerStructure,
} from '@mcs/shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PeerCatalogueService } from '../peer-catalogue.service';
import { PeerLinkService } from '../peer-link.service';
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
 * How a peer-backed service carries the peer it belongs to.
 *
 * `ServiceConnection` has fields for a URL and credentials and no field for a peer,
 * and the one place that builds it for an indexing pass is `ServiceManager`, which
 * knows nothing about peers and should not. Rather than widen the interface for one
 * implementation — or have a handler read the database, which no handler does — the
 * peer identifier travels where the address of a service already travels. It is a
 * real address in the only sense that matters here: it is what this handler dials.
 */
export const PEER_URL_SCHEME = 'peer://';

/** The address to register a peer-backed service under. */
export const peerBaseUrl = (peerId: string): string => `${PEER_URL_SCHEME}${peerId}`;

/**
 * The one library a peer gets when it cannot enumerate its own.
 *
 * A gateway from before `catalogue.libraries` existed advertises a catalogue and
 * answers "not supported" to the library listing, and its rows carry no library
 * handle. Everything downstream is expressed per library — categories, sync scopes,
 * missing counts — so those rows need a library to live in, and one named bag is an
 * honest description of what that peer told us.
 */
export const PEER_FALLBACK_LIBRARY = 'shared';

const LIBRARY_KINDS = new Set<string>(Object.values(LibraryKind));
const MEDIA_KINDS = new Set<string>(Object.values(MediaKind));

/** The identifier providers both sides agree to correlate on. */
const PROVIDER_KEYS = ['tvdb', 'tmdb', 'imdb', 'musicbrainz'] as const;

/**
 * Another gateway, as a media service.
 *
 * This is the whole claim tested: a peer is a Jellyfin with an introduction service
 * bolted on. It has libraries, it holds items, it serves ranges — so it is reached
 * through the same interface as everything else, and indexing, correlation,
 * categories, quality summaries, sync plans and transfers work on a friend's media
 * without knowing a peer exists.
 *
 * Two things it is not, and both are refused loudly rather than faked. It is not an
 * account system, so `authenticate` has no meaning. And it is never somewhere files
 * can be written: the bytes are on somebody else's disk, which is why a peer-backed
 * service is registered as remote and why it reports no paths for its libraries.
 *
 * Everything it knows travels over an already established link. This handler opens
 * nothing: if there is no link, the honest answer is that the service is offline,
 * exactly as it is for a Jellyfin that stopped answering.
 */
@Injectable()
@MediaHandler(MediaServiceType.PEER)
export class PeerHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.PEER;

	public constructor(
		private readonly _links: PeerLinkService,
		private readonly _catalogue: PeerCatalogueService,
	) {}

	public async probe(connection: ServiceConnection): Promise<MediaServiceProbe> {
		const empty: MediaServiceProbe = {
			reachable: false,
			authenticated: false,
			type: MediaServiceType.PEER,
			version: null,
			serverName: null,
			libraries: [],
			error: null,
		};
		const peerId = this._peerIdOf(connection);

		if (peerId === null) {
			return { ...empty, error: ErrorKey.SERVICE_NOT_FOUND };
		}

		if (!this._links.isLinked(peerId)) {
			// Not reachable and not authenticated, which for a peer are one fact: the
			// link proved who they are when it was opened, so there is no state where we
			// are connected and unauthorised.
			return { ...empty, error: ErrorKey.PEER_UNREACHABLE };
		}

		const libraries = await this.listLibraries(connection).catch(() => []);

		return {
			...empty,
			reachable: true,
			authenticated: true,
			// The negotiated protocol, which is the only version a peer has. Their
			// release number never crosses the wire and inventing one would put a
			// number on screen that matches nothing on their machine.
			version: this._versionOf(peerId),
			serverName: null,
			libraries: libraries.map((library) => ({
				externalId: library.externalId,
				name: library.name,
				kind: library.kind,
				paths: library.paths,
			})),
		};
	}

	/**
	 * A peer cannot sign anybody in, and saying so is the point.
	 *
	 * The alternative — an empty identity, or the generic "provider unreachable" —
	 * would let somebody set a friend's gateway as this gateway's authentication
	 * provider and find out at the sign-in screen, where the only thing on offer is
	 * "wrong credentials" for a password that was never wrong.
	 */
	public authenticate(): Promise<ExternalIdentity> {
		throw new BadRequestException({ key: ErrorKey.SERVICE_AUTH_UNSUPPORTED });
	}

	public async listLibraries(connection: ServiceConnection): Promise<NormalisedLibrary[]> {
		const peerId = this._requirePeerId(connection);
		const shared = await this._catalogue.fetchLibraries(peerId);

		if (shared.length > 0) {
			return shared.map((library) => ({
				externalId: library.externalId,
				name: library.name,
				kind: LIBRARY_KINDS.has(library.kind)
					? (library.kind as LibraryKind)
					: LibraryKind.OTHER,
				// Their paths are on their disk. Reporting any would offer this gateway a
				// local path for somebody else's files, and a library with one is a
				// library a transfer can be told to write into.
				paths: [],
			}));
		}

		// An empty answer from a peer that advertises the capability is the truth —
		// they share nothing — and inventing a library for them would show a friend
		// with one empty library where they meant to show nothing at all.
		if (this._links.supports(peerId, PeerCapability.LIBRARIES)) {
			return [];
		}

		return [
			{
				externalId: PEER_FALLBACK_LIBRARY,
				name: 'Shared',
				kind: LibraryKind.OTHER,
				paths: [],
			},
		];
	}

	/**
	 * A peer is never asked where its files are, and this is not a gap.
	 *
	 * The question the whole capability answers is "which directory on *this* disk is
	 * the one the media server reads", so that a local path can be mapped onto it. A
	 * peer has no such directory: the bytes are on somebody else's machine, their
	 * paths designate nothing here, and a path of theirs offered as a candidate would
	 * be written into a local path field and accepted — producing exactly the silent
	 * failure this feature exists to catch, with the gateway's own interface as the
	 * source of the bad value.
	 *
	 * Answered without touching the link at all. The far end is not asked and cannot
	 * be: the refusal is a property of what a peer *is*, so it must not depend on
	 * whether they happen to be connected, and no round trip is spent finding out
	 * something that is already known here.
	 */
	public listServerDirectories(): Promise<ServerStructure> {
		return Promise.resolve({
			support: ServerStructureSupport.UNSUPPORTED,
			path: null,
			parent: null,
			entries: [],
		});
	}

	/**
	 * Their catalogue, one library at a time.
	 *
	 * The whole page walk happens before the first item is yielded, which is the one
	 * place this handler differs in shape from an HTTP one: a page is a request and an
	 * answer over a single socket, not a cursor that can be held open, and the rows
	 * have to be in hand anyway to resolve an episode to the series it belongs to.
	 * Catalogues are metadata for what somebody shares, so the memory is a few
	 * thousand small objects rather than a library of forty thousand files.
	 */
	public async *scanLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		options: LibraryScanOptions = {},
	): AsyncIterable<NormalisedMediaItem> {
		const peerId = this._requirePeerId(connection);
		const entries = await this._catalogue.fetchCatalogue(peerId, {
			libraryId: this._libraryFilter(library),
		});
		const wanted = options.kinds === undefined ? null : new Set<string>(options.kinds);
		const titles = this._titles(entries);

		for (const entry of entries) {
			// Checked between rows rather than between pages: the pages are already in
			// hand by the time the first item is yielded, so this is the only place left
			// where a cancelled scan can stop early.
			if (options.signal?.aborted === true) {
				return;
			}

			const item = this._toItem(entry, titles);

			if (item !== null && (wanted === null || wanted.has(item.kind))) {
				yield item;
			}
		}
	}

	/**
	 * What changed on their side since we last asked.
	 *
	 * The cursor is a stamp of ours rather than theirs, because `catalogue.list`
	 * filters on the moment a row was last written on their gateway and both ends
	 * already have to tolerate the two clocks disagreeing. It is written after the
	 * answer comes back, so a refresh that failed halfway leaves the cursor where it
	 * was and the next one asks for the same window again.
	 */
	public async refreshLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		cursor: string | null,
	): Promise<LibraryRefresh> {
		const peerId = this._requirePeerId(connection);
		const entries = await this._catalogue.fetchCatalogue(peerId, {
			libraryId: this._libraryFilter(library),
			since: cursor,
		});
		const titles = this._titles(entries);
		const items: NormalisedMediaItem[] = [];

		for (const entry of entries) {
			const item = this._toItem(entry, titles);

			if (item !== null) {
				items.push(item);
			}
		}

		return { items, cursor: new Date().toISOString() };
	}

	/**
	 * A friend's gateway is not ours to send scanning.
	 *
	 * The refusal is the point rather than a gap waiting to be filled. This handler
	 * only ever reaches media somebody else holds, so there is no case where we have
	 * just put a file on the far end's disk and need it noticed — and a call that made
	 * a friend's server re-read a library on our say-so is a thing to be asked for, not
	 * a side effect of our own download.
	 *
	 * `UNSUPPORTED` rather than an exception, because an exception would be
	 * indistinguishable from the link being down, and the caller's answer to those two
	 * is different: one is a permanent property of this service type and the other is
	 * worth retrying.
	 */
	public async requestRescan(): Promise<RescanOutcome> {
		return RescanOutcome.UNSUPPORTED;
	}

	/**
	 * One row, asked for by their identifier.
	 *
	 * The series a lone episode belongs to cannot be resolved here — only the row that
	 * was asked for comes back — so its normalised title falls back to its own. That
	 * costs nothing in practice: this path answers "do you still hold it", and the
	 * title correlation was settled by the scan that had the whole library in hand.
	 */
	public async getItem(
		connection: ServiceConnection,
		externalId: string,
	): Promise<NormalisedMediaItem | null> {
		const peerId = this._requirePeerId(connection);

		const answer = await this._links
			.request<{ entry?: CatalogueEntry }>(peerId, 'media.describe', {
				serviceId: connection.id,
				externalId,
			})
			.catch((error: unknown) => {
				// A peer that answers "not found" no longer holds it, which is an answer
				// the revalidation table acts on. Anything else is a failure and has to
				// stay one, or a flaky link reads as a deleted file.
				if (error instanceof NotFoundException) {
					return null;
				}

				throw error;
			});

		return answer?.entry ? this._toItem(answer.entry, new Map()) : null;
	}

	/**
	 * Peers publish no artwork, and this says so rather than serving a blank.
	 *
	 * The catalogue carries no image: a poster is metadata a media server holds, the
	 * far end would have to proxy it, and nobody asked for the right to make a friend's
	 * gateway serve images. Peer items therefore carry a null `artworkUrl`, so nothing
	 * reaches this — and if something ever does, a missing poster is the truth.
	 */
	public openArtwork(): Promise<MediaStream> {
		throw new NotFoundException({ key: ErrorKey.SERVICE_RESOURCE_NOT_FOUND });
	}

	public async openStream(
		connection: ServiceConnection,
		item: MediaItemRef,
		range?: ByteRange,
	): Promise<MediaStream> {
		const peerId = this._requirePeerId(connection);
		const stream = await this._links.openStream(peerId, 'media.range', {
			serviceId: connection.id,
			externalId: item.externalId,
			contentId: item.file?.contentId ?? null,
			// Omitted rather than sent as nulls when no range was asked for: the far end
			// reads a malformed range as no range and serves the whole file, and sending
			// one relies on that rather than saying it.
			...(range === undefined ? {} : { start: range.start, end: range.end }),
		});
		const total = item.file?.size ?? null;

		return {
			stream,
			contentLength: range === undefined ? total : range.end - range.start + 1,
			totalLength: total,
			// Always: the far end is this application, and serving ranges is in the
			// floor of the protocol rather than in a capability.
			acceptsRanges: true,
			contentType: null,
		};
	}

	/**
	 * Nothing a third party could fetch, ever.
	 *
	 * The bytes only exist behind an authenticated link this gateway holds, and there
	 * is no URL that would survive leaving it. Null is the interface's answer for that
	 * and the callers already fall back to `openStream`.
	 */
	public async getDownloadUrl(): Promise<string | null> {
		return null;
	}

	/** Null for the bag a peer that cannot enumerate its libraries gets. */
	private _libraryFilter(library: NormalisedLibrary): string | null {
		return library.externalId === PEER_FALLBACK_LIBRARY ? null : library.externalId;
	}

	private _versionOf(peerId: string): string | null {
		const protocol = this._links.protocolOf(peerId);

		return protocol === null ? null : `protocol ${protocol}`;
	}

	/**
	 * Every row's own title, so a child can be given its series'.
	 *
	 * Correlation joins on normalised title plus season plus episode number, and an
	 * episode carrying its own name matches nothing: `the meadow` here against
	 * `episode 1` there, for the same episode of the same show. The catalogue names no
	 * series on an episode row, but it does carry the parent, and a walk up the chain
	 * is what the other handlers get from a `SeriesName` field.
	 */
	private _titles(entries: CatalogueEntry[]): Map<string, CatalogueEntry> {
		return new Map(entries.map((entry) => [entry.externalId, entry]));
	}

	private _showTitle(entry: CatalogueEntry, titles: Map<string, CatalogueEntry>): string {
		let current = entry;

		// Bounded rather than looped until the root: a far end that answers with a cycle
		// — by accident or otherwise — must not hang a scan. Three hops cover episode to
		// season to series with one to spare.
		for (let hop = 0; hop < 3; hop += 1) {
			const parent = current.parentExternalId
				? titles.get(current.parentExternalId)
				: undefined;

			if (parent === undefined || parent.externalId === current.externalId) {
				break;
			}

			current = parent;
		}

		return current.title;
	}

	private _toItem(
		entry: CatalogueEntry,
		titles: Map<string, CatalogueEntry>,
	): NormalisedMediaItem | null {
		const kind = MEDIA_KINDS.has(entry.kind) ? (entry.kind as MediaKind) : null;

		// A kind we do not model is skipped rather than mapped to something close, which
		// would file it in a browsing tree where it makes no sense. A newer peer sending
		// a kind this release has never heard of is the normal way that happens.
		if (kind === null || typeof entry.externalId !== 'string' || entry.externalId === '') {
			return null;
		}

		const showTitle =
			kind === MediaKind.EPISODE || kind === MediaKind.SEASON
				? this._showTitle(entry, titles)
				: entry.title;

		return {
			externalId: entry.externalId,
			parentExternalId: entry.parentExternalId ?? null,
			kind,
			title: entry.title,
			normalizedTitle: normalizeTitle(showTitle),
			year: entry.year ?? null,
			seasonNumber: entry.seasonNumber ?? null,
			episodeNumber: entry.episodeNumber ?? null,
			externalIds: this._toExternalIds(entry),
			// Neither crosses the wire. A description and a poster are what a media
			// server holds about an item, and the catalogue is deliberately the thinner
			// thing: what is held, not how it is filed or illustrated.
			overview: null,
			artworkUrl: null,
			file: this._toFile(entry),
			// Their stamp for it is not published either, and taking the moment we first
			// saw it would put a friend's whole library at the top of "recently added"
			// on the day it was linked.
			addedAt: null,
		};
	}

	private _toExternalIds(entry: CatalogueEntry): ExternalIds {
		const published = entry.externalIds ?? {};
		const ids: ExternalIds = {
			// Their row identifier is what this gateway hands back to ask for bytes, so
			// it is exactly what `provider` means for every other handler: the identifier
			// inside the service that reported the item.
			provider: entry.externalId,
		};

		for (const key of PROVIDER_KEYS) {
			const value = published[key];

			if (typeof value === 'string' && value !== '') {
				ids[key] = value;
			}
		}

		return ids;
	}

	/**
	 * What a peer says about the file, which is a size and an identity and no more.
	 *
	 * The resolution is read back out of the quality label they published, and it is
	 * the only field here that is reconstructed rather than reported. It is worth the
	 * liberty: without a height the comparator ranks every copy a friend holds as
	 * unknown, which loses to anything at all — so a 2160p remux on the other side of
	 * the link would be passed over for a 480p copy of ours, silently, for want of a
	 * number nobody sends. A label that says `mixed`, or nothing recognisable, yields
	 * null and the copy stays unranked rather than being ranked wrongly.
	 */
	private _toFile(entry: CatalogueEntry): MediaFileInfo | null {
		// No size and no content identity means a node with no file of its own — a
		// series, a season — or a library shared as titles only. Both are a null file.
		if ((entry.size ?? 0) <= 0 && !entry.contentId) {
			return null;
		}

		const height = /\b(\d{3,4})p\b/.exec(entry.quality ?? '');

		return {
			// They never publish a path, and this gateway must never guess one: it is
			// the shape of somebody else's disk. The naming layer already treats an
			// empty source path as "a peer that only sent us metadata" and falls back to
			// the standard scheme.
			path: '',
			size: entry.size ?? 0,
			container: null,
			videoCodec: null,
			audioCodec: null,
			width: null,
			height: height === null ? null : Number(height[1]),
			durationMs: null,
			bitrate: null,
			// Ours to compute and never theirs to assert: a quick hash is a statement
			// about bytes this gateway has read.
			quickHash: null,
			contentId: entry.contentId ?? null,
			checksum: null,
		};
	}

	/** The peer behind a registered service, or null when the address names none. */
	private _peerIdOf(connection: ServiceConnection): string | null {
		if (!connection.baseUrl.startsWith(PEER_URL_SCHEME)) {
			return null;
		}

		const peerId = connection.baseUrl.slice(PEER_URL_SCHEME.length).replace(/\/+$/, '');

		return peerId === '' ? null : peerId;
	}

	private _requirePeerId(connection: ServiceConnection): string {
		const peerId = this._peerIdOf(connection);

		if (peerId === null) {
			// A peer-backed service whose address names no peer is a row nothing can
			// ever use, and a registration nobody types by hand cannot be corrected in
			// a form either. It is the service that is wrong, not the peer.
			throw new NotFoundException({ key: ErrorKey.SERVICE_NOT_FOUND });
		}

		return peerId;
	}
}
