import {
	ErrorKey,
	MatchStrategy,
	MediaKind,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import type { MediaItem, MediaMatch } from '@/entities';
import type {
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	MatchingService,
	QualityService,
	type CacheService,
	type HandlerRegistry,
	type SettingsService,
} from '@/services';
import { MediaManager } from './media.manager';

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/library-a/Big Buck Bunny (2008) - S01E05 - The Flight.mp4',
	size: 1_048_576,
	container: 'mp4',
	videoCodec: 'hevc',
	audioCodec: 'aac',
	width: 1920,
	height: 1080,
	durationMs: 4000,
	bitrate: 2_000_000,
	quickHash: 'v1:abc',
	contentId: 'v1:abc:1048576',
	checksum: null,
	...overrides,
});

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item-a',
		serviceId: 'service-a',
		libraryId: 'library-a',
		externalId: 'a-5',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'The Flight',
		normalizedTitle: 'big buck bunny',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 5,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: file(),
		quality: null,
		syncState: SyncState.UNKNOWN,
		addedAt: null,
		childCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaItem;

const match = (overrides: Partial<MediaMatch> = {}): MediaMatch =>
	({
		id: 'match-1',
		localItemId: 'item-a',
		remoteItemId: 'item-b',
		remoteServiceId: 'service-b',
		remotePeerId: null,
		strategy: MatchStrategy.NORMALIZED_TITLE,
		confidence: 0.7,
		state: SyncState.MISSING,
		reason: null,
		confirmedAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaMatch;

interface Fakes {
	items: {
		find: jest.Mock;
		findOne: jest.Mock;
		findChildren: jest.Mock;
		findCandidatesForMatch: jest.Mock;
		search: jest.Mock;
		setSyncState: jest.Mock;
	};
	matches: {
		findOne: jest.Mock;
		findForLocalItem: jest.Mock;
		findForRemoteItem: jest.Mock;
		upsertPair: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
	};
}

const build = (world: { items?: MediaItem[] } = {}): { manager: MediaManager; fakes: Fakes } => {
	const items = world.items ?? [];
	const fakes: Fakes = {
		items: {
			find: jest.fn().mockResolvedValue(items),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(items.find((candidate) => candidate.id === options.where.id) ?? null),
			),
			findChildren: jest.fn().mockResolvedValue([]),
			findCandidatesForMatch: jest.fn().mockResolvedValue([]),
			search: jest.fn().mockResolvedValue([[], 0]),
			setSyncState: jest.fn().mockResolvedValue(undefined),
		},
		matches: {
			findOne: jest.fn().mockResolvedValue(null),
			findForLocalItem: jest.fn().mockResolvedValue([]),
			findForRemoteItem: jest.fn().mockResolvedValue([]),
			upsertPair: jest.fn((claim: unknown) => Promise.resolve(claim as MediaMatch)),
			save: jest.fn((value: MediaMatch) => Promise.resolve(value)),
			delete: jest.fn().mockResolvedValue(undefined),
		},
	};

	const manager = new MediaManager(
		fakes.items as unknown as MediaItemRepository,
		fakes.matches as unknown as MediaMatchRepository,
		{ find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as unknown as MediaServiceRepository,
		// The real scoring service: the rule under test is what the manager does with a
		// proposal, and a fake that produced one would prove nothing about the pair the
		// lab fixture is built around.
		new MatchingService(new QualityService()),
		{ getValue: jest.fn().mockResolvedValue(0.8) } as unknown as SettingsService,
		{ get: jest.fn().mockResolvedValue(null), set: jest.fn() } as unknown as CacheService,
		// Artwork is the only thing this manager fetches, and none of these tests do.
		{ get: jest.fn() } as unknown as HandlerRegistry,
	);

	return { manager, fakes };
};

describe('MediaManager', () => {
	describe('labels that contradict the bytes', () => {
		it('calls the same file under two episode numbers a conflict, not a match', () => {
			const { manager } = build();

			const reason = manager.labelDisagreement(
				item(),
				item({ id: 'item-b', serviceId: 'service-b', episodeNumber: 3 }),
			);

			expect(reason).toBe(
				'content identical, episode numbers differ: S01E05 here, S01E03 there',
			);
		});

		it('names the season when that is what disagrees', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(item(), item({ id: 'item-b', seasonNumber: 2 })),
			).toBe('content identical, season numbers differ: S01E05 here, S02E05 there');
		});

		it('says nothing when the numbers agree, whatever the names are', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(item(), item({ id: 'item-b', title: 'BigBuckBunny INTERNAL' })),
			).toBeNull();
		});

		it('says nothing when the content differs: that is an ordinary comparison', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(
					item(),
					item({ id: 'item-b', episodeNumber: 3, file: file({ contentId: 'v1:other:999' }) }),
				),
			).toBeNull();
		});

		it('never calls two files the same on size alone', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(
					item({ file: file({ contentId: null, quickHash: null }) }),
					item({ id: 'item-b', episodeNumber: 3, file: file({ contentId: null, quickHash: null }) }),
				),
			).toBeNull();
		});
	});

	describe('correlating a service', () => {
		it('finds the pair a title comparison could never have reconciled', async () => {
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-5',
				title: 'BigBuckBunny.S01E05.INTERNAL.1080p.x265-OTHER',
				normalizedTitle: 'bigbuckbunny s01e05 internal',
				year: null,
			});
			const { manager, fakes } = build({ items: [here, there] });

			await manager.correlateService('service-a');

			// The title lookup answers with nothing; only the content identity brings the
			// two rows together, which is the whole argument for deriving one from the file.
			expect(fakes.items.findCandidatesForMatch).toHaveBeenCalled();
			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					localItemId: 'item-a',
					remoteItemId: 'item-b',
					strategy: MatchStrategy.CHECKSUM,
				}),
			);
		});

		it('records a mislabelled pair as a conflict a person has to settle', async () => {
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				externalId: 'b-3',
				episodeNumber: 3,
			});
			const { manager, fakes } = build({ items: [here, there] });

			await manager.correlateService('service-a');

			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					state: SyncState.CONFLICT,
					reason: 'content identical, episode numbers differ: S01E05 here, S01E03 there',
				}),
			);
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(['item-a'], SyncState.CONFLICT);
		});

		it('never correlates an item with another row of its own service', async () => {
			const here = item();
			const twin = item({ id: 'item-a2', externalId: 'a-5-again' });
			const { manager, fakes } = build({ items: [here, twin] });

			await manager.correlateService('service-a');

			expect(fakes.matches.upsertPair).not.toHaveBeenCalled();
		});
	});

	describe('matches', () => {
		it('lists both sides, because an item is the remote half of somebody else’s', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findForLocalItem.mockResolvedValue([match({ id: 'match-1', confidence: 0.7 })]);
			fakes.matches.findForRemoteItem.mockResolvedValue([
				match({ id: 'match-1', confidence: 0.7 }),
				match({ id: 'match-2', confidence: 0.9 }),
			]);

			const listed = await manager.matches('item-a');

			// The same row on both sides is one entry, and the strongest comes first.
			expect(listed.map((entry) => entry.id)).toEqual(['match-2', 'match-1']);
		});

		it('records a confirmation as a human decision, not as a better score', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(match());

			const confirmed = await manager.confirmMatch('item-a', 'match-1', 'item-a');

			expect(confirmed.strategy).toBe(MatchStrategy.MANUAL);
			expect(confirmed.confidence).toBe(1);
			expect(confirmed.confirmedAt).not.toBeNull();
		});

		it('refuses a match that has nothing to do with the item in the path', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(
				match({ localItemId: 'somebody-else', remoteItemId: 'somebody-else-too' }),
			);

			await expect(manager.confirmMatch('item-a', 'match-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});
	});

	describe('browsing', () => {
		it('caps a page rather than trusting what was asked for', async () => {
			const { manager, fakes } = build();

			await manager.search({ page: 0, limit: 10_000 });

			expect(fakes.items.search).toHaveBeenCalledWith(
				expect.objectContaining({ page: 1, limit: 200 }),
			);
		});

		it('takes the parent from the route and never from the query string', async () => {
			const { manager, fakes } = build({ items: [item()] });

			await manager.children('item-a', { parentId: 'somewhere-else' });

			expect(fakes.items.search).toHaveBeenCalledWith(
				expect.objectContaining({ parentId: 'item-a' }),
			);
		});

		it('refuses artwork for an item that has none', async () => {
			const { manager } = build({ items: [item({ artworkUrl: null })] });

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});
	});
});
