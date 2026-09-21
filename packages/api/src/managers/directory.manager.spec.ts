import {
	ConnectionRoute,
	DirectorySignInState,
	ErrorKey,
	MediaServiceType,
	type CreateMediaServiceRequest,
	type MediaService as MediaServiceModel,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import type { MediaService } from '@/entities';
import type { MediaServiceRepository } from '@/repositories';
import type { CacheService, DirectoryRegistry, DirectoryServer } from '@/services';
import { DirectoryManager } from './directory.manager';
import type { DirectoryOrigin, ServiceManager } from './service.manager';

/**
 * The manager against fakes: a cache that is a map, a directory that answers what each
 * test says plex.tv would, and a service manager that records what it was asked to
 * register. What is pinned is who may use a sign-in, what the list says about each
 * server, and what a registration is made of.
 */

const server = (overrides: Partial<DirectoryServer> = {}): DirectoryServer => ({
	identifier: 'machine-own',
	name: 'Attic',
	owned: true,
	ownerName: null,
	version: '1.41.3',
	accessToken: 'own-server-token',
	connections: [{ uri: 'http://192.168.1.20:32400', local: true, relay: false, protocol: 'http' }],
	...overrides,
});

const bobs = server({
	identifier: 'machine-bob',
	name: 'Home',
	owned: false,
	ownerName: 'bob',
	accessToken: 'bob-server-token',
	connections: [{ uri: 'https://82-1-2-3.bob.plex.direct:32400', local: false, relay: false, protocol: 'https' }],
});

const carols = server({
	identifier: 'machine-carol',
	name: 'Basement',
	owned: false,
	ownerName: 'carol',
	accessToken: 'carol-server-token',
	connections: [{ uri: 'https://5-6-7-8.carol.plex.direct:8443', local: false, relay: true, protocol: 'https' }],
});

const registeredRow = (overrides: Partial<MediaService>): MediaService => ({
	id: 'existing',
	name: 'Existing',
	type: MediaServiceType.PLEX,
	baseUrl: 'http://elsewhere:32400',
	serverIdentifier: null,
	peerId: null,
	...overrides,
}) as MediaService;

interface Harness {
	manager: DirectoryManager;
	entries: Map<string, { value: unknown; ttl: number }>;
	directory: { startSignIn: jest.Mock; checkSignIn: jest.Mock; listServers: jest.Mock; resolve: jest.Mock };
	services: { findByServerIdentifiers: jest.Mock; findOwned: jest.Mock };
	serviceManager: { createDiscovered: jest.Mock };
	registry: { find: jest.Mock; types: jest.Mock };
}

function harness(): Harness {
	const entries = new Map<string, { value: unknown; ttl: number }>();
	const cache = {
		get: jest.fn(async (key: string) => structuredClone(entries.get(key)?.value ?? null)),
		set: jest.fn(async (key: string, value: unknown, ttl: number) => {
			entries.set(key, { value: structuredClone(value), ttl });
		}),
		delete: jest.fn(async (key: string) => {
			entries.delete(key);
		}),
	};
	const directory = {
		startSignIn: jest.fn().mockResolvedValue({
			pinId: '4242',
			code: 'long-code',
			authUrl: 'https://app.plex.tv/auth#?code=long-code',
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		}),
		checkSignIn: jest.fn().mockResolvedValue({ state: 'pending' }),
		listServers: jest.fn().mockResolvedValue([server(), bobs, carols]),
		resolve: jest.fn(async (one: DirectoryServer) => {
			const [first] = one.connections;

			return {
				baseUrl: first.uri,
				route: first.relay ? ConnectionRoute.RELAY : first.local ? ConnectionRoute.LOCAL : ConnectionRoute.REMOTE,
			};
		}),
	};
	const registry = {
		find: jest.fn((type: MediaServiceType) => (type === MediaServiceType.PLEX ? directory : null)),
		types: jest.fn(() => [MediaServiceType.PLEX]),
	};
	const services = {
		findByServerIdentifiers: jest.fn().mockResolvedValue([]),
		findOwned: jest.fn().mockResolvedValue([]),
	};
	const serviceManager = {
		createDiscovered: jest.fn(async (request: CreateMediaServiceRequest, origin: DirectoryOrigin) => ({
			id: `service-${origin.serverIdentifier}`,
			name: request.name,
		}) as MediaServiceModel),
	};

	const manager = new DirectoryManager(
		registry as unknown as DirectoryRegistry,
		cache as unknown as CacheService,
		services as unknown as MediaServiceRepository,
		serviceManager as unknown as ServiceManager,
	);

	return { manager, entries, directory, services, serviceManager, registry };
}

/** A sign-in the person has approved on plex.tv. */
async function approved(h: Harness, userId = 'user-1'): Promise<string> {
	const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, userId);

	h.directory.checkSignIn.mockResolvedValueOnce({ state: 'approved', accountToken: 'account-token' });
	await h.manager.readSignIn(signIn.id, userId);

	return signIn.id;
}

describe('DirectoryManager', () => {
	it('offers a sign-in for the types a directory serves', () => {
		expect(harness().manager.types()).toEqual([MediaServiceType.PLEX]);
	});

	describe('signing in', () => {
		it('opens a sign-in and hands the interface the page to approve it on, and nothing secret', async () => {
			const h = harness();

			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			expect(signIn).toMatchObject({
				type: MediaServiceType.PLEX,
				state: DirectorySignInState.PENDING,
				authUrl: 'https://app.plex.tv/auth#?code=long-code',
				code: 'long-code',
			});
			expect(signIn).not.toHaveProperty('pinId');
			expect(signIn).not.toHaveProperty('accountToken');
			// Kept a little past the PIN's own expiry, so a late poll reads "expired".
			const [stored] = [...h.entries.values()];

			expect(stored.ttl).toBeGreaterThan(15 * 60);
			expect(stored.ttl).toBeLessThanOrEqual(16 * 60 + 1);
		});

		it('refuses a sign-in for a type no directory serves', async () => {
			const h = harness();

			await expect(h.manager.startSignIn(MediaServiceType.JELLYFIN, 'user-1'))
				.rejects.toEqual(new BadRequestException(ErrorKey.DIRECTORY_UNSUPPORTED));
		});

		it('keeps waiting while nobody has approved', async () => {
			const h = harness();
			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			const read = await h.manager.readSignIn(signIn.id, 'user-1');

			expect(read.state).toBe(DirectorySignInState.PENDING);
			expect(h.directory.checkSignIn).toHaveBeenCalledWith(expect.objectContaining({ pinId: '4242', code: 'long-code' }));
		});

		it('keeps the account token on the gateway once approved, and stops asking plex.tv', async () => {
			const h = harness();
			const id = await approved(h);

			const again = await h.manager.readSignIn(id, 'user-1');

			expect(again.state).toBe(DirectorySignInState.APPROVED);
			expect(again).not.toHaveProperty('accountToken');
			expect(h.directory.checkSignIn).toHaveBeenCalledTimes(1);
			expect(h.entries.get(`directory:sign-in:${id}`)).toMatchObject({
				value: { accountToken: 'account-token' },
				ttl: 30 * 60,
			});
		});

		it('says expired, and forgets the sign-in, when plex.tv let it lapse', async () => {
			const h = harness();
			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			h.directory.checkSignIn.mockResolvedValueOnce({ state: 'expired' });

			expect((await h.manager.readSignIn(signIn.id, 'user-1')).state).toBe(DirectorySignInState.EXPIRED);
			await expect(h.manager.readSignIn(signIn.id, 'user-1'))
				.rejects.toEqual(new NotFoundException(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND));
		});

		it('says expired past the deadline without asking plex.tv at all', async () => {
			const h = harness();

			h.directory.startSignIn.mockResolvedValueOnce({
				pinId: '1',
				code: 'c',
				authUrl: 'https://app.plex.tv/auth#?code=c',
				expiresAt: new Date(Date.now() - 1_000),
			});

			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			expect((await h.manager.readSignIn(signIn.id, 'user-1')).state).toBe(DirectorySignInState.EXPIRED);
			expect(h.directory.checkSignIn).not.toHaveBeenCalled();
		});

		it('lets plex.tv being down reach the dialog as that, not as an expiry', async () => {
			const h = harness();
			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');
			const down = new ServiceUnavailableException({ key: ErrorKey.DIRECTORY_UNREACHABLE });

			h.directory.checkSignIn.mockRejectedValueOnce(down);

			await expect(h.manager.readSignIn(signIn.id, 'user-1')).rejects.toBe(down);
			// And the sign-in survives it: the next poll may well succeed.
			expect((await h.manager.readSignIn(signIn.id, 'user-1')).state).toBe(DirectorySignInState.PENDING);
		});

		it('answers somebody else’s sign-in exactly like one that does not exist', async () => {
			const h = harness();
			const id = await approved(h, 'user-1');

			await expect(h.manager.readSignIn(id, 'user-2'))
				.rejects.toEqual(new NotFoundException(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND));
			await expect(h.manager.servers(id, 'user-2'))
				.rejects.toEqual(new NotFoundException(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND));
			await expect(h.manager.cancelSignIn(id, 'user-2'))
				.rejects.toEqual(new NotFoundException(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND));
		});

		it('forgets the account token when the person cancels', async () => {
			const h = harness();
			const id = await approved(h);

			await h.manager.cancelSignIn(id, 'user-1');

			expect(h.entries.size).toBe(0);
		});
	});

	describe('listing the servers', () => {
		it('refuses before the person has approved', async () => {
			const h = harness();
			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			await expect(h.manager.servers(signIn.id, 'user-1'))
				.rejects.toEqual(new BadRequestException(ErrorKey.DIRECTORY_SIGN_IN_PENDING));
			expect(h.directory.listServers).not.toHaveBeenCalled();
		});

		it('lists the account’s own first, then each friend’s, with the path that answered', async () => {
			const h = harness();
			const id = await approved(h);

			h.directory.listServers.mockResolvedValue([carols, bobs, server()]);

			const listed = await h.manager.servers(id, 'user-1');

			expect(h.directory.listServers).toHaveBeenCalledWith('account-token');
			expect(listed).toEqual([
				{
					identifier: 'machine-own',
					name: 'Attic',
					owned: true,
					ownerName: null,
					version: '1.41.3',
					reachable: true,
					route: ConnectionRoute.LOCAL,
					baseUrl: 'http://192.168.1.20:32400',
					registeredServiceId: null,
				},
				expect.objectContaining({ identifier: 'machine-bob', ownerName: 'bob', route: ConnectionRoute.REMOTE }),
				expect.objectContaining({ identifier: 'machine-carol', ownerName: 'carol', route: ConnectionRoute.RELAY }),
			]);
		});

		it('shows a server nothing answered for as unreachable, with no address', async () => {
			const h = harness();
			const id = await approved(h);

			h.directory.resolve.mockResolvedValue(null);

			const [first] = await h.manager.servers(id, 'user-1');

			expect(first).toMatchObject({ reachable: false, route: null, baseUrl: null });
		});

		it('marks a server already registered, by its identity or by an address typed before', async () => {
			const h = harness();
			const id = await approved(h);

			h.services.findByServerIdentifiers.mockResolvedValue([
				registeredRow({ id: 'by-identity', serverIdentifier: 'machine-bob' }),
			]);
			h.services.findOwned.mockResolvedValue([
				// Registered by hand at an address plex.tv lists for Attic.
				registeredRow({ id: 'typed', baseUrl: 'http://192.168.1.20:32400' }),
				// Same address, but a Jellyfin: not the same server.
				registeredRow({ id: 'jellyfin', type: MediaServiceType.JELLYFIN, baseUrl: 'https://5-6-7-8.carol.plex.direct:8443' }),
			]);

			const listed = await h.manager.servers(id, 'user-1');

			expect(Object.fromEntries(listed.map((one) => [one.identifier, one.registeredServiceId]))).toEqual({
				'machine-own': 'typed',
				'machine-bob': 'by-identity',
				'machine-carol': null,
			});
		});
	});

	describe('registering', () => {
		it('registers several at once, each with where it was found', async () => {
			const h = harness();
			const id = await approved(h);

			const result = await h.manager.register(id, 'user-1', ['machine-own', 'machine-bob', 'machine-carol']);

			expect(result.failed).toEqual([]);
			expect(result.created.map((one) => one.id)).toEqual([
				'service-machine-own',
				'service-machine-bob',
				'service-machine-carol',
			]);
			expect(h.serviceManager.createDiscovered).toHaveBeenNthCalledWith(
				1,
				{
					name: 'Attic',
					type: MediaServiceType.PLEX,
					baseUrl: 'http://192.168.1.20:32400',
					token: 'own-server-token',
					shared: true,
				},
				{ serverIdentifier: 'machine-own', accountToken: 'account-token', connectionRoute: ConnectionRoute.LOCAL },
			);
		});

		it('brings a friend’s server in under their name, with its own token, and does not pass it on', async () => {
			const h = harness();
			const id = await approved(h);

			await h.manager.register(id, 'user-1', ['machine-bob']);

			expect(h.serviceManager.createDiscovered).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'Home (bob)', token: 'bob-server-token', shared: false }),
				expect.objectContaining({ serverIdentifier: 'machine-bob', connectionRoute: ConnectionRoute.REMOTE }),
			);
		});

		it('keeps a friend’s server name as it is when plex.tv does not say whose it is', async () => {
			const h = harness();
			const id = await approved(h);

			h.directory.listServers.mockResolvedValue([server({ identifier: 'anon', owned: false, ownerName: null, accessToken: null })]);

			await h.manager.register(id, 'user-1', ['anon']);

			expect(h.serviceManager.createDiscovered).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'Attic', token: undefined, shared: false }),
				expect.anything(),
			);
		});

		it('reports each one that cannot come in by name, and registers the rest', async () => {
			const h = harness();
			const id = await approved(h);

			h.services.findByServerIdentifiers.mockResolvedValue([registeredRow({ serverIdentifier: 'machine-own' })]);
			h.directory.resolve.mockImplementation(async (one: DirectoryServer) =>
				(one.identifier === 'machine-carol' ? null : { baseUrl: one.connections[0].uri, route: ConnectionRoute.REMOTE }));

			const result = await h.manager.register(id, 'user-1', ['machine-own', 'gone', 'machine-carol', 'machine-bob', 'machine-bob']);

			expect(result.created.map((one) => one.id)).toEqual(['service-machine-bob']);
			expect(result.failed).toEqual([
				{ identifier: 'machine-own', name: 'Attic', error: ErrorKey.SERVICE_DUPLICATE },
				{ identifier: 'gone', name: null, error: ErrorKey.DIRECTORY_SERVER_NOT_FOUND },
				{ identifier: 'machine-carol', name: 'Basement', error: ErrorKey.DIRECTORY_SERVER_UNREACHABLE },
			]);
		});

		it('names what the registration itself refused', async () => {
			const h = harness();
			const id = await approved(h);

			h.serviceManager.createDiscovered
				.mockRejectedValueOnce(new ConflictException(ErrorKey.SERVICE_DUPLICATE))
				.mockRejectedValueOnce(new ServiceUnavailableException({ key: ErrorKey.SERVICE_UNREACHABLE }))
				.mockRejectedValueOnce(new Error('database locked'));

			const result = await h.manager.register(id, 'user-1', ['machine-own', 'machine-bob', 'machine-carol']);

			expect(result.failed.map((one) => one.error)).toEqual([
				ErrorKey.SERVICE_DUPLICATE,
				ErrorKey.SERVICE_UNREACHABLE,
				ErrorKey.GENERAL,
			]);
		});

		it('reads a refusal whose message is its key, and falls back when it carries none', async () => {
			const h = harness();
			const id = await approved(h);

			h.serviceManager.createDiscovered
				.mockRejectedValueOnce(new NotFoundException(ErrorKey.SERVICE_NOT_FOUND))
				.mockRejectedValueOnce(new BadRequestException('plain words'));

			const result = await h.manager.register(id, 'user-1', ['machine-own', 'machine-bob']);

			expect(result.failed.map((one) => one.error)).toEqual([ErrorKey.SERVICE_NOT_FOUND, ErrorKey.GENERAL]);
		});

		it('refuses before the person has approved', async () => {
			const h = harness();
			const signIn = await h.manager.startSignIn(MediaServiceType.PLEX, 'user-1');

			await expect(h.manager.register(signIn.id, 'user-1', ['machine-own']))
				.rejects.toEqual(new BadRequestException(ErrorKey.DIRECTORY_SIGN_IN_PENDING));
			expect(h.serviceManager.createDiscovered).not.toHaveBeenCalled();
		});
	});
});
