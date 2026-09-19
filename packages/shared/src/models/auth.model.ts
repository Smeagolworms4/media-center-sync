import type { Right, User } from './user.model';

/**
 * How an account is authenticated.
 *
 * The gateway does not want to be one more password to remember: by default it
 * delegates to a media service already registered — you sign in with the Jellyfin
 * or Plex account you already use. `INTERNAL` exists because the very first
 * administrator has to exist before any service is registered, and because a
 * gateway whose only service went down must still be reachable to fix it.
 */
export enum AuthProviderType {
	/** Local accounts held by the gateway itself. */
	INTERNAL = 'internal',
	/** Delegated to a registered media service (Jellyfin, Plex, …). */
	SERVICE = 'service',
	/** Delegated to an external identity provider. */
	OIDC = 'oidc',
}

/** One way in, as offered to the sign-in screen. */
export interface AuthProvider {
	/** Stable key used by the sign-in request, e.g. `internal` or `service:<uuid>`. */
	key: string;
	type: AuthProviderType;
	label: string;
	/** Icon hint for the interface, e.g. `jellyfin`, `plex`, `key`. */
	icon: string;
	/** True when credentials are typed here; false when the flow redirects away. */
	credentials: boolean;
	/** Where to send the browser for a redirect flow. */
	redirectUrl?: string;
}

export interface LoginRequest {
	/** One of the keys returned by `GET /api/auth/providers`. */
	provider: string;
	username: string;
	password: string;
}

export interface RefreshRequest {
	refreshToken: string;
}

/**
 * A session.
 *
 * The access token is short-lived and backed by the database: its session is
 * checked on every call, so signing out revokes it immediately rather than leaving
 * a valid token alive until it expires.
 */
export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	/** Seconds until the access token expires. */
	expiresIn: number;
	user: User;
	rights: Right[];
}

export interface SessionUser extends User {
	rights: Right[];
}
