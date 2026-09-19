import type { User } from '@mcs/shared';
import { UserRole } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { isMirroredUser, useUsersStore } from '@/stores/users';
import { createStoreContext, stubFetch } from './helpers';

function user (overrides: Partial<User> = {}): User {
	return {
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
		...overrides,
	};
}

describe('isMirroredUser', () => {
	it('is false for an account the gateway itself issued', () => {
		expect(isMirroredUser(user())).toBe(false);
	});

	/** The username and the password of a mirrored account live on the media service. */
	it('is true for an account that came from a media service', () => {
		expect(isMirroredUser(user({ provider: 'service:8f1c' }))).toBe(true);
	});
});

describe('stores/users', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('loads the accounts', async () => {
		stubFetch([{ body: [user(), user({ id: 'u2', username: 'bob' })] }]);
		const store = useUsersStore();

		await store.load();

		expect(store.users).toHaveLength(2);
		expect(store.loaded).toBe(true);
	});

	it('keeps the failure so the page can show an error', async () => {
		stubFetch([{ status: 403, body: { message: 'error.auth.forbidden' } }]);
		const store = useUsersStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
	});

	it('replaces the row a role change answered with', async () => {
		const stub = stubFetch([{ body: [user()] }, { body: user({ role: UserRole.ADMIN }) }]);
		const store = useUsersStore();
		await store.load();

		await store.update('u1', { role: UserRole.ADMIN });

		expect(stub.mock.calls[1][1]?.method).toBe('PATCH');
		expect(store.users).toHaveLength(1);
		expect(store.users[0].role).toBe(UserRole.ADMIN);
	});

	it('drops a removed account', async () => {
		stubFetch([{ body: [user(), user({ id: 'u2' })] }, {}]);
		const store = useUsersStore();
		await store.load();

		await store.remove('u1');

		expect(store.users.map(one => one.id)).toEqual(['u2']);
	});
});
