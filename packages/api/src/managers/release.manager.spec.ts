import {
	DownloadClientType,
	ErrorKey,
	EventName,
	GrabState,
	IndexerType,
	isIndexerSuggestion,
	isPeerSuggestion,
	MediaKind,
	MediaOrigin,
	MediaServiceType,
	DEFAULT_RELEASE_PREFERENCES,
	NamingScheme,
	PeerTrust,
	PlacementStrategy,
	PEER_SUGGESTION_PREFIX,
	ReleaseKind,
	ReleaseSearchKind,
	SuggestionSource,
	SyncState,
	type MediaGroupSource,
	type PeerCopy,
	type Release,
	type ReleaseGroup,
	type ReleaseSearchResult,
	type Settings,
} from '@mcs/shared';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, ReleaseGrab as GrabEntity } from '@/entities';
import type { MediaItemRepository, PeerRepository, ReleaseGrabRepository } from '@/repositories';
import { PeerSuggestionService, QualityService } from '@/services';
import type {
	CacheService,
	DownloadClientRegistry,
	EventGatewayService,
	FileMoveService,
	FilesystemService,
	IndexerRegistry,
	NamingService,
	PlacementService,
	SettingsService,
} from '@/services';
import type { LibraryManager } from './library.manager';
import type { MediaGroupManager } from './media-group.manager';
import { ReleaseManager } from './release.manager';

interface Fakes {
	grabs: {
		create: jest.Mock;
		save: jest.Mock;
		findOne: jest.Mock;
		findLive: jest.Mock;
		findRecent: jest.Mock;
		findForItem: jest.Mock;
	};
	items: { findOne: jest.Mock; find: jest.Mock };
	/** What the registry hands back, so a test can make the tracker fail on its own. */
	indexer: { search: jest.Mock };
	indexers: { get: jest.Mock };
	client: {
		grab: jest.Mock;
		statuses: jest.Mock;
		files: jest.Mock;
		selectFiles: jest.Mock;
		start: jest.Mock;
	};
	clients: { get: jest.Mock };
	settings: { get: jest.Mock };
	cache: { get: jest.Mock; set: jest.Mock };
	naming: { render: jest.Mock };
	placement: { resolve: jest.Mock; prepare: jest.Mock };
	libraries: { placementLibraries: jest.Mock; categoryKeysByLibrary: jest.Mock };
	groups: { group: jest.Mock; groupChildren: jest.Mock };
	filesystem: { rights: jest.Mock; largestFileUnder: jest.Mock };
	mover: { move: jest.Mock };
	events: { emit: jest.Mock };
	/** Read for one column: whether a peer was invited by us or introduced by a friend. */
	peers: { find: jest.Mock };
}

/**
 * The tracker half of a result.
 *
 * The search answers one list of two kinds of row, so almost every assertion below has to
 * say which kind it is about. Reading it through the type guard rather than by index is
 * what keeps a test that means "the first release" from silently starting to mean "the
 * first peer copy" the day an offer sorts above it.
 */
const trackerGroups = (found: ReleaseSearchResult): ReleaseGroup[] =>
	found.suggestions.filter(isIndexerSuggestion).map((one) => one.release);

/** The peer half of the same list. */
const peerCopies = (found: ReleaseSearchResult): PeerCopy[] =>
	found.suggestions.filter(isPeerSuggestion).map((one) => one.copy);

/**
 * A gateway with both halves configured, which is the only state either half works in.
 *
 * The mapping is the one that matters: the client writes to `/downloads` and this
 * gateway reaches the same directory at `/share/torrents`, which is what every path in
 * these tests is translated through.
 */
const SETTINGS = {
	indexer: {
		type: IndexerType.PROWLARR,
		baseUrl: 'http://prowlarr:9696',
		apiKey: 'key',
		enabled: true,
	},
	downloadClient: {
		type: DownloadClientType.QBITTORRENT,
		baseUrl: 'http://qbittorrent:8080',
		rootMappings: [{ remoteRoot: '/downloads', localRoot: '/share/torrents' }],
		enabled: true,
	},
	placement: PlacementStrategy.DEFAULT_LIBRARY,
	fixedPath: null,
	namingOrder: [NamingScheme.SOURCE],
	// Nothing ranked, so the order a search answers in is the one it arrived in —
	// which is what every test here but the preference ones is asserting about.
	releasePreferences: DEFAULT_RELEASE_PREFERENCES,
	diskReserveBytes: 0,
} as unknown as Settings;

const settingsWith = (overrides: Record<string, unknown>): Settings =>
	({ ...SETTINGS, ...overrides }) as unknown as Settings;

const item = (overrides: Record<string, unknown> = {}): MediaItemEntity =>
	({
		id: 'series-1',
		kind: MediaKind.SERIES,
		title: 'Spartacus',
		parentId: null,
		libraryId: 'lib-shows',
		year: 2010,
		seasonNumber: null,
		episodeNumber: null,
		file: null,
		...overrides,
	}) as unknown as MediaItemEntity;

/**
 * The catalogue these tests run against: a series, its season, one episode we hold, and
 * a film. The episode carries a file of exactly a thousand bytes, which is what makes
 * the size guess in `search` say something.
 */
const WORLD: MediaItemEntity[] = [
	item(),
	item({ id: 'season-1', kind: MediaKind.SEASON, title: 'Season 1', parentId: 'series-1', seasonNumber: 1 }),
	item({
		id: 'ep-2',
		kind: MediaKind.EPISODE,
		title: 'The Thing in the Pit',
		parentId: 'season-1',
		seasonNumber: 1,
		episodeNumber: 2,
		file: { path: '/media/shows/S01E02.mkv', size: 1_000 },
	}),
	item({ id: 'movie-1', kind: MediaKind.MOVIE, title: 'Blade Runner 2049', year: 2017 }),
];

/**
 * One copy of something, as the group view answers it.
 *
 * Remote by default, because that is the only kind a suggestion can be made of: a copy on
 * a disk this gateway writes into is what we hold, not something to offer to fetch.
 */
const source = (overrides: Partial<MediaGroupSource> = {}): MediaGroupSource =>
	({
		itemId: 'their-ep',
		serviceId: 'svc-alice',
		serviceName: 'Alice Jellyfin',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: 'peer-alice',
		peerName: 'Alice',
		quality: null,
		companions: null,
		bytes: 2_000,
		versionId: null,
		edition: null,
		local: false,
		path: '/media/Shows/S01E01.mkv',
		localPath: null,
		sync: SyncState.IN_SYNC,
		...overrides,
	}) as MediaGroupSource;

/** A `QualitySummary` of one variant, which is what one indexed file answers. */
const quality = (resolution: string, bytes: number, codec = 'x265') => ({
	label: `${codec} · ${resolution}`,
	mixed: false,
	dominant: { label: `${codec} · ${resolution}`, videoCodec: codec, resolution, hdr: null, audioCodec: null, audioChannels: null, container: 'mkv', count: 1, bytes },
	variants: [{ label: `${codec} · ${resolution}`, videoCodec: codec, resolution, hdr: null, audioCodec: null, audioChannels: null, container: 'mkv', count: 1, bytes }],
	fileCount: 1,
	totalBytes: bytes,
});

const episodeGroup = (
	episodeNumber: number,
	sync: SyncState = SyncState.MISSING,
	sources: MediaGroupSource[] = [],
) => ({
	id: `ep-${episodeNumber}`,
	kind: MediaKind.EPISODE,
	title: `Episode ${episodeNumber}`,
	seasonNumber: 1,
	episodeNumber,
	sync,
	sources,
});

const GROUPS: Record<string, unknown> = {
	'series-1': {
		id: 'series-1',
		kind: MediaKind.SERIES,
		title: 'Spartacus',
		seasonNumber: null,
		episodeNumber: null,
		sync: SyncState.MISSING,
		sources: [],
	},
	'season-1': {
		id: 'season-1',
		kind: MediaKind.SEASON,
		title: 'Season 1',
		seasonNumber: 1,
		episodeNumber: null,
		sync: SyncState.MISSING,
		sources: [],
	},
	'ep-2': episodeGroup(2),
	'movie-1': {
		id: 'movie-1',
		kind: MediaKind.MOVIE,
		title: 'Blade Runner 2049',
		seasonNumber: null,
		episodeNumber: null,
		sync: SyncState.MISSING,
		sources: [],
	},
};

const CHILDREN: Record<string, unknown[]> = {
	'series-1': [GROUPS['season-1']],
	'season-1': [
		episodeGroup(1),
		episodeGroup(2),
		episodeGroup(3),
		episodeGroup(4),
		// Not an episode, and under a season: a folder of extras is an ordinary thing to
		// find there and must not be counted as a gap.
		{ id: 'extras-1', kind: MediaKind.SEASON, title: 'Extras', seasonNumber: 1, episodeNumber: null, sync: SyncState.MISSING, sources: [] },
	],
};

const release = (overrides: Partial<Release> = {}): Release => ({
	id: 'release-1',
	title: 'Spartacus.S01E02.1080p.WEB-DL-GRP',
	indexer: 'prowlarr',
	size: 5_000,
	seeders: 10,
	leechers: 1,
	publishedAt: null,
	magnetUrl: 'magnet:?xt=urn:btih:one',
	downloadUrl: null,
	kind: ReleaseKind.EPISODE,
	seasonNumber: 1,
	episodeNumber: 2,
	quality: '1080p',
	source: 'WEB-DL',
	languages: ['VO'],
	coverage: { seasonNumber: 1, episodeNumbers: [2], wholeSeason: false, wholeSeries: false },
	heldAlready: false,
	...overrides,
});

const grab = (overrides: Partial<GrabEntity> = {}): GrabEntity =>
	({
		id: 'grab-1',
		itemId: 'ep-2',
		title: 'Spartacus.S01.1080p.WEB-DL-GRP',
		indexer: 'prowlarr',
		state: GrabState.SENT,
		clientId: 'hash-1',
		bytesDone: 0,
		bytesTotal: 0,
		sourcePath: null,
		targetPath: null,
		targetLibraryId: null,
		targetFolder: null,
		// Whole-release by default, which is what most grabs are. A partial one says so
		// on its own row rather than being inferred from its placements — see the
		// `partial` column.
		partial: false,
		placements: [],
		error: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as unknown as GrabEntity;

const status = (overrides: Record<string, unknown> = {}) => ({
	clientId: 'hash-1',
	name: 'Spartacus.S01E02.1080p.WEB-DL-GRP',
	bytesDone: 500,
	bytesTotal: 1_000,
	rate: 42,
	complete: false,
	state: 'downloading',
	savePath: '/downloads',
	contentPath: '/downloads/Spartacus.S01E02.1080p.WEB-DL-GRP',
	...overrides,
});

const placement = (overrides: Record<string, unknown> = {}) => ({
	itemId: 'ep-2',
	seasonNumber: 1,
	episodeNumber: 2,
	title: 'The Thing in the Pit',
	fileName: null,
	targetPath: null,
	...overrides,
});

const build = (): { manager: ReleaseManager; fakes: Fakes } => {
	const indexer = { search: jest.fn().mockResolvedValue([]) };
	const client = {
		grab: jest.fn().mockResolvedValue('hash-1'),
		statuses: jest.fn().mockResolvedValue([]),
		files: jest.fn().mockResolvedValue([]),
		selectFiles: jest.fn().mockResolvedValue(undefined),
		start: jest.fn().mockResolvedValue(undefined),
	};

	const fakes: Fakes = {
		grabs: {
			create: jest.fn((values: Partial<GrabEntity>) => grab(values)),
			save: jest.fn((row: GrabEntity) => Promise.resolve(row)),
			findOne: jest.fn().mockResolvedValue(grab()),
			// Nothing in flight by default, so no test grows a download it never mentioned.
			findLive: jest.fn().mockResolvedValue([]),
			findRecent: jest.fn().mockResolvedValue([grab()]),
			findForItem: jest.fn().mockResolvedValue([grab({ id: 'grab-2' })]),
		},
		items: {
			findOne: jest.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve(WORLD.find((one) => one.id === where.id) ?? null),
			),
			find: jest.fn(({ where }: { where: { parentId: string } }) =>
				Promise.resolve(WORLD.filter((one) => one.parentId === where.parentId)),
			),
		},
		indexer,
		indexers: { get: jest.fn(() => indexer) },
		client,
		clients: { get: jest.fn(() => client) },
		settings: { get: jest.fn().mockResolvedValue(SETTINGS) },
		cache: { get: jest.fn().mockResolvedValue(release()), set: jest.fn().mockResolvedValue(undefined) },
		naming: { render: jest.fn().mockReturnValue('Spartacus/Season 01/S01E02.mkv') },
		placement: {
			// Calls the name back the way the real service does, per candidate library:
			// a fake that never asked would leave the manager's naming untested.
			resolve: jest.fn((request: { relativeName: (root: string) => string }) =>
				Promise.resolve({
					libraryId: 'lib-shows',
					libraryName: 'Shows',
					directory: '/media/shows',
					path: `/media/shows/${request.relativeName('/media/shows')}`,
				}),
			),
			prepare: jest.fn().mockResolvedValue(undefined),
		},
		libraries: {
			placementLibraries: jest.fn().mockResolvedValue([]),
			categoryKeysByLibrary: jest.fn().mockResolvedValue(new Map([['lib-shows', 'shows']])),
		},
		groups: {
			group: jest.fn((id: string) => Promise.resolve(GROUPS[id] ?? GROUPS['series-1'])),
			groupChildren: jest.fn((id: string) => Promise.resolve({ items: CHILDREN[id] ?? [], total: 0 })),
		},
		filesystem: {
			// Readable, which is the ordinary case; the tests about the opposite say so.
			rights: jest.fn().mockResolvedValue({ readable: true, writable: true }),
			largestFileUnder: jest
				.fn()
				.mockResolvedValue('/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/episode.mkv'),
		},
		peers: { find: jest.fn().mockResolvedValue([]) },
		mover: {
			move: jest.fn((order: { onProgress?: (progress: { bytesDone: number; bytesTotal: number; rate: number }) => void }) => {
				order.onProgress?.({ bytesDone: 500, bytesTotal: 1_000, rate: 7 });

				return Promise.resolve(undefined);
			}),
		},
		events: { emit: jest.fn() },
	};

	const manager = new ReleaseManager(
		fakes.grabs as unknown as ReleaseGrabRepository,
		fakes.items as unknown as MediaItemRepository,
		fakes.indexers as unknown as IndexerRegistry,
		fakes.clients as unknown as DownloadClientRegistry,
		fakes.settings as unknown as SettingsService,
		fakes.cache as unknown as CacheService,
		fakes.naming as unknown as NamingService,
		fakes.placement as unknown as PlacementService,
		fakes.libraries as unknown as LibraryManager,
		fakes.groups as unknown as MediaGroupManager,
		fakes.filesystem as unknown as FilesystemService,
		fakes.mover as unknown as FileMoveService,
		fakes.events as unknown as EventGatewayService,
		// The real one, over the real quality service: the folding of several summaries
		// into one is the part of a peer offer most likely to be wrong, and a fake that
		// answered a summary would prove nothing about it.
		new PeerSuggestionService(new QualityService()),
		fakes.peers as unknown as PeerRepository,
	);

	return { manager, fakes };
};

describe('ReleaseManager', () => {
	describe('search', () => {
		it('refuses when no indexer is configured', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(settingsWith({ indexer: null }));

			await expect(manager.search({ itemId: 'series-1' })).rejects.toThrow(
				ErrorKey.INDEXER_NOT_CONFIGURED,
			);
			expect(fakes.indexer.search).not.toHaveBeenCalled();
		});

		it('refuses an indexer that is configured and turned off', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(
				settingsWith({ indexer: { ...SETTINGS.indexer, enabled: false } }),
			);

			await expect(manager.search({ itemId: 'series-1' })).rejects.toThrow(ConflictException);
		});

		it('refuses a search with nothing to search for', async () => {
			const { manager } = build();

			await expect(manager.search({})).rejects.toThrow(BadRequestException);
		});

		it('names an indexer that failed rather than answering that nothing was found', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockRejectedValue(new Error('401 Unauthorized'));

			const found = await manager.search({ itemId: 'series-1' });

			expect(found.failed).toEqual([
				{ indexer: IndexerType.PROWLARR, error: expect.stringContaining('401 Unauthorized') },
			]);
			expect(trackerGroups(found)).toHaveLength(0);
			// The gaps are still answered: the screen has to say what is missing even when
			// nobody could be asked for it.
			expect(found.missing).toHaveLength(4);
		});

		it('searches a series by its own title and the season asked for', async () => {
			const { manager, fakes } = build();

			const found = await manager.search({ itemId: 'series-1', seasonNumber: 2, seasonPack: true });

			expect(fakes.indexer.search).toHaveBeenCalledWith(
				SETTINGS.indexer,
				expect.objectContaining({ term: 'Spartacus', seasonNumber: 2, episodeNumber: null, kind: 'show' }),
			);
			expect(found.query).toBe('Spartacus S02');
		});

		it('searches an episode by its series title, which is the name release names carry', async () => {
			const { manager, fakes } = build();

			await manager.search({ itemId: 'ep-2' });

			expect(fakes.indexer.search).toHaveBeenCalledWith(
				SETTINGS.indexer,
				expect.objectContaining({ term: 'Spartacus', seasonNumber: 1, episodeNumber: 2 }),
			);
		});

		it('falls back to the media own title when the parent chain is broken', async () => {
			const { manager, fakes } = build();

			fakes.items.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
				Promise.resolve(where.id === 'ep-2' ? (WORLD[2] ?? null) : null),
			);

			await manager.search({ itemId: 'ep-2' });

			expect(fakes.indexer.search).toHaveBeenCalledWith(
				SETTINGS.indexer,
				expect.objectContaining({ term: 'The Thing in the Pit' }),
			);
		});

		it('refuses a search for a media that is not in the catalogue', async () => {
			const { manager } = build();

			await expect(manager.search({ itemId: 'nobody' })).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});

		it('searches for words somebody typed, with no media behind them', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([release()]);

			const found = await manager.search({ term: 'Spartacus Vengeance' });

			expect(found.missing).toEqual([]);
			// No catalogue behind the search, so nothing can be said to be news.
			expect(trackerGroups(found)[0].brings).toEqual([]);
			expect(trackerGroups(found)[0].fills).toEqual([]);
		});

		it('marks a release whose size matches a file we hold', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([
				release({ id: 'held', size: 1_000, quality: '720p' }),
				release({ id: 'new', size: 42, quality: '2160p' }),
			]);

			const found = await manager.search({ itemId: 'ep-2' });
			const held = trackerGroups(found).find((one) => one.releases[0].id === 'held');
			const fresh = trackerGroups(found).find((one) => one.releases[0].id === 'new');

			expect(held?.heldAlready).toBe(true);
			expect(fresh?.heldAlready).toBe(false);
			// Grabbable all the same: the search is remembered for both.
			expect(fakes.cache.set).toHaveBeenCalledTimes(2);
		});

		it('matches a size held by a child of the media searched for', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([release({ size: 1_000 })]);

			const found = await manager.search({ itemId: 'season-1' });

			expect(trackerGroups(found)[0].heldAlready).toBe(true);
		});

		describe('fills', () => {
			it('gives a season pack every missing episode of its season', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.S01.1080p.WEB-DL-GRP',
						kind: ReleaseKind.SEASON_PACK,
						episodeNumber: null,
						coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].fills.map((one) => one.episodeNumber)).toEqual([1, 2, 3, 4]);
			});

			it('gives a complete-series pack everything that is missing', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.Complete.Series.1080p-GRP',
						kind: ReleaseKind.SEASON_PACK,
						coverage: { seasonNumber: null, episodeNumbers: [], wholeSeason: false, wholeSeries: true },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].fills).toHaveLength(4);
			});

			it('gives a name spelling three episodes exactly those three', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.S01E01-E03.1080p-GRP',
						coverage: { seasonNumber: 1, episodeNumbers: [1, 2, 3], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].fills.map((one) => one.episodeNumber)).toEqual([1, 2, 3]);
			});

			it('gives a film release the film', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Blade.Runner.2049.2017.2160p.BluRay-GRP',
						kind: ReleaseKind.MOVIE,
						seasonNumber: null,
						episodeNumber: null,
						coverage: { seasonNumber: null, episodeNumbers: [], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'movie-1' });

				expect(found.missing).toHaveLength(1);
				expect(trackerGroups(found)[0].fills).toEqual(found.missing);
			});

			it('gives a name nothing could be read off nothing at all', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'spartacus.repack.final.xvid',
						kind: ReleaseKind.UNKNOWN,
						seasonNumber: null,
						episodeNumber: null,
						coverage: { seasonNumber: null, episodeNumbers: [], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].fills).toEqual([]);
			});

			it('leaves a film already held with nothing to fill', async () => {
				const { manager, fakes } = build();

				fakes.groups.group.mockResolvedValue({ ...(GROUPS['movie-1'] as object), sync: SyncState.IN_SYNC });
				fakes.indexer.search.mockResolvedValue([
					release({ kind: ReleaseKind.MOVIE, coverage: { seasonNumber: null, episodeNumbers: [], wholeSeason: false, wholeSeries: false } }),
				]);

				const found = await manager.search({ itemId: 'movie-1' });

				expect(found.missing).toEqual([]);
				expect(trackerGroups(found)[0].fills).toEqual([]);
			});
		});

		describe('brings', () => {
			it('names an episode no server here has ever reported', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.S01E09.1080p-GRP',
						episodeNumber: 9,
						coverage: { seasonNumber: 1, episodeNumbers: [2, 9], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].brings).toEqual([{ seasonNumber: 1, episodeNumber: 9 }]);
			});

			it('names a whole season nobody here knows about', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.S02.1080p-GRP',
						kind: ReleaseKind.SEASON_PACK,
						seasonNumber: 2,
						episodeNumber: null,
						coverage: { seasonNumber: 2, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].brings).toEqual([{ seasonNumber: 2, episodeNumber: null }]);
			});

			it('says nothing new about a pack of a season we already know', async () => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						kind: ReleaseKind.SEASON_PACK,
						episodeNumber: null,
						coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].brings).toEqual([]);
			});
		});

		/**
		 * The other half of the answer, and the half that does not come off a tracker.
		 *
		 * A suggestion for a media is not only a name somebody uploaded. This gateway
		 * already indexes what every peer holds, so a season a friend has is a copy that
		 * exists, at a quality read off the file, on a machine we are already allowed to
		 * talk to. The screen has to be able to say so beside the tracker's rows — and the
		 * two must never be confused, because the action on each is a different machine.
		 */
		describe('the copies our peers already hold', () => {
			const withHoldings = (fakes: Fakes, sources: MediaGroupSource[]): void => {
				fakes.groups.groupChildren.mockImplementation((id: string) =>
					Promise.resolve({
						items: id === 'series-1'
							? [GROUPS['season-1']]
							: [
								episodeGroup(1, SyncState.MISSING, sources),
								episodeGroup(2, SyncState.MISSING, sources),
							],
						total: 0,
					}),
				);
			};

			it('offers a friend season beside the tracker rows, in one list', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source({ itemId: 'their-ep', quality: quality('1080p', 2_000) })]);
				fakes.indexer.search.mockResolvedValue([release()]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(peerCopies(found)).toHaveLength(1);
				expect(trackerGroups(found)).toHaveLength(1);
				// Both gaps on that service, folded into one thing to press.
				expect(peerCopies(found)[0].fills.map((one) => one.episodeNumber)).toEqual([1, 2]);
			});

			/**
			 * The whole reason the two are in one list. A file on a friend's disk is not a
			 * better-seeded claim — it is not a claim at all — so it goes above every release
			 * rather than being scored against them on fields it does not have.
			 */
			it('puts the copy that exists above the names on the tracker', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source()]);
				fakes.indexer.search.mockResolvedValue([release()]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(found.suggestions[0].source).toBe(SuggestionSource.PEER);
			});

			/**
			 * A peer copy is read out of the index and costs no network, so an indexer that
			 * timed out must not take it with it. This is the case the whole arrangement is
			 * worth most in: the tracker is down and the friend still has the season.
			 */
			it('still answers the friend copy when the indexer did not answer at all', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source()]);
				fakes.indexer.search.mockRejectedValue(new Error('401 Unauthorized'));

				const found = await manager.search({ itemId: 'series-1' });

				expect(found.failed).toHaveLength(1);
				expect(peerCopies(found)).toHaveLength(1);
			});

			it('names the holder, the service and how far away it is', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source({ peerId: 'peer-carol', peerName: 'Carol' })]);
				fakes.peers.find.mockResolvedValue([{ id: 'peer-carol', trust: PeerTrust.FRIEND_OF_FRIEND }]);

				const [offer] = peerCopies(await manager.search({ itemId: 'series-1' }));

				expect(offer.serviceName).toBe('Alice Jellyfin');
				expect(offer.peerName).toBe('Carol');
				// A gateway nobody in this household invited, and the row has to be able to
				// say so — see `MediaOrigin`.
				expect(offer.origin).toBe(MediaOrigin.FRIEND_OF_FRIEND);
			});

			it('offers nothing from a copy on our own disks', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source({ serviceId: 'svc-ours', local: true })]);

				expect(peerCopies(await manager.search({ itemId: 'series-1' }))).toEqual([]);
			});

			/**
			 * A peer's catalogue could be searched by title and deliberately is not: it
			 * would answer copies of something nobody has said is the same media, which is
			 * the guess the correlation graph exists to avoid making.
			 */
			it('offers nothing for free text, which names no media to match a copy against', async () => {
				const { manager } = build();

				const found = await manager.search({ term: 'Spartacus' });

				expect(peerCopies(found)).toEqual([]);
			});

			it('reads the holdings off the walk it already makes, not a second one', async () => {
				const { manager, fakes } = build();

				withHoldings(fakes, [source()]);
				await manager.search({ itemId: 'series-1' });

				// One call for the series and one for its season: the sources come back with
				// the groups, so asking again for a field already answered would double the
				// cost of every search on a series.
				expect(fakes.groups.groupChildren).toHaveBeenCalledTimes(2);
			});
		});

		describe('the kind it asks the indexer for', () => {
			/**
			 * The defect this field exists for: a film asked for under the television
			 * category answers an empty list, reports no fault, and looks exactly like a film
			 * no tracker carries.
			 */
			it('asks for a film as a film when a film was named', async () => {
				const { manager, fakes } = build();

				await manager.search({ itemId: 'movie-1' });

				expect(fakes.indexer.search).toHaveBeenCalledWith(
					SETTINGS.indexer,
					expect.objectContaining({ kind: ReleaseSearchKind.MOVIE }),
				);
			});

			it('asks for a film as a film on free text that says so', async () => {
				const { manager, fakes } = build();

				await manager.search({ term: 'Blade Runner 2049', kind: ReleaseSearchKind.MOVIE });

				expect(fakes.indexer.search).toHaveBeenCalledWith(
					SETTINGS.indexer,
					expect.objectContaining({ term: 'Blade Runner 2049', kind: ReleaseSearchKind.MOVIE }),
				);
			});

			/**
			 * A media the servers filed as the wrong kind is an ordinary thing to have to
			 * search around, and being able to is the whole point of the field being sayable.
			 */
			it('lets the caller override what the media claims to be', async () => {
				const { manager, fakes } = build();

				await manager.search({ itemId: 'series-1', kind: ReleaseSearchKind.MOVIE });

				expect(fakes.indexer.search).toHaveBeenCalledWith(
					SETTINGS.indexer,
					expect.objectContaining({ kind: ReleaseSearchKind.MOVIE }),
				);
			});
		});
	});

	describe('missingUnder', () => {
		it('answers the gaps under a series, two levels down', async () => {
			const { manager } = build();

			const missing = await manager.missingUnder('series-1');

			expect(missing.map((one) => one.episodeNumber)).toEqual([1, 2, 3, 4]);
		});
	});

	describe('plan', () => {
		it('takes one pack over four singles', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([
				release({
					id: 'pack',
					title: 'Spartacus.S01.1080p-GRP',
					kind: ReleaseKind.SEASON_PACK,
					seeders: 20,
					episodeNumber: null,
					coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
				}),
				...[1, 2, 3, 4].map((episodeNumber) =>
					release({
						id: `single-${episodeNumber}`,
						title: `Spartacus.S01E0${episodeNumber}.1080p-GRP`,
						seeders: 99,
						episodeNumber,
						coverage: { seasonNumber: 1, episodeNumbers: [episodeNumber], wholeSeason: false, wholeSeries: false },
					}),
				),
			]);

			const plan = await manager.plan({ itemId: 'series-1' });

			expect(plan.steps).toHaveLength(1);
			expect(plan.steps[0].releaseId).toBe('pack');
			expect(plan.steps[0].covers).toHaveLength(4);
			expect(plan.uncovered).toEqual([]);
		});

		it('breaks a tie on seeders, because a download that finishes is the point', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([
				release({ id: 'thin', title: 'Spartacus.S01E01.1080p-GRP', seeders: 2, episodeNumber: 1, quality: '1080p', coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false } }),
				release({ id: 'fat', title: 'Spartacus.S01E01.720p-GRP', seeders: 200, episodeNumber: 1, quality: '720p', coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false } }),
			]);

			const plan = await manager.plan({ itemId: 'series-1' });

			expect(plan.steps).toHaveLength(1);
			expect(plan.steps[0].releaseId).toBe('fat');
			expect(plan.steps[0].partial).toBe(false);
		});

		it('names what nothing on offer can fill rather than dropping it', async () => {
			const { manager, fakes } = build();

			fakes.indexer.search.mockResolvedValue([
				release({
					id: 'one',
					episodeNumber: 1,
					coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
				}),
			]);

			const plan = await manager.plan({ itemId: 'series-1' });

			expect(plan.steps).toHaveLength(1);
			expect(plan.uncovered.map((one) => one.episodeNumber)).toEqual([2, 3, 4]);
		});

		it('marks a pack taken for fewer episodes than it holds as partial', async () => {
			const { manager, fakes } = build();

			fakes.groups.groupChildren.mockImplementation((id: string) =>
				Promise.resolve({
					items:
						id === 'series-1'
							? [GROUPS['season-1']]
							: [episodeGroup(1), episodeGroup(2, SyncState.IN_SYNC), episodeGroup(3, SyncState.IN_SYNC)],
					total: 0,
				}),
			);
			fakes.indexer.search.mockResolvedValue([
				release({
					id: 'pack',
					kind: ReleaseKind.SEASON_PACK,
					episodeNumber: null,
					coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
				}),
			]);

			const plan = await manager.plan({ itemId: 'series-1' });

			expect(plan.steps[0].covers).toHaveLength(1);
			expect(plan.steps[0].partial).toBe(true);
		});

		it('answers an empty plan when nothing is missing', async () => {
			const { manager, fakes } = build();

			fakes.groups.groupChildren.mockResolvedValue({ items: [], total: 0 });

			const plan = await manager.plan({ itemId: 'series-1' });

			expect(plan).toEqual({ steps: [], uncovered: [] });
		});
	});

	describe('grab', () => {
		/**
		 * The two halves of the result set have two different machines behind them, and
		 * crossing them is the failure this guard exists for.
		 *
		 * A peer copy handed to qBittorrent is a magnetless add: the client takes nothing,
		 * answers no error, and every screen says the release was handed over while no byte
		 * ever moves. It would also *nearly* be refused by accident, because a peer
		 * identifier was never written to the release cache — which is a coincidence a
		 * caching change can remove, rather than a rule. So the refusal is on the prefix,
		 * and it comes before the client is so much as looked up.
		 */
		it('refuses a peer copy rather than handing it to the download client', async () => {
			const { manager, fakes } = build();

			await expect(
				manager.grab({ releaseId: `${PEER_SUGGESTION_PREFIX}svc-alice:1`, itemId: 'ep-2' }),
			).rejects.toThrow(ErrorKey.RELEASE_NOT_GRABBABLE);

			expect(fakes.client.grab).not.toHaveBeenCalled();
			expect(fakes.grabs.save).not.toHaveBeenCalled();
		});

		it('refuses it even with no download client configured, because the kind is wrong', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(settingsWith({ downloadClient: null }));

			// Not "no client", and not "no such release" either: the row was never one a
			// client could take. Either of those sends somebody to fix something that would
			// not have helped, when the answer is the other button on the same row.
			await expect(
				manager.grab({ releaseId: `${PEER_SUGGESTION_PREFIX}svc-alice:1`, itemId: 'ep-2' }),
			).rejects.toThrow(ErrorKey.RELEASE_NOT_GRABBABLE);
		});

		/**
		 * The failure that reports success, found by pointing the lab at a real Prowlarr.
		 *
		 * An indexer does not hand out a tracker's own link: it hands out one back to
		 * itself, built from the `Host` of the request that asked — so a search made by
		 * the gateway yields `http://localhost:9696/…`. Give that to a client in its own
		 * container and `localhost` is the *client*: it fetches nothing, adds nothing,
		 * and answers no error. The download never exists and every screen says it was
		 * handed over.
		 */
		it('follows an indexer link to the magnet behind it, from where the link works', async () => {
			const { manager, fakes } = build();
			const fetched = jest.fn().mockResolvedValue({
				headers: new Headers({ location: 'magnet:?xt=urn:btih:resolved' }),
			});

			global.fetch = fetched as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(
				release({ magnetUrl: null, downloadUrl: 'http://localhost:9696/1/download?apikey=k' }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ magnetUrl: 'magnet:?xt=urn:btih:resolved' }),
			);
		});

		it('hands the link over unchanged when it leads to no magnet', async () => {
			// Some trackers really do serve `.torrent` bytes at a URL the client can
			// fetch for itself, so refusing here would break a case that works.
			const { manager, fakes } = build();

			global.fetch = jest.fn().mockResolvedValue({ headers: new Headers() }) as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(
				release({ magnetUrl: null, downloadUrl: 'http://tracker.example/one.torrent' }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					magnetUrl: null,
					downloadUrl: 'http://tracker.example/one.torrent',
				}),
			);
		});

		it('refuses when no download client is configured', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(settingsWith({ downloadClient: null }));

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toThrow(
				ErrorKey.DOWNLOAD_CLIENT_NOT_CONFIGURED,
			);
			expect(fakes.client.grab).not.toHaveBeenCalled();
		});

		it('refuses a client that is configured and turned off', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(
				settingsWith({ downloadClient: { ...SETTINGS.downloadClient, enabled: false } }),
			);

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toThrow(
				ConflictException,
			);
		});

		it('refuses a client with no path mapping at all', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(
				settingsWith({ downloadClient: { ...SETTINGS.downloadClient, rootMappings: [] } }),
			);

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toThrow(
				ErrorKey.DOWNLOAD_PATH_UNREADABLE,
			);
		});

		it('refuses before a byte moves when a mapped local root cannot be read', async () => {
			const { manager, fakes } = build();

			fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toThrow(
				ErrorKey.DOWNLOAD_PATH_UNREADABLE,
			);
			expect(fakes.filesystem.rights).toHaveBeenCalledWith('/share/torrents');
			expect(fakes.client.grab).not.toHaveBeenCalled();
		});

		it('refuses a release whose search has expired', async () => {
			const { manager, fakes } = build();

			fakes.cache.get.mockResolvedValue(null);

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toThrow(
				NotFoundException,
			);
			expect(fakes.client.grab).not.toHaveBeenCalled();
		});

		it('hands the whole release to the client running, and remembers what it is for', async () => {
			const { manager, fakes } = build();

			const view = await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				SETTINGS.downloadClient,
				expect.objectContaining({
					magnetUrl: 'magnet:?xt=urn:btih:one',
					savePath: '/downloads',
					category: 'media-center-sync',
					paused: false,
				}),
			);
			expect(view.state).toBe(GrabState.SENT);
			expect(view.clientId).toBe('hash-1');
			expect(view.placements).toEqual([
				expect.objectContaining({ itemId: 'ep-2', seasonNumber: 1, episodeNumber: 2, fileName: null }),
			]);
			expect(fakes.events.emit).toHaveBeenCalledWith(EventName.RELEASE_GRAB, expect.anything());
		});

		it('adds a grab paused when only some episodes are wanted', async () => {
			const { manager, fakes } = build();

			const view = await manager.grab({
				releaseId: 'release-1',
				itemId: 'series-1',
				libraryId: 'lib-shows',
				folder: '/media/shows/Spartacus',
				wanted: [
					{ itemId: 'ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Two' },
					{ itemId: 'ep-3', seasonNumber: 1, episodeNumber: 3, title: 'Three' },
				],
			});

			expect(fakes.client.grab).toHaveBeenCalledWith(
				SETTINGS.downloadClient,
				expect.objectContaining({ paused: true }),
			);
			expect(view.placements).toHaveLength(2);
			expect(view.targetLibraryId).toBe('lib-shows');
			expect(view.targetFolder).toBe('/media/shows/Spartacus');
		});

		it('writes where the client itself was told to write when somebody named a path', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(
				settingsWith({ downloadClient: { ...SETTINGS.downloadClient, savePath: '/elsewhere' } }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ savePath: '/elsewhere' }),
			);
		});
	});

	describe('setDestination', () => {
		it('redirects a download that has not been filed yet', async () => {
			const { manager, fakes } = build();

			const view = await manager.setDestination('grab-1', 'lib-anime', '/media/anime/Spartacus');

			expect(view.targetLibraryId).toBe('lib-anime');
			expect(view.targetFolder).toBe('/media/anime/Spartacus');
			expect(fakes.grabs.save).toHaveBeenCalled();
			expect(fakes.events.emit).toHaveBeenCalledWith(EventName.RELEASE_GRAB, expect.anything());
		});

		it('refuses once the file is in the library', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(grab({ state: GrabState.PLACED }));

			await expect(manager.setDestination('grab-1', 'lib-anime', null)).rejects.toThrow(
				ConflictException,
			);
			expect(fakes.grabs.save).not.toHaveBeenCalled();
		});

		it('refuses a grab nobody has a row for', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(null);

			await expect(manager.setDestination('gone', null, null)).rejects.toThrow(
				ErrorKey.GRAB_NOT_FOUND,
			);
		});
	});

	describe('downloads', () => {
		it('answers everything, newest first', async () => {
			const { manager, fakes } = build();

			const rows = await manager.downloads();

			expect(rows).toHaveLength(1);
			expect(fakes.grabs.findRecent).toHaveBeenCalled();
		});

		it('answers only what belongs to one media when one is named', async () => {
			const { manager, fakes } = build();

			const rows = await manager.downloads('ep-2');

			expect(rows[0].id).toBe('grab-2');
			expect(fakes.grabs.findForItem).toHaveBeenCalledWith('ep-2');
		});
	});

	describe('poll', () => {
		it('asks nothing of the client when nothing is in flight', async () => {
			const { manager, fakes } = build();

			await manager.poll();

			expect(fakes.settings.get).not.toHaveBeenCalled();
			expect(fakes.client.statuses).not.toHaveBeenCalled();
		});

		it('asks nothing when the client has been unconfigured under a live download', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findLive.mockResolvedValue([grab({ state: GrabState.DOWNLOADING })]);
			fakes.settings.get.mockResolvedValue(settingsWith({ downloadClient: null }));

			await manager.poll();

			expect(fakes.client.statuses).not.toHaveBeenCalled();
		});

		it('asks only about our own category', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findLive.mockResolvedValue([grab({ state: GrabState.DOWNLOADING })]);

			await manager.poll();

			expect(fakes.client.statuses).toHaveBeenCalledWith(SETTINGS.downloadClient, 'media-center-sync');
		});

		it('cancels a download the client has never heard of', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING });

			fakes.grabs.findLive.mockResolvedValue([row]);

			await manager.poll();

			expect(row.state).toBe(GrabState.CANCELLED);
		});

		it('leaves a grab just sent alone, because it may not have appeared yet', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.SENT, placements: [placement()] });

			fakes.grabs.findLive.mockResolvedValue([row]);

			await manager.poll();

			expect(row.state).toBe(GrabState.SENT);
			expect(fakes.grabs.save).not.toHaveBeenCalled();
		});

		it('leaves a row with no client identifier alone', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.SENT, clientId: null });

			fakes.grabs.findLive.mockResolvedValue([row]);
			fakes.client.statuses.mockResolvedValue([status()]);

			await manager.poll();

			expect(row.state).toBe(GrabState.SENT);
		});

		it('reports progress on a download that is still running', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING, bytesTotal: 1_000 });

			fakes.grabs.findLive.mockResolvedValue([row]);
			fakes.client.statuses.mockResolvedValue([status({ bytesDone: 700, bytesTotal: 0 })]);

			await manager.poll();

			expect(row.state).toBe(GrabState.DOWNLOADING);
			expect(row.bytesDone).toBe(700);
			// The client reporting nothing does not erase what the release said it weighed.
			expect(row.bytesTotal).toBe(1_000);
			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.RELEASE_GRAB,
				expect.objectContaining({ rate: 42 }),
			);
		});

		describe('choosing the files of a partial grab', () => {
			const partial = (): GrabEntity =>
				grab({
					state: GrabState.SENT,
					title: 'Spartacus.S02.1080p-GRP',
					partial: true,
					placements: [
						placement({ itemId: 'ep-2', seasonNumber: 2, episodeNumber: 2, fileName: null }),
						placement({ itemId: 'ep-4', seasonNumber: 2, episodeNumber: 4, fileName: null }),
					],
				});

			it('matches every file on the file own name and selects only those indices', async () => {
				const { manager, fakes } = build();
				const row = partial();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status()]);
				fakes.client.files.mockResolvedValue([
					{ index: 0, name: 'Spartacus.S02/Spartacus.S02E01.1080p-GRP.mkv', size: 10, priority: 1 },
					{ index: 3, name: 'Spartacus.S02/Spartacus.S02E02.1080p-GRP.mkv', size: 10, priority: 1 },
					{ index: 7, name: 'Spartacus.S02/Spartacus.S02E04.1080p-GRP.mkv', size: 10, priority: 1 },
					{ index: 9, name: 'Spartacus.S02/proof.jpg', size: 1, priority: 1 },
				]);

				await manager.poll();

				expect(fakes.client.selectFiles).toHaveBeenCalledWith(
					SETTINGS.downloadClient,
					'hash-1',
					[3, 7],
				);
				expect(fakes.client.start).toHaveBeenCalledWith(SETTINGS.downloadClient, 'hash-1');
				expect(row.state).toBe(GrabState.DOWNLOADING);
				expect((row.placements ?? []).map((one) => one.fileName)).toEqual([
					'Spartacus.S02/Spartacus.S02E02.1080p-GRP.mkv',
					'Spartacus.S02/Spartacus.S02E04.1080p-GRP.mkv',
				]);
			});

			it('comes back next pass while the client has no file list yet', async () => {
				const { manager, fakes } = build();
				const row = partial();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status()]);
				fakes.client.files.mockResolvedValue([]);

				await manager.poll();

				expect(fakes.client.selectFiles).not.toHaveBeenCalled();
				expect(fakes.client.start).not.toHaveBeenCalled();
				expect(row.state).toBe(GrabState.SENT);
			});

			it('fails the grab when the pack holds none of the wanted episodes', async () => {
				const { manager, fakes } = build();
				const row = partial();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status()]);
				fakes.client.files.mockResolvedValue([
					{ index: 0, name: 'Spartacus.S03/Spartacus.S03E01.1080p-GRP.mkv', size: 10, priority: 1 },
				]);

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(row.error).toContain('none of the wanted episodes');
				expect(fakes.client.selectFiles).not.toHaveBeenCalled();
				expect(fakes.client.start).not.toHaveBeenCalled();
			});
		});

		describe('placing what has arrived', () => {
			const fetched = (): GrabEntity => grab({ state: GrabState.DOWNLOADING, placements: [placement({ fileName: 'episode.mkv' })] });

			it('copies it into the library and leaves the torrent seeding', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				// The client's spelling translated into ours, once, on the way in.
				expect(row.sourcePath).toBe('/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP');
				expect(fakes.mover.move).toHaveBeenCalledWith(
					expect.objectContaining({
						source: '/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/episode.mkv',
						destination: '/media/shows/Spartacus/Season 01/S01E02.mkv',
						keepSource: true,
					}),
				);
				expect(row.state).toBe(GrabState.PLACED);
				expect(row.targetPath).toBe('/media/shows/Spartacus/Season 01/S01E02.mkv');
				expect(row.error).toBeNull();
			});

			it('places a chosen folder through the fixed-path strategy', async () => {
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING, targetFolder: '/media/anime/Spartacus', targetLibraryId: 'lib-anime' });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({
						preferredLibraryId: 'lib-anime',
						settings: expect.objectContaining({
							placement: PlacementStrategy.FIXED_PATH,
							fixedPath: '/media/anime/Spartacus',
						}),
					}),
				);
			});

			it('falls back to the client own spelling for a path nothing maps', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([
					status({ complete: true, contentPath: null, savePath: '/somewhere/else' }),
				]);

				await manager.poll();

				expect(row.sourcePath).toBe('/somewhere/else/Spartacus.S01E02.1080p.WEB-DL-GRP');
			});

			it('fails the grab when nothing playable can be found under the download', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(null);

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(row.error).toContain('nothing playable');
				expect(fakes.mover.move).not.toHaveBeenCalled();
			});

			it('fails the grab when the download folder cannot be read', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(fakes.filesystem.largestFileUnder).not.toHaveBeenCalled();
			});

			it('fails the grab when the media it was for has gone', async () => {
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING, itemId: 'nobody' });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(fakes.mover.move).not.toHaveBeenCalled();
			});

			it('fails the grab when the copy itself fails', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.mover.move.mockRejectedValue(new Error('no space left on device'));

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(row.error).toContain('no space left on device');
			});
		});
	});

	describe('onApplicationBootstrap', () => {
		it('polls on a timer, and a client that is down does not take the timer with it', async () => {
			jest.useFakeTimers();

			try {
				const { manager, fakes } = build();

				fakes.grabs.findLive.mockRejectedValue(new Error('connection refused'));

				manager.onApplicationBootstrap();
				jest.advanceTimersByTime(5_000);
				await Promise.resolve();
				await Promise.resolve();

				expect(fakes.grabs.findLive).toHaveBeenCalledTimes(1);

				jest.advanceTimersByTime(5_000);
				await Promise.resolve();
				await Promise.resolve();

				expect(fakes.grabs.findLive).toHaveBeenCalledTimes(2);
			} finally {
				jest.useRealTimers();
			}
		});
	});
});
