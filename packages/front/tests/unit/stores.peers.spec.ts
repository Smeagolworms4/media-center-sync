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
		depth: 1,
		maxDepth: null,
		readingForbidden: false,
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

	it('replaces the peer forbidding it to read answered with, and keeps it linked', async () => {
		// The link is deliberately kept open, so the row has to come back linked and
		// forbidden at once — a store that dropped it, or marked it unreachable, would
		// describe the behaviour this action was written to stop.
		stubFetch([{ body: [peer()] }, { body: peer({ readingForbidden: true }) }]);
		const store = usePeersStore();
		await store.load();

		await store.setReadingForbidden('p1', true);

		expect(store.byId.p1.readingForbidden).toBe(true);
		expect(store.byId.p1.status).toBe(PeerStatus.LINKED);
		expect(store.peers).toHaveLength(1);
	});

	it('sends the flag rather than guessing from the row it holds', async () => {
		const stub = stubFetch([{ body: peer({ readingForbidden: false }) }]);
		const store = usePeersStore();
		store.peers = [peer({ readingForbidden: true })];

		await store.setReadingForbidden('p1', false);

		const [url, options] = stub.mock.calls[0] as [string, RequestInit];

		expect(url).toContain('/peers/p1/reading');
		expect(options.method).toBe('PATCH');
		expect(JSON.parse(String(options.body))).toEqual({ forbidden: false });
		expect(store.byId.p1.readingForbidden).toBe(false);
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

	describe('bans, which outlive the peer row', () => {
		it('refuses nobody when a peer is removed: the ban is its own action now', async () => {
			// The checkbox that used to ride on the removal is gone, so this call can no
			// longer carry one — which is the safe direction to fail in.
			const stub = stubFetch([{ status: 204 }]);
			const store = usePeersStore();
			store.peers = [peer()];

			await store.remove('p1');

			expect(store.peers).toHaveLength(0);
			// One call, so nothing went looking for a ban list that was never written.
			expect(stub).toHaveBeenCalledTimes(1);

			const [url, options] = stub.mock.calls[0] as [string, RequestInit];

			expect(url).toContain('/peers/p1');
			expect(options.method).toBe('DELETE');
			expect(options.body ?? null).toBeNull();
		});

		it('drops the peer from the list and adds it to the bans', async () => {
			stubFetch([
				{ body: { fingerprint: 'AB:CD', name: 'Bob', reason: null, bannedAt: '2026-02-02T00:00:00.000Z' } },
			]);
			const store = usePeersStore();
			store.peers = [peer()];

			await store.ban('p1');

			expect(store.peers).toHaveLength(0);
			expect(store.bans.map(one => one.fingerprint)).toEqual(['AB:CD']);
		});

		it('never lists the same fingerprint twice', async () => {
			// Banning a key that is already banned is somebody making sure, not an
			// error, and the list has to read as one decision rather than two.
			stubFetch([
				{ body: { fingerprint: 'AB:CD', name: 'Bob', reason: 'again', bannedAt: '2026-02-03T00:00:00.000Z' } },
			]);
			const store = usePeersStore();
			store.bans = [{ fingerprint: 'AB:CD', name: 'Bob', reason: null, bannedAt: '2026-02-02T00:00:00.000Z' }];

			await store.banFingerprint('AB:CD');

			expect(store.bans).toHaveLength(1);
			expect(store.bans[0].reason).toBe('again');
		});

		it('lifting a ban takes it off the list and links nobody', async () => {
			stubFetch([{ status: 204 }]);
			const store = usePeersStore();
			store.bans = [{ fingerprint: 'AB:CD', name: 'Bob', reason: null, bannedAt: '2026-02-02T00:00:00.000Z' }];

			await store.unban('AB:CD');

			expect(store.bans).toHaveLength(0);
			expect(store.peers).toHaveLength(0);
		});

		it('answers an empty body with an empty list rather than a broken screen', async () => {
			stubFetch([{ status: 200, body: null }]);
			const store = usePeersStore();

			await expect(store.loadBans()).resolves.toEqual([]);
		});
	});

	describe('how far a peer may introduce', () => {
		it('sends null to put the peer back on the gateway ceiling', async () => {
			// Null means "follow the default", not a limit of zero — and an omitted key
			// would be read as "leave it alone", which is a different instruction.
			const stub = stubFetch([{ body: peer({ maxDepth: null }) }]);
			const store = usePeersStore();
			store.peers = [peer({ maxDepth: 4 })];

			await store.setMaxDepth('p1', null);

			const [, options] = stub.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(String(options.body))).toEqual({ maxDepth: null });
			expect(store.byId.p1.maxDepth).toBeNull();
		});

		it('keeps the answer rather than what was typed', async () => {
			stubFetch([{ body: peer({ maxDepth: 2 }) }]);
			const store = usePeersStore();
			store.peers = [peer()];

			await store.setMaxDepth('p1', 2);

			expect(store.byId.p1.maxDepth).toBe(2);
		});
	});
});
