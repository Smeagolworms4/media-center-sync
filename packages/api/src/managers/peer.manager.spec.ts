import { ErrorKey, PeerStatus, PeerTrust } from '@mcs/shared';
import type { Peer, PeerInvite } from '@/entities';
import type {
	MediaItemRepository,
	MediaServiceRepository,
	PeerInviteRepository,
	PeerRepository,
} from '@/repositories';
import type { EventGatewayService, PeerLinkService, SettingsService } from '@/services';
import { PeerManager } from './peer.manager';

const OUR_FINGERPRINT = 'ffffffffffffffffffffffffffffffff';
const THEIR_FINGERPRINT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Fakes {
	peers: {
		find: jest.Mock;
		findOne: jest.Mock;
		findByFingerprint: jest.Mock;
		findWithPublicKey: jest.Mock;
		findLinked: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		setStatus: jest.Mock;
		delete: jest.Mock;
	};
	invites: {
		findByCode: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		markUsed: jest.Mock;
	};
	links: {
		identity: jest.Mock;
		connect: jest.Mock;
		disconnect: jest.Mock;
		verify: jest.Mock;
		fingerprint: string;
	};
}

const peerRow = (overrides: Partial<Peer> = {}): Peer =>
	({
		id: 'peer-1',
		name: 'Alice',
		fingerprint: THEIR_FINGERPRINT,
		publicKey: null,
		status: PeerStatus.LINKED,
		trust: PeerTrust.FRIEND,
		linkMode: null,
		address: null,
		viaPeerId: null,
		lastSeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Peer;

const build = (): { manager: PeerManager; fakes: Fakes } => {
	const fakes: Fakes = {
		peers: {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(null),
			findByFingerprint: jest.fn().mockResolvedValue(null),
			findWithPublicKey: jest.fn().mockResolvedValue(null),
			findLinked: jest.fn().mockResolvedValue([]),
			create: jest.fn((value: Partial<Peer>) => peerRow(value)),
			save: jest.fn((value: Peer) => Promise.resolve(value)),
			setStatus: jest.fn().mockResolvedValue(undefined),
			delete: jest.fn().mockResolvedValue(undefined),
		},
		invites: {
			findByCode: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<PeerInvite>) => ({ id: 'invite-1', ...value }) as PeerInvite),
			save: jest.fn((value: PeerInvite) => Promise.resolve(value)),
			markUsed: jest.fn().mockResolvedValue(undefined),
		},
		links: {
			identity: jest.fn(() => ({
				fingerprint: OUR_FINGERPRINT,
				name: 'gateway',
				rendezvous: 'https://rendezvous.test',
				directAddress: null,
				directReachable: false,
			})),
			connect: jest.fn(),
			disconnect: jest.fn(),
			verify: jest.fn(() => true),
			fingerprint: OUR_FINGERPRINT,
		},
	};

	const manager = new PeerManager(
		fakes.peers as unknown as PeerRepository,
		fakes.invites as unknown as PeerInviteRepository,
		{ findByPeer: jest.fn().mockResolvedValue([]) } as unknown as MediaServiceRepository,
		{ countByService: jest.fn().mockResolvedValue(0) } as unknown as MediaItemRepository,
		fakes.links as unknown as PeerLinkService,
		{
			getValue: jest.fn().mockResolvedValue('https://rendezvous.test'),
		} as unknown as SettingsService,
		{ emit: jest.fn() } as unknown as EventGatewayService,
	);

	return { manager, fakes };
};

/** An invitation as a friend's gateway would hand it over. */
const foreignInvite = (expiresAt: Date, code = 'abc123'): string =>
	`mcs://invite/${code}?fingerprint=${THEIR_FINGERPRINT}&rendezvous=https%3A%2F%2Frendezvous.test&secret=s3cr3t&exp=${expiresAt.toISOString()}`;

describe('PeerManager', () => {
	describe('invitations', () => {
		it('stores the hash of the secret and never the secret', async () => {
			const { manager, fakes } = build();

			const invite = await manager.createInvite(30);
			const stored = fakes.invites.create.mock.calls[0][0] as PeerInvite;

			expect(invite.url).toContain(invite.code);
			expect(invite.url).toContain(OUR_FINGERPRINT);
			expect(stored.secretHash).toHaveLength(64);
			expect(invite.url).not.toContain(stored.secretHash);
		});

		it('links to whoever the invitation names', async () => {
			const { manager, fakes } = build();

			const peer = await manager.accept(foreignInvite(new Date(Date.now() + 60_000)), 'Alice');

			expect(peer.fingerprint).toBe(THEIR_FINGERPRINT);
			expect(peer.name).toBe('Alice');
			expect(peer.status).toBe(PeerStatus.LINKED);
			// A peer we linked to ourselves is a friend, never a friend of a friend.
			expect(peer.trust).toBe(PeerTrust.FRIEND);
			expect(fakes.peers.save).toHaveBeenCalled();
		});

		it('records a foreign invitation as spent, so the same code cannot be used twice', async () => {
			const { manager, fakes } = build();

			await manager.accept(foreignInvite(new Date(Date.now() + 60_000)));

			const burned = fakes.invites.create.mock.calls[0][0] as PeerInvite;

			expect(burned.code).toBe('abc123');
			expect(burned.usedAt).toBeInstanceOf(Date);
		});

		it('refuses an invitation that has already been redeemed', async () => {
			const { manager, fakes } = build();

			fakes.invites.findByCode.mockResolvedValue({
				id: 'invite-1',
				code: 'abc123',
				secretHash: 'whatever',
				expiresAt: new Date(Date.now() + 60_000),
				usedAt: new Date(),
			} as PeerInvite);

			await expect(manager.accept(foreignInvite(new Date(Date.now() + 60_000)))).rejects.toThrow(
				ErrorKey.PEER_INVITE_INVALID,
			);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('says expired rather than invalid when the code has simply gone stale', async () => {
			const { manager } = build();

			await expect(manager.accept(foreignInvite(new Date(Date.now() - 60_000)))).rejects.toThrow(
				ErrorKey.PEER_INVITE_EXPIRED,
			);
		});

		it('refuses a code that names nobody to link to', async () => {
			const { manager } = build();

			await expect(manager.accept('just-a-code')).rejects.toThrow(ErrorKey.PEER_INVITE_INVALID);
		});

		it('refuses an invitation of ours presented with the wrong secret', async () => {
			const { manager, fakes } = build();

			fakes.invites.findByCode.mockResolvedValue({
				id: 'invite-1',
				code: 'abc123',
				secretHash: 'not-the-hash-of-s3cr3t'.padEnd(64, '0'),
				expiresAt: new Date(Date.now() + 60_000),
				usedAt: null,
			} as PeerInvite);

			await expect(manager.accept(foreignInvite(new Date(Date.now() + 60_000)))).rejects.toThrow(
				ErrorKey.PEER_INVITE_INVALID,
			);
		});
	});

	describe('blocking', () => {
		it('closes the live link, so blocking does not wait for a restart', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.block('peer-1');

			expect(fakes.links.disconnect).toHaveBeenCalledWith('peer-1');
			expect(fakes.peers.setStatus).toHaveBeenCalledWith('peer-1', PeerStatus.BLOCKED);
		});

		it('unblocks to unreachable rather than to linked, because no socket is open', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.BLOCKED }));

			await manager.unblock('peer-1');

			expect(fakes.peers.setStatus).toHaveBeenCalledWith('peer-1', PeerStatus.UNREACHABLE);
		});
	});

	describe('connecting', () => {
		it('records a peer as unreachable instead of leaving it looking linked', async () => {
			const { manager, fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.UNREACHABLE }));
			fakes.links.connect.mockRejectedValue(new Error('no route'));

			await expect(manager.connect('peer-1')).rejects.toThrow(ErrorKey.PEER_UNREACHABLE);
			expect(fakes.peers.setStatus).toHaveBeenCalledWith('peer-1', PeerStatus.UNREACHABLE);
		});
	});

	describe('verifying a peer credential', () => {
		it('refuses a peer whose public key we never learned', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow());
			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow({ publicKey: null }));

			await expect(manager.verify(THEIR_FINGERPRINT, 'signature')).resolves.toBe(false);
		});

		it('refuses a blocked peer before looking at the signature at all', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow({ status: PeerStatus.BLOCKED }));

			await expect(manager.verify(THEIR_FINGERPRINT, 'signature')).resolves.toBe(false);
			expect(fakes.links.verify).not.toHaveBeenCalled();
		});

		it('checks the signature against the payload the link negotiation signs', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow());
			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow({ publicKey: 'PEM' }));

			await expect(manager.verify(THEIR_FINGERPRINT, 'signature')).resolves.toBe(true);
			expect(fakes.links.verify).toHaveBeenCalledWith(
				'PEM',
				`${THEIR_FINGERPRINT}:${OUR_FINGERPRINT}`,
				'signature',
			);
		});
	});
});
