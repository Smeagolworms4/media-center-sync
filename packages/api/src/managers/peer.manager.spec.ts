import {
	ErrorKey,
	MAX_INTRODUCERS_ASKED,
	MAX_PEER_MAX_DEPTH,
	PROTOCOL_VERSION,
	PeerCapability,
	PeerDirection,
	PeerStatus,
	PeerTrust,
} from '@mcs/shared';
import { createHash } from 'node:crypto';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
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
import type { ConfigService } from '@nestjs/config';
import {
	PeerDialOutcome,
	PeerIntroductionService,
	type EventGatewayService,
	type PeerCredential,
	type PeerLinkService,
	type PeerReconnectService,
	type SettingsService,
} from '@/services';
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
		onLinkLost: jest.Mock;
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
	serviceManager: { probe: jest.Mock; scan: jest.Mock; refresh: jest.Mock; releaseService: jest.Mock };
	notifications: { notify: jest.Mock };
	/**
	 * The retry schedule, faked down to "dial once and tell me what happened".
	 *
	 * `now` runs the dial the manager registered, which is exactly what the real
	 * service does for a manual attempt — so a test can observe the outcome the
	 * backoff would have acted on without a timer or a socket anywhere near it.
	 */
	reconnects: {
		onDial: jest.Mock;
		schedule: jest.Mock;
		cancel: jest.Mock;
		now: jest.Mock;
		dial(peerId: string): Promise<PeerDialOutcome>;
	};
	/**
	 * The real token service over the fake key pair.
	 *
	 * Real, because minting a token in a test and having the manager read a different
	 * shape is exactly the bug these tests would otherwise miss. The cryptography under
	 * it is the fake link service's, so a test says whether a signature verifies by
	 * saying so rather than by holding a private key.
	 */
	introductions: PeerIntroductionService;
	settings: { get: jest.Mock; getValue: jest.Mock };
}

/** Let everything already queued run, without counting how many turns that takes. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
		readingForbidden: false,
		discovered: false,
		linkMode: null,
		address: null,
		viaPeerId: null,
		lastSeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Peer;

const build = (
	{
		autoConnect = false,
		settings = {},
	}: { autoConnect?: boolean; settings?: Record<string, unknown> } = {},
): { manager: PeerManager; fakes: Fakes } => {
	const base = {
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
			onLinkLost: jest.fn(),
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
			releaseService: jest.fn().mockResolvedValue(undefined),
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
		reconnects: {
			onDial: jest.fn(),
			schedule: jest.fn(),
			cancel: jest.fn(),
			now: jest.fn(),
			dial: () => Promise.resolve(PeerDialOutcome.REFUSED),
		},
		settings: {
			// Three hops and nothing kept, which is what a gateway nobody has configured
			// does. A test that cares about either says so.
			get: jest.fn().mockResolvedValue({
				peerMaxDepth: 3,
				keepDiscoveredPeers: false,
				...settings,
			}),
			getValue: jest.fn().mockResolvedValue('https://ours.example.org'),
		},
	};

	const fakes: Fakes = {
		...base,
		introductions: new PeerIntroductionService(base.links as unknown as PeerLinkService),
	};

	fakes.reconnects.onDial.mockImplementation((dial: (peerId: string) => Promise<PeerDialOutcome>) => {
		fakes.reconnects.dial = dial;
	});
	fakes.reconnects.now.mockImplementation((peerId: string) => fakes.reconnects.dial(peerId));

	const manager = new PeerManager(
		fakes.peers as unknown as PeerRepository,
		fakes.bans as unknown as BannedPeerRepository,
		fakes.invites as unknown as PeerInviteRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.items as unknown as MediaItemRepository,
		fakes.links as unknown as PeerLinkService,
		fakes.introductions,
		fakes.settings as unknown as SettingsService,
		{ emit: jest.fn() } as unknown as EventGatewayService,
		fakes.libraries as unknown as LibraryRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.serviceManager as unknown as ServiceManager,
		fakes.notifications as unknown as NotificationManager,
		fakes.reconnects as unknown as PeerReconnectService,
		{ getOrThrow: () => ({ maxDepth: null, autoConnect }) } as unknown as ConfigService,
	);

	// What the module lifecycle does for real. Without it nothing has registered a
	// dial, and every `connect` in this file would answer "refused" for the wrong
	// reason.
	manager.onModuleInit();

	return { manager, fakes };
};

/** An invitation as a friend's gateway would hand it over. */
const foreignInvite = (expiresAt: Date, code = 'abc123'): string =>
	`mcs://invite/${code}?fingerprint=${THEIR_FINGERPRINT}&address=https%3A%2F%2Ftheirs.example.org&secret=s3cr3t&exp=${expiresAt.toISOString()}`;

/** The same invitation as a gateway on the previous image spells it. */
const legacyInvite = (expiresAt: Date, code = 'abc123'): string =>
	`mcs://invite/${code}?fingerprint=${THEIR_FINGERPRINT}&rendezvous=https%3A%2F%2Ftheirs.example.org&secret=s3cr3t&exp=${expiresAt.toISOString()}`;

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
					// Never shared onward: what a friend's friend holds will be reached by
					// introducing the two ends, not by carrying their bytes through us.
					shared: false,
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
			// Their server leaves the way a removed service does: what it was feeding
			// is stopped first, while its items still say which transfers those are.
			expect(fakes.serviceManager.releaseService).toHaveBeenCalledWith('service-1');
			expect(fakes.serviceManager.releaseService.mock.invocationCallOrder[0])
				.toBeLessThan(fakes.services.delete.mock.invocationCallOrder[0]);
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
		const credential: PeerCredential = {
			fingerprint: THEIR_FINGERPRINT,
			publicKey: 'their-public-key',
			challenge: `${THEIR_FINGERPRINT}:${Date.now()}`,
			signature: 'a-signature',
			// The ordinary case, and the one every test below but the introductions
			// describes: two gateways that already know each other need nobody to vouch.
			introduction: null,
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

		it('admits a peer forbidden from reading, because the link is theirs to keep', async () => {
			// The whole point of forbidding rather than blocking: they stay connected,
			// we keep reading from them, and every answer they get from us is empty.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow({ readingForbidden: true }));

			await expect(manager.admit(credential)).resolves.toMatchObject({ peerId: 'peer-1' });
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

		describe('through an introduction', () => {
			const INTRODUCER_FINGERPRINT = 'b'.repeat(32);

			/**
			 * The gateway in the middle, as our own peer row sees it.
			 *
			 * It carries a public key, because that is the whole mechanism: the holder
			 * checks the token against the key it already holds for its own peer, never
			 * against one the token brought with it.
			 */
			const introducerRow = (overrides: Partial<Peer> = {}): Peer =>
				peerRow({
					id: 'peer-bob',
					name: 'Bob',
					fingerprint: INTRODUCER_FINGERPRINT,
					publicKey: 'bobs-public-key',
					depth: 1,
					...overrides,
				});

			/**
			 * Bob's own token service, which is the point of the test.
			 *
			 * Built on a key of Bob's rather than on ours: a token minted by this gateway
			 * would name this gateway as the introducer, and every test below would be
			 * describing a gateway vouching for its own visitors.
			 */
			const bobs = new PeerIntroductionService({
				fingerprint: INTRODUCER_FINGERPRINT,
				sign: (payload: string) => `signed-by-bob:${payload}`,
			} as unknown as PeerLinkService);

			/** A stranger arriving with a token minted for us by Bob. */
			const introduced = (
				{ depth = 2, holder = OUR_FINGERPRINT, subject = THEIR_FINGERPRINT } = {},
			): PeerCredential => ({
				...credential,
				introduction: bobs.issue(subject, holder, depth).token,
			});

			const knownIntroducer = (fakes: Fakes, row: Peer = introducerRow()): void => {
				fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
					Promise.resolve(fingerprint === INTRODUCER_FINGERPRINT ? row : null),
				);
				fakes.peers.findWithPublicKey.mockResolvedValue(row);
			};

			it('admits a gateway it has never met, as a friend of a friend', async () => {
				// The whole feature. Nobody is asked to approve anything — being reachable
				// at this distance is the agreement — and the link is theirs to use at
				// once, which is what stops the bytes going through Bob.
				const { manager, fakes } = build();

				knownIntroducer(fakes);

				await expect(manager.admit(introduced())).resolves.toMatchObject({
					name: expect.stringContaining('peer-'),
				});
				expect(fakes.peers.save).toHaveBeenCalledWith(
					expect.objectContaining({
						fingerprint: THEIR_FINGERPRINT,
						status: PeerStatus.LINKED,
						trust: PeerTrust.FRIEND_OF_FRIEND,
						depth: 2,
						viaPeerId: 'peer-bob',
						discovered: true,
					}),
				);
			});

			it('keeps them when the gateway asked for peers met this way to be kept', async () => {
				const { manager, fakes } = build({ settings: { keepDiscoveredPeers: true } });

				knownIntroducer(fakes);

				await expect(manager.admit(introduced())).resolves.not.toBeNull();
				expect(fakes.peers.save).toHaveBeenCalledWith(
					expect.objectContaining({ discovered: false }),
				);
			});

			it('refuses a token signed by somebody who is not a peer of ours', async () => {
				// A signature is only worth the relationship behind it. Whoever signed
				// this vouches for nobody here, however well formed it is.
				const { manager, fakes } = build();

				fakes.peers.findByFingerprint.mockResolvedValue(null);

				await expect(manager.admit(introduced())).resolves.toBeNull();
			});

			it('refuses a token from a peer we have not settled a link with', async () => {
				const { manager, fakes } = build();

				knownIntroducer(fakes, introducerRow({ status: PeerStatus.PENDING }));

				await expect(manager.admit(introduced())).resolves.toBeNull();
			});

			it('refuses a token whose signature does not verify', async () => {
				const { manager, fakes } = build();

				knownIntroducer(fakes);
				fakes.links.verify.mockReturnValue(false);

				await expect(manager.admit(introduced())).resolves.toBeNull();
			});

			it('refuses a token minted for a different gateway', async () => {
				// Without the holder in the claim, a token good for one of Bob's friends
				// would open a link to every one of them.
				const { manager, fakes } = build();

				knownIntroducer(fakes);

				await expect(
					manager.admit(introduced({ holder: 'e'.repeat(32) })),
				).resolves.toBeNull();
			});

			it('refuses a token minted for somebody else, even from the right signer', async () => {
				const { manager, fakes } = build();

				knownIntroducer(fakes);

				await expect(
					manager.admit(introduced({ subject: 'e'.repeat(32) })),
				).resolves.toBeNull();
			});

			it('never admits a gateway further away than the hop limit allows', async () => {
				// The limit is the consent: somebody who shortened it is saying fewer
				// people may reach them, and this is where that sentence is enforced.
				const { manager, fakes } = build({ settings: { peerMaxDepth: 1 } });

				knownIntroducer(fakes);

				await expect(manager.admit(introduced())).resolves.toBeNull();
			});

			it("honours the introducer's own shorter reach over the gateway ceiling", async () => {
				const { manager, fakes } = build({ settings: { peerMaxDepth: 4 } });

				knownIntroducer(fakes, introducerRow({ maxDepth: 1 }));

				await expect(manager.admit(introduced())).resolves.toBeNull();
			});

			it('refuses a banned key however well it was introduced', async () => {
				const { manager, fakes } = build();

				knownIntroducer(fakes);
				fakes.bans.isBanned.mockResolvedValue(true);

				await expect(manager.admit(introduced())).resolves.toBeNull();
				expect(fakes.peers.save).not.toHaveBeenCalled();
			});

			it('reads the distance as the longer of what was claimed and what we counted', async () => {
				// A gateway stating a smaller number than it counted would be promoting a
				// chain to a direct friendship.
				const { manager, fakes } = build({ settings: { peerMaxDepth: 4 } });

				knownIntroducer(fakes, introducerRow({ depth: 3 }));

				await expect(manager.admit(introduced({ depth: 2 }))).resolves.not.toBeNull();
				expect(fakes.peers.save).toHaveBeenCalledWith(
					expect.objectContaining({ depth: 4 }),
				);
			});

			it('forgets a temporary peer when their link closes, and keeps a kept one', async () => {
				const { manager, fakes } = build();

				fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: true }));

				await manager.forget('peer-1');

				expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });

				fakes.peers.delete.mockClear();
				fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: false }));

				await manager.forget('peer-1');

				expect(fakes.peers.delete).not.toHaveBeenCalled();
			});

			it('leaves a temporary peer alone while a link of our own is still open', async () => {
				// Both ends may hold a socket. Forgetting the row while we are still
				// pulling from them would cut a transfer that is running.
				const { manager, fakes } = build();

				fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: true }));
				fakes.links.isLinked.mockReturnValue(true);

				await expect(manager.forget('peer-1')).resolves.toBe(false);
				expect(fakes.peers.delete).not.toHaveBeenCalled();
			});

			it('refuses a token it cannot read, and records the stranger as a request only', async () => {
				// Unreadable is refused before any peer is looked up by what it claims: a
				// claim nobody can parse names no introducer to check it against.
				const { manager, fakes } = build();

				knownIntroducer(fakes);

				await expect(
					manager.admit({ ...credential, introduction: 'not-a-token' }),
				).resolves.toBeNull();
				expect(fakes.peers.save).not.toHaveBeenCalledWith(
					expect.objectContaining({ status: PeerStatus.LINKED }),
				);
				expect(fakes.peers.save).toHaveBeenCalledWith(
					expect.objectContaining({ status: PeerStatus.PENDING, trust: PeerTrust.FRIEND }),
				);
			});

			it('refuses a token from a peer whose key we never learned', async () => {
				// Nothing to check the signature against, and an unchecked introduction is
				// an open door with a token taped to it. The signature is never even read.
				const { manager, fakes } = build();

				knownIntroducer(fakes, introducerRow({ publicKey: null }));

				await expect(manager.admit(introduced())).resolves.toBeNull();
				expect(fakes.links.verify).not.toHaveBeenCalled();
				expect(fakes.peers.save).not.toHaveBeenCalledWith(
					expect.objectContaining({ status: PeerStatus.LINKED }),
				);
			});

			it('changes nothing about a friend who happens to present a token', async () => {
				// A settled link is not restated by a third party on every reconnection:
				// read here, the token would file an old friend as reached through Bob.
				const { manager, fakes } = build();
				const friend = peerRow();

				fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
					Promise.resolve(
						fingerprint === THEIR_FINGERPRINT
							? friend
							: fingerprint === INTRODUCER_FINGERPRINT
								? introducerRow()
								: null,
					),
				);
				fakes.peers.findWithPublicKey.mockResolvedValue(introducerRow());

				await expect(manager.admit(introduced())).resolves.toEqual({
					peerId: 'peer-1',
					name: 'Alice',
				});
				expect(friend).toMatchObject({ trust: PeerTrust.FRIEND, viaPeerId: null, depth: 1 });
			});

			it('settles a request of ours that they answer through an introduction, and keeps them', async () => {
				// We asked for this link ourselves. The row stays a friend, and it is
				// never turned into a temporary one that deletes itself when the transfer
				// ends — that flag belongs to rows an admission creates.
				const { manager, fakes } = build();
				const ours = peerRow({
					status: PeerStatus.PENDING,
					direction: PeerDirection.OUTGOING,
					trust: PeerTrust.FRIEND,
					address: null,
					discovered: false,
				});

				fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
					Promise.resolve(
						fingerprint === THEIR_FINGERPRINT
							? ours
							: fingerprint === INTRODUCER_FINGERPRINT
								? introducerRow()
								: null,
					),
				);
				fakes.peers.findWithPublicKey.mockResolvedValue(introducerRow());

				await expect(manager.admit(introduced())).resolves.toMatchObject({ peerId: 'peer-1' });
				expect(ours).toMatchObject({
					status: PeerStatus.LINKED,
					direction: null,
					trust: PeerTrust.FRIEND,
					address: '203.0.113.9',
					viaPeerId: 'peer-bob',
					discovered: false,
				});
			});

			it('keeps what it knew of a temporary peer met again through an introduction', async () => {
				// The socket says nothing about where they came from, so the address a
				// previous link learned is kept; and a friend of a friend stays one.
				const { manager, fakes } = build();
				const met = peerRow({
					status: PeerStatus.PENDING,
					direction: PeerDirection.INCOMING,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					address: '198.51.100.7',
					viaPeerId: 'peer-bob',
					discovered: true,
				});

				fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
					Promise.resolve(
						fingerprint === THEIR_FINGERPRINT
							? met
							: fingerprint === INTRODUCER_FINGERPRINT
								? introducerRow()
								: null,
					),
				);
				fakes.peers.findWithPublicKey.mockResolvedValue(introducerRow());

				await expect(
					manager.admit({ ...introduced(), address: null }),
				).resolves.toMatchObject({ peerId: 'peer-1' });
				expect(met).toMatchObject({
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					address: '198.51.100.7',
					discovered: true,
				});
			});
		});

		/**
		 * The other half of an introduction: the two ends could not reach each other.
		 *
		 * What is checked here is authorisation and nothing else — the bytes and the
		 * sockets are `PeerRelayService`'s. The rule being pinned down is that this
		 * gateway carries a link only for a pair it introduced itself, inside the two
		 * minutes the token it signed lives.
		 */
		describe('carrying a link for two friends', () => {
			const HOLDER_FINGERPRINT = 'c'.repeat(32);

			/** Somebody else's introducer, to stand for a token we did not mint. */
			const somebodyElses = new PeerIntroductionService({
				fingerprint: 'd'.repeat(32),
				sign: (payload: string) => `signed-by-them:${payload}`,
			} as unknown as PeerLinkService);

			const bothEnds = (fakes: Fakes): void => {
				fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
					Promise.resolve(
						fingerprint === HOLDER_FINGERPRINT
							? peerRow({ id: 'peer-kim', name: 'Kim', fingerprint: HOLDER_FINGERPRINT })
							: peerRow({ id: 'peer-ada', name: 'Ada', fingerprint: THEIR_FINGERPRINT }),
					),
				);
			};

			const asking = (fakes: Fakes, overrides: Partial<PeerCredential> = {}): PeerCredential => ({
				...credential,
				introduction: fakes.introductions.issue(THEIR_FINGERPRINT, HOLDER_FINGERPRINT, 2).token,
				...overrides,
			});

			it('carries for a pair it introduced itself', async () => {
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);

				await expect(manager.carry(asking(fakes))).resolves.toEqual({
					holderPeerId: 'peer-kim',
					holderName: 'Kim',
					subjectName: 'Ada',
				});
			});

			it('carries nothing until the household has agreed to', async () => {
				// The default. Somebody else's film crossing this machine, at the cost of
				// this household's upload, is never something to start doing unasked.
				const { manager, fakes } = build();

				bothEnds(fakes);

				await expect(manager.carry(asking(fakes))).resolves.toBeNull();
			});

			it('refuses a token it did not mint', async () => {
				// Otherwise this gateway would carry bytes between two strangers on the
				// word of whoever signed the token, which is anybody.
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);

				await expect(
					manager.carry(
						asking(fakes, {
							introduction: somebodyElses.issue(
								THEIR_FINGERPRINT,
								HOLDER_FINGERPRINT,
								2,
							).token,
						}),
					),
				).resolves.toBeNull();
			});

			it('refuses a token lifted off another gateway wire', async () => {
				// It names who may present it, and the socket underneath has just proved
				// who that is.
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);

				await expect(
					manager.carry({
						...asking(fakes),
						fingerprint: 'e'.repeat(32),
					}),
				).resolves.toBeNull();
			});

			it('refuses a socket that cannot prove it holds the key it claims', async () => {
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);
				fakes.links.verifyCredential.mockReturnValue(false);

				await expect(manager.carry(asking(fakes))).resolves.toBeNull();
			});

			it('refuses when one of the two ends is no longer a peer of ours', async () => {
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				fakes.peers.findByFingerprint.mockResolvedValue(null);

				await expect(manager.carry(asking(fakes))).resolves.toBeNull();
			});

			it('refuses a key on the ban list, whichever route it arrives by', async () => {
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);
				fakes.bans.isBanned.mockResolvedValue(true);

				await expect(manager.carry(asking(fakes))).resolves.toBeNull();
			});

			it('refuses an upgrade carrying no token at all', async () => {
				const { manager, fakes } = build({ settings: { relayForPeers: true } });

				bothEnds(fakes);

				await expect(manager.carry(credential)).resolves.toBeNull();
			});
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

	describe('who is asked to introduce us', () => {
		const linkedRows = [
			peerRow({ id: 'bob', fingerprint: 'b'.repeat(32) }),
			peerRow({ id: 'cara', fingerprint: 'c'.repeat(32) }),
			peerRow({ id: 'dan', fingerprint: 'd'.repeat(32) }),
			peerRow({ id: 'eve', fingerprint: 'e'.repeat(32) }),
		];

		it('asks first the peer that told us about this one', async () => {
			// The obvious answer and the one that certainly can: `viaPeerId` is how we
			// know this gateway exists at all, so that friend is linked to them by
			// construction.
			const { manager, fakes } = build();

			fakes.peers.findLinked.mockResolvedValue(linkedRows);
			fakes.links.isLinked.mockReturnValue(true);

			await expect(
				manager.introducersFor(peerRow({ id: 'chris', viaPeerId: 'dan' })),
			).resolves.toEqual(['dan', 'bob', 'cara']);
		});

		it('tries the others when that one is offline', async () => {
			// A friend's gateway being down is the commonest reason a link cannot be
			// opened, and giving up there would make the whole ladder depend on one
			// household's uptime.
			const { manager, fakes } = build();

			fakes.peers.findLinked.mockResolvedValue(linkedRows);
			fakes.links.isLinked.mockImplementation((id: string) => id !== 'dan');

			await expect(
				manager.introducersFor(peerRow({ id: 'chris', viaPeerId: 'dan' })),
			).resolves.toEqual(['bob', 'cara', 'eve']);
		});

		it('never returns more than the bound, however many friends there are', async () => {
			// A gateway that asked twenty peers in turn before reporting failure is a
			// screen that hangs, and the twentieth answer says nothing the first three
			// did not.
			const { manager, fakes } = build();

			fakes.peers.findLinked.mockResolvedValue(linkedRows);
			fakes.links.isLinked.mockReturnValue(true);

			await expect(manager.introducersFor(peerRow({ id: 'chris' }))).resolves.toHaveLength(
				MAX_INTRODUCERS_ASKED,
			);
		});

		it('asks nobody when no link is open, and never asks the peer about itself', async () => {
			const { manager, fakes } = build();

			fakes.peers.findLinked.mockResolvedValue(linkedRows);
			fakes.links.isLinked.mockReturnValue(false);

			await expect(manager.introducersFor(peerRow({ id: 'chris' }))).resolves.toEqual([]);

			fakes.links.isLinked.mockReturnValue(true);

			await expect(manager.introducersFor(peerRow({ id: 'bob' }))).resolves.not.toContain('bob');
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

		it('carries the issuing gateway\'s own address, and calls it what it is', async () => {
			// The one address left in the whole design, and it is ours. Two gateways that
			// have never met have nobody in the middle to introduce them, which is the
			// case this covers and the only one it covers.
			const { manager, fakes } = build();

			const invite = await manager.createInvite(30);

			expect(fakes.settings.getValue).toHaveBeenCalledWith('publicUrl');
			expect(fakes.settings.getValue).not.toHaveBeenCalledWith('rendezvousUrl');
			expect(invite.address).toBe('https://ours.example.org');
			expect(invite.url).toContain('address=https%3A%2F%2Fours.example.org');
			expect(invite.url).not.toContain('rendezvous');
		});

		it('keeps the address an invitation carries, so a first link has somewhere to dial', async () => {
			const { manager, fakes } = build();

			await manager.accept(foreignInvite(new Date(Date.now() + 60_000)), 'Alice');

			expect(fakes.peers.create).toHaveBeenCalledWith(
				expect.objectContaining({ address: 'https://theirs.example.org' }),
			);
		});

		it('still reads an invitation minted before the parameter was renamed', async () => {
			// One lives in somebody's chat window for an hour. Refusing to read its
			// address would turn a rename into a link with nowhere to dial.
			const { manager, fakes } = build();

			const peer = await manager.accept(legacyInvite(new Date(Date.now() + 60_000)), 'Alice');

			expect(peer.status).toBe(PeerStatus.LINKED);
			expect(fakes.peers.create).toHaveBeenCalledWith(
				expect.objectContaining({ address: 'https://theirs.example.org' }),
			);
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

		it('says expired for an invitation of ours that has gone stale, even with the right secret', async () => {
			const { manager, fakes } = build();

			fakes.invites.findByCode.mockResolvedValue({
				id: 'invite-1',
				code: 'abc123',
				secretHash: createHash('sha256').update('s3cr3t').digest('hex'),
				expiresAt: new Date(Date.now() - 1_000),
				usedAt: null,
			} as PeerInvite);

			await expect(manager.accept(foreignInvite(new Date(Date.now() + 60_000)))).rejects.toThrow(
				ErrorKey.PEER_INVITE_EXPIRED,
			);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('refuses an invitation of ours stripped of its fingerprint, and links nobody', async () => {
			// The secret is right, but the URL no longer says who to link to. Linking
			// anyway used to create a friend whose fingerprint was the invitation code —
			// a row no key could ever authenticate as, listed as linked.
			const { manager, fakes } = build();

			fakes.invites.findByCode.mockResolvedValue({
				id: 'invite-1',
				code: 'abc123',
				secretHash: createHash('sha256').update('s3cr3t').digest('hex'),
				expiresAt: new Date(Date.now() + 60_000),
				usedAt: null,
			} as PeerInvite);

			await expect(
				manager.accept(`mcs://invite/abc123?secret=s3cr3t&exp=${new Date(Date.now() + 60_000).toISOString()}`),
			).rejects.toThrow(ErrorKey.PEER_INVITE_INVALID);
			expect(fakes.peers.save).not.toHaveBeenCalled();
			// Not burned either: the code is still good in its complete form.
			expect(fakes.invites.markUsed).not.toHaveBeenCalled();
		});

		it('refuses a URL carrying nothing but a code', async () => {
			const { manager } = build();

			await expect(manager.accept('mcs://invite/abc123')).rejects.toThrow(
				ErrorKey.PEER_INVITE_INVALID,
			);
		});

		it('reads a foreign invitation with no readable expiry as expired, never as eternal', async () => {
			// Its expiry is the one thing a foreign invitation carries that we can check.
			// Missing or garbled, the only safe reading is that it has run out.
			const { manager, fakes } = build();
			const base = `mcs://invite/abc123?fingerprint=${THEIR_FINGERPRINT}&secret=s3cr3t`;

			await expect(manager.accept(base)).rejects.toThrow(ErrorKey.PEER_INVITE_EXPIRED);
			await expect(manager.accept(`${base}&exp=someday`)).rejects.toThrow(
				ErrorKey.PEER_INVITE_EXPIRED,
			);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});

		it('links somebody already known, keeping the name and the address we learned', async () => {
			// The address we hold came from a handshake that worked; the invitation's is
			// somebody's setting. And redeeming an invitation is choosing them, so a row
			// first created by an introduction stops being one that deletes itself.
			const { manager, fakes } = build();
			const known = peerRow({
				name: 'Kim',
				status: PeerStatus.PENDING,
				trust: PeerTrust.FRIEND_OF_FRIEND,
				address: '198.51.100.7',
				discovered: true,
			});

			fakes.peers.findByFingerprint.mockResolvedValue(known);

			await manager.accept(foreignInvite(new Date(Date.now() + 60_000)));

			expect(known).toMatchObject({
				name: 'Kim',
				address: '198.51.100.7',
				status: PeerStatus.LINKED,
				trust: PeerTrust.FRIEND,
				discovered: false,
			});
		});

		it('gives a known peer with no address the one the invitation carries, and the name chosen', async () => {
			const { manager, fakes } = build();
			const known = peerRow({ name: 'peer-aaaaaaaa', address: null });

			fakes.peers.findByFingerprint.mockResolvedValue(known);

			await manager.accept(foreignInvite(new Date(Date.now() + 60_000)), 'Alice');

			expect(known).toMatchObject({ name: 'Alice', address: 'https://theirs.example.org' });
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

		it('answers a banned fingerprint with nothing at all', async () => {
			// Silence, and the ban list is the only thing that refuses here now. An
			// answer that said "banned" would let anybody map out the list by watching
			// what happens.
			const { manager, fakes } = build();

			fakes.bans.isBanned.mockResolvedValue(true);

			await manager.requested('abc123', 'Bob', null);

			expect(fakes.peers.save).not.toHaveBeenCalled();
			expect(fakes.peers.findByFingerprint).not.toHaveBeenCalled();
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

	});

	describe('forbidding a peer to read', () => {
		it('keeps the link open, which is the whole difference from the block it replaced', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			const peer = await manager.setReadingForbidden('peer-1', true);

			expect(peer.readingForbidden).toBe(true);
			expect(peer.status).toBe(PeerStatus.LINKED);
			// Closing the socket is what cut our own access to their library. Nothing
			// here may reach for it.
			expect(fakes.links.disconnect).not.toHaveBeenCalled();
			expect(fakes.peers.setStatus).not.toHaveBeenCalled();
		});

		it('is reversible in one call, with nothing else changed', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow({ readingForbidden: true }));

			const peer = await manager.setReadingForbidden('peer-1', false);

			expect(peer.readingForbidden).toBe(false);
			expect(peer.status).toBe(PeerStatus.LINKED);
			expect(fakes.links.connect).not.toHaveBeenCalled();
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

		it('reports a peer nobody answered for as unreachable, so it is tried again', async () => {
			const { fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.UNREACHABLE }));
			fakes.links.connect.mockRejectedValue(new Error('connect ETIMEDOUT'));

			await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.UNREACHABLE);
		});

		it('reports a far end that refused us as refused, so it is never redialled', async () => {
			// Knocking again after being told no is how a gateway gets itself banned at
			// the other end for good.
			const { fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.UNREACHABLE }));
			fakes.links.connect.mockRejectedValue(
				new ServiceUnavailableException({ key: ErrorKey.PEER_REJECTED }),
			);

			await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.REFUSED);
		});

		it('reports a protocol version neither end speaks as refused', async () => {
			const { fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
			fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.UNREACHABLE }));
			fakes.links.connect.mockRejectedValue(
				new ServiceUnavailableException({ key: ErrorKey.PEER_PROTOCOL_UNSUPPORTED }),
			);

			await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.REFUSED);
		});

		it('refuses a banned fingerprint without opening a socket at all', async () => {
			const { fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
			fakes.bans.isBanned.mockResolvedValue(true);

			await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.REFUSED);
			expect(fakes.links.connect).not.toHaveBeenCalled();
		});

		it('refuses a row that went away under a timer, rather than rearming one', async () => {
			const { fakes } = build();

			fakes.peers.findWithPublicKey.mockResolvedValue(null);

			await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.REFUSED);
		});
	});

	describe('reconnecting by itself', () => {
		it('schedules every linked peer at boot rather than dialling them in turn', async () => {
			// A friend who is switched off takes the whole connection timeout to fail,
			// and a dozen of those in sequence would hold the boot for minutes.
			const { manager, fakes } = build({ autoConnect: true });

			fakes.peers.findLinked.mockResolvedValue([peerRow(), peerRow({ id: 'peer-2' })]);

			manager.onApplicationBootstrap();
			// Detached, and now with a sweep of the temporary peers in front of it:
			// draining the queue is what a boot really does, and counting `await`s would
			// break the next time a step is added in front.
			await flush();

			expect(fakes.reconnects.schedule.mock.calls.map((call) => call[0])).toEqual([
				'peer-1',
				'peer-2',
			]);
			expect(fakes.links.connect).not.toHaveBeenCalled();
		});

		it('schedules a retry when a live link drops', async () => {
			const { fakes } = build();
			const lost = fakes.links.onLinkLost.mock.calls[0]?.[0] as (peerId: string) => void;

			lost('peer-1');
			// The drop is answered off the socket callback: a peer that only existed for
			// a transfer is forgotten instead of being redialled, and telling the two
			// apart is a question for the database.
			await flush();

			expect(fakes.reconnects.schedule).toHaveBeenCalledWith('peer-1');
			expect(fakes.peers.setStatus).toHaveBeenCalledWith('peer-1', PeerStatus.UNREACHABLE);
		});

		it('stops trying a peer that has been removed', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.remove('peer-1');

			expect(fakes.reconnects.cancel).toHaveBeenCalledWith('peer-1');
		});
	});

	describe('verifying a peer credential', () => {
		it('refuses a peer whose public key we never learned', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow());
			fakes.peers.findWithPublicKey.mockResolvedValue(peerRow({ publicKey: null }));

			await expect(manager.verify(THEIR_FINGERPRINT, 'signature')).resolves.toBe(false);
		});

		it('refuses a peer that is not linked before looking at the signature at all', async () => {
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow({ status: PeerStatus.PENDING }));

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
		it('records the fingerprint and unlinks, when a peer is banned', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.ban('peer-1', 'flooded us');

			expect(fakes.bans.ban).toHaveBeenCalledWith(THEIR_FINGERPRINT, {
				name: 'Alice',
				reason: 'flooded us',
			});
			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});

		it('records nothing when a peer is simply removed', async () => {
			// The ordinary case has to stay ordinary: a friend who rebuilt their gateway
			// should be able to come back by asking. Removal carries no ban at all since
			// the checkbox that offered one went: the standalone action made it a second
			// way to reach the same outcome.
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.remove('peer-1');

			expect(fakes.bans.ban).not.toHaveBeenCalled();
			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});

		it('records the ban before deleting anything', async () => {
			// After the row is gone there is nothing left to take the fingerprint and
			// the name from, so a failure between the two must not leave a ban on
			// whatever survived it.
			const { manager, fakes } = build();
			const order: string[] = [];

			fakes.peers.findOne.mockResolvedValue(peerRow());
			fakes.bans.ban.mockImplementation((fingerprint: string) => {
				order.push('ban');

				return Promise.resolve({
					fingerprint,
					name: null,
					reason: null,
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
				});
			});
			fakes.peers.delete.mockImplementation(() => {
				order.push('delete');

				return Promise.resolve(undefined);
			});

			await manager.ban('peer-1');

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

	describe('choosing somebody first met through an introduction', () => {
		it('keeps a temporary peer that somebody then approves', async () => {
			// Settling a link is choosing them. Left temporary, a friend would delete
			// themselves the next time the link closed and vanish at every restart.
			const { manager, fakes } = build();
			const met = peerRow({
				status: PeerStatus.PENDING,
				direction: PeerDirection.INCOMING,
				trust: PeerTrust.FRIEND_OF_FRIEND,
				discovered: true,
			});

			fakes.peers.findOne.mockResolvedValue(met);

			await manager.approve('peer-1');

			expect(met).toMatchObject({ status: PeerStatus.LINKED, discovered: false });

			// And the proof it matters: their link closing now schedules a retry
			// instead of deleting them.
			await expect(manager.forget('peer-1')).resolves.toBe(false);
			expect(fakes.peers.delete).not.toHaveBeenCalled();
		});

		it('keeps the request somebody types for a temporary peer, rather than sweeping it', async () => {
			const { manager, fakes } = build();
			const met = peerRow({
				name: 'peer-aaaaaaaa',
				status: PeerStatus.LINKED,
				direction: null,
				address: '198.51.100.7',
				discovered: true,
			});

			fakes.peers.findByFingerprint.mockResolvedValue(met);

			await manager.add({ fingerprint: THEIR_FINGERPRINT });

			expect(met).toMatchObject({
				name: 'peer-aaaaaaaa',
				address: '198.51.100.7',
				status: PeerStatus.PENDING,
				direction: PeerDirection.OUTGOING,
				discovered: false,
			});
		});

		it('refuses to add a fingerprint that is only whitespace', async () => {
			const { manager, fakes } = build();

			await expect(manager.add({ fingerprint: '   ' })).rejects.toThrow(
				ErrorKey.PEER_INVITE_INVALID,
			);
			expect(fakes.peers.save).not.toHaveBeenCalled();
		});
	});

	describe('a temporary peer, when the gateway lets go of it', () => {
		it('forgets one whose link of ours drops, instead of redialling it', async () => {
			// A peer met for one transfer and redialled forever would be a stranger in
			// the list, called at every restart, with nothing on screen saying why.
			const { fakes } = build();
			const lost = fakes.links.onLinkLost.mock.calls[0]?.[0] as (peerId: string) => void;

			fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: true }));

			lost('peer-1');
			await flush();

			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
			expect(fakes.reconnects.schedule).not.toHaveBeenCalled();
		});

		it('sweeps the ones a stopped gateway left behind, at boot', async () => {
			const { manager, fakes } = build();

			fakes.peers.find.mockResolvedValue([peerRow({ id: 'peer-1', discovered: true })]);
			fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: true }));

			manager.onApplicationBootstrap();
			await flush();

			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});

		it('still reconnects to its friends when the sweep cannot read the list', async () => {
			// A row that outlived its link costs a line in a list; a boot that stopped
			// over it would cost every link this gateway has.
			const { manager, fakes } = build({ autoConnect: true });

			fakes.peers.find.mockRejectedValue(new Error('SQLITE_BUSY'));
			fakes.peers.findLinked.mockResolvedValue([peerRow()]);

			manager.onApplicationBootstrap();
			await flush();

			expect(fakes.reconnects.schedule).toHaveBeenCalledWith('peer-1');
		});
	});

	describe('banning by fingerprint', () => {
		it('refuses a fingerprint that is only whitespace', async () => {
			// An empty key on the list would match nothing today and whatever reads an
			// empty fingerprint as "unknown" tomorrow.
			const { manager, fakes } = build();

			await expect(manager.banFingerprint('  ')).rejects.toThrow(ErrorKey.PEER_INVITE_INVALID);
			expect(fakes.bans.ban).not.toHaveBeenCalled();
		});

		it('takes a linked peer with it, under the name we know them by', async () => {
			// A banned key still listed among the peers is a row somebody could approve
			// without knowing why it is there.
			const { manager, fakes } = build();

			fakes.peers.findByFingerprint.mockResolvedValue(peerRow());
			fakes.peers.findOne.mockResolvedValue(peerRow());

			await manager.banFingerprint(THEIR_FINGERPRINT, { name: 'Somebody else', reason: ' spam ' });

			expect(fakes.bans.ban).toHaveBeenCalledWith(THEIR_FINGERPRINT, {
				name: 'Alice',
				reason: 'spam',
			});
			expect(fakes.peers.delete).toHaveBeenCalledWith({ id: 'peer-1' });
		});
	});

	describe('answering a hello', () => {
		it('records an empty node identifier as unknown rather than as a name', async () => {
			// Two gateways that both sent nothing would otherwise share one identity.
			const { manager, fakes } = build();

			await manager.greet(
				'peer-1',
				{
					nodeId: '',
					fingerprint: THEIR_FINGERPRINT,
					name: 'Alice',
					protocol: PROTOCOL_VERSION,
					capabilities: [],
				},
				'challenge',
			);

			expect(fakes.peers.recordHandshake).toHaveBeenCalledWith(
				'peer-1',
				expect.objectContaining({ nodeId: null }),
			);
		});
	});

	it('reads a refusal raised with a bare key as a refusal, so it is never redialled', async () => {
		// The link service may raise its key as the whole response rather than inside
		// an object. Read as "unreachable", a gateway that said no would be dialled
		// again every few minutes for as long as we run.
		const { fakes } = build();

		fakes.peers.findWithPublicKey.mockResolvedValue(peerRow());
		fakes.peers.findOne.mockResolvedValue(peerRow({ status: PeerStatus.UNREACHABLE }));
		fakes.links.connect.mockRejectedValue(new HttpException(ErrorKey.PEER_REJECTED, 403));

		await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.REFUSED);
	});

	it('registers nothing for a temporary peer it dials for a transfer', async () => {
		// One file, not a library: a service for them would scan a catalogue we are
		// about to forget and leave rows behind when the link closes.
		const { fakes } = build();

		fakes.peers.findWithPublicKey.mockResolvedValue(peerRow({ discovered: true }));
		fakes.peers.findOne.mockResolvedValue(peerRow({ discovered: true }));
		fakes.links.connect.mockResolvedValue({
			mode: 'direct',
			address: null,
			protocol: null,
			nodeId: null,
			capabilities: [],
		});

		await expect(fakes.reconnects.dial('peer-1')).resolves.toBe(PeerDialOutcome.LINKED);
		expect(fakes.services.create).not.toHaveBeenCalled();
		expect(fakes.serviceManager.probe).not.toHaveBeenCalled();
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
