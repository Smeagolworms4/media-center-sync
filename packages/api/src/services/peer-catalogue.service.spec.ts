import { MediaKind, PeerTrust, ShareVisibility, type CatalogueEntry } from '@mcs/shared';
import type { PeerLinkService } from './peer-link.service';
import {
	PeerCatalogueService,
	type CataloguePeer,
	type CataloguePolicy,
	type ContentHolder,
} from './peer-catalogue.service';

function policy(overrides: Partial<CataloguePolicy> = {}): CataloguePolicy {
	return {
		libraryId: 'lib-1',
		visibility: ShareVisibility.FRIENDS,
		allowedPeerIds: [],
		deniedPeerIds: [],
		rateLimit: 0,
		...overrides,
	};
}

function peer(overrides: Partial<CataloguePeer> = {}): CataloguePeer {
	return { id: 'peer-1', name: 'Sam', trust: PeerTrust.FRIEND, viaPeerId: null, ...overrides };
}

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
	return {
		externalId: 'item-1',
		libraryId: 'lib-1',
		kind: MediaKind.EPISODE,
		title: 'Dulcinea',
		year: 2015,
		seasonNumber: 1,
		episodeNumber: 1,
		parentExternalId: null,
		externalIds: {},
		contentId: 'q1-abc',
		size: 100,
		quality: null,
		...overrides,
	};
}

describe('PeerCatalogueService', () => {
	let links: { request: jest.Mock; isLinked: jest.Mock; supports: jest.Mock };
	let service: PeerCatalogueService;

	beforeEach(() => {
		links = {
			request: jest.fn(),
			isLinked: jest.fn(() => true),
			supports: jest.fn(() => true),
		};
		service = new PeerCatalogueService(links as unknown as PeerLinkService);
	});

	describe('isVisible', () => {
		it('shows nothing when the library is private', () => {
			expect(service.isVisible(policy({ visibility: ShareVisibility.PRIVATE }), peer())).toBe(
				false,
			);
		});

		it('shows a friend a library shared with friends', () => {
			expect(service.isVisible(policy(), peer())).toBe(true);
		});

		it('does not treat a friend of a friend as a friend', () => {
			expect(service.isVisible(policy(), peer({ trust: PeerTrust.FRIEND_OF_FRIEND }))).toBe(
				false,
			);
		});

		it('shows a friend of a friend when the policy says so', () => {
			expect(
				service.isVisible(
					policy({ visibility: ShareVisibility.FRIENDS_OF_FRIENDS }),
					peer({ trust: PeerTrust.FRIEND_OF_FRIEND }),
				),
			).toBe(true);
		});

		it('lets an explicit allow override a private library', () => {
			expect(
				service.isVisible(
					policy({ visibility: ShareVisibility.PRIVATE, allowedPeerIds: ['peer-1'] }),
					peer(),
				),
			).toBe(true);
		});

		it('lets a denial beat everything, including an allow', () => {
			// A list of people who must not see something is only useful if it cannot be
			// overridden by a rule set six months earlier and forgotten.
			expect(
				service.isVisible(
					policy({
						visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
						allowedPeerIds: ['peer-1'],
						deniedPeerIds: ['peer-1'],
					}),
					peer(),
				),
			).toBe(false);
		});
	});

	describe('filterForPeer', () => {
		it('drops a library with no policy at all', () => {
			// Defaulting to visible would expose a library the moment somebody links.
			expect(service.filterForPeer([entry()], [], peer())).toEqual([]);
		});

		it('keeps what the policy allows', () => {
			expect(service.filterForPeer([entry()], [policy()], peer())).toHaveLength(1);
		});

		it('drops a row that names no library at all', () => {
			// A peer running an older image sends rows without a library handle. There is
			// nothing to match a policy against, and the rule above decides the rest.
			expect(service.filterForPeer([entry({ libraryId: null })], [policy()], peer())).toEqual(
				[],
			);
		});

		it('never invents a content identity for a row that came without one', () => {
			const [filtered] = service.filterForPeer(
				[entry({ contentId: null })],
				[policy()],
				peer(),
			);

			expect(filtered.contentId).toBeNull();
		});
	});

	describe('fetchCatalogue', () => {
		it('returns what the peer sent', async () => {
			links.request
				.mockResolvedValueOnce({ entries: [entry()] })
				.mockResolvedValueOnce({ entries: [] });

			expect(await service.fetchCatalogue('peer-1')).toHaveLength(1);
		});

		it('walks every page rather than importing the first one', async () => {
			// Asking once silently imported the first page of a library and reported the
			// rest as missing, which reads as a friend who deleted half their series.
			links.request
				.mockResolvedValueOnce({ entries: [entry({ externalId: 'a' })] })
				.mockResolvedValueOnce({ entries: [entry({ externalId: 'b' })] })
				.mockResolvedValueOnce({ entries: [] });

			const entries = await service.fetchCatalogue('peer-1');

			expect(entries.map((row) => row.externalId)).toEqual(['a', 'b']);
			expect(links.request).toHaveBeenNthCalledWith(
				2,
				'peer-1',
				'catalogue.list',
				expect.objectContaining({ page: 2 }),
			);
		});

		it('keeps the pages that crossed when one fails', async () => {
			// Half a catalogue is worth having: the next refresh fills the rest, and a
			// link that drops mid-import must not lose what already arrived.
			links.request
				.mockResolvedValueOnce({ entries: [entry()] })
				.mockRejectedValueOnce(new Error('link closed'));

			expect(await service.fetchCatalogue('peer-1')).toHaveLength(1);
		});

		it('answers with nothing when the peer does not', async () => {
			links.request.mockRejectedValue(new Error('unreachable'));

			expect(await service.fetchCatalogue('peer-1')).toEqual([]);
		});
	});

	describe('findHolders', () => {
		function holder(overrides: Partial<ContentHolder> = {}): ContentHolder {
			return {
				peerId: '',
				peerName: '',
				serviceId: 'svc-1',
				externalId: 'ext-1',
				size: 100,
				trust: PeerTrust.FRIEND,
				viaPeerId: null,
				...overrides,
			};
		}

		it('marks a peer reporting its own holdings as a friend', async () => {
			links.request.mockResolvedValue({ holders: [holder()] });

			const holders = await service.findHolders('q1-abc', [peer()], {
				allowFriendsOfFriends: false,
			});

			expect(holders).toEqual([
				expect.objectContaining({ peerId: 'peer-1', peerName: 'Sam', trust: PeerTrust.FRIEND }),
			]);
		});

		it('demotes anything else a peer reports to a friend of a friend', async () => {
			// Taking the far end's word for the trust level would let one peer promote an
			// arbitrary machine to friend.
			links.request.mockResolvedValue({
				holders: [holder({ peerId: 'stranger', peerName: 'Alex', trust: PeerTrust.FRIEND })],
			});

			const holders = await service.findHolders('q1-abc', [peer()], {
				allowFriendsOfFriends: true,
			});

			expect(holders[0]).toMatchObject({
				peerId: 'stranger',
				trust: PeerTrust.FRIEND_OF_FRIEND,
				viaPeerId: 'peer-1',
			});
		});

		it('drops friends of friends when the setting says no', async () => {
			links.request.mockResolvedValue({
				holders: [holder(), holder({ peerId: 'stranger', peerName: 'Alex' })],
			});

			const holders = await service.findHolders('q1-abc', [peer()], {
				allowFriendsOfFriends: false,
			});

			expect(holders.map((entry) => entry.peerId)).toEqual(['peer-1']);
		});

		it('asks for a second hop only when it is allowed', async () => {
			links.request.mockResolvedValue({ holders: [] });

			await service.findHolders('q1-abc', [peer()], { allowFriendsOfFriends: true });

			expect(links.request).toHaveBeenCalledWith(
				'peer-1',
				'catalogue.holders',
				expect.objectContaining({ depth: 1 }),
			);
		});

		it('does not ask a peer we have no link to', async () => {
			links.isLinked.mockReturnValue(false);

			expect(
				await service.findHolders('q1-abc', [peer()], { allowFriendsOfFriends: true }),
			).toEqual([]);
			expect(links.request).not.toHaveBeenCalled();
		});

		it('counts the same file behind two friends once', async () => {
			// Two entries would open two connections to one machine and count its
			// bandwidth twice when picking sources.
			links.request.mockResolvedValue({
				holders: [holder({ peerId: 'stranger', peerName: 'Alex' })],
			});

			const holders = await service.findHolders(
				'q1-abc',
				[peer(), peer({ id: 'peer-2', name: 'Kim' })],
				{ allowFriendsOfFriends: true },
			);

			expect(holders.filter((entry) => entry.peerId === 'stranger')).toHaveLength(1);
		});

		it('puts friends before friends of friends', async () => {
			links.request.mockImplementation(async (peerId: string) =>
				peerId === 'peer-1'
					? { holders: [holder({ peerId: 'stranger', peerName: 'Alex' })] }
					: { holders: [holder()] },
			);

			const holders = await service.findHolders(
				'q1-abc',
				[peer(), peer({ id: 'peer-2', name: 'Kim' })],
				{ allowFriendsOfFriends: true },
			);

			expect(holders[0].trust).toBe(PeerTrust.FRIEND);
		});

		it('never asks a friend of a friend directly', async () => {
			await service.findHolders('q1-abc', [peer({ trust: PeerTrust.FRIEND_OF_FRIEND })], {
				allowFriendsOfFriends: true,
			});

			expect(links.request).not.toHaveBeenCalled();
		});
	});
});
