import { ErrorKey, PeerTrust, ShareVisibility } from '@mcs/shared';
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
				{ id: 'service-1', name: 'Living room', shared: true, filesMounted: true, peerId: null },
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
	describe('a library nobody has configured', () => {
		it('is listed, following the gateway default, rather than left out', async () => {
			// Left out, the shares screen showed nothing at all on a gateway that was in
			// fact sharing every library it had — and a screen that cannot list a library
			// cannot be used to change it either.
			const { manager } = build();

			await expect(manager.list()).resolves.toEqual([
				expect.objectContaining({
					// No row, so no identifier and no date: nothing was written.
					id: '',
					libraryId: 'library-1',
					libraryName: 'Shows',
					visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
					overridden: false,
					updatedAt: '',
				}),
			]);
		});

		it('is visible to a peer the default reaches, without a row being written', async () => {
			const { manager, fakes } = build();

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([
				{
					libraryId: 'library-1',
					visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
					allowedPeerIds: [],
					deniedPeerIds: [],
					rateLimit: 0,
				},
			]);
			// Reading must never write. A row materialised here would freeze today's
			// default into the library and stop the setting ever moving it again.
			expect(fakes.policies.save).not.toHaveBeenCalled();
		});

		it('is named in the audit, which has to answer what the peer routes answer', async () => {
			const { manager } = build();

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toEqual([
				{
					libraryId: 'library-1',
					name: 'Shows',
					// Named because this list is not merged: two rows called `Shows` with
					// nothing to tell them apart read as a rendering fault.
					serviceName: 'Living room',
					itemCount: 120,
					throughUs: false,
				},
			]);
		});

		it('moves with the default, which is the whole point of resolving late', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue({
				defaultShareVisibility: ShareVisibility.FRIENDS,
			});

			await expect(manager.visiblePolicies(peer())).resolves.toMatchObject([
				{ visibility: ShareVisibility.FRIENDS },
			]);

			fakes.settings.get.mockResolvedValue({
				defaultShareVisibility: ShareVisibility.PRIVATE,
			});

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([]);
		});

		it('stays private on a service nobody switched on, whatever the default says', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', shared: false, filesMounted: true, peerId: null },
			]);

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([]);
			await expect(manager.list()).resolves.toMatchObject([
				{ visibility: ShareVisibility.PRIVATE, overridden: false },
			]);
		});

		it('follows the default on a shared service whose files we do not hold', async () => {
			// The whole point of the switch. Serving these bytes means reading the media
			// server over HTTP and passing them on, which works — the old rule refused it
			// and left the commonest case of all silently private.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', shared: true, filesMounted: false, peerId: null },
			]);

			await expect(manager.visiblePolicies(peer())).resolves.toMatchObject([
				{ libraryId: 'library-1', visibility: ShareVisibility.FRIENDS_OF_FRIENDS },
			]);
		});

		it("stays private on a peer's service, however that row reads", async () => {
			// Never relayed, and not merely off by default: what a friend's friend holds
			// is reached by introducing the two ends, not by carrying their bytes through
			// the middle. So the manager refuses it rather than trusting the switch.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', shared: true, filesMounted: true, peerId: 'peer-9' },
			]);

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([]);
		});

		it('keeps what was in force when a write names only other fields', async () => {
			// Seeding the new row with `private` instead would make setting a rate limit
			// silently stop sharing the library: the row now exists, so the default no
			// longer reaches it, and nothing on the screen said that was the trade.
			const { manager, fakes } = build();

			const saved = await manager.put('library-1', { rateLimit: 1024 });

			expect(saved.visibility).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
			expect(saved.overridden).toBe(true);
			expect(saved.rateLimit).toBe(1024);
			expect(fakes.policies.create).toHaveBeenCalled();
		});
	});

	describe('an explicit policy', () => {
		it('wins over the default, including a private on one of our own libraries', async () => {
			// An override to private is a decision, and a decision outranks a setting
			// somebody changes months later.
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy({ visibility: ShareVisibility.PRIVATE })]);

			await expect(manager.visiblePolicies(peer())).resolves.toEqual([]);
			await expect(manager.list()).resolves.toMatchObject([
				{ visibility: ShareVisibility.PRIVATE, overridden: true, id: 'policy-1' },
			]);
		});

		it('wins over the default when it is narrower than it', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy({ visibility: ShareVisibility.FRIENDS })]);

			await expect(
				manager.visiblePolicies(peer({ trust: PeerTrust.FRIEND_OF_FRIEND })),
			).resolves.toEqual([]);
		});
	});

	describe('a peer forbidden from reading', () => {
		it('sees nothing, whatever the policies say', async () => {
			// The gateway-wide answer, honoured here and nowhere else because this is the
			// one funnel every peer-facing route goes through.
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy({ visibility: ShareVisibility.FRIENDS_OF_FRIENDS })]);

			await expect(manager.visiblePolicies(peer({ readingForbidden: true }))).resolves.toEqual([]);
		});

		it('outranks an explicit allow naming them by identifier', async () => {
			// A per-library list cannot express "this person sees nothing of mine", which
			// is exactly why this sits above `deniedPeerIds` rather than beside it.
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([
				policy({ visibility: ShareVisibility.FRIENDS, allowedPeerIds: ['peer-1'] }),
			]);

			await expect(manager.visiblePolicies(peer({ readingForbidden: true }))).resolves.toEqual([]);
		});

		it('is reported as seeing nothing by the audit too', async () => {
			// The audit promises to answer the question the peer routes answer. Two
			// answers to one question is how somebody reads a screen saying a peer sees
			// three libraries while that peer is served none.
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy()]);
			fakes.peers.findOne.mockResolvedValue(peer({ readingForbidden: true }));

			await expect(manager.audit('peer-1')).resolves.toMatchObject({ libraries: [] });
		});

		it('sees everything again the moment the flag comes off', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy()]);

			await expect(manager.visiblePolicies(peer({ readingForbidden: false }))).resolves.toEqual([
				expect.objectContaining({ libraryId: 'library-1' }),
			]);
		});
	});

	describe('audit', () => {
		it('names the libraries this peer really would see', async () => {
			const { manager, fakes } = build();

			fakes.policies.find.mockResolvedValue([policy()]);

			const audit = await manager.audit('peer-1');

			expect(audit.peerName).toBe('Alice');
			expect(audit.libraries).toEqual([
				{
					libraryId: 'library-1',
					name: 'Shows',
					// Named because this list is not merged: two rows called `Shows` with
					// nothing to tell them apart read as a rendering fault.
					serviceName: 'Living room',
					itemCount: 120,
					throughUs: false,
				},
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

		it('hands a library back to the default by deleting the row, not by rewriting it', async () => {
			const { manager, fakes } = build();

			await manager.remove('library-1');

			expect(fakes.policies.deleteForLibrary).toHaveBeenCalledWith('library-1');
			expect(fakes.policies.save).not.toHaveBeenCalled();
		});
	});

	describe('sharing a library whose files we do not hold', () => {
		it('saves it like any other, because serving it is a solved problem', async () => {
			// It used to be refused with `SHARE_RELAY_NOT_AGREED`, pointing at a consent
			// control that was never built. `PeerExchangeManager.content()` opens a
			// stream against the media server and never looks for a local file, so there
			// was nothing behind the refusal but a second place to say yes.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', shared: true, filesMounted: false, peerId: null },
			]);

			await expect(
				manager.put('library-1', { visibility: ShareVisibility.FRIENDS }),
			).resolves.toMatchObject({ visibility: ShareVisibility.FRIENDS, overridden: true });
		});

		it('says in an audit that this one is served through us', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Living room', shared: true, filesMounted: false, peerId: null },
			]);

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toMatchObject([{ libraryId: 'library-1', throughUs: true }]);
		});

		it('says nothing of the sort about a library we hold', async () => {
			const { manager } = build();

			const audit = await manager.audit('peer-1');

			expect(audit.libraries).toMatchObject([{ libraryId: 'library-1', throughUs: false }]);
		});
	});

});
