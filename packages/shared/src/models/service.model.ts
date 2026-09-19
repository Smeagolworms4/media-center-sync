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
	libraries: { externalId: string; name: string; kind: string; paths: string[] }[];
	/** Error key when the probe failed. */
	error: string | null;
}
