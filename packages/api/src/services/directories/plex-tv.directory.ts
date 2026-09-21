import { ErrorKey, MediaServiceType } from '@mcs/shared';
import {
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlexTvConfig } from '@/config';
import { requestJson } from '../handlers/handler.http';
import { asBoolean, asRecord, asRecordArray, asString, type Payload } from '../handlers/payload';
import { PeerLinkService } from '../peer-link.service';
import { orderConnections, routeOf } from './connection-order';
import { MediaDirectory } from './directory.decorator';
import type {
	DirectoryConnection,
	DirectoryPin,
	DirectoryPinCheck,
	DirectoryServer,
	ResolvedConnection,
	ServiceDirectory,
} from './service-directory.interface';

/** What plex.tv shows on its approval page and in the account's device list. */
const PRODUCT_NAME = 'Media Center Sync';

/**
 * Plex splits its account service across three hosts, and each call has to go to the
 * right one: PINs live on `plex.tv`, the server list on `clients.plex.tv`, and the page
 * where somebody approves a PIN on `app.plex.tv`.
 */
const PLEX_TV = 'https://plex.tv';
const PLEX_CLIENTS = 'https://clients.plex.tv';
const PLEX_APP = 'https://app.plex.tv';

/**
 * How long one candidate address gets to answer as its server.
 *
 * Short, because every address of every server is tried at once while somebody looks
 * at a spinner, and an address that is not going to answer — a friend's LAN IP, a
 * port the router does not forward — usually says nothing at all rather than refusing.
 * Long enough for a TLS handshake to a `plex.direct` name across the internet, which is
 * the slowest thing that does answer.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** Used when plex.tv answers without an expiry, which the current API never does. */
const FALLBACK_PIN_LIFETIME_MS = 15 * 60 * 1000;

/**
 * plex.tv as a directory of Plex servers.
 *
 * Signing in is Plex's PIN flow, the one it documents for third-party applications,
 * and it is chosen for what it keeps out of the gateway: the person's Plex password.
 * The gateway asks plex.tv for a PIN, the person approves it on plex.tv's own page in
 * their own browser — with their own two-factor prompt if they have one — and the
 * gateway, polling the PIN, is handed an account token. The password never crosses
 * this process, so it cannot be logged, stored or leaked by it. The older route, a
 * login and password posted to `/users/signin`, would have made this gateway one more
 * place that held it.
 *
 * `strong=true` asks for the long PIN meant for a link rather than the four characters
 * meant for a television keyboard: nobody types it, and a short code is a code
 * somebody else could approve by guessing.
 */
@Injectable()
@MediaDirectory(MediaServiceType.PLEX)
export class PlexTvDirectory implements ServiceDirectory {
	public readonly type = MediaServiceType.PLEX;

	private readonly _logger = new Logger(PlexTvDirectory.name);
	private readonly _override: string | null;

	public constructor(
		config: ConfigService,
		private readonly _peerLink: PeerLinkService,
	) {
		this._override = config.get<PlexTvConfig>('plexTv')?.url?.replace(/\/+$/, '') ?? null;
	}

	public async startSignIn(): Promise<DirectoryPin> {
		const answer = await this._account<Payload>(this._host(PLEX_TV), '/api/v2/pins', {
			method: 'POST',
			query: { strong: 'true' },
		});
		const pinId = asString(answer.id);
		const code = asString(answer.code);

		if (pinId === null || code === null) {
			throw new ServiceUnavailableException({
				key: ErrorKey.DIRECTORY_UNREACHABLE,
				detail: 'plex.tv answered a PIN with no identifier or code',
			});
		}

		const expiresAt = new Date(asString(answer.expiresAt) ?? '');
		const query = new URLSearchParams({
			clientID: this._clientIdentifier(),
			code,
			'context[device][product]': PRODUCT_NAME,
		});

		return {
			pinId,
			code,
			// The parameters go after the `#`, not in the query: Plex's approval page is
			// a single-page application that reads its route from the fragment, and a
			// query string there is silently ignored — the page opens and asks the person
			// to sign in to nothing in particular.
			authUrl: `${this._host(PLEX_APP)}/auth#?${query.toString()}`,
			expiresAt: Number.isNaN(expiresAt.getTime())
				? new Date(Date.now() + FALLBACK_PIN_LIFETIME_MS)
				: expiresAt,
		};
	}

	/**
	 * A PIN plex.tv no longer knows answers `404`, and that is how it says the request
	 * lapsed: nobody approved it before it expired, and it is gone. Everything else
	 * that is not a token yet is still waiting.
	 */
	public async checkSignIn(pin: Pick<DirectoryPin, 'pinId' | 'code'>): Promise<DirectoryPinCheck> {
		let answer: Payload;

		try {
			answer = await this._account<Payload>(
				this._host(PLEX_TV),
				`/api/v2/pins/${encodeURIComponent(pin.pinId)}`,
				{ query: { code: pin.code } },
			);
		} catch (error) {
			if (error instanceof NotFoundException) {
				return { state: 'expired' };
			}

			throw error;
		}

		const accountToken = asString(answer.authToken);

		if (accountToken !== null) {
			return { state: 'approved', accountToken };
		}

		const expiresAt = new Date(asString(answer.expiresAt) ?? '');

		return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()
			? { state: 'expired' }
			: { state: 'pending' };
	}

	/**
	 * The account's resources, reduced to the ones that serve media.
	 *
	 * The same list holds every player the account ever signed in from — phones,
	 * televisions, this gateway itself — and only a device that `provides` `server`
	 * holds a library. `includeHttps` asks for the `plex.direct` addresses, which are the
	 * ones a remote server can actually be reached on with a valid certificate, and
	 * `includeRelay` for the relay, which is the last resort and is only ever taken last.
	 */
	public async listServers(accountToken: string): Promise<DirectoryServer[]> {
		const answer = await this._account<unknown>(this._host(PLEX_CLIENTS), '/api/v2/resources', {
			query: { includeHttps: 1, includeRelay: 1 },
			token: accountToken,
		});

		return asRecordArray(answer).flatMap((device) => {
			const provides = (asString(device.provides) ?? '').split(',').map((one) => one.trim());
			const identifier = asString(device.clientIdentifier);

			if (!provides.includes('server') || identifier === null) {
				return [];
			}

			const owned = asBoolean(device.owned);

			return [{
				identifier,
				name: asString(device.name) ?? identifier,
				owned,
				// `sourceTitle` is the friend who shared it. On an owned server it is empty
				// or the account's own name, and reading it there would label somebody's
				// own server as shared with them by themselves.
				ownerName: owned ? null : asString(device.sourceTitle),
				version: asString(device.productVersion),
				accessToken: asString(device.accessToken),
				connections: asRecordArray(device.connections).flatMap((connection) => {
					const uri = asString(connection.uri);

					return uri === null
						? []
						: [{
							uri: uri.replace(/\/+$/, ''),
							local: asBoolean(connection.local),
							relay: asBoolean(connection.relay),
							protocol: asString(connection.protocol) ?? (uri.startsWith('https:') ? 'https' : 'http'),
						}];
				}),
			}];
		});
	}

	/**
	 * Every candidate at once, and the best-ranked one that answered wins.
	 *
	 * At once rather than one after the other because the ones that do not answer are
	 * exactly the ones that hang until the deadline, and a server with a dead LAN
	 * address, a firewalled port and a working `plex.direct` name would otherwise make
	 * somebody wait out two timeouts to be shown the third. The order still decides:
	 * a relay that answered first never beats a local address that answered too.
	 */
	public async resolve(server: DirectoryServer): Promise<ResolvedConnection | null> {
		const candidates = orderConnections(server.connections);
		const answers = await Promise.all(
			candidates.map((connection) => this._answersAs(connection, server)),
		);
		const index = answers.indexOf(true);

		if (index === -1) {
			return null;
		}

		return { baseUrl: candidates[index].uri, route: routeOf(candidates[index]) };
	}

	/**
	 * Whether that address is that server, and not merely something that answers.
	 *
	 * `/identity` answers without a token and carries the server's
	 * `machineIdentifier`, which is the same value as its `clientIdentifier` at plex.tv.
	 * Checking it is what stops a stale address from being accepted: a server that
	 * moved leaves its old LAN IP to whatever the router hands it to next, possibly
	 * another Plex, and registering that would index somebody else's library under this
	 * server's name without a single error.
	 */
	private async _answersAs(connection: DirectoryConnection, server: DirectoryServer): Promise<boolean> {
		try {
			const answer = await requestJson<Payload>(connection.uri, '/identity', {
				headers: this._headers(server.accessToken),
				timeoutMs: PROBE_TIMEOUT_MS,
			});
			const identity = asString(asRecord(answer.MediaContainer).machineIdentifier);

			if (identity !== server.identifier) {
				this._logger.warn(
					`${connection.uri} answered as ${identity ?? 'nothing'}, not as ${server.name} (${server.identifier}): ignored`,
				);

				return false;
			}

			return true;
		} catch {
			return false;
		}
	}

	/**
	 * One call to the account service, its failures turned into the directory's keys.
	 *
	 * A refusal of the account token and a plex.tv that is down are the two things the
	 * person can act on, and they act in different places: sign in again, or wait. A
	 * `404` passes through untouched, because for a PIN it is the answer "expired".
	 */
	private async _account<T>(
		host: string,
		path: string,
		options: { method?: string; query?: Record<string, string | number>; token?: string },
	): Promise<T> {
		try {
			return await requestJson<T>(host, path, {
				method: options.method,
				query: options.query,
				headers: this._headers(options.token ?? null),
			});
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}

			if (error instanceof UnauthorizedException) {
				throw new UnauthorizedException({ key: ErrorKey.DIRECTORY_REFUSED });
			}

			throw new ServiceUnavailableException({
				key: ErrorKey.DIRECTORY_UNREACHABLE,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Plex identifies the application, not the user, and a PIN can only be polled by
	 * the client identifier that created it. The gateway's own node identity is used
	 * because it survives restarts: a new identifier per boot would leave the account's
	 * device list with one "Media Center Sync" per restart.
	 */
	private _headers(token: string | null): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Plex-Product': PRODUCT_NAME,
			'X-Plex-Client-Identifier': this._clientIdentifier(),
			'X-Plex-Device': PRODUCT_NAME,
			'X-Plex-Platform': 'Node',
		};

		if (token !== null) {
			headers['X-Plex-Token'] = token;
		}

		return headers;
	}

	private _clientIdentifier(): string {
		return `mcs-${this._peerLink.nodeId}`;
	}

	private _host(real: string): string {
		return this._override ?? real;
	}
}
