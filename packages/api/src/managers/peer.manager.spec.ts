import {
	ErrorKey,
	MAX_PEER_MAX_DEPTH,
	PROTOCOL_VERSION,
	PeerCapability,
	PeerDirection,
	PeerStatus,
	PeerTrust,
} from '@mcs/shared';
import type { Peer, PeerInvite } from '@/entities';
import type {
	BannedPeerRepository,
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerInviteRepository,
	PeerRepository,
} from '@/repositories';
import type { EventGatewayService, PeerLinkService, SettingsService } from '@/services';
import { PeerManager } from './peer.manager';
import type { NotificationManager } from './notification.manager';
import type { ServiceManager } from './service.manager';

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
		recordHandshake: jest.Mock;
		delete: jest.Mock;
	};
	bans: {
		isBanned: jest.Mock;
		findByFingerprint: jest.Mock;
		findAll: jest.Mock;
		ban: jest.Mock;
		unban: jest.Mock;
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
		isLinked: jest.Mock;
		verify: jest.Mock;
		verifyCredential: jest.Mock;
		hello: jest.Mock;
		sign: jest.Mock;
		fingerprint: string;
		publicKey: string;
	};
	services: {
		findByPeer: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
	};
	libraries: { findByService: jest.Mock; delete: jest.Mock };
	matches: { deleteForItems: jest.Mock; deleteForService: jest.Mock };
	items: { countByService: jest.Mock; findStale: jest.Mock; remove: jest.Mock };
	serviceManager: { probe: jest.Mock; scan: jest.Mock; refresh: jest.Mock };
	notifications: { notify: jest.Mock };
}

const peerRow = (overrides: Partial<Peer> = {}): Peer =>
	({
		id: 'peer-1',
		name: 'Alice',
		fingerprint: THEIR_FINGERPRINT,
		publicKey: null,
		status: PeerStatus.LINKED,
		trust: PeerTrust.FRIEND,
		depth: 1,
		maxDepth: null,
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
			recordHandshake: jest.fn().mockResolvedValue(undefined),
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
			isLinked: jest.fn(() => false),
			verify: jest.fn(() => true),
			verifyCredential: jest.fn(() => true),
			hello: jest.fn(() => ({
				nodeId: 'node-us',
				fingerprint: OUR_FINGERPRINT,
				name: 'gateway',
				protocol: PROTOCOL_VERSION,
				capabilities: [PeerCapability.CONTENT],
			})),
			sign: jest.fn((payload: string) => `signed:${payload}`),
			fingerprint: OUR_FINGERPRINT,
			publicKey: 'our-public-key',
		},
		services: {
			findByPeer: jest.fn().mockResolvedValue([]),
			create: jest.fn((value: Record<string, unknown>) => ({ id: 'service-1', ...value })),
			save: jest.fn((value: Record<string, unknown>) => Promise.resolve(value)),
			delete: jest.fn().mockResolvedValue(undefined),
		},
		libraries: {
			findByService: jest.fn().mockResolvedValue([]),
			delete: jest.fn().mockResolvedValue(undefined),
		},
		matches: {
			deleteForItems: jest.fn().mockResolvedValue(0),
			deleteForService: jest.fn().mockResolvedValue(0),
		},
		items: {
			countByService: jest.fn().mockResolvedValue(0),
			findStale: jest.fn().mockResolvedValue([]),
			remove: jest.fn().mockResolvedValue(undefined),
		},
		serviceManager: {
			probe: jest.fn().mockResolvedValue({ libraries: [] }),
			scan: jest.fn().mockResolvedValue(undefined),
			refresh: jest.fn().mockResolvedValue(undefined),
		},
		notifications: { notify: jest.fn().mockResolvedValue(undefined) },
		bans: {
			isBanned: jest.fn().mockResolvedValue(false),
			findByFingerprint: jest.fn().mockResolvedValue(null),
			findAll: jest.fn().mockResolvedValue([]),
			ban: jest.fn((fingerprint: string, extra: Record<string, unknown> = {}) =>
				Promise.resolve({
					id: 'ban-1',
					fingerprint,
					name: null,
					reason: null,
					...extra,
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					updatedAt: new Date('2026-01-01T00:00:00.000Z'),
				}),
			),
			unban: jest.fn().mockResolvedValue(true),
		},
	};

	const manager = new PeerManager(
		fakes.peers as unknown as PeerRepository,
		fakes.bans as unknown as BannedPeerRepository,
		fakes.invites as unknown as PeerInviteRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.items as unknown as MediaItemRepository,
		fakes.links as unknown as PeerLinkService,
		{
			getValue: jest.fn().mockResolvedValue('https://rendezvous.test'),
		} as unknown as SettingsService,
		{ emit: jest.fn() } as unknown as EventGatewayService,
		fakes.libraries as unknown as LibraryRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.serviceManager as unknown as ServiceManager,
		fakes.notifications as unknown as NotificationManager,
	);

	return { manager, fakes };
};

/** An invitation as a friend's gateway would hand it over. */
const foreignInvite = (expiresAt: Date, code = 'abc123'): string =>
	`mcs://invite/${code}?fingerprint=${THEIR_FINGERPRINT}&rendezvous=https%3A%2F%2Frendezvous.test&secret=s3cr3t&exp=${expiresAt.toISOString()}`;

describe('PeerManager', () => {
	describe('what a link brings', () => {
		it('registers nothing for a peer that has only asked', async () => {
			// A pending peer has agreed to nothing. Registering a service for one would
			// put a stranger's name in the services screen on the strength of a request.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.PENDING }));
			fakes.peers.findByFingerprint.mockResolvedValue(null);

			await manager.add({ fingerprint: THEIR_FINGERPRINT });

			expect(fakes.services.create).not.toHaveBeenCalled();
		});

		it('registers a peer as a remote service of ours the moment the link settles', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);

			await manager.approve('peer-1');

			expect(fakes.services.create).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Alice',
					type: 'peer',
					// We cannot write into somebody else's disk, so it is never local and
					// never a destination.
					scope: 'remote',
					baseUrl: 'peer://peer-1',
					peerId: 'peer-1',
				}),
			);
		});

		it('asks a peer for nothing until there is a link to ask over', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);
			fakes.links.isLinked.mockReturnValue(false);

			await manager.approve('peer-1');

			// The row exists so the screens have something to show; the libraries arrive
			// with the first connection.
			expect(fakes.services.save).toHaveBeenCalled();
			expect(fakes.serviceManager.probe).not.toHaveBeenCalled();
		});

		it('indexes everything the first time and only what changed afterwards', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);
			fakes.links.isLinked.mockReturnValue(true);
			fakes.services.findByPeer.mockResolvedValue([
				{ id: 'service-1', name: 'Alice', baseUrl: 'peer://peer-1', lastScanAt: new Date() },
			]);

			await manager.approve('peer-1');

			expect(fakes.serviceManager.refresh).toHaveBeenCalledWith('service-1');
			expect(fakes.serviceManager.scan).not.toHaveBeenCalled();
		});

		it('lets a link settle even when the catalogue cannot be read', async () => {
			// Failing here would tell somebody their friend refused them because a
			// catalogue page timed out.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);
			fakes.links.isLinked.mockReturnValue(true);
			fakes.serviceManager.probe.mockRejectedValue(new Error('link closed'));

			await expect(manager.approve('peer-1')).resolves.toMatchObject({
				status: PeerStatus.LINKED,
			});
		});

		it('takes back what a peer brought when it is unlinked, matches included', async () => {
			// A match names an item on each side and only one of them is reached by a
			// foreign key, so unlinking used to leave rows pointing at media that no
			// longer exists.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());
			fakes.services.findByPeer.mockResolvedValue([{ id: 'service-1' }]);
			fakes.libraries.findByService.mockResolvedValue([{ id: 'library-1' }]);
			fakes.items.findStale.mockResolvedValue([{ id: 'item-1' }]);

			await manager.remove('peer-1');

			expect(fakes.matches.deleteForItems).toHaveBeenCalledWith(['item-1']);
			expect(fakes.matches.deleteForService).toHaveBeenCalledWith('service-1');
			expect(fakes.libraries.delete).toHaveBeenCalledWith({
				id: 'library-1',
				serviceId: 'service-1',
			});
			expect(fakes.services.delete).toHaveBeenCalledWith({ id: 'service-1' });
			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});

		it('renames what a peer brought without opening a link to do it', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ name: 'peer-aaaaaaaa' }));
			fakes.services.findByPeer.mockResolvedValue([{ id: 'service-1', name: 'peer-aaaaaaaa' }]);

			await manager.rename('peer-1', 'The cottage');

			expect(fakes.services.save).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'The cottage' }),
			);
			expect(fakes.serviceManager.probe).not.toHaveBeenCalled();
		});
	});

	describe('an inbound link', () => {
		const credential = {
			fingerprint: THEIR_FINGERPRINT,
			publicKey: 'their-public-key',
			challenge: `${THEIR_FINGERPRINT}:${Date.now()}`,
			signature: 'a-signature',
			address: '203.0.113.9',
		};

		const theirHello = (protocol = PROTOCOL_VERSION) => ({
			nodeId: 'node-alice',
			fingerprint: THEIR_FINGERPRINT,
			name: 'Alice',
			protocol,
			capabilities: [PeerCapability.CONTENT, PeerCapability.CATALOGUE],
		});

		it('admits a peer we have linked to', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow());

			await expect(manager.admit(credential)).resolves.toEqual({
				peerId: 'peer-1',
				name: 'Alice',
			});
		});

		it('admits a peer we merely failed to reach', async () => {
			// `UNREACHABLE` means we could not reach them, which says nothing about
			// whether they are a friend — and their call is how that stops being true.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ status: PeerStatus.UNREACHABLE }),
			);

			await expect(manager.admit(credential)).resolves.toMatchObject({ peerId: 'peer-1' });
		});

		it('refuses a credential that does not verify, without asking who it claims to be', async () => {
			const { manager, fakes } = build();

			fakes.links.verifyCredential.mockReturnValue(false);

			await expect(manager.admit(credential)).resolves.toBeNull();
			expect(fakes.peers.findByFingerprint).not.toHaveBeenCalled();
		});

		it('records a stranger as a request and still refuses them', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(null);

			await expect(manager.admit(credential)).resolves.toBeNull();
			expect(fakes.peers.save).toHaveBeenCalledWith(
				expect.objectContaining({
					fingerprint: THEIR_FINGERPRINT,
					status: PeerStatus.PENDING,
					direction: PeerDirection.INCOMING,
					address: '203.0.113.9',
				}),
			);
		});

		it('refuses a peer that is blocked', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow({ status: PeerStatus.BLOCKED }));

			await expect(manager.admit(credential)).resolves.toBeNull();
		});

		it('settles our own outgoing request when they answer by connecting', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.OUTGOING }),
			);

			// `requested` settles the row, so the second read sees a link. Both sides
			// have now named each other, which is exactly what a link is.
			fakes.peers.findByFingerprint
				.mockResolvedValueOnce(
					peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.OUTGOING }),
				)
				.mockResolvedValueOnce(peerRow({ status: PeerStatus.LINKED, direction: null }));

			await expect(manager.admit(credential)).resolves.toMatchObject({ peerId: 'peer-1' });
		});

		it('refuses a peer who asked us and has not been approved', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);

			await expect(manager.admit(credential)).resolves.toBeNull();
		});

		it('answers a hello with ours, signed with their challenge', async () => {
			const { manager, fakes } = build();

			await expect(manager.greet('peer-1', theirHello(), 'their-challenge')).resolves.toEqual({
				hello: expect.objectContaining({ fingerprint: OUR_FINGERPRINT }),
				publicKey: 'our-public-key',
				signature: 'signed:their-challenge',
			});
			expect(fakes.peers.recordHandshake).toHaveBeenCalledWith('peer-1', {
				nodeId: 'node-alice',
				protocol: PROTOCOL_VERSION,
				capabilities: [PeerCapability.CONTENT, PeerCapability.CATALOGUE],
			});
		});

		it('refuses a version it does not speak and writes nothing', async () => {
			const { manager, fakes } = build();

			await expect(
				manager.greet('peer-1', theirHello(PROTOCOL_VERSION + 41), 'c'),
			).resolves.toBeNull();
			expect(fakes.peers.recordHandshake).not.toHaveBeenCalled();
		});
	});

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

	describe('linking by fingerprint', () => {
		it('records a request and waits, rather than claiming a link', async () => {
			const { manager, fakes } = build();

			const peer = await manager.add({ fingerprint: 'abc123', name: 'Bob' });

			expect(peer.status).toBe(PeerStatus.PENDING);
			expect(peer.direction).toBe(PeerDirection.OUTGOING);
			expect(fakes.peers.save).toHaveBeenCalled();
		});

		it('settles the link when both sides have now named each other', async () => {
			// Adding somebody who already asked us is answering, not asking. Treating it
			// as a fresh outgoing request leaves two halves of one link pointing at each
			// other and neither of them settled.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.INCOMING }),
			);

			const peer = await manager.add({ fingerprint: 'abc123' });

			expect(peer.status).toBe(PeerStatus.LINKED);
			expect(peer.direction).toBeNull();
		});

		it('records an incoming request without granting anything', async () => {
			const { manager, fakes } = build();

			await manager.requested('abc123', 'Bob', '1.2.3.4:4210');

			const saved = fakes.peers.save.mock.calls[0]?.[0] as { status: string; direction: string };

			expect(saved.status).toBe(PeerStatus.PENDING);
			expect(saved.direction).toBe(PeerDirection.INCOMING);
		});

		it('answers a blocked peer with nothing at all', async () => {
			// Answering differently would let somebody learn they are blocked by watching
			// what happens, which is more than they should be able to find out.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow({ status: PeerStatus.BLOCKED }));

			await manager.requested('abc123', 'Bob', null);

			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('settles our own outgoing request when they ask back', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(
				peerRow({ status: PeerStatus.PENDING, direction: PeerDirection.OUTGOING }),
			);

			await manager.requested('abc123', 'Bob', null);

			const saved = fakes.peers.save.mock.calls[0]?.[0] as { status: string };

			expect(saved.status).toBe(PeerStatus.LINKED);
		});

		it('refuses to approve a peer that was blocked', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.BLOCKED }));

			await expect(manager.approve('peer-1')).rejects.toThrow(ErrorKey.PEER_REJECTED);
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

	describe('banning, which outlives the row', () => {
		it('records the fingerprint when a peer is removed with a ban', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.remove('peer-1', { ban: true, reason: 'flooded us' });

			expect(fakes.bans.ban).toHaveBeenCalledWith(THEIR_FINGERPRINT, {
				name: 'Alice',
				reason: 'flooded us',
			});
			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});

		it('records nothing when a peer is simply removed', async () => {
			// The ordinary case has to stay ordinary: a friend who rebuilt their gateway
			// should be able to come back by asking.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.remove('peer-1');

			expect(fakes.bans.ban).not.toHaveBeenCalled();
		});

		it('records the ban before deleting anything', async () => {
			// After the row is gone there is nothing left to take the fingerprint and
			// the name from, so a failure between the two must not leave a ban on
			// whatever survived it.
			const { manager, fakes } = build();
			const order: string[] = [];

			fakes.peers.findOne.mockResolvedValue(peerRow());
			fakes.bans.ban.mockImplementation(() => {
				order.push('ban');

				return Promise.resolve({ fingerprint: THEIR_FINGERPRINT });
			});
			fakes.peers.delete.mockImplementation(() => {
				order.push('delete');

				return Promise.resolve(undefined);
			});

			await manager.remove('peer-1', { ban: true });

			expect(order).toEqual(['ban', 'delete']);
		});

		it('refuses to add a banned fingerprint, and says so', async () => {
			const { manager, fakes } = build();

			fakes.bans.isBanned.mockResolvedValue(true);

			await expect(manager.add({ fingerprint: THEIR_FINGERPRINT })).rejects.toThrow(
				ErrorKey.PEER_BANNED,
			);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('refuses an invitation redeemed with a banned fingerprint', async () => {
			// A valid invitation is not a way around the list: redeeming one links the
			// peer outright, with no pending row and nothing to approve.
			const { manager, fakes } = build();

			fakes.bans.isBanned.mockResolvedValue(true);

			await expect(
				manager.accept(foreignInvite(new Date(Date.now() + 60_000))),
			).rejects.toThrow(ErrorKey.PEER_BANNED);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('says nothing at all to a banned gateway that asks', async () => {
			// Answering differently would let somebody learn they are banned by watching
			// what happens, which is more than a refused peer should find out.
			const { manager, fakes } = build();

			fakes.bans.isBanned.mockResolvedValue(true);

			await expect(
				manager.requested(THEIR_FINGERPRINT, 'Alice', null),
			).resolves.toBeUndefined();
			expect(fakes.peers.findByFingerprint).not.toHaveBeenCalled();
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('reports a lift of a ban nobody had', async () => {
			const { manager, fakes } = build();

			fakes.bans.unban.mockResolvedValue(false);

			await expect(manager.unban('nobody')).rejects.toThrow(ErrorKey.PEER_BAN_NOT_FOUND);
		});

		it('bans a fingerprint that was never linked here', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(null);

			const ban = await manager.banFingerprint('  ab:cd  ', { name: 'Someone' });

			expect(fakes.bans.ban).toHaveBeenCalledWith('ab:cd', {
				name: 'Someone',
				reason: null,
			});
			expect(ban.fingerprint).toBe('ab:cd');
		});
	});

	describe('how far a peer may introduce', () => {
		it('puts a settled peer at one hop, whatever it was before', async () => {
			// A friend of a friend we then invite directly is somebody we chose from now
			// on, and leaving the old distance would keep ranking them behind peers who
			// are further away.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(
				peerRow({
					status: PeerStatus.PENDING,
					direction: PeerDirection.INCOMING,
					depth: 3,
					trust: PeerTrust.FRIEND_OF_FRIEND,
				}),
			);

			await manager.approve('peer-1');

			expect(fakes.peers.save).toHaveBeenCalledWith(expect.objectContaining({ depth: 1 }));
		});

		it('clearing the limit puts the peer back on the gateway ceiling', async () => {
			// Null means "follow the default", not a limit of zero and not whatever
			// number happened to be the default the day it was set.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ maxDepth: 5 }));

			await manager.setMaxDepth('peer-1', null);

			expect(fakes.peers.save).toHaveBeenCalledWith(expect.objectContaining({ maxDepth: null }));
		});

		it('refuses a limit past the hard ceiling', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await expect(manager.setMaxDepth('peer-1', MAX_PEER_MAX_DEPTH + 1)).rejects.toBeDefined();
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});
	});

});
