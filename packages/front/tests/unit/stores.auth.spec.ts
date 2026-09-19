import { AuthProviderType, Right, UserRole } from '@mcs/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { createStoreContext, stubFetch } from './helpers';

const user = {
	id: 'u1',
	username: 'ada',
	displayName: 'Ada',
	email: null,
	role: UserRole.USER,
	provider: 'internal',
	providerUserId: null,
	avatarUrl: null,
	lastSeenAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function tokenPair (overrides: Record<string, unknown> = {}) {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		user,
		rights: [Right.LIBRARY_READ, Right.MEDIA_READ],
		...overrides,
	};
}

describe('stores/auth', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('starts with nobody signed in', () => {
		const authStore = useAuthStore();
		expect(authStore.authenticated).toBe(false);
		expect(authStore.user).toBeNull();
		expect(authStore.rights).toEqual([]);
		expect(authStore.hasRight(Right.LIBRARY_READ)).toBe(false);
	});

	it('lists the providers the gateway offers', async () => {
		const stub = stubFetch([{ body: [{
			key: 'internal',
			type: AuthProviderType.INTERNAL,
			label: 'Gateway account',
			icon: 'key',
			credentials: true,
		}] }]);

		const providers = await useAuthStore().loadProviders();

		expect(stub.mock.calls[0][0]).toBe('/api/auth/providers');
		expect(providers).toHaveLength(1);
		expect(useAuthStore().providersLoaded).toBe(true);
	});

	it('signs in and keeps the session', async () => {
		const stub = stubFetch([{ body: tokenPair() }]);
		const authStore = useAuthStore();

		const signedIn = await authStore.login({ provider: 'internal', username: 'ada', password: 'secret' });

		expect(stub.mock.calls[0][0]).toBe('/api/auth/login');
		expect(JSON.parse((stub.mock.calls[0][1] as RequestInit).body as string)).toEqual({
			provider: 'internal', username: 'ada', password: 'secret',
		});
		expect(signedIn.username).toBe('ada');
		expect(authStore.authenticated).toBe(true);
		expect(authStore.user?.rights).toEqual([Right.LIBRARY_READ, Right.MEDIA_READ]);
	});

	it('answers on rights, never on the role', async () => {
		stubFetch([{ body: tokenPair() }]);
		const authStore = useAuthStore();
		await authStore.login({ provider: 'internal', username: 'ada', password: 'secret' });

		expect(authStore.hasRight(Right.LIBRARY_READ)).toBe(true);
		expect(authStore.hasRight([Right.LIBRARY_READ, Right.MEDIA_READ])).toBe(true);
		expect(authStore.hasRight(Right.SETTINGS_MANAGE)).toBe(false);
		expect(authStore.hasRight([Right.LIBRARY_READ, Right.SETTINGS_MANAGE])).toBe(false);
	});

	it('leaves a failed sign-in with no session at all', async () => {
		stubFetch([{ status: 401, body: { statusCode: 401, message: 'error.auth.invalid_credentials' } }]);
		const authStore = useAuthStore();

		await expect(authStore.login({ provider: 'internal', username: 'ada', password: 'no' })).rejects.toBeTruthy();
		expect(authStore.authenticated).toBe(false);
	});

	it('logout revokes the session server-side and forgets it', async () => {
		stubFetch([{ body: tokenPair() }, { body: null }]);
		const authStore = useAuthStore();
		await authStore.login({ provider: 'internal', username: 'ada', password: 'secret' });

		const stub = stubFetch([{ body: null }]);
		await authStore.logout();

		expect(stub.mock.calls[0][0]).toBe('/api/auth/logout');
		expect(authStore.authenticated).toBe(false);
		expect(useTokenStore().session).toBeNull();
		expect(window.localStorage.getItem('mcs.session')).toBe('null');
	});

	it('forgets the session even when the gateway cannot be reached', async () => {
		stubFetch([{ body: tokenPair() }]);
		const authStore = useAuthStore();
		await authStore.login({ provider: 'internal', username: 'ada', password: 'secret' });

		globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
		await authStore.logout();

		expect(authStore.authenticated).toBe(false);
	});

	it('restore refreshes a stored session that has expired', async () => {
		useTokenStore().store(tokenPair({ expiresIn: -60 }) as never);
		const stub = stubFetch([{ body: tokenPair({ accessToken: 'access-2' }) }]);
		const authStore = useAuthStore();

		await authStore.restore();

		expect(stub.mock.calls[0][0]).toBe('/api/auth/refresh');
		expect(authStore.ready).toBe(true);
		expect(authStore.authenticated).toBe(true);
	});

	it('restore drops a session the gateway no longer honours', async () => {
		useTokenStore().store(tokenPair({ expiresIn: -60 }) as never);
		stubFetch([{ status: 401, body: { statusCode: 401, message: 'error.auth.session_expired' } }]);
		const authStore = useAuthStore();

		await authStore.restore();

		expect(authStore.ready).toBe(true);
		expect(authStore.authenticated).toBe(false);
	});

	it('reports a gateway that has never been claimed', async () => {
		const stub = stubFetch([{ body: { required: true, version: '1.4.0' } }]);

		const state = await useAuthStore().loadSetupState();

		expect(stub.mock.calls[0][0]).toBe('/api/auth/setup');
		expect(state?.required).toBe(true);
		expect(useAuthStore().setupRequired).toBe(true);
		expect(useAuthStore().setupVersion).toBe('1.4.0');
	});

	it('reads a gateway that cannot answer as one that does not need setting up', async () => {
		// An older gateway does not serve this route at all, and trapping everybody
		// on a setup screen because of a 404 would be the worse of the two mistakes.
		stubFetch([{ status: 404, body: { message: 'Cannot GET /api/auth/setup' } }]);

		expect(await useAuthStore().loadSetupState()).toBeNull();
		expect(useAuthStore().setupRequired).toBe(false);
	});

	it('creates the first administrator and keeps the session it answered', async () => {
		const stub = stubFetch([{ status: 201, body: tokenPair() }]);
		const authStore = useAuthStore();
		authStore.setupRequired = true;

		const created = await authStore.setup({ username: 'ada', password: 'correct horse' });

		expect(stub.mock.calls[0][0]).toBe('/api/auth/setup');
		expect((stub.mock.calls[0][1] as RequestInit).method).toBe('POST');
		expect(created.username).toBe('ada');
		expect(useTokenStore().accessToken).toBe('access-1');
		// The open route has just closed itself, so nothing should offer it again.
		expect(authStore.setupRequired).toBe(false);
		expect(authStore.authenticated).toBe(true);
	});

	it('restore asks whether the gateway has been claimed, and nothing else', async () => {
		// With nothing stored there is no session to prove, but there is still one
		// question: a gateway with no account at all has to lead to its setup screen
		// rather than to a sign-in page nobody can use.
		const stub = stubFetch([{ body: { required: false, version: '1.2.3' } }]);
		const authStore = useAuthStore();
		await authStore.restore();

		expect(authStore.ready).toBe(true);
		expect(authStore.authenticated).toBe(false);
		expect(authStore.setupRequired).toBe(false);
		expect(stub).toHaveBeenCalledTimes(1);
		expect(stub.mock.calls[0][0]).toBe('/api/auth/setup');
	});

	it('restore runs once however many callers ask for it', async () => {
		useTokenStore().store(tokenPair({ expiresIn: -60 }) as never);
		const stub = stubFetch([{ body: tokenPair() }]);
		const authStore = useAuthStore();

		await Promise.all([authStore.restore(), authStore.whenReady(), authStore.restore()]);

		expect(stub).toHaveBeenCalledTimes(1);
	});
});
