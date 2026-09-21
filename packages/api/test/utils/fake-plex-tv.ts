import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * plex.tv and the Plex servers it lists, in one process the functional tests hold.
 *
 * Never the real plex.tv: a test that signed in there would need an account, a person
 * clicking "approve" and the internet. The gateway is pointed here through
 * `MCS_PLEX_TV_URL`, the variable read only for this, and this answers the four things
 * it asks: open a PIN, poll it, list the account's resources, and — on the servers'
 * behalf — `/identity`, `/` and `/library/sections`, which are what the Plex handler's
 * probe reads when a server is registered.
 *
 * The servers live under `/pms/<name>`, so one listening port stands for any number of
 * them: the handler joins its paths onto whatever base URL it was given.
 */

export interface FakePlexServer {
	/** What `/identity` answers as — set it to another value to play a stale address. */
	machineIdentifier: string;
	friendlyName: string;
}

export interface FakeResource {
	name: string;
	clientIdentifier: string;
	provides: string;
	owned: boolean;
	sourceTitle?: string;
	accessToken?: string;
	productVersion?: string;
	/** Paths under this fake (`/pms/...`) or absolute URIs nobody answers. */
	connections: { path?: string; uri?: string; local: boolean; relay: boolean }[];
}

export interface FakePlexTv {
	url: string;
	/** Servers by the path segment after `/pms/`. */
	servers: Map<string, FakePlexServer>;
	resources: FakeResource[];
	/** The account token handed out on approval, and the only one accepted. */
	accountToken: string;
	approve: () => void;
	expire: () => void;
	/** Refuse the account token from now on, as plex.tv does once it is revoked. */
	revoke: () => void;
	/** Every request, as `METHOD path`, to prove what was and was not asked. */
	calls: string[];
	close: () => Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);

	response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
	response.end(payload);
}

export async function startFakePlexTv(): Promise<FakePlexTv> {
	let state: 'pending' | 'approved' | 'expired' = 'pending';
	let revoked = false;
	let url = '';
	const calls: string[] = [];
	const servers = new Map<string, FakePlexServer>();
	const resources: FakeResource[] = [];
	const accountToken = 'fake-account-token';

	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const parsed = new URL(request.url ?? '/', 'http://fake');
		const path = parsed.pathname;

		calls.push(`${request.method} ${path}`);

		if (request.method === 'POST' && path === '/api/v2/pins') {
			state = 'pending';
			send(response, 201, {
				id: 4242,
				code: 'fake-strong-code',
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
				authToken: null,
			});

			return;
		}

		if (path === '/api/v2/pins/4242') {
			if (state === 'expired') {
				send(response, 404, { errors: [{ code: 1020, message: 'Code not found or expired' }] });

				return;
			}

			send(response, 200, { id: 4242, authToken: state === 'approved' ? accountToken : null });

			return;
		}

		if (path === '/api/v2/resources') {
			if (revoked || request.headers['x-plex-token'] !== accountToken) {
				send(response, 401, { errors: [] });

				return;
			}

			send(response, 200, resources.map((resource) => ({
				...resource,
				connections: resource.connections.map((connection) => ({
					uri: connection.uri ?? `${url}${connection.path}`,
					local: connection.local,
					relay: connection.relay,
					protocol: (connection.uri ?? url).startsWith('https') ? 'https' : 'http',
				})),
			})));

			return;
		}

		const pms = /^\/pms\/([^/]+)(\/.*)?$/.exec(path);
		const plex = pms ? servers.get(pms[1]) : undefined;

		if (!pms || !plex) {
			send(response, 404, { error: 'not found' });

			return;
		}

		const rest = pms[2] ?? '/';

		if (rest === '/identity') {
			send(response, 200, { MediaContainer: { machineIdentifier: plex.machineIdentifier, version: '1.41.3' } });
		} else if (rest === '/library/sections') {
			send(response, 200, { MediaContainer: { Directory: [] } });
		} else {
			send(response, 200, { MediaContainer: { friendlyName: plex.friendlyName, version: '1.41.3' } });
		}
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		url,
		servers,
		resources,
		accountToken,
		calls,
		approve: () => {
			state = 'approved';
		},
		expire: () => {
			state = 'expired';
		},
		revoke: () => {
			revoked = true;
		},
		close: () => new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}
