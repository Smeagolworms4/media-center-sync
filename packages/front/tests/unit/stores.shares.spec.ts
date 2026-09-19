import type { SharePolicy } from '@mcs/shared';
import { ShareVisibility } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSharesStore } from '@/stores/shares';
import { createStoreContext, stubFetch } from './helpers';

function policy (overrides: Partial<SharePolicy> = {}): SharePolicy {
	return {
		id: 'sp1',
		libraryId: 'l1',
		libraryName: 'Shows',
		serviceId: 's1',
		visibility: ShareVisibility.FRIENDS,
		allowedPeerIds: [],
		deniedPeerIds: [],
		relays: false,
		relay: false,
		rateLimit: 0,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('stores/shares', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('loads the policies and indexes them by library', async () => {
		stubFetch([{ body: [policy(), policy({ id: 'sp2', libraryId: 'l2' })] }]);
		const store = useSharesStore();

		await store.load();

		expect(store.byLibraryId.l2.id).toBe('sp2');
	});

	it('keeps the failure rather than reporting every library private', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useSharesStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
		expect(store.policies).toHaveLength(0);
	});

	/** A library has at most one policy, so saving replaces it rather than adding. */
	it('saves a policy with PUT and replaces the row in place', async () => {
		const stub = stubFetch([
			{ body: [policy()] },
			{ body: policy({ visibility: ShareVisibility.FRIENDS_OF_FRIENDS }) },
		]);
		const store = useSharesStore();
		await store.load();

		await store.save('l1', { visibility: ShareVisibility.FRIENDS_OF_FRIENDS });

		expect(stub.mock.calls[1][1]?.method).toBe('PUT');
		expect(store.policies).toHaveLength(1);
		expect(store.byLibraryId.l1.visibility).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
	});

	it('makes a library private again by deleting its policy', async () => {
		stubFetch([{ body: [policy()] }, {}]);
		const store = useSharesStore();
		await store.load();

		await store.remove('l1');

		expect(store.policies).toHaveLength(0);
		expect(store.byLibraryId.l1).toBeUndefined();
	});

	it('asks what one peer would see', async () => {
		const stub = stubFetch([{ body: { peerId: 'p1', peerName: 'Bob', trust: 'friend', libraries: [] } }]);
		const store = useSharesStore();

		const audit = await store.audit('p1');

		expect(String(stub.mock.calls[0][0])).toContain('/api/shares/audit/p1');
		expect(audit.peerName).toBe('Bob');
	});
});
