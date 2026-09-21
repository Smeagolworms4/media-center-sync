import request from 'supertest';
import {
	ConnectionRoute,
	DirectorySignInState,
	ErrorKey,
	MediaServiceStatus,
	MediaServiceType,
	UserRole,
	type DirectorySignIn,
	type DiscoveredServer,
	type MediaService,
	type RegisterDiscoveredResult,
} from '@mcs/shared';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';
import { startFakePlexTv, type FakePlexTv } from './utils/fake-plex-tv';

/**
 * Adding Plex servers through plex.tv, over HTTP, against a plex.tv this test runs.
 *
 * The application is the real one — guards, validation pipe, serialisation — pointed at
 * `fake-plex-tv.ts` through `MCS_PLEX_TV_URL`. The real plex.tv is never called.
 *
 * The account is shaped like the owner's: a server of his own whose LAN address still
 * points at another box (a stale IP) and which answers on a second address, a friend's
 * server reached directly, a friend's server only the relay reaches, and a server that
 * does not answer at all.
 */
describe('Finding Plex servers through plex.tv', () => {
	let plexTv: FakePlexTv;
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		plexTv = await startFakePlexTv();
		// Read when the application is created, which is after this line: the
		// configuration factory runs at instantiation, not at import.
		process.env.MCS_PLEX_TV_URL = plexTv.url;
		context = await createTestApp();
		admin = await signInAs(context);

		plexTv.servers.set('own-new', { machineIdentifier: 'machine-own', friendlyName: 'Attic' });
		plexTv.servers.set('stale', { machineIdentifier: 'somebody-elses-box', friendlyName: 'Neighbour' });
		plexTv.servers.set('bob', { machineIdentifier: 'machine-bob', friendlyName: 'Home' });
		plexTv.servers.set('carol-relay', { machineIdentifier: 'machine-carol', friendlyName: 'Basement' });
		plexTv.resources.push(
			{
				name: 'Attic',
				clientIdentifier: 'machine-own',
				provides: 'server',
				owned: true,
				accessToken: 'own-server-token',
				connections: [
					{ path: '/pms/stale', local: true, relay: false },
					{ path: '/pms/own-new', local: false, relay: false },
				],
			},
			{
				name: 'Home',
				clientIdentifier: 'machine-bob',
				provides: 'server',
				owned: false,
				sourceTitle: 'bob',
				accessToken: 'bob-server-token',
				connections: [{ path: '/pms/bob', local: false, relay: false }],
			},
			{
				name: 'Basement',
				clientIdentifier: 'machine-carol',
				provides: 'server',
				owned: false,
				sourceTitle: 'carol',
				accessToken: 'carol-server-token',
				connections: [
					{ uri: 'http://127.0.0.1:9', local: false, relay: false },
					{ path: '/pms/carol-relay', local: false, relay: true },
				],
			},
			{
				name: 'Asleep',
				clientIdentifier: 'machine-asleep',
				provides: 'server',
				owned: true,
				connections: [{ uri: 'http://127.0.0.1:9', local: true, relay: false }],
			},
			{ name: 'Phone', clientIdentifier: 'phone', provides: 'player', owned: true, connections: [] },
		);
	});

	afterAll(async () => {
		await context.close();
		await plexTv.close();
		delete process.env.MCS_PLEX_TV_URL;
	});

	const api = (identity: TestIdentity = admin) => {
		const server = request(context.app.getHttpServer());

		return {
			get: (path: string) => server.get(`/api${path}`).set('Authorization', `Bearer ${identity.token}`),
			post: (path: string) => server.post(`/api${path}`).set('Authorization', `Bearer ${identity.token}`),
			delete: (path: string) => server.delete(`/api${path}`).set('Authorization', `Bearer ${identity.token}`),
		};
	};

	/** A sign-in the person has approved on (fake) plex.tv. */
	const approvedSignIn = async (): Promise<string> => {
		const started = await api().post('/directories/plex/sign-ins').expect(201);

		plexTv.approve();
		await api().get(`/directories/sign-ins/${(started.body as DirectorySignIn).id}`).expect(200);

		return (started.body as DirectorySignIn).id;
	};

	it('offers a sign-in for Plex, to whoever may manage services and to nobody else', async () => {
		await api().get('/directories').expect(200, [MediaServiceType.PLEX]);

		const guest = await signInAs(context, UserRole.GUEST);

		await api(guest).get('/directories').expect(403);
		await api(guest).post('/directories/plex/sign-ins').expect(403);
	});

	it('signs in through plex.tv’s own page, and never shows anybody the account token', async () => {
		const started = await api().post('/directories/plex/sign-ins').expect(201);
		const signIn = started.body as DirectorySignIn;

		expect(signIn.state).toBe(DirectorySignInState.PENDING);
		expect(signIn.authUrl.startsWith(`${plexTv.url}/auth#?`)).toBe(true);
		expect(new URLSearchParams(signIn.authUrl.split('#?')[1]).get('code')).toBe('fake-strong-code');
		expect(plexTv.calls).toContain('POST /api/v2/pins');

		const waiting = await api().get(`/directories/sign-ins/${signIn.id}`).expect(200);

		expect(waiting.body.state).toBe(DirectorySignInState.PENDING);

		plexTv.approve();

		const done = await api().get(`/directories/sign-ins/${signIn.id}`).expect(200);

		expect(done.body.state).toBe(DirectorySignInState.APPROVED);
		expect(JSON.stringify(done.body)).not.toContain(plexTv.accountToken);
		expect(JSON.stringify(started.body)).not.toContain(plexTv.accountToken);
	});

	it('refuses the servers of a sign-in nobody approved yet, by key', async () => {
		const started = await api().post('/directories/plex/sign-ins').expect(201);

		const refused = await api().get(`/directories/sign-ins/${started.body.id}/servers`).expect(400);

		expect(refused.body.message).toBe(ErrorKey.DIRECTORY_SIGN_IN_PENDING);
	});

	it('says a PIN nobody approved has expired, then forgets it', async () => {
		const started = await api().post('/directories/plex/sign-ins').expect(201);

		plexTv.expire();

		const expired = await api().get(`/directories/sign-ins/${started.body.id}`).expect(200);

		expect(expired.body.state).toBe(DirectorySignInState.EXPIRED);

		const gone = await api().get(`/directories/sign-ins/${started.body.id}`).expect(404);

		expect(gone.body.message).toBe(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND);
	});

	it('does not let another administrator use somebody’s sign-in', async () => {
		const id = await approvedSignIn();
		const other = await signInAs(context, UserRole.ADMIN);

		await api(other).get(`/directories/sign-ins/${id}/servers`).expect(404);
		await api(other).delete(`/directories/sign-ins/${id}`).expect(404);
	});

	it('refuses a sign-in for a type with no directory, by key', async () => {
		const refused = await api().post('/directories/jellyfin/sign-ins').expect(400);

		expect(refused.body.message).toBe(ErrorKey.DIRECTORY_UNSUPPORTED);
		await api().post('/directories/emby/sign-ins').expect(400);
	});

	describe('once signed in', () => {
		let signInId: string;

		beforeAll(async () => {
			signInId = await approvedSignIn();
		});

		it('lists the account’s servers, its own first, each with the path that answered', async () => {
			const listed = await api().get(`/directories/sign-ins/${signInId}/servers`).expect(200);
			const servers = listed.body as DiscoveredServer[];

			expect(servers.map((one) => [one.identifier, one.owned, one.ownerName, one.reachable, one.route])).toEqual([
				['machine-asleep', true, null, false, null],
				// The LAN address answers as another machine and is refused; the direct one
				// that answers as Attic is taken instead.
				['machine-own', true, null, true, ConnectionRoute.REMOTE],
				['machine-bob', false, 'bob', true, ConnectionRoute.REMOTE],
				['machine-carol', false, 'carol', true, ConnectionRoute.RELAY],
			]);
			expect(servers.find((one) => one.identifier === 'machine-own')?.baseUrl).toBe(`${plexTv.url}/pms/own-new`);
			expect(servers.every((one) => one.registeredServiceId === null)).toBe(true);
		});

		it('registers two at once; a friend’s comes in as somebody else’s, and no token is returned', async () => {
			const registered = await api()
				.post(`/directories/sign-ins/${signInId}/servers`)
				.send({ identifiers: ['machine-own', 'machine-bob'] })
				.expect(200);
			const result = registered.body as RegisterDiscoveredResult;

			expect(result.failed).toEqual([]);
			expect(result.created.map((one) => one.name)).toEqual(['Attic', 'Home (bob)']);

			const own = result.created[0];
			const bobs = result.created[1];

			expect(own).toMatchObject({
				type: MediaServiceType.PLEX,
				baseUrl: `${plexTv.url}/pms/own-new`,
				serverIdentifier: 'machine-own',
				connectionRoute: ConnectionRoute.REMOTE,
				status: MediaServiceStatus.ONLINE,
				filesMounted: false,
				shared: true,
			});
			// Somebody else's: not mounted, like any server reached only over HTTP, and
			// not passed on to our own peers.
			expect(bobs).toMatchObject({ filesMounted: false, shared: false, mode: 'remote' });

			const listed = await api().get('/services').expect(200);
			const body = JSON.stringify(listed.body);

			expect(body).not.toContain(plexTv.accountToken);
			expect(body).not.toContain('own-server-token');
			expect(body).not.toContain('bob-server-token');
			expect((listed.body as MediaService[])[0]).not.toHaveProperty('accountToken');

			// Stored, though: it is what re-resolution asks plex.tv with.
			const [row] = await context.dataSource.query(
				'SELECT "accountToken", "token" FROM "media_services" WHERE "id" = ?',
				[bobs.id],
			) as { accountToken: string; token: string }[];

			expect(row).toEqual({ accountToken: plexTv.accountToken, token: 'bob-server-token' });
		});

		it('shows a registered server as such and does not register it twice', async () => {
			const listed = await api().get(`/directories/sign-ins/${signInId}/servers`).expect(200);
			const own = (listed.body as DiscoveredServer[]).find((one) => one.identifier === 'machine-own');

			expect(own?.registeredServiceId).not.toBeNull();

			const again = await api()
				.post(`/directories/sign-ins/${signInId}/servers`)
				.send({ identifiers: ['machine-own', 'machine-asleep', 'machine-nobody'] })
				.expect(200);

			expect((again.body as RegisterDiscoveredResult).created).toEqual([]);
			expect((again.body as RegisterDiscoveredResult).failed).toEqual([
				{ identifier: 'machine-own', name: 'Attic', error: ErrorKey.SERVICE_DUPLICATE },
				{ identifier: 'machine-asleep', name: 'Asleep', error: ErrorKey.DIRECTORY_SERVER_UNREACHABLE },
				{ identifier: 'machine-nobody', name: null, error: ErrorKey.DIRECTORY_SERVER_NOT_FOUND },
			]);
		});

		it('finds a registered server again when its address stops answering', async () => {
			const listed = await api().get('/services').expect(200);
			const own = (listed.body as MediaService[]).find((one) => one.serverIdentifier === 'machine-own') as MediaService;

			// The owner moved house: the old address is gone, plex.tv lists a new one.
			plexTv.servers.delete('own-new');
			plexTv.servers.set('own-moved', { machineIdentifier: 'machine-own', friendlyName: 'Attic' });
			plexTv.resources[0].connections = [{ path: '/pms/own-moved', local: true, relay: false }];

			const probed = await api().post(`/services/${own.id}/probe`).expect(200);

			expect(probed.body).toMatchObject({ reachable: true, authenticated: true });

			const read = await api().get(`/services/${own.id}`).expect(200);

			expect(read.body).toMatchObject({
				baseUrl: `${plexTv.url}/pms/own-moved`,
				connectionRoute: ConnectionRoute.LOCAL,
				status: MediaServiceStatus.ONLINE,
			});
		});

		it('refuses a body that names no server, on the field', async () => {
			const refused = await api()
				.post(`/directories/sign-ins/${signInId}/servers`)
				.send({ identifiers: [] })
				.expect(400);

			expect(JSON.stringify(refused.body)).toContain('identifiers');
		});

		it('forgets the sign-in when the person cancels', async () => {
			await api().delete(`/directories/sign-ins/${signInId}`).expect(204);
			await api().get(`/directories/sign-ins/${signInId}/servers`).expect(404);
		});
	});

	it('says plex.tv refused the account when its token was revoked', async () => {
		// Last, because the fake refuses the token for good from here on — as plex.tv
		// does once somebody signs the gateway out from their account page.
		const id = await approvedSignIn();

		plexTv.revoke();

		const refused = await api().get(`/directories/sign-ins/${id}/servers`).expect(401);

		expect(refused.body).toMatchObject({ key: ErrorKey.DIRECTORY_REFUSED });
	});
});
