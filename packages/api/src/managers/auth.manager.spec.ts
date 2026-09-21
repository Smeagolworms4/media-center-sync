import {
	AuthProviderType,
	ErrorKey,
	MediaServiceType,
	UserRole,
	type LoginRequest,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import type { MediaService, Session, User } from '@/entities';
import type {
	MediaServiceRepository,
	SessionRepository,
	UserRepository,
} from '@/repositories';
import type { ExternalIdentity, HandlerRegistry } from '@/services';
import { AuthManager, durationSeconds } from './auth.manager';

/** Four rounds rather than twelve: the suite hashes a password per test. */
const ROUNDS = 4;

interface Fakes {
	users: {
		findByUsername: jest.Mock;
		findForAuthentication: jest.Mock;
		findByProvider: jest.Mock;
		findOne: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		update: jest.Mock;
		touchLastSeen: jest.Mock;
		createQueryBuilder: jest.Mock;
		count: jest.Mock;
	};
	sessions: {
		findValidByHash: jest.Mock;
		findOne: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		revoke: jest.Mock;
		revokeAllForUser: jest.Mock;
	};
	services: { findAuthProviders: jest.Mock; findWithSecrets: jest.Mock; setStatus: jest.Mock };
	handlers: { get: jest.Mock };
	authenticate: jest.Mock;
}

const internalUser = async (overrides: Partial<User> = {}): Promise<User> =>
	({
		id: 'user-1',
		username: 'admin',
		displayName: 'Administrator',
		email: null,
		role: UserRole.ADMIN,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		passwordHash: await hash('secret', ROUNDS),
		lastSeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as User;

/** `version` is what the image was built as; left out, the configuration has none. */
const build = (
	settings: { version?: string } = { version: 'test-version' },
): { manager: AuthManager; fakes: Fakes } => {
	const fakes: Fakes = {
		users: {
			findByUsername: jest.fn().mockResolvedValue(null),
			findForAuthentication: jest.fn().mockResolvedValue(null),
			findByProvider: jest.fn().mockResolvedValue(null),
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn(
				(value: Partial<User>) =>
					({
						id: 'mirrored-1',
						createdAt: new Date('2026-01-01T00:00:00.000Z'),
						updatedAt: new Date('2026-01-01T00:00:00.000Z'),
						...value,
					}) as User,
			),
			save: jest.fn((value: User) => Promise.resolve(value)),
			update: jest.fn().mockResolvedValue(undefined),
			touchLastSeen: jest.fn().mockResolvedValue(undefined),
			createQueryBuilder: jest.fn(),
			count: jest.fn().mockResolvedValue(0),
		},
		sessions: {
			findValidByHash: jest.fn().mockResolvedValue(null),
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<Session>) => ({ id: 'session-1', ...value }) as Session),
			save: jest.fn((value: Session) => Promise.resolve(value)),
			revoke: jest.fn().mockResolvedValue(undefined),
			revokeAllForUser: jest.fn().mockResolvedValue(1),
		},
		services: {
			findAuthProviders: jest.fn().mockResolvedValue([]),
			findWithSecrets: jest.fn().mockResolvedValue(null),
			setStatus: jest.fn().mockResolvedValue(undefined),
		},
		handlers: { get: jest.fn() },
		authenticate: jest.fn(),
	};

	fakes.handlers.get.mockReturnValue({ authenticate: fakes.authenticate });

	const manager = new AuthManager(
		fakes.users as unknown as UserRepository,
		fakes.sessions as unknown as SessionRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.handlers as unknown as HandlerRegistry,
		{ sign: jest.fn(() => 'access-token') } as unknown as JwtService,
		{
			getOrThrow: () => ({
				jwtSecret: 'test',
				accessTtl: '15m',
				refreshTtl: '30d',
				bcryptRounds: ROUNDS,
			}),
			get: () => settings.version,
		} as unknown as ConfigService,
	);

	return { manager, fakes };
};

/** A refusal is its class and its key: the class is the status, the key the wording. */
const expectRefusal = async (
	attempt: Promise<unknown>,
	type: new (...args: never[]) => Error,
	key: string,
): Promise<void> => {
	const error = await attempt.then(
		() => null,
		(reason: unknown) => reason,
	);

	expect(error).toBeInstanceOf(type);
	expect((error as Error).message).toBe(key);
};

const login = (overrides: Partial<LoginRequest> = {}): LoginRequest => ({
	provider: 'internal',
	username: 'admin',
	password: 'secret',
	...overrides,
});

describe('durationSeconds', () => {
	it('reads the forms the configuration accepts', () => {
		expect(durationSeconds('15m', 0)).toBe(900);
		expect(durationSeconds('30d', 0)).toBe(2_592_000);
		expect(durationSeconds('3600', 0)).toBe(3600);
	});

	it('reads a unit in either case, since the pattern admits both', () => {
		expect(durationSeconds('2H', 0)).toBe(7200);
		expect(durationSeconds('45 S', 0)).toBe(45);
	});

	it('falls back rather than producing a session that never expires', () => {
		expect(durationSeconds('whenever', 900)).toBe(900);
	});
});

describe('AuthManager', () => {
	describe('providers', () => {
		it('always offers the internal way in, first', async () => {
			const { manager } = build();

			await expect(manager.providers()).resolves.toEqual([
				expect.objectContaining({ key: 'internal', type: AuthProviderType.INTERNAL }),
			]);
		});

		it('offers every service flagged as an authentication provider', async () => {
			const { manager, fakes } = build();

			fakes.services.findAuthProviders.mockResolvedValue([
				{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Living room', type: MediaServiceType.JELLYFIN },
			] as MediaService[]);

			const providers = await manager.providers();

			expect(providers).toHaveLength(2);
			expect(providers[1]).toEqual({
				key: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				type: AuthProviderType.SERVICE,
				label: 'Living room',
				icon: 'jellyfin',
				credentials: true,
			});
		});
	});

	describe('signing in', () => {
		it('answers the same key for a wrong password and an account nobody has', async () => {
			const { manager, fakes } = build();

			await expect(manager.login(login())).rejects.toThrow(ErrorKey.AUTH_INVALID_CREDENTIALS);

			fakes.users.findForAuthentication.mockResolvedValue(await internalUser());

			await expect(manager.login(login({ password: 'wrong' }))).rejects.toThrow(
				ErrorKey.AUTH_INVALID_CREDENTIALS,
			);
		});

		it('refuses an internal sign-in for an account whose password lives elsewhere', async () => {
			const { manager, fakes } = build();

			fakes.users.findForAuthentication.mockResolvedValue(
				await internalUser({ passwordHash: null, provider: 'service:x' }),
			);

			await expect(manager.login(login())).rejects.toThrow(ErrorKey.AUTH_INVALID_CREDENTIALS);
		});

		it('issues a pair carrying the rights of the role', async () => {
			const { manager, fakes } = build();

			fakes.users.findForAuthentication.mockResolvedValue(await internalUser());

			const pair = await manager.login(login());

			expect(pair.accessToken).toBe('access-token');
			expect(pair.refreshToken).toHaveLength(96);
			expect(pair.expiresIn).toBe(900);
			expect(pair.rights).toContain('service.manage');
			expect(pair.user.username).toBe('admin');
		});

		it('stores only the hash of the refresh token', async () => {
			const { manager, fakes } = build();

			fakes.users.findForAuthentication.mockResolvedValue(await internalUser());

			const pair = await manager.login(login());
			const stored = fakes.sessions.create.mock.calls[0][0] as Session;

			expect(stored.refreshTokenHash).not.toBe(pair.refreshToken);
			expect(stored.refreshTokenHash).toHaveLength(64);
		});
	});

	describe('signing in through a media service', () => {
		const identity: ExternalIdentity = {
			externalUserId: 'jf-42',
			username: 'damien',
			displayName: 'Damien',
			email: 'damien@example.test',
			avatarUrl: null,
			token: 'their-session-token',
		};

		const registerProvider = (fakes: Fakes): void => {
			fakes.services.findWithSecrets.mockResolvedValue({
				id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
				token: 'api-key',
				username: null,
				password: null,
				authProvider: true,
			} as MediaService);
		};

		it('mirrors the account on first use and never stores a password', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue(identity);

			await manager.login(
				login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', password: 'their-password' }),
			);

			const created = fakes.users.create.mock.calls[0][0] as User;

			expect(created.passwordHash).toBeNull();
			expect(created.provider).toBe('service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
			expect(created.providerUserId).toBe('jf-42');
			// Being an administrator of somebody's Jellyfin says nothing about who may
			// reconfigure this gateway.
			expect(created.role).toBe(UserRole.USER);
		});

		it('reuses the mirror on the next sign-in rather than creating a second account', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue(identity);
			fakes.users.findByProvider.mockResolvedValue(
				await internalUser({ id: 'user-2', provider: 'service:x', providerUserId: 'jf-42' }),
			);
			fakes.users.save.mockImplementation((value: User) => Promise.resolve(value));

			await manager.login(login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));

			expect(fakes.users.create).not.toHaveBeenCalled();
		});

		it('keeps what it knows when the provider stops sending a name or an address', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue({
				...identity,
				displayName: null,
				email: null,
				avatarUrl: null,
			});
			fakes.users.findByProvider.mockResolvedValue(
				await internalUser({
					id: 'user-2',
					displayName: 'Damien D.',
					email: 'known@example.test',
					avatarUrl: 'http://jellyfin:8096/avatar.png',
					provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
					providerUserId: 'jf-42',
				}),
			);

			const pair = await manager.login(
				login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
			);

			// A server that omits a field is not saying it was deleted; blanking it on
			// every sign-in would erase what somebody set on a previous one.
			expect(pair.user.displayName).toBe('Damien D.');
			expect(pair.user.email).toBe('known@example.test');
			expect(pair.user.avatarUrl).toBe('http://jellyfin:8096/avatar.png');
		});

		it('takes the next free suffix when the username is already held here', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue(identity);
			fakes.users.findByUsername.mockImplementation(async (username: string) =>
				username === 'damien' ? internalUser({ username }) : null,
			);

			const pair = await manager.login(
				login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
			);

			// Two people called damien on two servers are two people: never the other
			// one's account, and never a failed sign-in either.
			expect(pair.user.username).toBe('damien-1');
		});

		it('names an account "user" when the provider sends a blank username', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue({ ...identity, username: '   ' });

			const pair = await manager.login(
				login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
			);

			expect(pair.user.username).toBe('user');
		});

		it('falls back to a random suffix rather than looping when a hundred are taken', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockResolvedValue(identity);
			fakes.users.findByUsername.mockImplementation(async (username: string) =>
				internalUser({ username }),
			);

			const pair = await manager.login(
				login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
			);

			expect(pair.user.username).toMatch(/^damien-[0-9a-f]{8}$/);
			expect(fakes.users.findByUsername).toHaveBeenCalledTimes(100);
		});

		it('refuses a provider key nothing registered', async () => {
			const { manager } = build();

			await expect(manager.login(login({ provider: 'service:nonsense' }))).rejects.toThrow(
				ErrorKey.AUTH_PROVIDER_UNKNOWN,
			);
		});

		it('refuses a service that is registered but is not an authentication provider', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.services.findWithSecrets.mockResolvedValue({
				id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				authProvider: false,
			} as MediaService);

			await expect(
				manager.login(login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })),
			).rejects.toThrow(ErrorKey.AUTH_PROVIDER_UNKNOWN);
		});

		it('tells a wrong password apart from a server that is down', async () => {
			const { manager, fakes } = build();

			registerProvider(fakes);
			fakes.authenticate.mockRejectedValue(new UnauthorizedException('nope'));

			await expect(
				manager.login(login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })),
			).rejects.toThrow(ErrorKey.AUTH_INVALID_CREDENTIALS);

			fakes.authenticate.mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(
				manager.login(login({ provider: 'service:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })),
			).rejects.toThrow(ErrorKey.AUTH_PROVIDER_UNREACHABLE);
		});
	});

	describe('refreshing', () => {
		it('spends the presented session and issues another', async () => {
			const { manager, fakes } = build();

			fakes.sessions.findValidByHash.mockResolvedValue({
				id: 'session-1',
				userId: 'user-1',
			} as Session);
			fakes.users.findOne.mockResolvedValue(await internalUser());

			const pair = await manager.refresh('a-refresh-token');

			expect(fakes.sessions.revoke).toHaveBeenCalledWith('session-1');
			expect(fakes.sessions.create).toHaveBeenCalled();
			expect(pair.refreshToken).not.toBe('a-refresh-token');
		});

		it('revokes every session of the account when a spent token comes back', async () => {
			const { manager, fakes } = build();

			// Valid lookup finds nothing, but the hash is one we have seen: the
			// legitimate client rotated it away, so whoever holds this one got it
			// somewhere else.
			fakes.sessions.findValidByHash.mockResolvedValue(null);
			fakes.sessions.findOne.mockResolvedValue({
				id: 'session-1',
				userId: 'user-1',
				revokedAt: new Date(),
			} as Session);

			await expect(manager.refresh('a-replayed-token')).rejects.toThrow(
				ErrorKey.AUTH_SESSION_EXPIRED,
			);

			expect(fakes.sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
		});

		it('leaves the account alone for a token nothing ever issued', async () => {
			const { manager, fakes } = build();

			await expect(manager.refresh('never-seen')).rejects.toThrow(ErrorKey.AUTH_SESSION_EXPIRED);

			expect(fakes.sessions.revokeAllForUser).not.toHaveBeenCalled();
		});

		it('refuses a session whose account has since been deleted', async () => {
			const { manager, fakes } = build();

			fakes.sessions.findValidByHash.mockResolvedValue({
				id: 'session-1',
				userId: 'ghost',
			} as Session);

			await expect(manager.refresh('a-refresh-token')).rejects.toThrow(
				ErrorKey.AUTH_SESSION_EXPIRED,
			);
		});
	});

	describe('changing a password', () => {
		const withPasswordHash = (fakes: Fakes, user: User | null): void => {
			fakes.users.createQueryBuilder.mockReturnValue({
				addSelect: () => ({ where: () => ({ getOne: () => Promise.resolve(user) }) }),
			});
		};

		it('refuses an account that no longer exists', async () => {
			const { manager, fakes } = build();

			withPasswordHash(fakes, null);

			await expectRefusal(
				manager.changePassword('user-1', 'secret', 'newer'),
				UnauthorizedException,
				ErrorKey.AUTH_SESSION_EXPIRED,
			);
			expect(fakes.users.update).not.toHaveBeenCalled();
		});

		it('refuses an account mirrored from a media service', async () => {
			const { manager, fakes } = build();

			withPasswordHash(fakes, await internalUser({ provider: 'service:x', passwordHash: null }));

			await expect(manager.changePassword('user-1', 'secret', 'newer')).rejects.toThrow(
				ForbiddenException,
			);
		});

		it('checks the current password before accepting a new one', async () => {
			const { manager, fakes } = build();

			withPasswordHash(fakes, await internalUser());

			await expect(manager.changePassword('user-1', 'wrong', 'newer')).rejects.toThrow(
				ErrorKey.AUTH_INVALID_CREDENTIALS,
			);
			expect(fakes.users.update).not.toHaveBeenCalled();
		});

		it('signs every session out, or the change protects nobody', async () => {
			const { manager, fakes } = build();

			withPasswordHash(fakes, await internalUser());

			await manager.changePassword('user-1', 'secret', 'newer');

			expect(fakes.users.update).toHaveBeenCalled();
			expect(fakes.sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
		});
	});

	it('signs out of every session, because the access token does not name its own', async () => {
		const { manager, fakes } = build();

		await manager.logout('user-1');

		expect(fakes.sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
	});

	it('reads the session back from the database rather than from the token', async () => {
		const { manager, fakes } = build();

		fakes.users.findOne.mockResolvedValue(await internalUser({ role: UserRole.GUEST }));

		const session = await manager.session('user-1');

		expect(session.rights).toEqual(['library.read', 'media.read']);
	});

	it('refuses to read back a session whose account was deleted after sign-in', async () => {
		const { manager } = build();

		// The token is still signed and unexpired; the account behind it is gone, and
		// a session read for nobody would hand the interface rights nobody holds.
		await expectRefusal(
			manager.session('user-1'),
			UnauthorizedException,
			ErrorKey.AUTH_SESSION_EXPIRED,
		);
	});

	describe('the first administrator', () => {
		it('refuses once any account exists, which is the only thing guarding the open route', async () => {
			const { manager, fakes } = build();

			fakes.users.count.mockResolvedValue(1);

			await expectRefusal(
				manager.setup({ username: 'intruder', password: 'long enough' }),
				ConflictException,
				ErrorKey.AUTH_FORBIDDEN,
			);
			expect(fakes.users.save).not.toHaveBeenCalled();
		});

		it.each([
			['a blank username', { username: '   ', password: 'long enough' }],
			['a password under eight characters', { username: 'admin', password: 'short' }],
		])('refuses %s', async (_, request) => {
			const { manager, fakes } = build();

			await expectRefusal(
				manager.setup(request),
				BadRequestException,
				ErrorKey.AUTH_INVALID_CREDENTIALS,
			);
			expect(fakes.users.save).not.toHaveBeenCalled();
		});

		it('creates an administrator with a hash, and signs them straight in', async () => {
			const { manager, fakes } = build();

			const pair = await manager.setup({ username: ' admin ', password: 'long enough' });
			const created = fakes.users.create.mock.calls[0][0] as User;

			expect(created.username).toBe('admin');
			// No display name given is the username, not an empty label in the header.
			expect(created.displayName).toBe('admin');
			expect(created.role).toBe(UserRole.ADMIN);
			expect(created.passwordHash).not.toBe('long enough');
			expect(pair.accessToken).toBe('access-token');
		});

		it('says setup is required only while no account exists', async () => {
			const { manager, fakes } = build();

			await expect(manager.setupState()).resolves.toEqual({
				required: true,
				version: 'test-version',
			});

			fakes.users.count.mockResolvedValue(1);

			await expect(manager.setupState()).resolves.toMatchObject({ required: false });
		});

		it('reports a development build when the image carries no version', async () => {
			const { manager } = build({});

			await expect(manager.setupState()).resolves.toMatchObject({ version: 'dev' });
		});
	});

	describe('the administrator of an unattended install', () => {
		const environment = { ...process.env };

		afterEach(() => {
			process.env = { ...environment };
		});

		it.each([
			['a username without a password', { MCS_ADMIN_USER: 'admin' }],
			['a password without a username', { MCS_ADMIN_PASSWORD: 'long enough' }],
			['a username of blanks', { MCS_ADMIN_USER: '  ', MCS_ADMIN_PASSWORD: 'long enough' }],
		])('creates nobody from %s, and leaves the setup screen to ask', async (_, variables) => {
			const { manager, fakes } = build();

			delete process.env.MCS_ADMIN_USER;
			delete process.env.MCS_ADMIN_PASSWORD;
			Object.assign(process.env, variables);

			await manager.onApplicationBootstrap();

			expect(fakes.users.save).not.toHaveBeenCalled();
		});

		it('creates nobody when an account already exists, at every restart', async () => {
			const { manager, fakes } = build();

			process.env.MCS_ADMIN_USER = 'admin';
			process.env.MCS_ADMIN_PASSWORD = 'long enough';
			fakes.users.count.mockResolvedValue(1);

			await manager.onApplicationBootstrap();

			expect(fakes.users.save).not.toHaveBeenCalled();
		});

		it('creates the administrator the environment names when nobody exists yet', async () => {
			const { manager, fakes } = build();

			process.env.MCS_ADMIN_USER = ' admin ';
			process.env.MCS_ADMIN_PASSWORD = 'long enough';

			await manager.onApplicationBootstrap();

			const created = fakes.users.create.mock.calls[0][0] as User;

			expect(created.username).toBe('admin');
			expect(created.role).toBe(UserRole.ADMIN);
		});

		it('still boots when the environment names a password it refuses', async () => {
			const { manager, fakes } = build();

			process.env.MCS_ADMIN_USER = 'admin';
			process.env.MCS_ADMIN_PASSWORD = 'short';

			// Throwing here would stop the gateway, and with it the setup screen that is
			// the only way left to finish the job.
			await expect(manager.onApplicationBootstrap()).resolves.toBeUndefined();
			expect(fakes.users.save).not.toHaveBeenCalled();
		});
	});
});
