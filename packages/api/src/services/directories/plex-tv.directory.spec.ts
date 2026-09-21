import { ConnectionRoute, ErrorKey, MediaServiceType } from '@mcs/shared';
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PeerLinkService } from '../peer-link.service';
import { PlexTvDirectory } from './plex-tv.directory';
import type { DirectoryServer } from './service-directory.interface';

/**
 * plex.tv, faked at the one seam the directory has: `fetch`.
 *
 * Never the real plex.tv. Each test says what plex.tv and the servers answer, by URL,
 * and the directory is judged on what it makes of those answers. A route nobody
 * declared refuses the connection, which is what an address that is not there does.
 */
type Answer = { status?: number; body?: unknown } | 'refused';

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function fakeNetwork(routes: Record<string, Answer>): Recorded[] {
	const calls: Recorded[] = [];

	global.fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);

		calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });

		const key = Object.keys(routes)
			.sort((a, b) => b.length - a.length)
			.find((one) => url.startsWith(one));
		const answer = key === undefined ? 'refused' : routes[key];

		if (answer === 'refused') {
			throw new TypeError('fetch failed: connect ECONNREFUSED');
		}

		return {
			ok: (answer.status ?? 200) < 400,
			status: answer.status ?? 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
		} as unknown as Response;
	}) as unknown as typeof fetch;

	return calls;
}

const identity = (machineIdentifier: string): Answer => ({
	body: { MediaContainer: { machineIdentifier, version: '1.41.3' } },
});

const directory = (url: string | null = null): PlexTvDirectory =>
	new PlexTvDirectory(
		{ get: () => ({ url }) } as unknown as ConfigService,
		{ nodeId: 'node-1' } as PeerLinkService,
	);

/** The error key a call was refused with, or a marker when it was not refused. */
const refusal = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => 'not refused',
		(error: unknown) => ((error as HttpException).getResponse() as { key?: string }).key,
	);

describe('PlexTvDirectory', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('is the directory for Plex', () => {
		expect(directory().type).toBe(MediaServiceType.PLEX);
	});

	describe('signing in', () => {
		it('opens a strong PIN on plex.tv and sends the person to Plex’s own page with it', async () => {
			const calls = fakeNetwork({
				'https://plex.tv/api/v2/pins': {
					status: 201,
					body: { id: 4242, code: 'long-strong-code', expiresAt: '2099-01-01T00:15:00Z', authToken: null },
				},
			});

			const pin = await directory().startSignIn();

			expect(pin).toMatchObject({ pinId: '4242', code: 'long-strong-code' });
			expect(pin.expiresAt.toISOString()).toBe('2099-01-01T00:15:00.000Z');
			expect(calls[0].method).toBe('POST');
			expect(calls[0].url).toBe('https://plex.tv/api/v2/pins?strong=true');
			expect(calls[0].headers).toMatchObject({
				'X-Plex-Client-Identifier': 'mcs-node-1',
				'X-Plex-Product': 'Media Center Sync',
			});
			// No token and no password: there is nothing to send yet, and the password
			// is never ours to send.
			expect(calls[0].headers).not.toHaveProperty('X-Plex-Token');
			expect(pin.authUrl.startsWith('https://app.plex.tv/auth#?')).toBe(true);

			const fragment = new URLSearchParams(pin.authUrl.split('#?')[1]);

			expect(fragment.get('clientID')).toBe('mcs-node-1');
			expect(fragment.get('code')).toBe('long-strong-code');
			expect(fragment.get('context[device][product]')).toBe('Media Center Sync');
		});

		it('gives a PIN plex.tv sent without an expiry a lifetime of its own', async () => {
			fakeNetwork({ 'https://plex.tv/api/v2/pins': { status: 201, body: { id: 1, code: 'c' } } });

			const pin = await directory().startSignIn();

			expect(pin.expiresAt.getTime()).toBeGreaterThan(Date.now());
		});

		it('says plex.tv did not answer rather than opening a PIN nobody can poll', async () => {
			fakeNetwork({ 'https://plex.tv/api/v2/pins': { status: 201, body: { code: 'no-id' } } });

			expect(await refusal(directory().startSignIn())).toBe(ErrorKey.DIRECTORY_UNREACHABLE);
		});

		it('names plex.tv as what is down when it does not answer', async () => {
			fakeNetwork({});

			expect(await refusal(directory().startSignIn())).toBe(ErrorKey.DIRECTORY_UNREACHABLE);
		});

		it('is still waiting while nobody has approved', async () => {
			const calls = fakeNetwork({
				'https://plex.tv/api/v2/pins/4242': { body: { id: 4242, authToken: null, expiresAt: '2099-01-01T00:00:00Z' } },
			});

			await expect(directory().checkSignIn({ pinId: '4242', code: 'c0de' })).resolves.toEqual({ state: 'pending' });
			expect(calls[0].url).toBe('https://plex.tv/api/v2/pins/4242?code=c0de');
			expect(calls[0].headers['X-Plex-Client-Identifier']).toBe('mcs-node-1');
		});

		it('hands back the account token once the person approved on plex.tv', async () => {
			fakeNetwork({ 'https://plex.tv/api/v2/pins/4242': { body: { id: 4242, authToken: 'account-token' } } });

			await expect(directory().checkSignIn({ pinId: '4242', code: 'c' }))
				.resolves.toEqual({ state: 'approved', accountToken: 'account-token' });
		});

		it('reads a PIN plex.tv no longer knows as expired', async () => {
			fakeNetwork({ 'https://plex.tv/api/v2/pins/4242': { status: 404, body: { errors: [] } } });

			await expect(directory().checkSignIn({ pinId: '4242', code: 'c' })).resolves.toEqual({ state: 'expired' });
		});

		it('reads a PIN past its expiry with no token as expired, before plex.tv forgets it', async () => {
			fakeNetwork({
				'https://plex.tv/api/v2/pins/4242': { body: { authToken: null, expiresAt: '2000-01-01T00:00:00Z' } },
			});

			await expect(directory().checkSignIn({ pinId: '4242', code: 'c' })).resolves.toEqual({ state: 'expired' });
		});

		it('does not take plex.tv being down for an expired PIN', async () => {
			// "Expired" sends the person back to the start; a hiccup must not.
			fakeNetwork({ 'https://plex.tv/api/v2/pins/4242': { status: 503 } });

			expect(await refusal(directory().checkSignIn({ pinId: '4242', code: 'c' }))).toBe(ErrorKey.DIRECTORY_UNREACHABLE);
		});
	});

	describe('listing the account’s servers', () => {
		const resources = [
			{
				name: 'Attic',
				product: 'Plex Media Server',
				productVersion: '1.41.3',
				clientIdentifier: 'machine-own',
				provides: 'server',
				owned: true,
				sourceTitle: 'me',
				accessToken: 'own-server-token',
				connections: [
					{ protocol: 'https', uri: 'https://192-168-1-20.hash.plex.direct:32400/', local: true, relay: false },
					{ protocol: 'http', uri: 'http://192.168.1.20:32400', local: true, relay: false },
				],
			},
			{
				name: 'Bob’s Plex',
				productVersion: '1.40.0',
				clientIdentifier: 'machine-bob',
				provides: 'server,player',
				owned: false,
				sourceTitle: 'bob',
				accessToken: 'bob-server-token',
				connections: [{ uri: 'https://82-1-2-3.bobhash.plex.direct:32400', local: false, relay: false }],
			},
			{
				name: 'Carol behind a strict router',
				clientIdentifier: 'machine-carol',
				provides: 'server',
				owned: '0',
				sourceTitle: 'carol',
				accessToken: 'carol-server-token',
				connections: [{ protocol: 'https', uri: 'https://5-6-7-8.carolhash.plex.direct:8443', local: false, relay: true }],
			},
			// A phone and a television: resources of the account, not servers.
			{ name: 'Pixel', clientIdentifier: 'phone', provides: 'player,controller', owned: true },
			{ name: 'Living room TV', clientIdentifier: 'tv', provides: 'client', owned: true },
			// A server with no identity cannot be found again; it is left out.
			{ name: 'Nameless', provides: 'server', owned: true },
		];

		it('keeps only what serves media, with who owns it and every address it lists', async () => {
			const calls = fakeNetwork({ 'https://clients.plex.tv/api/v2/resources': { body: resources } });

			const servers = await directory().listServers('account-token');

			expect(calls[0].url).toBe('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1');
			expect(calls[0].headers['X-Plex-Token']).toBe('account-token');
			expect(servers.map((server) => server.identifier)).toEqual(['machine-own', 'machine-bob', 'machine-carol']);
			expect(servers[0]).toEqual({
				identifier: 'machine-own',
				name: 'Attic',
				owned: true,
				// `sourceTitle` on an owned server is ignored: it is not shared by anybody.
				ownerName: null,
				version: '1.41.3',
				accessToken: 'own-server-token',
				connections: [
					{ uri: 'https://192-168-1-20.hash.plex.direct:32400', local: true, relay: false, protocol: 'https' },
					{ uri: 'http://192.168.1.20:32400', local: true, relay: false, protocol: 'http' },
				],
			});
			expect(servers[1]).toMatchObject({
				owned: false,
				ownerName: 'bob',
				accessToken: 'bob-server-token',
				// A connection with no protocol field is read off its URI.
				connections: [{ uri: 'https://82-1-2-3.bobhash.plex.direct:32400', protocol: 'https' }],
			});
			expect(servers[2]).toMatchObject({ owned: false, ownerName: 'carol', connections: [{ relay: true }] });
		});

		it('answers an empty list for an account with no server at all', async () => {
			fakeNetwork({
				'https://clients.plex.tv/api/v2/resources': { body: [{ name: 'Phone', clientIdentifier: 'p', provides: 'player' }] },
			});

			await expect(directory().listServers('account-token')).resolves.toEqual([]);
		});

		it('says the account token was refused when plex.tv no longer accepts it', async () => {
			fakeNetwork({ 'https://clients.plex.tv/api/v2/resources': { status: 401 } });

			expect(await refusal(directory().listServers('revoked'))).toBe(ErrorKey.DIRECTORY_REFUSED);
		});

		it('asks the plex.tv a test points it at, for every one of the three hosts', async () => {
			const calls = fakeNetwork({
				'http://fake-plex-tv:32499/api/v2/pins': { status: 201, body: { id: 7, code: 'c' } },
				'http://fake-plex-tv:32499/api/v2/resources': { body: [] },
			});
			const faked = directory('http://fake-plex-tv:32499/');

			const pin = await faked.startSignIn();
			await faked.listServers('account-token');

			expect(pin.authUrl.startsWith('http://fake-plex-tv:32499/auth#?')).toBe(true);
			expect(calls.map((call) => call.url)).toEqual([
				'http://fake-plex-tv:32499/api/v2/pins?strong=true',
				'http://fake-plex-tv:32499/api/v2/resources?includeHttps=1&includeRelay=1',
			]);
		});
	});

	describe('resolving a server’s address', () => {
		const server = (connections: DirectoryServer['connections']): DirectoryServer => ({
			identifier: 'machine-own',
			name: 'Attic',
			owned: true,
			ownerName: null,
			version: null,
			accessToken: 'server-token',
			connections,
		});
		const local = { uri: 'http://192.168.1.20:32400', local: true, relay: false, protocol: 'http' };
		const remote = { uri: 'https://82-1-2-3.hash.plex.direct:32400', local: false, relay: false, protocol: 'https' };
		const relay = { uri: 'https://5-6-7-8.hash.plex.direct:8443', local: false, relay: true, protocol: 'https' };

		it('takes the local address when it answers as the server, over every other', async () => {
			fakeNetwork({
				[relay.uri]: identity('machine-own'),
				[remote.uri]: identity('machine-own'),
				[local.uri]: identity('machine-own'),
			});

			await expect(directory().resolve(server([relay, remote, local])))
				.resolves.toEqual({ baseUrl: local.uri, route: ConnectionRoute.LOCAL });
		});

		it('falls back to the remote address when the local one does not answer', async () => {
			fakeNetwork({ [relay.uri]: identity('machine-own'), [remote.uri]: identity('machine-own') });

			await expect(directory().resolve(server([local, relay, remote])))
				.resolves.toEqual({ baseUrl: remote.uri, route: ConnectionRoute.REMOTE });
		});

		it('takes the relay only when nothing else answered, and says it is the relay', async () => {
			fakeNetwork({ [relay.uri]: identity('machine-own') });

			await expect(directory().resolve(server([relay, remote, local])))
				.resolves.toEqual({ baseUrl: relay.uri, route: ConnectionRoute.RELAY });
		});

		it('refuses an address that answers as some other server', async () => {
			// The server moved; its old LAN address now belongs to somebody else's box.
			// Accepting it would index that box's library under this server's name.
			const calls = fakeNetwork({
				[local.uri]: identity('a-different-machine'),
				[remote.uri]: identity('machine-own'),
			});

			await expect(directory().resolve(server([local, remote])))
				.resolves.toEqual({ baseUrl: remote.uri, route: ConnectionRoute.REMOTE });
			expect(calls.some((call) => call.url === `${local.uri}/identity`)).toBe(true);
		});

		it('refuses an address that answers with no identity at all', async () => {
			fakeNetwork({ [local.uri]: { body: { MediaContainer: {} } } });

			await expect(directory().resolve(server([local]))).resolves.toBeNull();
		});

		it('answers nothing when no address answers as the server', async () => {
			fakeNetwork({ [local.uri]: { status: 500 } });

			await expect(directory().resolve(server([local, remote, relay]))).resolves.toBeNull();
		});

		it('answers nothing for a server with no address listed', async () => {
			fakeNetwork({});

			await expect(directory().resolve(server([]))).resolves.toBeNull();
		});
	});
});
