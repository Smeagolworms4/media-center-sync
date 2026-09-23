import {
	MatchStrategy,
	MediaKind,
	MediaServiceType,
	SyncState,
	type MediaFileInfo,
	type MediaGroupQuery,
} from '@mcs/shared';
import type { MediaItem, MediaService, Peer } from '@/entities';
import type {
	MediaItemDigest,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerRepository,
	GroupSeedQuery,
	MatchPair,
} from '@/repositories';
import { QualityService, type SettingsService } from '@/services';
import type { LibraryManager } from './library.manager';
import { MediaGroupManager } from './media-group.manager';

/** One correlation as the table holds it, before anything decides whether it applies. */
interface Correlation {
	localItemId: string | null;
	remoteItemId: string;
	strategy: MatchStrategy;
	confidence: number;
	state: SyncState;
	confirmedAt: Date | null;
}

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/library/Big Buck Bunny - S01E01 - 1080p.mp4',
	size: 1_048_576,
	container: 'mp4',
	videoCodec: 'hevc',
	audioCodec: 'aac',
	width: 1920,
	height: 1080,
	durationMs: 4000,
	bitrate: 2_000_000,
	quickHash: null,
	contentId: null,
	checksum: null,
	...overrides,
});

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item',
		serviceId: 'local',
		libraryId: 'library-local',
		externalId: 'x',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'The Flight',
		normalizedTitle: 'big buck bunny the flight',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 1,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: file(),
		quality: null,
		syncState: SyncState.IN_SYNC,
		ignored: false,
		addedAt: null,
		childCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaItem;

const service = (overrides: Partial<MediaService> = {}): MediaService =>
	({
		id: 'local',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		filesMounted: true,
		baseUrl: 'http://127.0.0.1:8096',
		priority: 100,
		peerId: null,
		...overrides,
	}) as MediaService;

const correlation = (overrides: Partial<Correlation> = {}): Correlation => ({
	localItemId: 'a',
	remoteItemId: 'b',
	strategy: MatchStrategy.EXTERNAL_ID,
	confidence: 0.95,
	state: SyncState.IN_SYNC,
	confirmedAt: null,
	...overrides,
});

interface World {
	items: MediaItem[];
	matches: Correlation[];
	services: MediaService[];
	peers: Peer[];
	threshold: number;
}

const digest = (row: MediaItem): MediaItemDigest => ({
	id: row.id,
	serviceId: row.serviceId,
	libraryId: row.libraryId,
	parentId: row.parentId,
	kind: row.kind,
	syncState: row.syncState,
	ignored: row.ignored ?? false,
});

/**
 * The repositories, answering out of an in-memory world.
 *
 * `findAppliedPairs` repeats here the condition the repository expresses in SQL —
 * not null, not a conflict nothing naming the work vouched for, above the threshold or
 * confirmed. That duplication is deliberate and bounded: this file is about what the
 * manager does with the edges it is given, and the functional tests run the real
 * statement against a real database, which is the only place the SQL itself can be
 * proven.
 */
const build = (
	world: Partial<World> = {},
): {
	manager: MediaGroupManager;
	world: World;
	reads: { items: Record<string, jest.Mock>; matches: Record<string, jest.Mock> };
} => {
	const full: World = {
		items: [],
		matches: [],
		services: [service(), service({ id: 'remote', name: 'Cabin', filesMounted: false, priority: 200 })],
		peers: [],
		threshold: 0.8,
		...world,
	};

	const byId = (id: string): MediaItem | undefined => full.items.find((row) => row.id === id);

	const items = {
		findGroupSeeds: jest.fn((query: GroupSeedQuery) =>
			Promise.resolve(
				full.items
					.filter(
						(row) =>
							(query.serviceIds === undefined || query.serviceIds.includes(row.serviceId)) &&
							(query.libraryIds === undefined ||
								query.libraryIds.includes(row.libraryId)) &&
							(query.kind === undefined || row.kind === query.kind) &&
							(query.parentIds === undefined ||
								(row.parentId !== null && query.parentIds.includes(row.parentId))) &&
							(query.search === undefined ||
								row.normalizedTitle.includes(query.search.toLowerCase())),
					)
					.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
					.map(digest),
			),
		),
		findDigests: jest.fn((ids: string[]) =>
			Promise.resolve(full.items.filter((row) => ids.includes(row.id)).map(digest)),
		),
		findChildDigests: jest.fn((parentIds: string[]) =>
			Promise.resolve(
				full.items
					.filter((row) => row.parentId !== null && parentIds.includes(row.parentId))
					.map(digest),
			),
		),
		findByIds: jest.fn((ids: string[]) =>
			Promise.resolve(full.items.filter((row) => ids.includes(row.id))),
		),
		findOne: jest.fn(({ where }: { where: { id: string } }) =>
			Promise.resolve(byId(where.id) ?? null),
		),
	};

	const matches = {
		findAppliedPairs: jest.fn((threshold: number) =>
			Promise.resolve(
				full.matches
					.filter(
						(match) =>
							match.localItemId !== null &&
							(match.state !== SyncState.CONFLICT ||
								[
									MatchStrategy.EXTERNAL_ID,
									MatchStrategy.SEASON_EPISODE,
									MatchStrategy.MANUAL,
								].includes(match.strategy)) &&
							(match.confidence >= threshold || match.confirmedAt !== null),
					)
					.map(
						(match): MatchPair => ({
							localItemId: match.localItemId as string,
							remoteItemId: match.remoteItemId,
							state: match.state,
						}),
					),
			),
		),
	};

	return {
		manager: new MediaGroupManager(
			items as unknown as MediaItemRepository,
			matches as unknown as MediaMatchRepository,
			{ find: jest.fn(() => Promise.resolve(full.services)) } as unknown as MediaServiceRepository,
			{ find: jest.fn(() => Promise.resolve(full.peers)) } as unknown as PeerRepository,
			new QualityService(),
			{ getValue: jest.fn(() => Promise.resolve(full.threshold)) } as unknown as SettingsService,
			// Categories are the library manager's business; these tests filter by
			// library identifier, which never reaches it.
			{
				librariesOfCategory: jest.fn(() => Promise.resolve([])),
			} as unknown as LibraryManager,
		),
		world: full,
		reads: { items, matches },
	};
};

const query = (overrides: MediaGroupQuery = {}): MediaGroupQuery => ({ limit: 50, ...overrides });

describe('MediaGroupManager', () => {
	describe('the grouping rule', () => {
		it('joins two items an applied match put together', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local' }),
					item({ id: 'b', serviceId: 'remote', libraryId: 'library-remote' }),
				],
				matches: [correlation({ confidence: 0.95 })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sources.map((source) => source.itemId).sort()).toEqual(['a', 'b']);
			expect(page.pagination.total).toBe(1);
		});

		it('leaves a proposal below the threshold as two groups', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', syncState: SyncState.LOCAL_ONLY }),
					item({ id: 'b', serviceId: 'remote', syncState: SyncState.MISSING }),
				],
				// Scored, written, and not applied: the honest rendering of "we are not
				// sure these are the same thing" is two posters, not one.
				matches: [correlation({ confidence: 0.6 })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(2);
			expect(page.items.every((group) => group.sources.length === 1)).toBe(true);
		});

		it('joins the same pair once a human has confirmed it', async () => {
			const { manager } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation({ confidence: 0.6, confirmedAt: new Date() })],
			});

			expect((await manager.groups(query())).items).toHaveLength(1);
		});

		it('leaves the same bytes under two labels as two groups, which is what that conflict is for', async () => {
			// Nobody has decided which episode the file is; joining the two would
			// renumber one library after the other on a guess.
			const { manager } = build({
				items: [
					item({ id: 'a', syncState: SyncState.CONFLICT }),
					item({ id: 'b', serviceId: 'remote', syncState: SyncState.CONFLICT }),
				],
				matches: [
					correlation({
						confidence: 1,
						state: SyncState.CONFLICT,
						strategy: MatchStrategy.CHECKSUM,
					}),
				],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(2);
			expect(page.items[0].sync).toBe(SyncState.CONFLICT);
		});

		it('joins two cuts of one film into one group that reads conflict', async () => {
			// The identifier decided the work, the running time the version: one card that
			// says "two versions", where there used to be two cards that looked unrelated.
			const { manager } = build({
				items: [
					item({
						id: 'a',
						kind: MediaKind.MOVIE,
						syncState: SyncState.CONFLICT,
						file: file({ durationMs: 11_640_000, contentId: 'q1-theatrical' }),
					}),
					item({
						id: 'b',
						serviceId: 'remote',
						kind: MediaKind.MOVIE,
						syncState: SyncState.CONFLICT,
						file: file({ durationMs: 12_540_000, contentId: 'q1-extended' }),
					}),
				],
				matches: [correlation({ confidence: 0.98, state: SyncState.CONFLICT })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sync).toBe(SyncState.CONFLICT);
			expect(page.items[0].versions).toEqual([
				expect.objectContaining({ versionId: 'q1-theatrical', heldLocally: true }),
				expect.objectContaining({ versionId: 'q1-extended', heldLocally: false }),
			]);
		});

		it('folds three services into one group with three sources', async () => {
			const { manager } = build({
				services: [
					service(),
					service({ id: 'remote', filesMounted: false, priority: 200 }),
					service({ id: 'friend', filesMounted: false, priority: 300, peerId: 'peer-1' }),
				],
				peers: [{ id: 'peer-1', name: 'Théo' } as Peer],
				items: [
					item({ id: 'a' }),
					item({ id: 'b', serviceId: 'remote' }),
					item({ id: 'c', serviceId: 'friend' }),
				],
				// The transitive case: a joined b, b joined c, and nobody ever compared a
				// with c. A group is a connected component, not a pair.
				matches: [
					correlation({ localItemId: 'a', remoteItemId: 'b' }),
					correlation({ localItemId: 'b', remoteItemId: 'c' }),
				],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sources).toHaveLength(3);
			expect(page.items[0].sources.find((source) => source.serviceId === 'friend')).toMatchObject({
				peerId: 'peer-1',
				peerName: 'Théo',
				local: false,
			});
		});

		it('gives an item nobody matched a group of its own', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].id).toBe('a');
		});
	});

	describe('the representative', () => {
		const world = (order: string[]): World['items'] => {
			const rows: Record<string, MediaItem> = {
				z: item({ id: 'z', serviceId: 'remote', title: 'Le vol' }),
				a: item({ id: 'a', serviceId: 'local', title: 'The Flight' }),
				m: item({ id: 'm', serviceId: 'remote', title: 'The Flight (2008)' }),
			};

			return order.map((id) => rows[id]);
		};

		const matches = [
			correlation({ localItemId: 'a', remoteItemId: 'z' }),
			correlation({ localItemId: 'a', remoteItemId: 'm' }),
		];

		it('prefers a local copy and answers the same identifier twice running', async () => {
			const first = build({ items: world(['z', 'a', 'm']), matches });
			const second = build({ items: world(['m', 'z', 'a']), matches });

			const one = await first.manager.groups(query());
			const again = await first.manager.groups(query());
			const other = await second.manager.groups(query());

			expect(one.items[0].id).toBe('a');
			expect(again.items[0].id).toBe('a');
			// Same world, rows handed back in a different order: an interface that
			// reloads must not find the poster under a new identifier.
			expect(other.items[0].id).toBe('a');
			expect(one.items[0].title).toBe('The Flight');
		});

		it('falls back on the identifier when nothing local separates the copies', async () => {
			const { manager } = build({
				items: [
					item({ id: 'y', serviceId: 'remote' }),
					item({ id: 'x', serviceId: 'remote' }),
				],
				matches: [correlation({ localItemId: 'y', remoteItemId: 'x' })],
			});

			expect((await manager.groups(query())).items[0].id).toBe('x');
		});

		it('fills its gaps from the other copies rather than showing nothing', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', overview: null, year: null, externalIds: { provider: 'jf-1' } }),
					item({
						id: 'b',
						serviceId: 'remote',
						overview: 'A rabbit takes his revenge.',
						year: 2008,
						externalIds: { tvdb: '99', provider: 'plex-1' },
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.overview).toBe('A rabbit takes his revenge.');
			expect(group.year).toBe(2008);
			// The remote identifier is kept, the representative's own wins where both
			// have one.
			expect(group.externalIds).toEqual({ tvdb: '99', provider: 'jf-1' });
		});
	});

	describe('hideOwned', () => {
		/*
		 * The filter is "nothing left to fetch here", not "the row exists".
		 *
		 * A series present locally but three episodes short is precisely what somebody
		 * opens this screen to find; hiding it because the series row is held would
		 * drop the only case the filter was asked for.
		 */
		it('keeps a series we hold that is still missing an episode', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items.map((group) => group.id)).toContain('show');
		});

		it('drops a series we hold with no gap under it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
				],
				matches: [
					correlation({ localItemId: 'show', remoteItemId: 'show-remote' }),
					correlation({ localItemId: 'ep-here', remoteItemId: 'ep-there' }),
				],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			// Named rather than counted: the fake repository here does not implement
			// `rootsOnly`, so the episodes come back as groups of their own and a
			// length would be asserting the harness, not the filter.
			expect(answer.items.map((group) => group.id)).not.toContain('show');
		});

		it('keeps a film whose only copy here is a different cut', async () => {
			// Holding the theatrical cut is not holding the extended one, and hiding the
			// group would make the other cut unfindable the moment the two were joined.
			const { manager } = build({
				items: [
					item({ id: 'a', kind: MediaKind.MOVIE, syncState: SyncState.CONFLICT }),
					item({ id: 'b', serviceId: 'remote', kind: MediaKind.MOVIE, syncState: SyncState.CONFLICT }),
				],
				matches: [correlation({ state: SyncState.CONFLICT })],
			});

			const answer = await manager.groups(query({ hideOwned: true }));

			expect(answer.items.map((group) => group.id)).toEqual(['a']);
		});

		it('counts an episode held here only in another cut as a gap', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show', syncState: SyncState.CONFLICT }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
				],
				matches: [
					correlation({ localItemId: 'show', remoteItemId: 'show-remote' }),
					correlation({
						localItemId: 'ep-here',
						remoteItemId: 'ep-there',
						state: SyncState.CONFLICT,
					}),
				],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items.find((group) => group.id === 'show')?.missingCount).toBe(1);
		});

		it('keeps what only somebody else holds', async () => {
			const { manager } = build({
				items: [item({ id: 'theirs', serviceId: 'remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true }));

			expect(answer.items.map((group) => group.id)).toEqual(['theirs']);
		});

		it('answers the whole shelf when the filter is not asked for', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
				],
			});

			const answer = await manager.groups(query({ rootsOnly: true }));

			expect(answer.items.map((group) => group.id)).toContain('show');
		});

		it('does not count an ignored episode as a gap', async () => {
			// The special that would otherwise keep a finished season looking unfinished.
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({
						id: 'special',
						serviceId: 'remote',
						parentId: 'show-remote',
						seasonNumber: 0,
						ignored: true,
					}),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			// The show is held and its only outstanding child is one nobody counts, so
			// there is nothing left to fetch and it goes.
			expect(answer.items.map((group) => group.id)).not.toContain('show');
		});
	});

	describe('artwork', () => {
		it('points at a local copy, because a friend’s server may be asleep', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', artworkUrl: '/local/poster.jpg' }),
					item({ id: 'b', serviceId: 'remote', artworkUrl: '/remote/poster.jpg' }),
				],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].artworkItemId).toBe('a');
		});

		it('takes a remote poster rather than none when the local copy has no artwork', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', artworkUrl: null }),
					item({ id: 'b', serviceId: 'remote', artworkUrl: '/remote/poster.jpg' }),
				],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].artworkItemId).toBe('b');
		});

		it('answers null when nobody reported one', async () => {
			const { manager } = build({ items: [item({ id: 'a', artworkUrl: '' })] });

			expect((await manager.groups(query())).items[0].artworkItemId).toBeNull();
		});
	});

	describe('quality', () => {
		it('spans every source rather than whichever server won the representative', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ height: 1080, videoCodec: 'hevc', size: 100 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ height: 2160, videoCodec: 'hevc', size: 400 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.quality?.mixed).toBe(true);
			expect(group.quality?.fileCount).toBe(2);
			expect(group.quality?.totalBytes).toBe(500);
			expect(group.quality?.variants.map((variant) => variant.resolution).sort()).toEqual([
				'1080p',
				'2160p',
			]);
		});

		it('folds the aggregates a season carries, which have no file to re-read', async () => {
			const quality = new QualityService();
			const { manager } = build({
				items: [
					item({
						id: 'a',
						kind: MediaKind.SEASON,
						file: null,
						quality: quality.summarise([file({ height: 1080 })]),
					}),
					item({
						id: 'b',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						// The width with the height, because a resolution is read off both:
						// leaving the default 1920 would describe a 1080p scope master
						// rather than the 720p encode this case is about.
						quality: quality.summarise([
							file({ height: 720, width: 1280 }),
							file({ height: 720, width: 1280 }),
						]),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.quality?.fileCount).toBe(3);
			expect(group.quality?.dominant?.resolution).toBe('720p');
		});

		it('says nothing at all when nothing has been scanned', async () => {
			const { manager } = build({ items: [item({ id: 'a', file: null, quality: null })] });

			expect((await manager.groups(query())).items[0].quality).toBeNull();
		});
	});

	/**
	 * What the poster expands into when somebody asks which copies are worth holding.
	 *
	 * The fold is on the fingerprint and on nothing else, which is the only rule that
	 * survives contact with a real library: the same file on three servers is one thing
	 * to pull, and two files under one title are two, whatever their titles, their
	 * editions or their scrapers agree on.
	 */
	describe('versions', () => {
		it('folds the copies of one file into a single version', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same' }) }),
					item({ id: 'b', serviceId: 'remote', file: file({ contentId: 'q1-same' }) }),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toHaveLength(1);
			expect(group.versions[0].sourceItemIds.sort()).toEqual(['a', 'b']);
			expect(group.versions[0].heldLocally).toBe(true);
		});

		it('folds a copy with no identity onto the version its bytes say it is', async () => {
			/*
			 * The owner's Jellyfin and Plex over one NAS: the same file, only one of them
			 * mounted, so only one can be fingerprinted. Left apart, the page offers to
			 * fetch twenty gigabytes already on the disk it would write them to.
			 */
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 20_292_365_537 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 20_292_365_537 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toHaveLength(1);
			expect(group.versions[0].sourceItemIds.sort()).toEqual(['a', 'b']);
		});

		it('leaves a copy of a different size where it is, however close', async () => {
			// A near miss is a different cut, and calling two cuts one copy is how
			// somebody ends up without the version they wanted.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 20_292_365_537 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 20_292_365_536 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].sourceItemIds).toEqual(['a']);
		});

		it('leaves a copy of the same size but a different encoding alone', async () => {
			// Byte equality is conclusive on a film and a coincidence on a clip. The
			// encoding is what makes an accident implausible without inventing a
			// threshold nobody could justify.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 4096, height: 1080 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 4096, height: 2160 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].sourceItemIds).toEqual(['a']);
		});

		it('keeps two encodes of one cut as two things to choose between', async () => {
			// They correlate — same cut, same running time — and they are still two
			// files. Holding one of them is an ordinary state and not a failed sync.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-1080', height: 1080 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: 'q1-2160', height: 2160 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions.map((version) => version.versionId)).toEqual(['q1-1080', 'q1-2160']);
			expect(group.versions.map((version) => version.heldLocally)).toEqual([true, false]);
			expect(group.versions[1].quality?.dominant?.resolution).toBe('2160p');
		});

		it('says a version is not held when only somebody else has it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'remote', file: file({ contentId: 'q1-theirs' }) }),
				],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toEqual([
				expect.objectContaining({ versionId: 'q1-theirs', heldLocally: false }),
			]);
		});

		it('carries the edition, wherever among the copies it was found', async () => {
			// Only Plex reports one and only some filenames carry the tag, so a label
			// found on any copy of the same bytes describes them all.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same' }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: 'q1-same', edition: 'Extended Cut' }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].edition).toBe('Extended Cut');
			expect(group.sources.find((source) => source.itemId === 'b')?.edition).toBe('Extended Cut');
		});

		it('reads the edition tag off a filename when nobody reported one', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'a',
						file: file({
							contentId: 'q1-x',
							path: '/library/Titanic (1997) {edition-Theatrical}.mkv',
						}),
					}),
				],
			});

			expect((await manager.groups(query())).items[0].versions[0].edition).toBe('Theatrical');
		});

		it('lists no version for a copy nobody has fingerprinted', async () => {
			// Honest rather than convenient: giving an unfingerprinted row an identity of
			// its own would show the one file two servers hold as two versions, and
			// offering both would download it twice into one path.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: null }) }),
					item({ id: 'b', serviceId: 'remote', file: file({ contentId: null }) }),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toEqual([]);
			expect(group.sources.map((source) => source.versionId)).toEqual([null, null]);
		});
	});

	describe('children', () => {
		const season = (): World =>
			({
				items: [
					item({ id: 'season-local', kind: MediaKind.SEASON, file: null, title: 'Season 1' }),
					item({
						id: 'season-remote',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						title: 'Season 1',
					}),
					// Held on both, under one group: one child, not two.
					item({ id: 'e1-local', parentId: 'season-local', title: 'E1' }),
					item({ id: 'e1-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E1' }),
					// Only on the friend's server: this is what `missingCount` counts.
					item({ id: 'e2-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E2' }),
					item({ id: 'e3-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E3' }),
					// Only ours.
					item({ id: 'e4-local', parentId: 'season-local', title: 'E4' }),
				],
				matches: [
					correlation({ localItemId: 'season-local', remoteItemId: 'season-remote' }),
					correlation({ localItemId: 'e1-local', remoteItemId: 'e1-remote' }),
				],
			}) as World;

		it('counts child groups, and how many of them we do not hold', async () => {
			const { manager } = build(season());

			const group = (await manager.groups(query({ kind: MediaKind.SEASON }))).items[0];

			expect(group.childCount).toBe(4);
			// E2 and E3, known on the friend's server and absent here. E1 is held under
			// two rows and counts once; E4 is ours and is not missing from anywhere we
			// are being asked about.
			expect(group.missingCount).toBe(2);
		});

		it('counts a child we hold under a parent that never matched as held', async () => {
			// The lab case: the two servers never agreed on the series title, so the
			// seasons are two groups while the episode inside is correctly one. Counting
			// only the rows filed under this parent would report that episode missing on
			// the season card while its own poster says we hold it.
			const { manager } = build({
				items: [
					item({ id: 'season-theirs', serviceId: 'remote', kind: MediaKind.SEASON, file: null }),
					item({ id: 'season-ours', kind: MediaKind.SEASON, file: null, title: 'Ours' }),
					item({ id: 'e5-theirs', serviceId: 'remote', parentId: 'season-theirs' }),
					item({ id: 'e5-ours', parentId: 'season-ours' }),
				],
				matches: [correlation({ localItemId: 'e5-ours', remoteItemId: 'e5-theirs' })],
			});

			const page = await manager.groups(query({ kind: MediaKind.SEASON }));
			const theirs = page.items.find((group) => group.id === 'season-theirs');

			expect(theirs?.childCount).toBe(1);
			expect(theirs?.missingCount).toBe(0);
		});

		it('merges the children of every copy, wherever the seasons live', async () => {
			const { manager } = build(season());

			const page = await manager.groupChildren('season-local', query());

			expect(page.pagination.total).toBe(4);
			expect(page.items.map((group) => group.title).sort()).toEqual(['E1', 'E2', 'E3', 'E4']);
			expect(page.items.find((group) => group.title === 'E1')?.sources).toHaveLength(2);
		});

		it('reaches the same children from the far side of the parent group', async () => {
			const { manager } = build(season());

			// Addressed by a copy that is not the representative: a series page opened
			// from a friend's row has to show the same seasons.
			const page = await manager.groupChildren('season-remote', query());

			expect(page.pagination.total).toBe(4);
		});

		it('ignores a parent the caller tried to smuggle into the query string', async () => {
			const { manager } = build(season());

			const page = await manager.groupChildren(
				'season-local',
				query({ parentId: 'season-remote' }),
			);

			expect(page.pagination.total).toBe(4);
		});
	});

	describe('the state a group shows', () => {
		it('is missing when no local service holds it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'remote', syncState: SyncState.IN_SYNC }),
					item({ id: 'b', serviceId: 'friend', syncState: SyncState.IN_SYNC }),
				],
				services: [
					service(),
					service({ id: 'remote', filesMounted: false }),
					service({ id: 'friend', filesMounted: false }),
				],
				matches: [correlation({ localItemId: 'a', remoteItemId: 'b' })],
			});

			// Two friends agreeing with each other is not an answer to "do I have this".
			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.MISSING);
		});

		it('takes the most urgent of the states our own copies are in', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', syncState: SyncState.IN_SYNC }),
					item({ id: 'b', serviceId: 'second', syncState: SyncState.OUTDATED }),
				],
				services: [service(), service({ id: 'second', name: 'Attic' })],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.OUTDATED);
		});

		it('filters on the group’s state, not on the rows behind it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', title: 'Held', syncState: SyncState.IN_SYNC }),
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Held',
						// The remote row of a media we do hold reads `in_sync` too, and a
						// filter on rows would return this group under `missing`.
						syncState: SyncState.IN_SYNC,
					}),
					item({ id: 'c', serviceId: 'remote', title: 'Theirs', syncState: SyncState.MISSING }),
				],
				matches: [correlation()],
			});

			const missing = await manager.groups(query({ states: [SyncState.MISSING] }));

			expect(missing.pagination.total).toBe(1);
			expect(missing.items[0].title).toBe('Theirs');
		});

		it('reads as downloaded rather than missing while the library resyncs', async () => {
			/*
			 * The case the whole state exists for: the file is in the library folder and
			 * no service has scanned yet, so there is no local row and every other test
			 * above would answer `missing` — which is what offered the same episode a
			 * second time.
			 */
			const { manager } = build({
				items: [
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Theirs',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.AWAITING_INDEX);
		});

		it('says it was never indexed once the gateway has stopped waiting', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Theirs',
						syncState: SyncState.NOT_INDEXED,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.NOT_INDEXED);
		});

		it('answers the landed state to a filter that asks for it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', title: 'Held', syncState: SyncState.IN_SYNC }),
					item({
						id: 'c',
						serviceId: 'remote',
						title: 'Landed',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			const landed = await manager.groups(query({ states: [SyncState.AWAITING_INDEX] }));

			expect(landed.items.map((group) => group.title)).toEqual(['Landed']);
		});
	});

	describe('a child already on the disk', () => {
		it('is not counted as a gap under its season', async () => {
			// Counting it would put a number on a season card that nothing anybody does
			// can bring down: fetching it again writes the same bytes to the same path.
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({
						id: 'ep-landed',
						serviceId: 'remote',
						parentId: 'show-remote',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ rootsOnly: true }));

			expect(answer.items[0].missingCount).toBe(0);
		});

		it('is hidden by "hide what I already have", like anything else we hold', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'landed',
						serviceId: 'remote',
						kind: MediaKind.SERIES,
						file: null,
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items).toHaveLength(0);
		});
	});

	describe('filtering and paging', () => {
		const library = (): World =>
			({
				items: [
					item({ id: 'a', title: 'Alpha' }),
					item({ id: 'a-remote', serviceId: 'remote', title: 'Alpha' }),
					item({ id: 'b', title: 'Bravo' }),
					item({ id: 'c-remote', serviceId: 'remote', title: 'Charlie' }),
					item({ id: 'd', title: 'Delta', kind: MediaKind.MOVIE }),
				],
				matches: [correlation({ localItemId: 'a', remoteItemId: 'a-remote' })],
			}) as World;

		it('narrows which groups appear without ungrouping the ones that stay', async () => {
			const { manager } = build(library());

			const page = await manager.groups(query({ serviceIds: ['remote'] }));

			expect(page.items.map((group) => group.title)).toEqual(['Alpha', 'Charlie']);
			// Alpha is shown because the friend holds a copy, and it is still shown with
			// both of them.
			expect(page.items[0].sources).toHaveLength(2);
			expect(page.items[0].id).toBe('a');
		});

		it('pages groups rather than rows', async () => {
			const { manager } = build(library());

			const first = await manager.groups(query({ limit: 2, page: 1 }));
			const second = await manager.groups(query({ limit: 2, page: 2 }));

			// Five rows, four groups: a page of rows would have answered a total of five
			// and shown Alpha twice.
			expect(first.pagination).toMatchObject({ total: 4, pages: 2, limit: 2 });
			expect(first.items.map((group) => group.title)).toEqual(['Alpha', 'Bravo']);
			expect(second.items.map((group) => group.title)).toEqual(['Charlie', 'Delta']);
		});

		it('filters by kind and by search', async () => {
			const { manager } = build(library());

			expect((await manager.groups(query({ kind: MediaKind.MOVIE }))).pagination.total).toBe(1);
			expect((await manager.groups(query({ search: 'bunny' }))).pagination.total).toBe(4);
			expect((await manager.groups(query({ search: 'nothing' }))).pagination.total).toBe(0);
		});
	});

	describe('one group', () => {
		it('is reachable from any copy in it', async () => {
			const { manager } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			await expect(manager.group('b')).resolves.toMatchObject({ id: 'a' });
		});

		it('answers a key for an item nobody holds', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			await expect(manager.group('nope')).rejects.toMatchObject({
				message: 'error.media.not_found',
			});
		});

		it('refuses a parent nobody holds rather than answering an empty page', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			await expect(manager.groups(query({ parentId: 'nope' }))).rejects.toMatchObject({
				message: 'error.media.not_found',
			});
		});
	});

	/**
	 * Whose word the group takes, field by field.
	 *
	 * The order the household actually wants is three deep: **a correction, then what
	 * our own servers report, then what a friend's does.** The middle and the last were
	 * already right. The first was missing, and it mattered: a correction is written
	 * onto the copy it was made on, and a wrong season number is usually noticed on the
	 * shelf where it makes a mess — which is often a friend's. That copy ranks behind
	 * every local one, so the local server's value went on winning and the person who
	 * made the correction saw nothing change.
	 */
	describe('which copy decides a field', () => {
		const pair = (
			localOverrides: Partial<MediaItem>,
			remoteOverrides: Partial<MediaItem>,
		): MediaItem[] => [
			item({ id: 'a', serviceId: 'local', ...localOverrides }),
			item({ id: 'b', serviceId: 'remote', libraryId: 'library-remote', ...remoteOverrides }),
		];

		/** What a corrected copy looks like: the column changed, the snapshot kept. */
		const corrected = (
			changes: Partial<MediaItem>,
			reported: Partial<MediaItem> = {},
		): Partial<MediaItem> => {
			const base = item({ ...reported });

			return {
				...changes,
				reported: {
					libraryId: base.libraryId,
					title: base.title,
					seriesTitle: null,
					year: base.year,
					seasonNumber: base.seasonNumber,
					episodeNumber: base.episodeNumber,
					overview: base.overview,
					externalIds: base.externalIds,
				},
			} as Partial<MediaItem>;
		};

		it('lets a correction made on a friend’s copy win over our server’s answer', async () => {
			const { manager } = build({
				items: pair(
					{ year: 2008, seasonNumber: 1 },
					corrected({ year: 1999, seasonNumber: 4 }),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.seasonNumber).toBe(4);
			// The group is still represented by the copy we can actually ask for artwork
			// and bytes: what moved is the value, not which server answers.
			expect(group.id).toBe('a');
		});

		it('keeps our server’s answer ahead of a friend’s when neither is corrected', async () => {
			const { manager } = build({
				items: pair({ year: 2008 }, { year: 1999 }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(2008);
		});

		it('still fills a gap from a friend’s copy, which is not the same as overruling', async () => {
			const { manager } = build({
				items: pair({ year: null, overview: null }, { year: 1999, overview: 'What it is about.' }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.overview).toBe('What it is about.');
		});

		it('takes only the field that was corrected, never the emptier ones beside it', async () => {
			// Promoting the whole row would drag a friend’s missing overview along with
			// their corrected year and blank out the description our own server has.
			const { manager } = build({
				items: pair(
					{ year: 2008, overview: 'Ours, and complete.' },
					corrected({ year: 1999, overview: null }, { year: 2008 }),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.overview).toBe('Ours, and complete.');
		});

		it('puts our server back in front once the correction is withdrawn', async () => {
			// Withdrawing a correction clears both halves, so there is nothing left to
			// outrank anything: the order falls back to local before remote on its own.
			const { manager } = build({
				items: pair({ year: 2008 }, { year: 1999, overrides: null, reported: null }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(2008);
		});

		it('carries the corrected title and the form the wall de-duplicates on together', async () => {
			// Two rows disagreeing about which media this is would put the same poster on
			// the screen twice.
			const { manager } = build({
				items: pair(
					{ title: 'The Flight', normalizedTitle: 'big buck bunny the flight' },
					corrected(
						{ title: 'Le Vol', normalizedTitle: 'le vol' },
						{ title: 'The Flight' },
					),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.title).toBe('Le Vol');
			expect(group.normalizedTitle).toBe('le vol');
		});

		it('does not let a field erased on one copy blank out a value another one has', async () => {
			// "This value is wrong and there is no right one" is a statement about one
			// server's answer, not a reason to take a year off the media.
			const { manager } = build({
				items: pair({ year: null }, corrected({ year: null }, { year: 1999 })),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBeNull();
		});
	});

	describe('what it reads', () => {
		it('loads the matches once for the page, not once per item', async () => {
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' }), item({ id: 'c' })],
				matches: [correlation()],
			});

			await manager.groups(query());

			expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(1);
			expect(reads.matches.findAppliedPairs).toHaveBeenCalledWith(0.8);
		});

		it('reads the full rows only for the page it returns', async () => {
			const { manager, reads } = build({
				items: [
					item({ id: 'a', title: 'Alpha' }),
					item({ id: 'b', title: 'Bravo' }),
					item({ id: 'c', title: 'Charlie' }),
				],
			});

			await manager.groups(query({ limit: 1 }));

			// Three groups match, one page is asked for: the JSON columns of the other
			// two are never read.
			expect(reads.items.findByIds).toHaveBeenCalledWith(['a']);
		});
	});
});
