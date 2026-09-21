import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { reachableHost } from './fake-jellyfin';

/**
 * plex.tv, and the Plex servers it lists, for the one journey that signs in to it.
 *
 * ## Why this exists
 *
 * Signing in to the real plex.tv from a journey would need a real Plex account, a
 * person — or a script typing a password into somebody else's site — to approve the
 * request, and the internet; the run would read green or red depending on plex.tv's
 * day and on whoever owns that account. So the journey *is* plex.tv, the way
 * `fake-jellyfin.ts` makes a journey the media server. The gateway is not faked
 * anywhere: it opens a real PIN here, polls it, lists the account's resources, probes
 * each address and registers what the browser ticked, exactly as it would against
 * plex.tv.
 *
 * ## How the gateway finds it
 *
 * Through `MCS_PLEX_TV_URL`, which the gateway reads for this purpose only and which
 * defaults to the real plex.tv. It is set on the CI stack's API to `http://e2e:<port>`,
 * and that is why this server listens on a **fixed** port rather than on port zero
 * like the fake Jellyfin: the gateway is started before any journey, so the address
 * has to be known before this process exists. `e2e` resolves because `e2e.sh` runs the
 * journeys with `--use-aliases`; the browser, which opens the approval page, runs in
 * this same container and resolves the same name to itself.
 *
 * ## What it answers
 *
 * - `POST /api/v2/pins`, `GET /api/v2/pins/:id` — the PIN, pending until approved.
 * - `GET /auth` — the approval page the browser is sent to, with one button. It posts
 *   to `/approve`, which is this fake's stand-in for somebody signing in on plex.tv.
 * - `GET /api/v2/resources` — the account's servers, only for the token it handed out.
 * - `/pms/<name>/identity`, `/pms/<name>/`, `/pms/<name>/library/sections` — each
 *   server's side of a probe, which is what a registration runs.
 */

export interface FakePlexServer {
	/** Path segment under `/pms/`, and the server's `machineIdentifier`. */
	identifier: string;
	name: string;
	owned: boolean;
	/** The friend who shared it, for one that is not owned. */
	ownerName?: string;
	/** How plex.tv lists its one address. `unreachable` lists one nothing answers on. */
	route: 'local' | 'remote' | 'relay' | 'unreachable';
}

export interface FakePlexTv {
	/** Where the gateway reaches it: must equal the API's `MCS_PLEX_TV_URL`. */
	url: string;
	/** Every request, as `METHOD path`. */
	calls: string[];
	close: () => Promise<void>;
}

/** The fixed port, and the name the gateway was told. See the note above. */
export const FAKE_PLEX_TV_PORT = Number(process.env.E2E_FAKE_PLEX_TV_PORT ?? 0);
export const FAKE_PLEX_TV_URL = process.env.E2E_FAKE_PLEX_TV_URL ?? '';

function send (response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	response.end(payload);
}

/**
 * The approval page. Deliberately plain: the journey is about the gateway's dialog,
 * and this page only has to stand where plex.tv's would and flip the PIN when asked.
 */
function approvalPage (): string {
	return String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Fake plex.tv</title></head>
<body>
	<h1>Fake plex.tv</h1>
	<p data-test="fake-plex-code"></p>
	<button data-test="fake-plex-approve" type="button">Allow Media Center Sync</button>
	<p data-test="fake-plex-approved" hidden>Approved. You can close this tab.</p>
	<script>
		const params = new URLSearchParams(location.hash.replace(/^#\??/, ''));
		document.querySelector('[data-test="fake-plex-code"]').textContent = 'Code: ' + (params.get('code') || '(none)');
		document.querySelector('[data-test="fake-plex-approve"]').addEventListener('click', async () => {
			await fetch('/approve?code=' + encodeURIComponent(params.get('code') || ''), { method: 'POST' });
			document.querySelector('[data-test="fake-plex-approved"]').hidden = false;
		});
	</script>
</body></html>`;
}

export async function startFakePlexTv (servers: FakePlexServer[]): Promise<FakePlexTv> {
	const calls: string[] = [];
	const accountToken = `fake-account-${Math.random().toString(36).slice(2)}`;
	const code = `fake-code-${Math.random().toString(36).slice(2)}`;
	// Addresses the gateway can dial: this container's own IP, not the `e2e` name,
	// which is how a real plex.tv lists servers too — by address.
	const self = `http://${reachableHost()}:${FAKE_PLEX_TV_PORT}`;
	let approved = false;

	const uriOf = (server: FakePlexServer): string =>
		(server.route === 'unreachable' ? 'http://127.0.0.1:1' : `${self}/pms/${server.identifier}`);

	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://fake');
		calls.push(`${request.method} ${url.pathname}`);

		if (request.method === 'POST' && url.pathname === '/api/v2/pins') {
			approved = false;
			send(response, 201, {
				id: 777,
				code,
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
				authToken: null,
			});
			return;
		}

		if (url.pathname === '/api/v2/pins/777') {
			send(response, 200, { id: 777, code, authToken: approved ? accountToken : null });
			return;
		}

		if (url.pathname === '/auth') {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(approvalPage());
			return;
		}

		if (request.method === 'POST' && url.pathname === '/approve') {
			approved = url.searchParams.get('code') === code;
			send(response, approved ? 200 : 400, { approved });
			return;
		}

		if (url.pathname === '/api/v2/resources') {
			if (request.headers['x-plex-token'] !== accountToken) {
				send(response, 401, { errors: [{ message: 'unauthorized' }] });
				return;
			}
			send(response, 200, [
				// A phone: a resource of the account, not a server, and never listed.
				{ name: 'Phone', clientIdentifier: 'phone', provides: 'player', owned: true, connections: [] },
				...servers.map(one => ({
					name: one.name,
					product: 'Plex Media Server',
					productVersion: '1.41.3',
					clientIdentifier: one.identifier,
					provides: 'server',
					owned: one.owned,
					sourceTitle: one.ownerName ?? '',
					accessToken: `token-${one.identifier}`,
					connections: [{
						protocol: 'http',
						uri: uriOf(one),
						local: one.route === 'local',
						relay: one.route === 'relay',
					}],
				})),
			]);
			return;
		}

		const pms = /^\/pms\/([^/]+)(\/.*)?$/.exec(url.pathname);
		const plex = pms ? servers.find(one => one.identifier === pms[1]) : undefined;

		if (pms && plex) {
			const rest = pms[2] ?? '/';
			if (rest === '/identity') {
				send(response, 200, { MediaContainer: { machineIdentifier: plex.identifier, version: '1.41.3' } });
			} else if (rest === '/library/sections') {
				send(response, 200, { MediaContainer: { Directory: [] } });
			} else {
				send(response, 200, { MediaContainer: { friendlyName: plex.name, version: '1.41.3' } });
			}
			return;
		}

		send(response, 404, { error: 'not found' });
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(FAKE_PLEX_TV_PORT, '0.0.0.0', resolve);
	});

	return {
		url: FAKE_PLEX_TV_URL,
		calls,
		close: () => new Promise<void>(resolve => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}
