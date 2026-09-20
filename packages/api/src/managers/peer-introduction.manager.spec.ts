import {
	ErrorKey,
	PEER_INTRODUCE_METHOD,
	PeerCapability,
	PeerLinkMode,
	PeerStatus,
	PeerTrust,
} from '@mcs/shared';
import type { Peer } from '@/entities';
import type { BannedPeerRepository, PeerRepository } from '@/repositories';
import type { PeerLinkService, SettingsService } from '@/services';
import { PeerIntroductionManager } from './peer-introduction.manager';
import type { PeerManager } from './peer.manager';

const HOLDER_FINGERPRINT = 'c'.repeat(64);

const peerRow = (overrides: Partial<Peer> = {}): Peer =>
	({
		id: 'peer-bob',
		name: 'Bob',
		fingerprint: 'b'.repeat(64),
		status: PeerStatus.LINKED,
		trust: PeerTrust.FRIEND,
		depth: 1,
		maxDepth: null,
		discovered: false,
		readingForbidden: false,
		linkMode: null,
		address: null,
		viaPeerId: null,
		capabilities: [],
		lastSeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Peer;

/**
 * Everything around the manager, and not one socket among it.
 *
 * `connect` stands in for the whole dial ladder — direct, then an introduction, then
 * relayed — which is `PeerLinkService`'s and is pinned where a socket is allowed. What
 * these tests are about is what this manager does with each outcome: which row it
 * writes, what it hands the link service, and what it leaves behind when a dial fails.
 */
const build = (
	{
		keepDiscoveredPeers = false,
		linked = true,
		supports = true,
	}: { keepDiscoveredPeers?: boolean; linked?: boolean; supports?: boolean } = {},
) => {
	const rows = new Map<string, Peer>([['peer-bob', peerRow()]]);
	const fakes = {
		peers: {
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(rows.get(options.where.id) ?? null),
			),
			findByFingerprint: jest.fn().mockResolvedValue(null),
			findWithPublicKey: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<Peer>) => peerRow({ id: 'peer-chris', ...value })),
			save: jest.fn((value: Peer) => {
				rows.set(value.id, value);

				return Promise.resolve(value);
			}),
			setStatus: jest.fn((id: string, status: PeerStatus, mode?: PeerLinkMode) => {
				const row = rows.get(id);

				if (row) {
					rows.set(id, { ...row, status, linkMode: mode ?? row.linkMode } as Peer);
				}

				return Promise.resolve();
			}),
			recordHandshake: jest.fn().mockResolvedValue(undefined),
			delete: jest.fn((criteria: { id: string }) => {
				rows.delete(criteria.id);

				return Promise.resolve();
			}),
		},
		bans: { isBanned: jest.fn().mockResolvedValue(false) },
		links: {
			isLinked: jest.fn(() => linked),
			supports: jest.fn(() => supports),
			request: jest.fn().mockResolvedValue({
				token: 'a-token',
				fingerprint: HOLDER_FINGERPRINT,
				address: '203.0.113.4:4200',
				expiresAt: new Date(Date.now() + 120_000).toISOString(),
				depth: 2,
			}),
			connect: jest.fn().mockResolvedValue({
				peerId: 'peer-chris',
				mode: PeerLinkMode.DIRECT,
				address: '203.0.113.4:4200',
				connected: true,
				since: new Date().toISOString(),
				protocol: 1,
				capabilities: [PeerCapability.CONTENT],
				nodeId: 'node-chris',
			}),
		},
		settings: {
			get: jest.fn().mockResolvedValue({ keepDiscoveredPeers }),
			getValue: jest.fn().mockResolvedValue(null),
		},
		manager: {
			remove: jest.fn((id: string) => {
				rows.delete(id);

				return Promise.resolve();
			}),
		},
		rows,
	};

	const manager = new PeerIntroductionManager(
		fakes.peers as unknown as PeerRepository,
		fakes.bans as unknown as BannedPeerRepository,
		fakes.links as unknown as PeerLinkService,
		fakes.settings as unknown as SettingsService,
		fakes.manager as unknown as PeerManager,
	);

	return { manager, fakes };
};

describe('PeerIntroductionManager', () => {
	describe('being introduced', () => {
		it('asks the friend in the middle and links straight to the holder', async () => {
			// The point of the whole design: one small request crosses the friend, and
			// the bytes never do.
			const { manager, fakes } = build();
			const peer = await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.links.request).toHaveBeenCalledWith('peer-bob', PEER_INTRODUCE_METHOD, {
				holderId: 'their-row-42',
			});
			expect(peer).toMatchObject({
				fingerprint: HOLDER_FINGERPRINT,
				status: PeerStatus.LINKED,
				trust: PeerTrust.FRIEND_OF_FRIEND,
				depth: 2,
				viaPeerId: 'peer-bob',
			});
		});

		it('presents the token on the upgrade and names who minted it', async () => {
			// The friend in the middle is named alongside the token so the ladder does
			// not ask them for a second one it already holds, and so its last rung falls
			// back through that same friend rather than through somebody who agreed to
			// nothing.
			const { manager, fakes } = build();

			await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.links.connect).toHaveBeenCalledWith(
				expect.objectContaining({ fingerprint: HOLDER_FINGERPRINT, address: '203.0.113.4:4200' }),
				{ introduction: 'a-token', via: 'peer-bob', introducers: ['peer-bob'] },
			);
			// And nothing reads a rendezvous setting on the way: there is no such thing.
			expect(fakes.settings.getValue).not.toHaveBeenCalled();
		});

		it('records a relayed link as relayed when neither end could be dialled', async () => {
			// The fallback is the ordinary ladder's last rung rather than a mode of its
			// own, and the friend in the middle then really does carry the bytes — which
			// is why the mode is written down rather than smoothed over.
			const { manager, fakes } = build();

			fakes.links.connect.mockResolvedValue({
				peerId: 'peer-chris',
				mode: PeerLinkMode.RELAY,
				address: '198.51.100.9:4200',
				connected: true,
				since: new Date().toISOString(),
				protocol: 1,
				capabilities: [],
				nodeId: null,
			});

			await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.peers.setStatus).toHaveBeenCalledWith(
				'peer-chris',
				PeerStatus.LINKED,
				PeerLinkMode.RELAY,
				'198.51.100.9:4200',
			);
		});

		it('leaves no row behind when the holder cannot be reached at all', async () => {
			// Neither a direct socket nor the relay. A row kept here would be a gateway
			// in the peers list that nobody invited and nobody ever reached.
			const { manager, fakes } = build();

			fakes.links.connect.mockRejectedValue(new Error('no route'));

			await expect(manager.reach('peer-bob', 'their-row-42')).rejects.toThrow(
				ErrorKey.PEER_UNREACHABLE,
			);
			expect(fakes.rows.has('peer-chris')).toBe(false);
		});

		it('keeps the peer when the gateway was told to keep the ones it meets', async () => {
			const { manager, fakes } = build({ keepDiscoveredPeers: true });

			await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.peers.create).toHaveBeenCalledWith(
				expect.objectContaining({ discovered: false }),
			);
		});

		it('marks the peer as temporary by default', async () => {
			const { manager, fakes } = build();

			await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.peers.create).toHaveBeenCalledWith(
				expect.objectContaining({ discovered: true }),
			);
		});

		it('asks nobody who has never advertised that they introduce', async () => {
			// The rule the whole versioning scheme rests on. A gateway from before this
			// existed answers "method not supported", and reporting that as a refusal
			// would read a release difference as a decision.
			const { manager, fakes } = build({ supports: false });

			await expect(manager.reach('peer-bob', 'their-row-42')).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
			expect(fakes.links.request).not.toHaveBeenCalled();
		});

		it('says the friend is unreachable rather than asking a link that is not open', async () => {
			const { manager } = build({ linked: false });

			await expect(manager.reach('peer-bob', 'their-row-42')).rejects.toThrow(
				ErrorKey.PEER_UNREACHABLE,
			);
		});

		it('refuses a holder whose key is on the ban list', async () => {
			// The ban outlives the peer row, which is the whole reason it exists: a key
			// we refused does not come back through a friend.
			const { manager, fakes } = build();

			fakes.bans.isBanned.mockResolvedValue(true);

			await expect(manager.reach('peer-bob', 'their-row-42')).rejects.toThrow(
				ErrorKey.PEER_BANNED,
			);
		});

		it('reopens a friend we already know without using a token on them', async () => {
			// A token is a way to meet a stranger. Using one on somebody already in the
			// list would rewrite a relationship from a statement made by a third party.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ id: 'peer-chris', fingerprint: HOLDER_FINGERPRINT, discovered: false }),
			);

			const peer = await manager.reach('peer-bob', 'their-row-42');

			expect(peer.fingerprint).toBe(HOLDER_FINGERPRINT);
			expect(fakes.peers.create).not.toHaveBeenCalled();
		});

		it('never believes a holder is nearer than two hops', async () => {
			const { manager, fakes } = build();

			fakes.links.request.mockResolvedValue({
				token: 'a-token',
				fingerprint: HOLDER_FINGERPRINT,
				address: null,
				expiresAt: new Date().toISOString(),
				depth: 1,
			});

			await manager.reach('peer-bob', 'their-row-42');

			expect(fakes.peers.create).toHaveBeenCalledWith(expect.objectContaining({ depth: 2 }));
		});

		it('reports a friend who will not introduce us as no route that way', async () => {
			const { manager, fakes } = build();

			fakes.links.request.mockRejectedValue(new Error('refused'));

			await expect(manager.reach('peer-bob', 'their-row-42')).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});
	});

	describe('letting go afterwards', () => {
		it('closes and forgets a link that was only opened for the transfer', async () => {
			const { manager, fakes } = build();

			await manager.reach('peer-bob', 'their-row-42');
			await manager.release('peer-chris');

			expect(fakes.manager.remove).toHaveBeenCalledWith('peer-chris');
			expect(fakes.rows.has('peer-chris')).toBe(false);
		});

		it('leaves a peer somebody asked to keep exactly as it is', async () => {
			// Half the value of the setting is that the caller does not have to know
			// which kind of peer it has before saying it is done.
			const { manager, fakes } = build({ keepDiscoveredPeers: true });

			await manager.reach('peer-bob', 'their-row-42');
			await manager.release('peer-chris');

			expect(fakes.manager.remove).not.toHaveBeenCalled();
			expect(fakes.rows.has('peer-chris')).toBe(true);
		});

		it('says nothing about a peer that is already gone', async () => {
			const { manager, fakes } = build();

			await expect(manager.release('peer-nobody')).resolves.toBeUndefined();
			expect(fakes.manager.remove).not.toHaveBeenCalled();
		});
	});
});
