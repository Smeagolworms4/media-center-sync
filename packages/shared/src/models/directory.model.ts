import type { MediaService, MediaServiceType } from './service.model';

/**
 * Finding media servers through the account service that knows them, instead of
 * asking somebody for an address.
 *
 * A Plex server is the case this exists for: nobody knows the address of their Plex,
 * and nobody should have to — they sign in to plex.tv and plex.tv says which servers
 * the account owns, which ones friends have shared with it, and every address each of
 * them can be reached at. The vocabulary here is generic on purpose, so that the next
 * account service with the same idea is one class on the API side and not a second
 * set of shapes.
 */

/**
 * How the gateway ended up reaching a server it found through a directory.
 *
 * Kept on the registration because the three are not equally good at the one thing
 * this gateway does most: moving whole files. A relay is carried through the account
 * service's own infrastructure and capped by it — acceptable for browsing a
 * catalogue, a crawl for pulling a film — and a service reached that way has to say
 * so on screen rather than let somebody wonder why a transfer takes all night.
 */
export enum ConnectionRoute {
	/** An address on the server's own network, as the directory reports it. */
	LOCAL = 'local',
	/** A direct address across the internet, usually the server's own HTTPS name. */
	REMOTE = 'remote',
	/** The account service's relay: it works, it is slow, and it is the last resort. */
	RELAY = 'relay',
}

/**
 * Where somebody stands in signing in to a directory.
 *
 * The gateway never sees the account's password: the person approves the request on
 * the directory's own page, and the gateway only ever learns that it was approved.
 */
export enum DirectorySignInState {
	/** Waiting for the person to approve on the directory's page. */
	PENDING = 'pending',
	/** Approved: the servers of that account can be listed. */
	APPROVED = 'approved',
	/** Nobody approved in time, or the directory forgot the request. Start again. */
	EXPIRED = 'expired',
}

/**
 * One sign-in in progress, as the interface sees it.
 *
 * What it deliberately does not carry is the account token the directory hands back
 * on approval: it stays on the gateway, and the only thing that crosses this boundary
 * is the fact that it exists.
 */
export interface DirectorySignIn {
	/** The gateway's own handle for this sign-in, meaningless to the directory. */
	id: string;
	type: MediaServiceType;
	state: DirectorySignInState;
	/** The directory's page where the person approves the request. */
	authUrl: string;
	/** The code that page shows, for somebody comparing it with what is on screen. */
	code: string;
	expiresAt: string;
}

/**
 * A server a directory knows for the signed-in account, as the add screen lists it.
 *
 * Reachability is measured, not reported: the directory's own `presence` flag says
 * whether the server last talked to it, which says nothing about whether this
 * gateway, on its network, can open a connection to any of the addresses listed.
 */
export interface DiscoveredServer {
	/** The server's permanent identity at its directory, whatever its address becomes. */
	identifier: string;
	name: string;
	/** True for the account's own servers, false for one a friend shared with it. */
	owned: boolean;
	/** Who shared it, for a server the account does not own. */
	ownerName: string | null;
	version: string | null;
	/** Whether any address answered as this server within the probe's deadline. */
	reachable: boolean;
	/** The best way in that answered, or null when none did. */
	route: ConnectionRoute | null;
	/** The address that answered, or null. */
	baseUrl: string | null;
	/**
	 * The service already registered for this server on this gateway, if any.
	 *
	 * Offered twice, the same server would be indexed twice, and every media it holds
	 * would appear to be available from two places that are one.
	 */
	registeredServiceId: string | null;
}

/** Register some of the servers a sign-in found. */
export interface RegisterDiscoveredRequest {
	/** Their identifiers, as `DiscoveredServer.identifier`. */
	identifiers: string[];
}

/** One server that could not be registered, and the key that says why. */
export interface DiscoveredFailure {
	identifier: string;
	name: string | null;
	error: string;
}

/**
 * What came of registering several servers at once.
 *
 * Not all-or-nothing: registering three servers where one has just gone offline must
 * still register the other two, and say by name which one did not come in and why.
 */
export interface RegisterDiscoveredResult {
	created: MediaService[];
	failed: DiscoveredFailure[];
}
