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
 * Where the service sits.
 *
 * LOCAL is a service whose files the gateway can write to: pulled media lands in
 * its libraries. REMOTE is a service we can only read from — somebody else's, or
 * one of ours we do not want to write into. There can be several of each.
 */
export enum MediaServiceScope {
	LOCAL = 'local',
	REMOTE = 'remote',
}

/**
 * The three kinds of thing this gateway talks to.
 *
 * Scope and peer are two fields and this is the one question people ask, so it is
 * named rather than left to be inferred. They are genuinely different, not shades of
 * one idea:
 *
 * - a **peer** is another gateway running this application. It speaks our own
 *   protocol, so exchanges can be swarmed between several peers holding the same file,
 *   and what it shows us is what its owner chose to share.
 * - a **local** media server is one whose library folders this gateway can write into.
 *   Pulled files land on a disk we can reach, which is the only arrangement where a
 *   sync finishes with the media server seeing the result.
 * - a **remote** media server is a plain Jellyfin or Plex we merely have an account
 *   on. We read from it and pull over HTTP; nothing about it knows this application
 *   exists.
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
	scope: MediaServiceScope;
	baseUrl: string;
	status: MediaServiceStatus;
	/** Free-form version string reported by the service. */
	version: string | null;
	/**
	 * Which of the three kinds this is, derived from the scope and the peer.
	 *
	 * Read-only: registering decides it. A service reached through a peer is a peer's
	 * whatever its scope says, because we cannot write into somebody else's disk.
	 */
	mode: MediaServiceMode;
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
	scope: MediaServiceScope;
	baseUrl: string;
	/** API key or token. Write-only: it is never returned by the API. */
	token?: string;
	username?: string;
	password?: string;
	authProvider?: boolean;
	priority?: number;
}

export type UpdateMediaServiceRequest = Partial<CreateMediaServiceRequest>;

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
