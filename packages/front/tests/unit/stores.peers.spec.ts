import type { Peer } from '@mcs/shared';
import { EventName, PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePeersStore } from '@/stores/peers';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

function peer (overrides: Partial<Peer> = {}): Peer {
	return {
		id: 'p1',
		name: 'Bob',
		nodeId: null,
		protocol: 1,
		capabilities: [],
		fingerprint: 'AB:CD',
		status: PeerStatus.LINKED,
		direction: null,
		trust: PeerTrust.FRIEND,
		linkMode: PeerLinkMode.DIRECT,
		address: '203.0.113.9:4210',
		viaPeerId: null,
		viaPeerName: null,
		serviceCount: 1,
		sharedItemCount: 120,
		lastSeenAt: '2026-02-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('stores/peers', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('loads the peers and our own identity', async () => {
		stubFetch([
			{ body: [peer()] },
			{ body: { fingerprint: 'FF:EE', name: 'me', rendezvous: 'wss://r', directAddress: null, directReachable: false } },
		]);
		const store = usePeersStore();

		await store.load();
		await store.loadIdentity();

		expect(store.byId.p1.name).toBe('Bob');
		expect(store.identity?.directReachable).toBe(false);
	});

	it('keeps the failure instead of pretending nobody is linked', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = usePeersStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
	});

	it('adds the peer an accepted invitation produced', async () => {
		stubFetch([{ body: peer({ id: 'p2', name: 'Carol' }) }]);
		const store = usePeersStore();

		await store.accept({ invite: 'mcs://invite/xyz', name: 'Carol' });

		expect(store.peers.map(one => one.id)).toEqual(['p2']);
	});

	it('replaces the peer a block answered with', async () => {
		stubFetch([{ body: [peer()] }, { body: peer({ status: PeerStatus.BLOCKED }) }]);
		const store = usePeersStore();
		await store.load();

		await store.block('p1');

		expect(store.byId.p1.status).toBe(PeerStatus.BLOCKED);
		expect(store.peers).toHaveLength(1);
	});

	it('applies a status frame without re-reading the list', async () => {
		stubFetch([{ body: [peer()] }]);
		const store = usePeersStore();
		await store.load();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.PEER_STATUS, {
			id: 'p1',
			status: PeerStatus.UNREACHABLE,
			linkMode: PeerLinkMode.RELAY,
			lastSeenAt: '2026-03-01T00:00:00.000Z',
		});

		expect(store.byId.p1.status).toBe(PeerStatus.UNREACHABLE);
		expect(store.byId.p1.linkMode).toBe(PeerLinkMode.RELAY);
	});

	it('drops a removed peer', async () => {
		stubFetch([{ body: [peer(), peer({ id: 'p2' })] }, {}]);
		const store = usePeersStore();
		await store.load();

		await store.remove('p1');

		expect(store.peers.map(one => one.id)).toEqual(['p2']);
	});
});
