import request from 'supertest';
import {
	PeerDirection,
	PeerLinkMode,
	PeerStatus,
	PeerTrust,
	UserRole,
	type MediaService,
	type Peer,
	type PeerIdentity,
	type PeerInvite,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import { PeerLinkService } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/** An identifier that is a valid UUID and belongs to nobody. */
const ABSENT = '11111111-2222-4333-8444-555555555555';

describe('Peers', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let user: TestIdentity;
	let guest: TestIdentity;
	let peers: PeerRepository;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		user = await signInAs(context, UserRole.USER);
		guest = await signInAs(context, UserRole.GUEST);
		peers = context.app.get(PeerRepository);
	});

	afterAll(async () => {
		await context.close();
	});

	const get = (path: string, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/peers${path}`)
			.set('Authorization', `Bearer ${identity.token}`);

	const post = (path: string, body: Record<string, unknown> = {}, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.post(`/api/peers${path}`)
			.set('Authorization', `Bearer ${identity.token}`)
			.send(body);

	/** A fingerprint nothing else in the suite will collide with. */
	let counter = 0;
	const fingerprint = (): string => `fingerprint-${(counter += 1)}`;

	const seed = async (overrides: Partial<Peer> = {}): Promise<string> =>
		(
			await peers.save(
				peers.create({
					name: 'Seeded',
					fingerprint: fingerprint(),
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
					...overrides,
				}),
			)
		).id;

	describe('our own identity', () => {
		it('answers what somebody needs to find us, and is not read as a peer identifier', async () => {
			const response = await get('/identity').expect(200);
			const identity = response.body as PeerIdentity;

			expect(identity).toMatchObject({
				nodeId: expect.any(String),
				fingerprint: expect.any(String),
				name: expect.any(String),
				directReachable: expect.any(Boolean),
			});
			// Not derived from the key: rotating one must not make this gateway look like
			// a new participant to everybody who already knows it.
			expect(identity.nodeId).not.toBe(identity.fingerprint);
		});
	});

	describe('linking by fingerprint', () => {
		it('records a request and waits, rather than claiming a link', async () => {
			const response = await post('', { fingerprint: 'fingerprint-alice' }).expect(201);
			const peer = response.body as Peer;

			expect(peer).toMatchObject({
				id: expect.any(String),
				fingerprint: 'fingerprint-alice',
				status: PeerStatus.PENDING,
				direction: PeerDirection.OUTGOING,
				trust: PeerTrust.FRIEND,
				linkMode: null,
				serviceCount: 0,
				sharedItemCount: 0,
			});
			// Nothing has been negotiated yet, so there is no version and no capability
			// to claim. Null is not version zero.
			expect(peer.protocol).toBeNull();
			expect(peer.capabilities).toEqual([]);
		});

		it('names them after the fingerprint when nobody said what to call them', async () => {
			const response = await post('', { fingerprint: 'abcdef0123456789' }).expect(201);

			expect((response.body as Peer).name).toBe('peer-abcdef01');
		});

		it('accepts `name`', async () => {
			const response = await post('', { fingerprint: fingerprint(), name: 'Alice' }).expect(201);

			expect((response.body as Peer).name).toBe('Alice');
			expect(((await get(`/${(response.body as Peer).id}`).expect(200)).body as Peer).name).toBe(
				'Alice',
			);
		});

		it('accepts `address`', async () => {
			const response = await post('', {
				fingerprint: fingerprint(),
				address: '10.0.0.7:4210',
			}).expect(201);

			expect(
				((await get(`/${(response.body as Peer).id}`).expect(200)).body as Peer).address,
			).toBe('10.0.0.7:4210');
		});

		it('is answering rather than asking when they already asked us', async () => {
			const theirs = fingerprint();

			await seed({
				fingerprint: theirs,
				status: PeerStatus.PENDING,
				direction: PeerDirection.INCOMING,
			});

			const response = await post('', { fingerprint: theirs }).expect(201);

			expect(response.body as Peer).toMatchObject({
				status: PeerStatus.LINKED,
				direction: null,
			});
		});

		it('refuses a body with no fingerprint, and one carrying a field it never declared', async () => {
			await post('', {}).expect(400);
			await post('', { fingerprint: '' }).expect(400);

			const response = await post('', {
				fingerprint: fingerprint(),
				trust: PeerTrust.FRIEND,
			}).expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('trust');
		});
	});

	describe('reading', () => {
		it('lists every peer, linked, pending or blocked', async () => {
			const response = await get('').expect(200);

			expect((response.body as Peer[]).length).toBeGreaterThan(0);
			expect(response.body as Peer[]).toEqual(
				expect.arrayContaining([expect.objectContaining({ fingerprint: 'fingerprint-alice' })]),
			);
		});

		it('answers a key for a peer nobody linked to', async () => {
			const response = await get(`/${ABSENT}`).expect(404);

			expect(response.body).toMatchObject({ message: 'error.peer.not_found' });
		});

		it('refuses an identifier that is not one', async () => {
			await get('/not-a-uuid').expect(400);
		});

		it('answers the services a peer exposes, which is none until it has told us', async () => {
			const id = await seed();
			const response = await get(`/${id}/services`).expect(200);

			expect(response.body as MediaService[]).toEqual([]);
		});

		it('answers a key when asked for the services of a peer nobody linked to', async () => {
			const response = await get(`/${ABSENT}/services`).expect(404);

			expect(response.body).toMatchObject({ message: 'error.peer.not_found' });
		});
	});

	describe('renaming', () => {
		it('renames a peer locally', async () => {
			const id = await seed({ name: 'peer-12345678' });

			const response = await request(context.app.getHttpServer())
				.patch(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ name: 'The cottage' })
				.expect(200);

			expect((response.body as Peer).name).toBe('The cottage');
			expect(((await get(`/${id}`).expect(200)).body as Peer).name).toBe('The cottage');
		});

		it('refuses an empty name and a body with nothing in it', async () => {
			const id = await seed();

			await request(context.app.getHttpServer())
				.patch(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ name: '' })
				.expect(400);

			await request(context.app.getHttpServer())
				.patch(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({})
				.expect(400);
		});
	});

	describe('approving', () => {
		it('settles a request somebody made of us', async () => {
			const id = await seed({
				status: PeerStatus.PENDING,
				direction: PeerDirection.INCOMING,
			});

			const response = await post(`/${id}/approve`).expect(200);

			expect(response.body as Peer).toMatchObject({
				status: PeerStatus.LINKED,
				direction: null,
				trust: PeerTrust.FRIEND,
			});
		});

		it('refuses to approve a request we made ourselves', async () => {
			// Documented on the route and in the manager, and worth enforcing rather than
			// describing: approving our own request declares a link the other side never
			// agreed to, and the first pull then fails with an authentication error
			// instead of the honest answer, which is that they have not answered yet.
			const id = await seed({
				status: PeerStatus.PENDING,
				direction: PeerDirection.OUTGOING,
			});

			const response = await post(`/${id}/approve`).expect(409);

			// Its own key, not the one that means the far end refused us: that is the
			// opposite fact, and it is what somebody would have been told about a
			// request that is simply still outstanding.
			expect(response.body).toMatchObject({ message: 'error.peer.awaiting_them' });
			expect(((await get(`/${id}`).expect(200)).body as Peer).status).toBe(PeerStatus.PENDING);
		});

		it('refuses to approve somebody who was blocked', async () => {
			const id = await seed({ status: PeerStatus.BLOCKED });

			const response = await post(`/${id}/approve`).expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.rejected' });
		});

		it('answers a key for a peer nobody linked to', async () => {
			await post(`/${ABSENT}/approve`).expect(404);
		});
	});

	describe('blocking', () => {
		it('blocks, and unblocks to unreachable rather than to linked', async () => {
			const id = await seed();

			expect((await post(`/${id}/block`).expect(200)).body as Peer).toMatchObject({
				status: PeerStatus.BLOCKED,
			});

			// No socket is open, and claiming a link that was never re-established would
			// show a peer as connected until somebody tried to pull from it.
			expect((await post(`/${id}/unblock`).expect(200)).body as Peer).toMatchObject({
				status: PeerStatus.UNREACHABLE,
			});
		});

		it('answers a key for a peer nobody linked to', async () => {
			await post(`/${ABSENT}/block`).expect(404);
			await post(`/${ABSENT}/unblock`).expect(404);
		});
	});

	describe('connecting', () => {
		it('answers unreachable, with the key that says so, when there is nowhere to go', async () => {
			// No address and no rendezvous configured: the only honest answer, and the one
			// the interface renders as "could not be reached" rather than as an error.
			const id = await seed({ address: null });

			const response = await post(`/${id}/connect`).expect(503);

			expect(response.body).toMatchObject({ message: 'error.peer.unreachable' });
			expect(((await get(`/${id}`).expect(200)).body as Peer).status).toBe(
				PeerStatus.UNREACHABLE,
			);
		});

		it('answers a key for a peer nobody linked to', async () => {
			await post(`/${ABSENT}/connect`).expect(404);
		});
	});

	/**
	 * A peer is a media service with an introduction service bolted on.
	 *
	 * These go through the real application deliberately: the claim is not that a
	 * handler can map a catalogue row, which a unit test pins, but that linking a peer
	 * produces an ordinary service with ordinary libraries holding ordinary items —
	 * because everything downstream reads those and nothing downstream knows what a
	 * peer is.
	 *
	 * The link itself is the only thing faked, and it is faked on the real service
	 * rather than replaced: a test must never open a socket to a peer, and everything
	 * above the socket is exactly what production runs.
	 */
	describe('what a link brings', () => {
		let services: MediaServiceRepository;
		let libraries: LibraryRepository;
		let items: MediaItemRepository;

		const theirLibraries = [
			{ externalId: 'their-films', name: 'Films', kind: 'movies', itemCount: 1 },
			{ externalId: 'their-shows', name: 'Shows', kind: 'shows', itemCount: 0 },
		];

		const theirFilm = {
			externalId: 'their-item-1',
			libraryId: 'their-films',
			kind: 'movie',
			title: 'Tears of Steel',
			year: 2012,
			seasonNumber: null,
			episodeNumber: null,
			parentExternalId: null,
			externalIds: { tmdb: '133701' },
			contentId: 'v1:abc:1048576',
			size: 1_048_576,
			quality: 'x265 · 1080p',
		};

		beforeAll(() => {
			services = context.app.get(MediaServiceRepository);
			libraries = context.app.get(LibraryRepository);
			items = context.app.get(MediaItemRepository);
		});

		beforeEach(() => {
			const links = context.app.get(PeerLinkService);
			const pages = new Map<string, number>();

			jest.spyOn(links, 'isLinked').mockReturnValue(true);
			jest.spyOn(links, 'supports').mockReturnValue(true);
			jest.spyOn(links, 'protocolOf').mockReturnValue(1);
			jest.spyOn(links, 'request').mockImplementation(
				async (peerId: string, method: string, params: unknown) => {
					if (method === 'catalogue.libraries') {
						return { libraries: theirLibraries } as never;
					}

					const query = (params ?? {}) as { libraryId?: string | null };
					const key = `${peerId}:${query.libraryId ?? 'all'}`;
					const page = (pages.get(key) ?? 0) + 1;

					pages.set(key, page);

					// One page of rows, then the empty page that ends the walk — which is
					// how a real peer answers, and what stops the import asking forever.
					return {
						entries:
							page === 1 && query.libraryId === 'their-films' ? [theirFilm] : [],
					} as never;
				},
			);
		});

		afterEach(() => {
			jest.restoreAllMocks();
		});

		/** The indexing pass is detached from the request that asked for it. */
		const settled = async (serviceId: string): Promise<void> => {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				if ((await items.countByService(serviceId)) > 0) {
					return;
				}

				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};

		it('registers what a peer shares as a service holding their libraries', async () => {
			const id = await seed({
				name: 'The cottage',
				status: PeerStatus.PENDING,
				direction: PeerDirection.INCOMING,
			});

			await post(`/${id}/approve`).expect(200);

			const [service] = await services.findByPeer(id);

			expect(service).toMatchObject({
				name: 'The cottage',
				// Remote, always: we cannot write into somebody else's disk, and a
				// peer-backed row is never offered as a destination.
				scope: 'remote',
				type: 'peer',
				peerId: id,
			});

			const registered = await libraries.findByService(service.id);

			expect(registered.map((library) => library.name).sort()).toEqual(['Films', 'Shows']);
			// No path, so nothing can ever mark one writable and plan a transfer into it.
			expect(registered.every((library) => library.paths.length === 0)).toBe(true);
		});

		it('indexes their rows, so everything downstream sees ordinary items', async () => {
			const id = await seed({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING });

			await post(`/${id}/approve`).expect(200);

			const [service] = await services.findByPeer(id);

			await settled(service.id);

			const held = await items.find({ where: { serviceId: service.id } });

			expect(held).toHaveLength(1);
			expect(held[0]).toMatchObject({
				externalId: 'their-item-1',
				title: 'Tears of Steel',
				normalizedTitle: 'tears of steel',
			});
			// Their path never crossed, and this gateway must not invent one.
			expect(held[0].file?.path).toBe('');
		});

		it('drops a library they have stopped sharing, and only that one', async () => {
			const id = await seed({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING });

			await post(`/${id}/approve`).expect(200);

			const [service] = await services.findByPeer(id);

			await settled(service.id);

			const links = context.app.get(PeerLinkService);

			jest.spyOn(links, 'request').mockImplementation(async (_peerId, method) =>
				method === 'catalogue.libraries'
					? ({ libraries: [theirLibraries[1]] } as never)
					: ({ entries: [] } as never),
			);
			// The socket is the one thing a test must not open. Everything the link
			// service is asked for afterwards is answered above.
			jest.spyOn(links, 'connect').mockResolvedValue({
				peerId: id,
				mode: PeerLinkMode.DIRECT,
				address: '127.0.0.1:4299',
				connected: true,
				since: new Date().toISOString(),
				protocol: 1,
				capabilities: ['catalogue', 'libraries'],
				nodeId: 'their-node',
			});

			await post(`/${id}/connect`).expect(200);

			// Un-sharing is somebody changing their mind on purpose, which is exactly
			// what adopting libraries does not model: it creates and updates and never
			// deletes. Leaving the library behind would keep counting a friend's films as
			// available to pull, which is the one thing un-sharing was meant to stop.
			await expect(
				libraries.findByService(service.id).then((rows) => rows.map((row) => row.name)),
			).resolves.toEqual(['Shows']);
			await expect(items.countByService(service.id)).resolves.toBe(0);
		});

		it('counts their libraries on the peer, rather than reporting a flat zero', async () => {
			const id = await seed({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING });

			await post(`/${id}/approve`).expect(200);

			const response = await get(`/${id}/services`).expect(200);

			expect(response.body as MediaService[]).toMatchObject([{ libraryCount: 2 }]);
		});
	});

	describe('unlinking', () => {
		it('forgets a peer', async () => {
			const id = await seed();

			await request(context.app.getHttpServer())
				.delete(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			await get(`/${id}`).expect(404);
		});

		it('takes back what the link brought, and nothing of ours', async () => {
			const links = context.app.get(PeerLinkService);

			jest.spyOn(links, 'isLinked').mockReturnValue(true);
			jest.spyOn(links, 'supports').mockReturnValue(true);
			jest.spyOn(links, 'request').mockImplementation(async (_peerId, method) =>
				method === 'catalogue.libraries'
					? ({
						libraries: [
							{ externalId: 'their-films', name: 'Films', kind: 'movies', itemCount: 0 },
						],
					} as never)
					: ({ entries: [] } as never),
			);

			const services = context.app.get(MediaServiceRepository);
			const libraries = context.app.get(LibraryRepository);
			const ours = await services.save(
				services.create({
					name: 'Ours',
					type: 'jellyfin' as never,
					scope: 'local' as never,
					baseUrl: `http://ours-${Date.now()}.test`,
				}),
			);
			const id = await seed({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING });

			await post(`/${id}/approve`).expect(200);

			const [theirs] = await services.findByPeer(id);

			expect(await libraries.findByService(theirs.id)).toHaveLength(1);

			await request(context.app.getHttpServer())
				.delete(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			await expect(services.findByPeer(id)).resolves.toEqual([]);
			await expect(libraries.findByService(theirs.id)).resolves.toEqual([]);
			// And nothing of ours went with it. Unlinking is about one machine.
			await expect(services.findOne({ where: { id: ours.id } })).resolves.not.toBeNull();

			jest.restoreAllMocks();
		});

		it('answers a key for a peer nobody linked to', async () => {
			await request(context.app.getHttpServer())
				.delete(`/api/peers/${ABSENT}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(404);
		});
	});

	describe('invitations', () => {
		it('mints one, carrying everything the far end needs in a single string', async () => {
			const response = await post('/invites', {}).expect(201);
			const invite = response.body as PeerInvite;

			expect(invite).toMatchObject({
				code: expect.any(String),
				fingerprint: expect.any(String),
				expiresAt: expect.any(String),
			});
			expect(invite.url).toContain('mcs://invite/');
			expect(invite.url).toContain(`fingerprint=${invite.fingerprint}`);
			// The secret lives in the URL and nowhere else: only its hash is stored, so a
			// stolen database hands over no usable invitations.
			expect(invite.url).toMatch(/secret=[^&]+/);
			expect(JSON.stringify({ ...invite, url: '' })).not.toContain('secret');
		});

		it('accepts a chosen lifetime, and refuses one outside the range', async () => {
			const short = (await post('/invites', { ttlMinutes: 5 }).expect(201))
				.body as PeerInvite;
			const long = (await post('/invites', { ttlMinutes: 10_080 }).expect(201))
				.body as PeerInvite;

			expect(new Date(short.expiresAt).getTime()).toBeLessThan(
				new Date(long.expiresAt).getTime(),
			);

			await post('/invites', { ttlMinutes: 1 }).expect(400);
			await post('/invites', { ttlMinutes: 10_081 }).expect(400);
			await post('/invites', { ttlMinutes: 'an hour' }).expect(400);
		});

		it('redeems one, and burns it', async () => {
			const invite = (await post('/invites', {}).expect(201)).body as PeerInvite;

			const linked = await post('/accept', { invite: invite.url, name: 'Round trip' })
				.expect(200);

			expect(linked.body as Peer).toMatchObject({
				name: 'Round trip',
				status: PeerStatus.LINKED,
				trust: PeerTrust.FRIEND,
			});

			// One code, one link. An invitation that could be replayed is a credential
			// lying in somebody's chat log, and whoever found it would be a friend.
			const replayed = await post('/accept', { invite: invite.url }).expect(401);

			expect(replayed.body).toMatchObject({ message: 'error.peer.invite_invalid' });
		});

		it('refuses a bare code, because the link is in the rest of the URL', async () => {
			// Both forms are parsed — a code pasted with its query string still attached
			// is what actually arrives — but a code on its own carries neither the secret
			// that proves it nor the fingerprint that says who to link to, so it can only
			// ever be refused. Pinned here so that the day somebody makes a bare code
			// work, they have to mean it.
			const invite = (await post('/invites', {}).expect(201)).body as PeerInvite;

			const response = await post('/accept', { invite: invite.code }).expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.invite_invalid' });
		});

		it('refuses a code nobody ever minted', async () => {
			const response = await post('/accept', { invite: 'not-an-invitation' }).expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.invite_invalid' });
		});

		it('refuses one that has gone stale, and says which of the two it is', async () => {
			const stale = new URLSearchParams({
				fingerprint: 'fingerprint-from-a-friend',
				rendezvous: '',
				secret: 'whatever',
				exp: new Date(Date.now() - 60_000).toISOString(),
			});

			const response = await post('/accept', {
				invite: `mcs://invite/some-code?${stale.toString()}`,
			}).expect(401);

			// Its own key: "invalid" for both would leave somebody re-pasting a code that
			// will never work again, when what they need is a fresh one.
			expect(response.body).toMatchObject({ message: 'error.peer.invite_expired' });
		});

		it('refuses a body with no invitation in it', async () => {
			await post('/accept', {}).expect(400);
			await post('/accept', { invite: '' }).expect(400);
		});
	});

	describe('rights', () => {
		it('lets a reader read, because PEER_READ is what a user screen needs', async () => {
			await get('', user).expect(200);
			await get('/identity', user).expect(200);
		});

		it('refuses a reader everything that changes a link', async () => {
			const id = await seed();

			await post('', { fingerprint: fingerprint() }, user).expect(403);
			await post(`/${id}/approve`, {}, user).expect(403);
			await post(`/${id}/block`, {}, user).expect(403);
			await post('/invites', {}, user).expect(403);
			await post('/accept', { invite: 'anything' }, user).expect(403);
			await request(context.app.getHttpServer())
				.delete(`/api/peers/${id}`)
				.set('Authorization', `Bearer ${user.token}`)
				.expect(403);
		});

		it('refuses a guest even the reading', async () => {
			await get('', guest).expect(403);
			await get('/identity', guest).expect(403);
		});

		it('refuses an anonymous caller entirely', async () => {
			await request(context.app.getHttpServer()).get('/api/peers').expect(401);
		});
	});
});
