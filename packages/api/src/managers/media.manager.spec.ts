import { Readable } from 'node:stream';
import {
	ErrorKey,
	MatchStrategy,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import type { MediaItem, MediaMatch, MediaService as MediaServiceEntity } from '@/entities';
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

const mediaService = (overrides: Partial<MediaServiceEntity> = {}): MediaServiceEntity =>
	({
		id: 'service-a',
		name: 'Living room',
		type: MediaServiceType.PLEX,
		scope: MediaServiceScope.LOCAL,
		baseUrl: 'http://plex:32400',
		token: null,
		username: null,
		password: null,
		peerId: null,
		...overrides,
	}) as MediaServiceEntity;

interface Fakes {
	items: {
		find: jest.Mock;
		findOne: jest.Mock;
		findChildren: jest.Mock;
		findCandidatesForMatch: jest.Mock;
		search: jest.Mock;
		setSyncState: jest.Mock;
		save: jest.Mock;
	};
	matches: {
		findOne: jest.Mock;
		findForLocalItem: jest.Mock;
		findForRemoteItem: jest.Mock;
		upsertPair: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
	};
	services: { find: jest.Mock; findOne: jest.Mock; findWithSecrets: jest.Mock };
	cache: { get: jest.Mock; set: jest.Mock };
	openArtwork: jest.Mock;
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
			save: jest.fn((value: MediaItem) => Promise.resolve(value)),
		},
		matches: {
			findOne: jest.fn().mockResolvedValue(null),
			findForLocalItem: jest.fn().mockResolvedValue([]),
			findForRemoteItem: jest.fn().mockResolvedValue([]),
			upsertPair: jest.fn((claim: unknown) => Promise.resolve(claim as MediaMatch)),
			save: jest.fn((value: MediaMatch) => Promise.resolve(value)),
			delete: jest.fn().mockResolvedValue(undefined),
		},
		services: {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(mediaService()),
			findWithSecrets: jest.fn().mockResolvedValue(mediaService({ token: 'plex-token' })),
		},
		cache: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) },
		openArtwork: jest.fn(async () => ({
			stream: Readable.from([Buffer.from('poster bytes')]),
			contentType: 'image/jpeg',
		})),
	};

	const manager = new MediaManager(
		fakes.items as unknown as MediaItemRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.services as unknown as MediaServiceRepository,
		// The real scoring service: the rule under test is what the manager does with a
		// proposal, and a fake that produced one would prove nothing about the pair the
		// lab fixture is built around.
		new MatchingService(new QualityService()),
		{ getValue: jest.fn().mockResolvedValue(0.8) } as unknown as SettingsService,
		fakes.cache as unknown as CacheService,
		{ get: jest.fn(() => ({ openArtwork: fakes.openArtwork })) } as unknown as HandlerRegistry,
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

		it('tells an item we hold from one we merely know about', async () => {
			// With nothing to match against, an item on a service the gateway can write
			// into is `local_only` and one on a friend's is `missing`. Getting the scope
			// wrong here turns the whole library into a list of things to fetch.
			const mine = item({ id: 'item-mine', serviceId: 'service-a' });
			const theirs = item({
				id: 'item-theirs',
				serviceId: 'service-b',
				file: file({ contentId: 'v1:other:1', checksum: null }),
			});
			const { manager, fakes } = build({ items: [mine, theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-a', scope: MediaServiceScope.LOCAL }),
				mediaService({ id: 'service-b', scope: MediaServiceScope.REMOTE, peerId: 'peer-1' }),
			]);

			await manager.correlateService('service-a');
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-mine'],
				SyncState.LOCAL_ONLY,
			);

			fakes.items.setSyncState.mockClear();
			await manager.correlateService('service-b');
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-theirs'],
				SyncState.MISSING,
			);
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

		it('refuses to browse under an item nobody has', async () => {
			const { manager } = build();

			await expect(manager.children('ghost', {})).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
			await expect(manager.node('ghost')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});
	});

	describe('undoing a correlation', () => {
		it('deletes the match the item in the path takes part in', async () => {
			// A correlation nobody can undo is one nobody will trust.
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(match());

			await manager.deleteMatch('item-a', 'match-1');

			expect(fakes.matches.delete).toHaveBeenCalledWith({ id: 'match-1' });
		});

		it('refuses a match that has nothing to do with the item in the path', async () => {
			// Without that check any identifier would do for the first half of the path,
			// and a deletion would land on a correlation nobody was looking at.
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(
				match({ localItemId: 'somebody-else', remoteItemId: 'somebody-else-too' }),
			);

			await expect(manager.deleteMatch('item-a', 'match-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
			expect(fakes.matches.delete).not.toHaveBeenCalled();
		});

		it('answers a key for a match that is not there at all', async () => {
			const { manager } = build({ items: [item()] });

			await expect(manager.deleteMatch('item-a', 'ghost')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});
	});

	describe('correcting what a service got wrong', () => {
		it('writes the correction into the columns everything else reads', async () => {
			// A season reassigned by hand that only changed a label would be worse than
			// nothing: it has to reach correlation and filing too.
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', { seasonNumber: 2, episodeNumber: 14 });

			const saved = fakes.items.save.mock.calls[0][0] as MediaItem;

			expect(saved).toMatchObject({ seasonNumber: 2, episodeNumber: 14 });
			// And what the service said is kept, or the change could be neither shown
			// nor undone.
			expect(saved.reported).toMatchObject({ seasonNumber: 1, episodeNumber: 5 });
		});

		it('re-correlates at once rather than waiting for the next scan', async () => {
			// Renumbering an episode changes what it matches. Leaving that until the next
			// scan means the screen that made the correction still shows the old state.
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', { seasonNumber: 2 });

			expect(fakes.items.findCandidatesForMatch).toHaveBeenCalled();
			expect(fakes.services.find).toHaveBeenCalled();
		});

		it('puts the service’s answer back when the correction is withdrawn', async () => {
			const corrected = item({
				seasonNumber: 2,
				overrides: { seasonNumber: 2 },
				reported: {
					libraryId: 'library-a',
					title: 'The Flight',
					seriesTitle: null,
					year: 2008,
					seasonNumber: 1,
					episodeNumber: 5,
					overview: null,
					externalIds: {},
				},
			} as Partial<MediaItem>);
			const { manager, fakes } = build({ items: [corrected] });

			await manager.setOverride('item-a', null);

			const saved = fakes.items.save.mock.calls[0][0] as MediaItem;

			expect(saved.seasonNumber).toBe(1);
			expect(saved.overrides).toBeNull();
			expect(saved.reported).toBeNull();
		});
	});

	describe('artwork', () => {
		it('asks the service once and answers from the cache afterwards', async () => {
			// A grid of sixty posters is sixty requests from the browser, and without the
			// cache every one of them would reach somebody's Raspberry Pi.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			const first = await manager.artwork('item-a');

			expect(first.contentType).toBe('image/jpeg');
			expect(first.body.toString()).toBe('poster bytes');

			const [key, stored] = fakes.cache.set.mock.calls[0] as [
				string,
				{ body: string; contentType: string },
			];

			fakes.cache.get.mockResolvedValue(stored);
			fakes.openArtwork.mockClear();

			const second = await manager.artwork('item-a');

			expect(key).toContain('item-a');
			expect(second.body.toString()).toBe('poster bytes');
			expect(fakes.openArtwork).not.toHaveBeenCalled();
		});

		it('asks with the token rather than anonymously', async () => {
			// Jellyfin serves images to anyone; Plex answers 401 without its token, and
			// every poster would be a broken image with nothing saying it was a
			// credential rather than a missing file.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			await manager.artwork('item-a');

			expect(fakes.openArtwork.mock.calls[0][0]).toMatchObject({ token: 'plex-token' });
		});

		it('falls back to the row without secrets rather than failing', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.services.findWithSecrets.mockResolvedValue(null);

			await expect(manager.artwork('item-a')).resolves.toMatchObject({
				contentType: 'image/jpeg',
			});
		});

		it('names a media type when the service gave none', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.openArtwork.mockResolvedValue({
				stream: Readable.from([Buffer.from('bytes')]),
				contentType: null,
			});

			await expect(manager.artwork('item-a')).resolves.toMatchObject({
				contentType: 'application/octet-stream',
			});
		});

		it('answers a key when the service the item belongs to has gone', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.services.findOne.mockResolvedValue(null);

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
		});

		it('drops a response too large to be a poster', async () => {
			// Past the ceiling it is either a video somebody put in the poster field or a
			// service answering with the wrong thing entirely, and buffering it would be
			// the gateway spending its memory on somebody else's mistake.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });
			const megabyte = Buffer.alloc(1024 * 1024);

			fakes.openArtwork.mockResolvedValue({
				stream: Readable.from(Array.from({ length: 9 }, () => megabyte)),
				contentType: 'image/jpeg',
			});

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
			expect(fakes.cache.set).not.toHaveBeenCalled();
		});
	});

	describe('what counts as the same content', () => {
		it('recognises two files by a checksum when neither has a content identity', () => {
			const { manager } = build();
			const same = file({ contentId: null, checksum: 'sha256:abc' });

			expect(
				manager.labelDisagreement(
					item({ file: same }),
					item({ id: 'item-b', episodeNumber: 3, file: same }),
				),
			).toBe('content identical, episode numbers differ: S01E05 here, S01E03 there');
		});

		it('writes a question mark where a library told us nothing', () => {
			// A film carries no season or episode number, and a disagreement about one
			// still has to be readable rather than saying `SnullEnull`.
			const { manager } = build();
			const same = file();

			expect(
				manager.labelDisagreement(
					item({ kind: MediaKind.MOVIE, seasonNumber: null, episodeNumber: null, file: same }),
					item({
						id: 'item-b',
						kind: MediaKind.MOVIE,
						seasonNumber: 1,
						episodeNumber: null,
						file: same,
					}),
				),
			).toBe('content identical, season numbers differ: S??E?? here, S01E?? there');
		});

		it('says nothing about a node that holds no file at all', () => {
			// A series and a season have no bytes of their own, and comparing them by
			// content would make every parent identical to every other.
			const { manager } = build();

			expect(
				manager.labelDisagreement(
					item({ kind: MediaKind.SERIES, file: null }),
					item({ id: 'item-b', kind: MediaKind.SERIES, episodeNumber: 3, file: null }),
				),
			).toBeNull();
		});
	});
});
