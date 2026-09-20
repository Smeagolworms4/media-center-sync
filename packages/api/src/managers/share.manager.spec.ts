import { ErrorKey, MediaServiceScope, PeerTrust, ShareVisibility } from '@mcs/shared';
import type { Library, Peer, SharePolicy } from '@/entities';
import type {
	LibraryRepository,
	MediaServiceRepository,
	PeerRepository,
	SharePolicyRepository,
} from '@/repositories';
import { PeerCatalogueService, type SettingsService } from '@/services';
import { ShareManager } from './share.manager';

interface Fakes {
	policies: {
		find: jest.Mock;
		findByLibrary: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		deleteForLibrary: jest.Mock;
	};
	libraries: { find: jest.Mock; findOne: jest.Mock };
	peers: { findOne: jest.Mock };
	services: { find: jest.Mock };
	settings: { get: jest.Mock };
}

const library = (overrides: Partial<Library> = {}): Library =>
	({
		id: 'library-1',
		serviceId: 'service-1',
		name: 'Shows',
		itemCount: 120,
		...overrides,
	}) as Library;

const policy = (overrides: Partial<SharePolicy> = {}): SharePolicy =>
	({
		id: 'policy-1',
		libraryId: 'library-1',
		visibility: ShareVisibility.FRIENDS,
		allowedPeerIds: [],
		deniedPeerIds: [],
		rateLimit: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as SharePolicy;

const peer = (overrides: Partial<Peer> = {}): Peer =>
	({
		id: 'peer-1',
		name: 'Alice',
		trust: PeerTrust.FRIEND,
		viaPeerId: null,
		...overrides,
	}) as Peer;

const build = (): { manager: ShareManager; fakes: Fakes } => {
	const fakes: Fakes = {
		policies: {
			find: jest.fn().mockResolvedValue([]),
			findByLibrary: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<SharePolicy>) => policy(value)),
			save: jest.fn((value: SharePolicy) => Promise.resolve(value)),
			deleteForLibrary: jest.fn().mockResolvedValue(undefined),
		},
		libraries: {
			find: jest.fn().mockResolvedValue([library()]),
			findOne: jest.fn().mockResolvedValue(library()),
		},
		peers: { findOne: jest.fn().mockResolvedValue(peer()) },
		services: {
			find: jest.fn().mockResolvedValue([
				{ id: 'service-1', scope: MediaServiceScope.LOCAL, peerId: null },
			]),
		},
		settings: {
			get: jest.fn().mockResolvedValue({
				defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS,
			}),
		},
	};

	// The real visibility service, not a fake: the audit's whole purpose is to answer
	// with the same test the peer-facing routes run, and a fake would let the two
	// drift apart while the test kept passing.
	const manager = new ShareManager(
		fakes.policies as unknown as SharePolicyRepository,
		fakes.libraries as unknown as LibraryRepository,
		fakes.peers as unknown as PeerRepository,
		new PeerCatalogueService({} as never),
		fakes.services as unknown as MediaServiceRepository,
		fakes.settings as unknown as SettingsService,
	);

	return { manager, fakes };
};

describe('ShareManager', () => {
	describe('the absence of a policy', () => {
		it('shows a library with no row nowhere at all', async () => {
			const { manager } = build();

			await expect(manager.list()).resolves.toEqual([]);
		});

		it('keeps a library with no row out of what a peer would see', async () => {
			const { manager } = build();

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toEqual([]);
		});

		it('keeps a library with no row out of the policies the peer routes read', async () => {
			const { manager } = build();

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([]);
		});

		it('creates a policy as private when the request said nothing about visibility', async () => {
			const { manager, fakes } = build();

			const saved = await manager.put('library-1', { rateLimit: 1024 });

			expect(saved.visibility).toBe(ShareVisibility.PRIVATE);
			expect(saved.rateLimit).toBe(1024);
			expect(fakes.policies.create).toHaveBeenCalled();
		});
	});

	describe('audit', () => {
		it('names the libraries this peer really would see', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy()]);

			const audit = await manager.audit('peer-1');

			expect(audit.peerName).toBe('Alice');
			expect(audit.libraries).toEqual([
				{ libraryId: 'library-1', name: 'Shows', itemCount: 120, throughUs: false },
			]);
		});

		it('excludes a friend of a friend from a library shared with friends', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy()]);
			fakes.peers.findOne.mockResolvedValue(peer({ trust: PeerTrust.FRIEND_OF_FRIEND }));

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toEqual([]);
		});

		it('lets a denial override an explicit allow', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([
				policy({
					visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
					allowedPeerIds: ['peer-1'],
					deniedPeerIds: ['peer-1'],
				}),
			]);

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toEqual([]);
		});

		it('refuses to audit a peer nobody linked to', async () => {
			const { manager, fakes } = build();

			fakes.peers.findOne.mockResolvedValue(null);

			await expect(manager.audit('peer-1')).rejects.toThrow(ErrorKey.PEER_NOT_FOUND);
		});
	});

	describe('writing a policy', () => {
		it('refuses a library nothing registered', async () => {
			const { manager, fakes } = build();

			fakes.libraries.findOne.mockResolvedValue(null);

			await expect(manager.put('library-1', {})).rejects.toThrow(ErrorKey.LIBRARY_NOT_FOUND);
		});

		it('changes one field without touching the others', async () => {
			const { manager, fakes } = build();

			fakes.policies.findByLibrary.mockResolvedValue(
				policy({ allowedPeerIds: ['peer-9'], rateLimit: 1024 }),
			);

			const saved = await manager.put('library-1', { visibility: ShareVisibility.PRIVATE });

			expect(saved.visibility).toBe(ShareVisibility.PRIVATE);
			expect(saved.allowedPeerIds).toEqual(['peer-9']);
			expect(saved.rateLimit).toBe(1024);
		});

		it('makes a library private again by deleting the row, not by rewriting it', async () => {
			const { manager, fakes } = build();

			await manager.remove('library-1');

			expect(fakes.policies.deleteForLibrary).toHaveBeenCalledWith('library-1');
			expect(fakes.policies.save).not.toHaveBeenCalled();
		});
	});

	describe('relaying a library that is not ours', () => {
		it('refuses to share a remote library until somebody agrees to relay it', async () => {
			// Sharing one of our own libraries gives away our own bytes off our own disk.
			// Sharing a remote one makes us the conduit: our bandwidth, and an access
			// granted to us rather than to the people we would be handing it to.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([{ id: 'service-1', scope: MediaServiceScope.REMOTE }]);

			await expect(
				manager.put('library-1', { visibility: ShareVisibility.FRIENDS }),
			).rejects.toThrow(ErrorKey.SHARE_RELAY_NOT_AGREED);
		});

		it('allows it once somebody has said so', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([{ id: 'service-1', scope: MediaServiceScope.REMOTE }]);

			const saved = await manager.put('library-1', {
				visibility: ShareVisibility.FRIENDS,
				relay: true,
			});

			expect(saved).toMatchObject({ relay: true, relays: true });
		});

		it('leaves a remote library private without any agreement', async () => {
			// Private is not sharing, so there is nothing to agree to and nothing to
			// refuse — somebody setting a rate limit on a library they have not shared
			// should not be told about relays.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([{ id: 'service-1', scope: MediaServiceScope.REMOTE }]);

			await expect(manager.put('library-1', { rateLimit: 1024 })).resolves.toMatchObject({
				relays: true,
				relay: false,
			});
		});

		it('says a library of ours is ours to give', async () => {
			const { manager } = build();

			await expect(
				manager.put('library-1', { visibility: ShareVisibility.FRIENDS }),
			).resolves.toMatchObject({ relays: false });
		});
	});

});
