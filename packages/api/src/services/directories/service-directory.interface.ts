import type { ConnectionRoute, MediaServiceType } from '@mcs/shared';

/**
 * A sign-in request the directory has opened, waiting for somebody to approve it.
 *
 * `pinId` and `code` are the directory's, and they are what the gateway polls with.
 * The person never types either: they approve on `authUrl`, which carries the code.
 */
export interface DirectoryPin {
	pinId: string;
	code: string;
	authUrl: string;
	expiresAt: Date;
}

/**
 * Where a sign-in stands, as the directory answered it.
 *
 * Three answers rather than a token-or-null, because "not yet" and "never" lead
 * somewhere different: the first keeps the dialog waiting, the second tells the person
 * to start again, and folding them together is how a dialog ends up polling forever
 * for a request the directory threw away twenty minutes ago.
 */
export type DirectoryPinCheck =
	| { state: 'pending' }
	| { state: 'approved'; accountToken: string }
	| { state: 'expired' };

/** One address the directory lists for a server, with what it knows about it. */
export interface DirectoryConnection {
	uri: string;
	/** On the server's own network, as the server reported it to the directory. */
	local: boolean;
	/** Carried by the directory's relay. */
	relay: boolean;
	/** `http` or `https`. */
	protocol: string;
}

/**
 * A server the directory knows for one account.
 *
 * `accessToken` is the server's own token for this account, distinct from the account
 * token: it is what a friend's server accepts from us, and all it opens is that server.
 */
export interface DirectoryServer {
	identifier: string;
	name: string;
	owned: boolean;
	ownerName: string | null;
	version: string | null;
	accessToken: string | null;
	connections: DirectoryConnection[];
}

/** The address that answered as the server, and which kind of address it was. */
export interface ResolvedConnection {
	baseUrl: string;
	route: ConnectionRoute;
}

/**
 * An account service that knows where media servers are: plex.tv, for Plex.
 *
 * A separate extension point from the media handlers, and not a method on them,
 * because it is a different party. A handler speaks to one server at an address it is
 * given; a directory is asked, once per account, which servers exist and where. Most
 * service types have no directory at all — Jellyfin has none — and a capability only
 * one type has would have to be reached through a test on the type somewhere above,
 * which is the leak `MediaServiceHandler` is built to avoid. So a directory registers
 * itself for a type with `@MediaDirectory`, and a type without one simply has none.
 */
export interface ServiceDirectory {
	readonly type: MediaServiceType;

	/** Open a sign-in request. The person approves it on the directory's own page. */
	startSignIn(): Promise<DirectoryPin>;

	/** Ask whether that request was approved. */
	checkSignIn(pin: Pick<DirectoryPin, 'pinId' | 'code'>): Promise<DirectoryPinCheck>;

	/** Every server the account can reach — its own and those shared with it. */
	listServers(accountToken: string): Promise<DirectoryServer[]>;

	/**
	 * The first address, in the directory's order of preference, that answers as that
	 * server — or null when none does.
	 */
	resolve(server: DirectoryServer): Promise<ResolvedConnection | null>;
}
