import type { LibraryKind } from './library.model';

/**
 * The kind of media service behind a registration.
 *
 * Each type is a handler on the API side. Adding one — Emby, Kodi, a plain HTTP
 * index — means writing a handler and declaring it; nothing else in the
 * application knows the difference.
 */
export enum MediaServiceType {
	JELLYFIN = 'jellyfin',
	PLEX = 'plex',
	/**
	 * Another gateway's shared libraries, reached over the peer link.
	 *
	 * A peer is a media service with an introduction service bolted on: it has
	 * libraries, it holds items, we can list it and pull from it. Saying so here is
	 * what lets indexing, correlation, categories, missing counts, quality summaries,
	 * sync plans and transfers work on a friend's media without a single line of
	 * their own — the alternative was a parallel path beside every one of those.
	 *
	 * It is the one type nobody registers by hand: linking a peer creates it and
	 * unlinking removes it, because its address is a fingerprint rather than a URL
	 * somebody could type.
	 */
	PEER = 'peer',
}

/**
 * The three kinds of thing this gateway talks to.
 *
 * Read, never declared. It used to be read off a field somebody chose in the
 * registration form, labelled "scope" with the values `local` and `remote` — which
 * every reader took for a statement about the network, because that is what those
 * words mean everywhere else. Somebody registering the Jellyfin sitting on their own
 * LAN answered `remote` for a distant service and `local` for a nearby one, and three
 * screens later found their libraries private and their server refused as a
 * destination, with nothing connecting either consequence to the word they had picked.
 * So the question is no longer asked: whether the files are reachable is a fact about
 * the mounts, and facts are derived.
 *
 * - a **peer** is another gateway running this application. It speaks our own
 *   protocol, so exchanges can be swarmed between several peers holding the same file,
 *   and what it shows us is what its owner chose to share.
 * - a **local** media server is one whose library folders this gateway can reach on
 *   disk. Pulled files land somewhere the media server will actually scan, which is
 *   the only arrangement where a sync finishes with it seeing the result.
 * - a **remote** media server is a Jellyfin or Plex we only talk to over HTTP —
 *   somebody else's, or our own before anybody has mapped its folders. We can read it
 *   and serve it on; we cannot write into it.
 *
 * Nothing stops a gateway holding several of each, and the useful arrangements mix
 * them: your own server, a friend's gateway, and a distant Jellyfin somebody gave you
 * an account on.
 */
export enum MediaServiceMode {
	PEER = 'peer',
	LOCAL = 'local',
	REMOTE = 'remote',
}

export enum MediaServiceStatus {
	UNKNOWN = 'unknown',
	ONLINE = 'online',
	OFFLINE = 'offline',
	UNAUTHORIZED = 'unauthorized',
}

export interface MediaService {
	id: string;
	name: string;
	type: MediaServiceType;
	/**
	 * Whether this service's libraries are offered to peers.
	 *
	 * The one thing about sharing somebody declares. It carries no visibility of its
	 * own: on means the gateway's `defaultShareVisibility` applies to every library
	 * here that nobody has overridden, off means private. Keeping it a switch rather
	 * than a level is what lets somebody change that setting later and have every
	 * library nobody touched move with it — a copy of today's value written onto each
	 * service would freeze the answer and quietly make the setting mean nothing.
	 *
	 * A per-library policy still wins in both directions, including an explicit
	 * private on a service that is shared.
	 */
	shared: boolean;
	/**
	 * Whether this gateway reaches this service's files on disk.
	 *
	 * Derived from the mounts and never declared — see `mode`. It is what decides
	 * whether the service can be a destination, and it is false for a perfectly
	 * healthy server we simply talk to over HTTP.
	 */
	filesMounted: boolean;
	baseUrl: string;
	status: MediaServiceStatus;
	/** Free-form version string reported by the service. */
	version: string | null;
	/**
	 * Which of the three kinds this is, derived from the mounts and the peer.
	 *
	 * Read-only, and deliberately not something the registration form asks: a service
	 * reached through a peer is a peer's, one whose folders we reach is local, and
	 * everything else is remote.
	 */
	mode: MediaServiceMode;
	/**
	 * The service's own root, and where that same directory is for us.
	 *
	 * Jellyfin says `/media/Shows/…` and this gateway sees `/mnt/nas/Shows/…`. Until
	 * now that had to be spelled out per library, so a server with six libraries was
	 * six paths to type and six chances to get one wrong — and a library whose two
	 * paths do not designate the same directory accepts transfers the media server
	 * will never see, with nothing anywhere reporting an error.
	 *
	 * Stated once here, every library under it derives its own. `remoteRoot` is the
	 * prefix as the service reports it, `localRoot` the same directory as we reach it;
	 * both are null when nobody has said, and a library's explicit `localPath` always
	 * wins over anything derived, because the exception is why that field exists.
	 *
	 * Setting this mapping is also what makes the service ours: `filesMounted` and
	 * therefore `mode` are re-derived the moment it lands, so a service registered
	 * before anybody mapped its folders becomes a destination without being
	 * re-registered.
	 */
	remoteRoot: string | null;
	localRoot: string | null;
	/** Set when this service also authenticates users of the gateway. */
	authProvider: boolean;
	/**
	 * Order in which this service is consulted when the same media is available
	 * from several. Lowest first. A sync can override it per run.
	 */
	priority: number;
	/** Owning peer, when the service is reached through a linked friend. */
	peerId: string | null;
	lastProbeAt: string | null;
	lastScanAt: string | null;
	libraryCount: number;
	itemCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface CreateMediaServiceRequest {
	name: string;
	type: MediaServiceType;
	/**
	 * Share this service's libraries. Omitted means yes.
	 *
	 * The same reasoning as `defaultShareVisibility` shipping as a real level rather
	 * than silence: a gateway that shares nothing until somebody has visited a second
	 * screen shows its friends an empty shelf, and they conclude the link failed.
	 * Linking a peer passes false explicitly — see `MediaServiceType.PEER`.
	 */
	shared?: boolean;
	baseUrl: string;
	/** API key or token. Write-only: it is never returned by the API. */
	token?: string;
	username?: string;
	password?: string;
	authProvider?: boolean;
	priority?: number;

	/** The service's own root, and the same directory as this gateway reaches it. */
	remoteRoot?: string | null;
	localRoot?: string | null;
}

export type UpdateMediaServiceRequest = Partial<CreateMediaServiceRequest>;

/**
 * Trying a connection before anything is written.
 *
 * Deliberately not `CreateMediaServiceRequest`. A probe answers one question — is
 * this server reachable with these credentials — and a name, a priority or a root
 * mapping say nothing about whether it answers. Sending the whole form made the
 * route refuse six fields by name, and the honest reading of that refusal is that
 * the caller was sending what the route does not handle.
 */
export interface ProbeMediaServiceRequest {
	type: MediaServiceType;
	baseUrl: string;
	token?: string;
	username?: string;
	password?: string;
}

/** Result of a connection probe, before or after registration. */
export interface MediaServiceProbe {
	reachable: boolean;
	authenticated: boolean;
	type: MediaServiceType | null;
	version: string | null;
	serverName: string | null;
	/**
	 * What the service says it holds, before anything is registered.
	 *
	 * `kind` is the same enum a registered library carries: losing it here would
	 * mean the form that shows a probe result and the screen that shows the saved
	 * library disagree about what a library is, for no reason beyond the boundary.
	 */
	libraries: { externalId: string; name: string; kind: LibraryKind; paths: string[] }[];
	/** Error key when the probe failed. */
	error: string | null;
}

/**
 * Whether a service was able to say where its own files are.
 *
 * Two values and not a boolean on the entries, because "this kind of server has no
 * way to tell us" and "this server holds nothing there" lead somewhere different: the
 * first means stop asking and let somebody type, the second means the directory is
 * really empty. The same reasoning as `RescanOutcome.UNSUPPORTED` on the API side —
 * a degraded answer, never an exception, or it becomes indistinguishable from a
 * server that is down.
 */
export enum ServerStructureSupport {
	/** The server answered with paths of its own. */
	REPORTED = 'reported',
	/** This service cannot say. A peer never can: the disk is somebody else's. */
	UNSUPPORTED = 'unsupported',
}

/**
 * One directory as the media server itself spells it.
 *
 * `path` is the server's own string and is never resolved, cleaned or joined here:
 * a Plex on Windows answers `D:\Media\Shows` and a gateway that tidied it into
 * something POSIX would hand back a path that matches nothing on the machine that
 * produced it.
 */
export interface ServerDirectory {
	path: string;
	/** Last segment, because a list of full paths is unreadable at three levels down. */
	name: string;
	/** True for a directory a library is declared on, false for one walked into. */
	root: boolean;
	/** The library the server declared this root for, when it declared one. */
	libraryExternalId: string | null;
	libraryName: string | null;
	/** False for a file, which only the path-match proof ever asks for. */
	directory: boolean;
}

/** What a service answers when asked to describe its own filesystem. */
export interface ServerStructure {
	support: ServerStructureSupport;
	/** The directory these entries are inside, null when they are the library roots. */
	path: string | null;
	/** The directory above, when there is one to walk back up to. */
	parent: string | null;
	entries: ServerDirectory[];
}

/** Which part of a server's filesystem to describe. */
export interface ServerStructureRequest {
	/** Restrict the roots to one library's, by the identifier the service gave it. */
	libraryExternalId?: string | null;
	/** Walk into this directory instead of listing the library roots. */
	path?: string | null;
	/**
	 * Also list files.
	 *
	 * The picker never wants them — a file is not a destination — and the one caller
	 * that does is the marker proof in `LibraryManager.check()`, which asks the server
	 * whether it can see a file the gateway has just written.
	 */
	includeFiles?: boolean;
}
