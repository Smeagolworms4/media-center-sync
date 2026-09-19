import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { useTokenStore } from '@/stores/token';
import { createStoreContext, stubFetch } from './helpers';

function pair (overrides: Record<string, unknown> = {}) {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		user: { id: 'u1', username: 'ada' },
		rights: [],
		...overrides,
	};
}

describe('stores/token', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('turns the relative lifetime into an absolute deadline', () => {
		const tokenStore = useTokenStore();
		const before = Date.now();

		const stored = tokenStore.store(pair() as never);

		expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
		expect(tokenStore.isValid).toBe(true);
		expect(tokenStore.accessToken).toBe('access-1');
		expect(tokenStore.refreshToken).toBe('refresh-1');
	});

	it('treats a token about to expire as already stale', () => {
		const tokenStore = useTokenStore();
		tokenStore.store(pair({ expiresIn: 5 }) as never);

		expect(tokenStore.authenticated).toBe(true);
		expect(tokenStore.isValid).toBe(false);
	});

	it('survives a reload through local storage', async () => {
		useTokenStore().store(pair() as never);
		// The ref writes through a watcher, which runs after the current tick.
		await nextTick();
		expect(window.localStorage.getItem('mcs.session')).toBeTruthy();

		// A fresh application over the same storage is what a page reload is.
		createStoreContext();

		expect(useTokenStore().accessToken).toBe('access-1');
		expect(useTokenStore().authenticated).toBe(true);
	});

	it('refreshes with the stored refresh token', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(pair({ expiresIn: -10 }) as never);
		const stub = stubFetch([{ body: pair({ accessToken: 'access-2', refreshToken: 'refresh-2' }) }]);

		await tokenStore.refresh();

		expect(JSON.parse((stub.mock.calls[0][1] as RequestInit).body as string))
			.toEqual({ refreshToken: 'refresh-1' });
		expect(tokenStore.accessToken).toBe('access-2');
		expect(tokenStore.refreshToken).toBe('refresh-2');
	});

	it('clears the session when the refresh is refused', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(pair({ expiresIn: -10 }) as never);
		stubFetch([{ status: 401, body: { statusCode: 401, message: 'error.auth.session_expired' } }]);

		await expect(tokenStore.refresh()).rejects.toBeTruthy();
		expect(tokenStore.session).toBeNull();
	});

	it('refreshes once for several callers racing on a stale token', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(pair({ expiresIn: -10 }) as never);
		const stub = stubFetch([{ body: pair({ accessToken: 'access-2' }) }]);

		const tokens = await Promise.all([
			tokenStore.getAccessToken(),
			tokenStore.getAccessToken(),
			tokenStore.getAccessToken(),
		]);

		expect(stub).toHaveBeenCalledTimes(1);
		expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
	});

	it('hands out nothing when there is no session', async () => {
		expect(await useTokenStore().getAccessToken()).toBeNull();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('returns nothing rather than throwing when the refresh fails', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(pair({ expiresIn: -10 }) as never);
		stubFetch([{ status: 401, body: {} }]);

		expect(await tokenStore.getAccessToken()).toBeNull();
	});

	it('revoke without a session does not call the API', async () => {
		const tokenStore = useTokenStore();
		await tokenStore.revoke();

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(tokenStore.session).toBeNull();
	});
});
