import type { Readable } from 'node:stream';
import type {
	ExternalIds,
	LibraryKind,
	MediaFileInfo,
	MediaKind,
	MediaServiceProbe,
	MediaServiceType,
	ServerStructure,
	ServerStructureRequest,
} from '@mcs/shared';

/**
 * Everything a handler needs to reach one registered service.
 *
 * The handlers are deliberately stateless: they are singletons shared by every
 * service of their type, and the connection travels as an argument. A gateway that
 * holds three Jellyfins has one Jellyfin handler, not three, and nothing in a
 * handler may remember which one it last talked to.
 */
export interface ServiceConnection {
	/** Identifier of the registered service, only used to label errors and sources. */
	id: string;
	type: MediaServiceType;
	baseUrl: string;
	token: string | null;
	username: string | null;
	password: string | null;
	/** Overrides the handler default. A service behind a slow link needs more. */
	timeoutMs?: number;
}

/** A library as the service describes it, before the gateway maps it to a local path. */
export interface NormalisedLibrary {
	externalId: string;
	name: string;
	kind: LibraryKind;
	/**
	 * Paths as the service reports them, which are the service's own — not ours.
	 * Mapping them onto something the gateway can write to is the library manager's
	 * problem, and it is why `Library.localPath` exists separately.
	 */
	paths: string[];
}

/**
 * One item as a handler produces it.
 *
 * This is the shape the indexing layer persists; it carries no gateway identifier
 * because a handler has no idea what we already store. Parents are referenced by
 * their identifier inside the service, and resolved to our own rows afterwards.
 */
export interface NormalisedMediaItem {
	externalId: string;
	parentExternalId: string | null;
	kind: MediaKind;
	title: string;
	/** Already reduced by the title normaliser, so every handler agrees on the form. */
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	externalIds: ExternalIds;
	overview: string | null;
	artworkUrl: string | null;
	/** Null for a node that holds no file of its own — a series, a season. */
	file: MediaFileInfo | null;
	addedAt: string | null;
}

/**
 * Who the far end says somebody is, when that service authenticates our users.
 *
 * The gateway does not want to be one more password to remember, so a sign-in is
 * forwarded to a media service the person already has an account on. What comes
 * back is an identity, never a right: the role is ours to decide.
 */
export interface ExternalIdentity {
	externalUserId: string;
	username: string;
	displayName: string | null;
	email: string | null;
	avatarUrl: string | null;
	/** Session token the service handed back, when it hands one back. */
	token: string | null;
}

export interface LibraryScanOptions {
	/** Restrict the scan. Left empty, the handler yields everything it understands. */
	kinds?: MediaKind[];
	/** How many rows a page asks for. Handlers clamp it to what the API tolerates. */
	pageSize?: number;
	signal?: AbortSignal;
}

/**
 * What an incremental refresh found, and where to resume from.
 *
 * The cursor is opaque on purpose: Jellyfin counts in save dates, Plex in epoch
 * seconds, and the next handler will count in something else again. Only the
 * handler that produced a cursor ever reads it back.
 */
export interface LibraryRefresh {
	items: NormalisedMediaItem[];
	cursor: string | null;
}

/**
 * What came of asking a service to re-read a library.
 *
 * Three answers and not a boolean, because the three lead somewhere different. A
 * library was asked, so the file should appear within a scan; the whole server was
 * asked because the library could not be addressed, which is coarser and slower but
 * still an answer; or the service cannot be asked at all, and the only thing left is
 * to wait for whatever it does on its own. The last one is a legitimate answer and
 * never an error — a handler that had to throw would make "this kind of server has no
 * refresh endpoint" indistinguishable from "the server is down".
 */
export enum RescanOutcome {
	/** That one library was asked to re-read itself. */
	LIBRARY = 'library',
	/** The library could not be addressed, so the whole server was asked. */
	SERVER = 'server',
	/** This service cannot be told to scan. Waiting is the only option. */
	UNSUPPORTED = 'unsupported',
}

/** Half-open byte range, inclusive on both ends like HTTP says. */
export interface ByteRange {
	start: number;
	end: number;
}

/**
 * A byte source opened against a service.
 *
 * `acceptsRanges` is load-bearing rather than informational: a source that ignores
 * `Range` cannot be resumed, so a transfer against it has to fall back to a single
 * connection and say so, instead of silently writing the whole file into the slot
 * meant for its first chunk.
 */
export interface MediaStream {
	stream: Readable;
	/** Length of this response, not of the file, when a range was asked for. */
	contentLength: number | null;
	/** Total size of the file when the server told us, through `Content-Range`. */
	totalLength: number | null;
	acceptsRanges: boolean;
	contentType: string | null;
}

/** Minimal reference to an item, so both an entity and a scan result fit. */
export interface MediaItemRef {
	externalId: string;
	file?: MediaFileInfo | null;
}

/**
 * The contract every media service speaks through.
 *
 * Adding Emby, Kodi or a plain HTTP index means writing one class implementing this
 * and decorating it with `@MediaHandler`; nothing else in the application knows the
 * difference. Which is also the constraint: anything a handler cannot express here
 * has to be expressed as a degraded answer, never as a special case leaking upwards.
 */
export interface MediaServiceHandler {
	readonly type: MediaServiceType;

	/**
	 * Reachability, authentication and shape, in one round trip when possible.
	 *
	 * A probe never throws for a service that answers badly — an unreachable server
	 * and a wrong token are both ordinary answers the settings screen renders, and
	 * turning them into exceptions only moves the mapping somewhere less convenient.
	 */
	probe(connection: ServiceConnection): Promise<MediaServiceProbe>;

	/** Used when this service is the gateway's authentication provider. */
	authenticate(
		connection: ServiceConnection,
		username: string,
		password: string,
	): Promise<ExternalIdentity>;

	listLibraries(connection: ServiceConnection): Promise<NormalisedLibrary[]>;

	/**
	 * Where this service says its own files are.
	 *
	 * The whole reason a directory picker exists is that a local path typed by hand
	 * may not designate the directory the media server actually reads — and when it
	 * does not, transfers land somewhere the server never scans and nothing anywhere
	 * reports an error. Browsing this gateway's disk is guessing at the answer; the
	 * server already knows it. Jellyfin returns a `Path` per library and can list a
	 * directory; Plex returns a `Location` per section. So the server is asked, and
	 * what it says is the authoritative half of the mapping somebody is configuring.
	 *
	 * On the interface rather than on the handlers that happen to have an endpoint for
	 * it, for the reason `requestRescan` is: a capability only Jellyfin had would have
	 * to be reached through a test on the service type somewhere above, and that test
	 * is the leak this project is built to avoid. Every handler answers, and
	 * `ServerStructureSupport.UNSUPPORTED` is a real answer rather than a gap — a peer
	 * gives it always, because the disk is somebody else's and their paths mean
	 * nothing here.
	 *
	 * With no `path`, it names the library roots as the server declares them, which is
	 * all the picker needs. With one, it walks into that directory, which is what lets
	 * somebody point at the shelf inside a root and what lets `LibraryManager.check()`
	 * ask whether the server can see a file the gateway has just written.
	 *
	 * It throws for a server that is down, exactly like every other call here, and
	 * answers `UNSUPPORTED` for a server that simply has no way to say. Folding the
	 * two together would make "this kind of server cannot tell us" indistinguishable
	 * from "your Jellyfin is asleep", and those are fixed in very different places.
	 */
	listServerDirectories(
		connection: ServiceConnection,
		request?: ServerStructureRequest,
	): Promise<ServerStructure>;

	/**
	 * Full scan, page by page.
	 *
	 * An async iterable rather than an array because a library of forty thousand
	 * episodes must not be held in memory at once, and because the caller wants to
	 * report progress and be cancellable between pages.
	 */
	scanLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		options?: LibraryScanOptions,
	): AsyncIterable<NormalisedMediaItem>;

	/**
	 * Only what changed since the cursor, plus the new cursor.
	 *
	 * This is the path that runs every few minutes, and the reason the interface can
	 * stay fast: it reads the gateway's own index, never a media service, and that
	 * index is kept current by asking each service for its own short list of recent
	 * changes instead of re-reading everything.
	 */
	refreshLibrary(
		connection: ServiceConnection,
		library: NormalisedLibrary,
		cursor: string | null,
	): Promise<LibraryRefresh>;

	/**
	 * Ask the service to re-read a library, because we have just put a file in it.
	 *
	 * On the interface rather than on the two handlers that happen to have an endpoint
	 * for it, and that is the rule this project is built on: a service type is added by
	 * writing one class, and nothing else changes. A refresh that only Jellyfin could
	 * perform would have to be reached through a test on the service type somewhere
	 * above, which is the leak. So every handler answers, and `UNSUPPORTED` is a real
	 * answer — the gateway simply waits longer, which it is already able to do.
	 *
	 * Per library where the service can address one, because a household library is
	 * measured in tens of thousands of files and a full-server scan to notice one new
	 * episode is a cost the media server pays for minutes.
	 *
	 * It reports rather than throws for the same reason `probe` does: a server that is
	 * asleep is an ordinary thing for this call to meet, and the landing it was asked
	 * about is recorded either way.
	 */
	/**
	 * Ask the server for the metadata and the artwork of one item it already knows.
	 *
	 * The precise half of `requestRescan`. A file that has just been indexed is a row
	 * carrying a name and nothing else, because a scan looks at the disk and not at the
	 * metadata providers — and the one moment anybody would have asked for the rest has
	 * gone by. This asks, for that item and no other.
	 *
	 * False when the server has nothing of the kind, which is an answer and not a failure:
	 * Plex fetches metadata itself the moment it identifies a new item, so there is
	 * nothing to ask it for. Asking a whole library instead of one item is what this
	 * exists to avoid — recursive over thirty thousand rows it is hours of provider
	 * traffic, restarted by every file that lands.
	 */
	refreshItem(connection: ServiceConnection, externalId: string): Promise<boolean>;

	requestRescan(
		connection: ServiceConnection,
		library: NormalisedLibrary | null,
	): Promise<RescanOutcome>;

	/** Null when the service no longer holds it — which is an answer, not a failure. */
	getItem(
		connection: ServiceConnection,
		externalId: string,
	): Promise<NormalisedMediaItem | null>;

	/**
	 * The artwork behind `NormalisedMediaItem.artworkUrl`.
	 *
	 * It is a method rather than a URL the caller fetches because only the handler
	 * knows how that service wants to be asked. Jellyfin serves images to anyone;
	 * Plex answers `401` without `X-Plex-Token`, and a poster that is simply missing
	 * for one service and present for another looks like a broken image tag rather
	 * than a missing credential.
	 *
	 * The gateway proxies and caches what comes back — a browser `<img>` carries no
	 * `Authorization` header, so linking straight to the service cannot work either.
	 */
	openArtwork(connection: ServiceConnection, item: MediaItemRef & { artworkUrl: string }): Promise<MediaStream>;

	/** The bytes a transfer pulls. A missing range means the whole file. */
	openStream(
		connection: ServiceConnection,
		item: MediaItemRef,
		range?: ByteRange,
	): Promise<MediaStream>;

	/**
	 * A URL a third party could fetch directly, when the service can mint one.
	 *
	 * Null is the normal answer for a service that only serves authenticated
	 * requests; callers fall back to `openStream` rather than treating it as an error.
	 */
	getDownloadUrl(connection: ServiceConnection, item: MediaItemRef): Promise<string | null>;
}
