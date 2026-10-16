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
import {
	BadRequestException,
	ConflictException,
	NotFoundException,
	UnauthorizedException,
} from '@nestjs/common';
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
import type { LandingManager } from './landing.manager';
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
		delete: jest.Mock;
	};
	items: {
		findOne: jest.Mock;
		find: jest.Mock;
		findChildren: jest.Mock;
		ancestry: jest.Mock;
		topAncestor: jest.Mock;
	};
	/** What the registry hands back, so a test can make the tracker fail on its own. */
	indexer: { search: jest.Mock; trackers: jest.Mock };
	indexers: { get: jest.Mock };
	client: {
		grab: jest.Mock;
		statuses: jest.Mock;
		files: jest.Mock;
		selectFiles: jest.Mock;
		start: jest.Mock;
		pause: jest.Mock;
		defaultSavePath: jest.Mock;
	};
	clients: { get: jest.Mock };
	settings: { get: jest.Mock };
	cache: { get: jest.Mock; set: jest.Mock };
	naming: { render: jest.Mock };
	placement: { resolve: jest.Mock; prepare: jest.Mock };
	libraries: { placementLibraries: jest.Mock; categoryKeysByLibrary: jest.Mock; read: jest.Mock };
	groups: { group: jest.Mock; groupChildren: jest.Mock };
	filesystem: { rights: jest.Mock; filesUnder: jest.Mock; largestFileUnder: jest.Mock };
	mover: { move: jest.Mock };
	events: { emit: jest.Mock };
	landings: { recordFile: jest.Mock };
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
	// A second episode of the same season, held by nobody: what a pack is taken for when
	// it is taken for more than one thing, and the row a second copy has to be filed as.
	item({
		id: 'ep-3',
		kind: MediaKind.EPISODE,
		title: 'Legends',
		parentId: 'season-1',
		seasonNumber: 1,
		episodeNumber: 3,
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
		/*
		 * The show, as this gateway holds it. Placement asks the grouping where a series
		 * already lives rather than re-deriving it — see `_existingCopy` — so this is what
		 * every test about filing an episode beside its neighbours now runs through.
		 */
		sources: [{ itemId: 'series-1', local: true }],
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
	offTarget: false,
	// Most public trackers report none, which is the ordinary case and not a statement
	// that a release costs full ratio.
	flags: [],
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
	paused: false,
	failed: false,
	failedReason: null,
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
	bytes: null,
	targetPath: null,
	...overrides,
});

/**
 * What the placement asked the naming service to render, for one `resolve` call.
 *
 * `relativeName` is a callback, so the only way to see the facts a placement was built
 * from is to call it — which is also the only way to assert on the one that matters: the
 * show an episode is filed under.
 */
const namedBy = (
	render: jest.Mock,
	order: { relativeName: (root: string) => string },
): { title: string; seriesTitle: string | null; seriesYear: number | null }[] => {
	render.mockClear();
	order.relativeName('/media/shows');

	return render.mock.calls.map(([, item]) => item as {
		title: string;
		seriesTitle: string | null;
		seriesYear: number | null;
	});
};

const build = (): { manager: ReleaseManager; fakes: Fakes } => {
	const indexer = {
		search: jest.fn().mockResolvedValue([]),
		trackers: jest.fn().mockResolvedValue(['YGG', 'Sharewood']),
	};
	const client = {
		grab: jest.fn().mockResolvedValue('hash-1'),
		statuses: jest.fn().mockResolvedValue([]),
		files: jest.fn().mockResolvedValue([]),
		selectFiles: jest.fn().mockResolvedValue(undefined),
		start: jest.fn().mockResolvedValue(undefined),
		pause: jest.fn().mockResolvedValue(undefined),
		// A client that says where it writes, which is the ordinary one and the only one
		// whose answer the gateway passes on. The test that matters for the other case
		// says null for itself: nothing of ours is sent then, and a client that will not
		// answer must not have a path invented for it.
		defaultSavePath: jest.fn().mockResolvedValue('/downloads'),
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
			delete: jest.fn().mockResolvedValue({ affected: 1 }),
		},
		items: {
			findOne: jest.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve(WORLD.find((one) => one.id === where.id) ?? null),
			),
			find: jest.fn(({ where }: { where: { parentId: string } }) =>
				Promise.resolve(WORLD.filter((one) => one.parentId === where.parentId)),
			),
			// Walked to find a file of this show we already hold, which is what the naming
			// service imitates: without one a torrent lands in `Season 01` beside the
			// `Saison 1` folders a library has used for years.
			findChildren: jest.fn((parentId: string) =>
				Promise.resolve(WORLD.filter((one) => one.parentId === parentId)),
			),
			// Asked when the tree says nothing, which is what a hierarchy a media server
			// misreads looks like from here. Empty by default.
			// The row and its parents, nearest first — the order a pinned folder is looked
			// for in, since a decision taken about a season beats the same one taken about
			// its series.
			ancestry: jest.fn((item: { id: string; parentId: string | null }) => {
				const chain = [item];

				for (;;) {
					const parentId = chain[chain.length - 1].parentId;
					const parent = parentId === null
						? undefined
						: WORLD.find((one) => one.id === parentId);

					if (parent === undefined) {
						return Promise.resolve(chain);
					}

					chain.push(parent as typeof item);
				}
			}),
			// The walk the real repository does, over the same little world: up to the row
			// with no parent.
			topAncestor: jest.fn((item: { id: string; parentId: string | null }) => {
				let current = item;

				while (current.parentId !== null) {
					const parent = WORLD.find((one) => one.id === current.parentId);

					if (parent === undefined) {
						break;
					}

					current = parent as typeof current;
				}

				return Promise.resolve(current);
			}),
		},
		indexer,
		indexers: { get: jest.fn(() => indexer) },
		client,
		clients: { get: jest.fn(() => client) },
		settings: { get: jest.fn().mockResolvedValue(SETTINGS) },
		cache: { get: jest.fn().mockResolvedValue(release()), set: jest.fn().mockResolvedValue(undefined) },
		// Named the way the real service names: the show's folder, the season's folder,
		// and a file carrying the show's name. A double that answered a bare `S01E02.mkv`
		// would pin a shape this product never writes.
		naming: { render: jest.fn().mockReturnValue('Spartacus/Season 01/Spartacus - S01E02.mkv') },
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
			/*
			 * The shelf a held copy sits on, with both spellings of its paths.
			 *
			 * Both, because that is the whole difficulty: `file.path` is what the media
			 * server reports and everything downstream compares against what this gateway
			 * sees. Here they are the same directory under two names, as they are on a real
			 * gateway.
			 */
			read: jest.fn().mockResolvedValue({
				id: 'lib-shows',
				paths: ['/media/shows'],
				localPath: '/media/shows',
			}),
		},
		groups: {
			group: jest.fn((id: string) => Promise.resolve(GROUPS[id] ?? GROUPS['series-1'])),
			groupChildren: jest.fn((id: string) => Promise.resolve({ items: CHILDREN[id] ?? [], total: 0 })),
		},
		filesystem: {
			// Readable, which is the ordinary case; the tests about the opposite say so.
			rights: jest.fn().mockResolvedValue({ readable: true, writable: true }),
			/*
			 * One file, which is what a torrent of one episode is — and what every test
			 * here was written against. A pack holding several says so for itself: see
			 * `_spreadOf`, which files one episode per coordinate it can read.
			 */
			filesUnder: jest.fn().mockResolvedValue([
				{ path: '/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/episode.mkv', size: 1_000 },
			]),
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
		// Reading what the gateway told the media server is how the tests assert that it
		// told it anything at all — a placed torrent that announces nothing is the defect
		// this doubles for.
		landings: { recordFile: jest.fn().mockResolvedValue(undefined) },
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
		fakes.landings as unknown as LandingManager,
	);

	return { manager, fakes };
};

describe('ReleaseManager', () => {
	describe('what a download says it is bringing', () => {
		it('records the quality the release name claims, so the queue can say it', async () => {
			/*
			 * Twelve gigabytes reads the same whether it is a 2160p remux or a 720p
			 * re-encode: the queue said nothing about what was arriving, and the only way to
			 * know was to remember which line had been pressed.
			 *
			 * The release is handed back by the cache, which is where a grab reads it: a
			 * release identifier is only valid inside the search that produced it.
			 */
			const { manager, fakes } = build();

			fakes.cache.get.mockResolvedValue(
				release({ quality: '2160p', source: 'WEB-DL', languages: ['MULTi'] }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			const saved = fakes.grabs.save.mock.calls.at(-1)?.[0] as { quality: string | null };

			expect(saved.quality).toBe('2160p · WEB-DL · MULTi');
		});

		it('says nothing rather than "unknown" when the name says nothing', async () => {
			// Plenty of releases are named nothing useful, and a column that never says
			// anything is worse than an absent one.
			const { manager, fakes } = build();

			fakes.cache.get.mockResolvedValue(release({ quality: null, source: null, languages: [] }));

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			const saved = fakes.grabs.save.mock.calls.at(-1)?.[0] as { quality: string | null };

			expect(saved.quality).toBeNull();
		});
	});

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
				{
					indexer: IndexerType.PROWLARR,
					error: expect.stringContaining('401 Unauthorized'),
					// A bare `Error` carries no key, and the generic one is what the screen
					// falls back to. Which is the honest answer: nothing here knows more.
					key: ErrorKey.GENERAL,
				},
			]);
			expect(trackerGroups(found)).toHaveLength(0);
			// The gaps are still answered: the screen has to say what is missing even when
			// nobody could be asked for it.
			expect(found.missing).toHaveLength(4);
		});

		it('carries which of the three failures it was, so the screen can say', async () => {
			/*
			 * A refused key, an address nothing answers and a reply that merely took too
			 * long were one sentence telling somebody to check their address and their key.
			 * Three different fixes, and only one of them is the settings — so a household
			 * whose indexer was fine, behind a gateway busy with a scan, went hunting
			 * through configuration that was right all along.
			 */
			const { manager, fakes } = build();

			fakes.indexer.search.mockRejectedValue(
				new UnauthorizedException({ key: ErrorKey.INDEXER_UNAUTHORIZED }),
			);

			const found = await manager.search({ itemId: 'series-1' });

			expect(found.failed[0]?.key).toBe(ErrorKey.INDEXER_UNAUTHORIZED);
		});

		/**
		 * What a tracker sends back is not what was asked for.
		 *
		 * Reported from use: a search for one episode answers other episodes of the show,
		 * and a row a season away sits in the list looking exactly like the right one.
		 * Indexers match on words, so every episode of the series answers the same query —
		 * and picking the wrong row costs a download, a file filed under the wrong episode,
		 * and a gap that still reads as missing afterwards.
		 *
		 * Marked and sunk, never removed: what is being read is a release *name*, tracker
		 * naming is not a standard, and a row this parser misreads would otherwise vanish
		 * with no way to see that it had.
		 */
		describe('what comes back that was not asked for', () => {
			const found = async (rows: Release[]) => {
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue(rows);

				const answer = await manager.search({ itemId: 'ep-2' });

				return {
					// In the order the screen draws them.
					order: answer.suggestions
						.filter(one => !isPeerSuggestion(one))
						.map(one => ({ id: one.release.releases[0].id, offTarget: one.release.offTarget })),
				};
			};

			it('marks a release that names another episode of the same season, and sinks it',
				async () => {
					const { order } = await found([
						release({ id: 'right', title: 'Spartacus.S01E02.1080p-GRP' }),
						release({
							id: 'wrong',
							title: 'Spartacus.S01E05.1080p-GRP',
							episodeNumber: 5,
							coverage: { seasonNumber: 1, episodeNumbers: [5], wholeSeason: false, wholeSeries: false },
						}),
					]);

					// Still offered — somebody who can see the name is right and the reading is
					// wrong can still take it — but under everything else.
					expect(order).toEqual([
						{ id: 'right', offTarget: false },
						{ id: 'wrong', offTarget: true },
					]);
				});

			it('marks a release that names another season', async () => {
				const { order } = await found([
					release({
						id: 'wrong-season',
						title: 'Spartacus.S02E02.1080p-GRP',
						seasonNumber: 2,
						coverage: { seasonNumber: 2, episodeNumbers: [2], wholeSeason: false, wholeSeries: false },
					}),
				]);

				expect(order).toEqual([{ id: 'wrong-season', offTarget: true }]);
			});

			it('marks a pack of another show, however exactly it names the season asked for',
				async () => {
					/*
					 * The owner's own search, and the defect that cost the most. Season four
					 * of **From** — one of the commonest words in English — answered, under a
					 * heading promising "what fills the gaps you have":
					 *
					 * ```
					 * Bridgerton.2020.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-TFA   384 sources
					 * Snowpiercer.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-CHiLL     227 sources
					 * Dexter.S04.MULTI.VFF.1080p.WEB.DDP.5.1.H265-TyHD            142 sources
					 * ```
					 *
					 * Every one a season-four pack, so every one agreeing with the coordinate
					 * — and nothing anywhere compared the title. Taking the first would have
					 * downloaded fifteen gigabytes of Bridgerton, filed it as From, and left
					 * the gap reading as filled.
					 */
					const { order } = await found([
						release({ id: 'ours', title: 'Spartacus.S01E02.1080p-GRP' }),
						release({
							id: 'bridgerton',
							title: 'Bridgerton.2020.S01.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-TFA',
							episodeNumber: null,
							coverage: {
								seasonNumber: 1,
								episodeNumbers: [],
								wholeSeason: true,
								wholeSeries: false,
							},
						}),
						release({
							id: 'dexter',
							title: 'Dexter.COMPLETE.SERIES.MULTI.VFF.1080p-GRP',
							seasonNumber: null,
							episodeNumber: null,
							coverage: {
								seasonNumber: null,
								episodeNumbers: [],
								wholeSeason: false,
								wholeSeries: true,
							},
						}),
					]);

					// The complete-series pack too: "everything" is only everything of the
					// show that was asked for, and reading the coordinate first said otherwise.
					expect(order).toEqual([
						{ id: 'ours', offTarget: false },
						{ id: 'bridgerton', offTarget: true },
						{ id: 'dexter', offTarget: true },
					]);
				});

			it('tells a show from one whose name merely begins with it', async () => {
				// A prefix is not enough — and this is the whole reason the test is a reading
				// of what sits between the title and the coordinate. See `namesMedia`.
				const { order } = await found([
					release({ id: 'ours', title: 'Spartacus.S01E02.1080p-GRP' }),
					release({ id: 'other', title: 'Spartacus.Gods.of.the.Arena.S01E02.1080p-GRP' }),
				]);

				expect(order).toEqual([
					{ id: 'ours', offTarget: false },
					{ id: 'other', offTarget: true },
				]);
			});

			it('judges no title at all on words somebody typed by hand', async () => {
				/*
				 * Free text is the search that exists for when the rules fail — half a title,
				 * a release group, a word somebody is hunting with — and refusing every name
				 * that does not begin with it would make it the search that fails hardest.
				 */
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						id: 'anything',
						title: 'Bridgerton.2020.S01.MULTI.1080p-GRP',
						episodeNumber: null,
						coverage: {
							seasonNumber: 1,
							episodeNumbers: [],
							wholeSeason: true,
							wholeSeries: false,
						},
					}),
				]);

				const answer = await manager.search({ term: 'bridgerton', seasonNumber: 1 });

				expect(trackerGroups(answer)[0].offTarget).toBe(false);
			});

			it('leaves a season pack alone, which contains the episode asked for', async () => {
				// And the grab machinery takes one file out of a pack — see `wanted`.
				const { order } = await found([
					release({
						id: 'pack',
						title: 'Spartacus.S01.COMPLETE.1080p-GRP',
						episodeNumber: null,
						coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				expect(order).toEqual([{ id: 'pack', offTarget: false }]);
			});

			it('leaves a complete-series pack alone whatever it names', async () => {
				const { order } = await found([
					release({
						id: 'series',
						title: 'Spartacus.COMPLETE.SERIES.1080p-GRP',
						seasonNumber: null,
						episodeNumber: null,
						coverage: {
							seasonNumber: null,
							episodeNumbers: [],
							wholeSeason: false,
							wholeSeries: true,
						},
					}),
				]);

				expect(order).toEqual([{ id: 'series', offTarget: false }]);
			});

			it('leaves a release whose name says nothing alone', async () => {
				/*
				 * The narrowness is the point. Tracker naming is not a standard and plenty
				 * of real releases spell neither a season nor an episode; marking those would
				 * sink exactly the shows whose releases are named worst, which is the
				 * opposite of the fault being fixed.
				 */
				const { order } = await found([
					release({
						id: 'unnamed',
						title: 'Spartacus.Blood.and.Sand.1080p-GRP',
						seasonNumber: null,
						episodeNumber: null,
						coverage: {
							seasonNumber: null,
							episodeNumbers: [],
							wholeSeason: false,
							wholeSeries: false,
						},
					}),
				]);

				expect(order).toEqual([{ id: 'unnamed', offTarget: false }]);
			});

			it('reads a multi-episode release by what it lists', async () => {
				const { order } = await found([
					release({
						id: 'double',
						title: 'Spartacus.S01E01E02.1080p-GRP',
						coverage: {
							seasonNumber: 1,
							episodeNumbers: [1, 2],
							wholeSeason: false,
							wholeSeries: false,
						},
					}),
					release({
						id: 'other-double',
						title: 'Spartacus.S01E03E04.1080p-GRP',
						coverage: {
							seasonNumber: 1,
							episodeNumbers: [3, 4],
							wholeSeason: false,
							wholeSeries: false,
						},
					}),
				]);

				expect(order).toEqual([
					{ id: 'double', offTarget: false },
					{ id: 'other-double', offTarget: true },
				]);
			});

			it('marks nothing when nothing specific was asked', async () => {
				// A film, or words somebody typed: there is no season and no episode for a
				// release to contradict.
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						id: 'a',
						seasonNumber: 4,
						coverage: { seasonNumber: 4, episodeNumbers: [9], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const answer = await manager.search({ term: 'Spartacus' });

				expect(trackerGroups(answer).map(one => one.offTarget)).toEqual([false]);
			});
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

		it('reports the words it really sent, episode and all', async () => {
			/*
			 * The line somebody reads when nothing came back, so that they can correct the
			 * search. It was built here a second time and spelled only the season: standing
			 * on episode eight and pressing search, the screen answered `Lanterns S01` while
			 * `Lanterns S01E08` had gone out — telling a person the gateway did something
			 * other than what it did.
			 */
			const { manager } = build();

			const found = await manager.search({ itemId: 'ep-2' });

			expect(found.query).toBe('Spartacus S01E02');
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

			it('claims nothing for a pack of another show', async () => {
				/*
				 * The line that keeps fifteen gigabytes of Bridgerton out of the list headed
				 * "what fills the gaps you have". The coverage agreed — it really is a
				 * season-one pack — and agreeing with the coordinate was all anything checked.
				 */
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Bridgerton.2020.S01.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-TFA',
						kind: ReleaseKind.SEASON_PACK,
						episodeNumber: null,
						coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].fills).toEqual([]);
				expect(trackerGroups(found)[0].brings).toEqual([]);
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

		describe('the order the screen draws them in', () => {
			it('puts what closes most of the gap first, not what is best seeded', async () => {
				/*
				 * The owner's season four search, in order: eight single episodes by seeders,
				 * and the season pack — the one row that answers the question he asked — in
				 * twelfth place. Seeders decided, and seeders say how popular a release is,
				 * not how much of a season it brings.
				 */
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({ id: 'one-episode', title: 'Spartacus.S01E02.1080p-GRP', seeders: 546 }),
					release({
						id: 'pack',
						title: 'Spartacus.S01.MULTi.1080p.WEB-GRP',
						seeders: 189,
						kind: ReleaseKind.SEASON_PACK,
						episodeNumber: null,
						coverage: { seasonNumber: 1, episodeNumbers: [], wholeSeason: true, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found).map((one) => one.releases[0].id))
					.toEqual(['pack', 'one-episode']);
			});

			it('leaves the seeded order alone where nothing fills a gap', async () => {
				// Ties at zero for everything that fills nothing, so a search where somebody
				// is replacing a copy rather than filling one is ordered as it always was.
				const { manager, fakes } = build();

				fakes.indexer.search.mockResolvedValue([
					release({ id: 'quiet', title: 'Spartacus.S01E09.1080p-GRP', seeders: 10, episodeNumber: 9,
						coverage: { seasonNumber: 1, episodeNumbers: [9], wholeSeason: false, wholeSeries: false } }),
					release({ id: 'loud', title: 'Spartacus.S01E08.1080p-GRP', seeders: 500, episodeNumber: 8,
						coverage: { seasonNumber: 1, episodeNumbers: [8], wholeSeason: false, wholeSeries: false } }),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found).map((one) => one.releases[0].id)).toEqual(['loud', 'quiet']);
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

			/**
			 * The owner's Monk, Beetlejuice and Eureka, from the other side.
			 *
			 * One file named `S01E01-E02` is one row and two episodes, so there is no row
			 * for the second — which is precisely why it reads as something no server here
			 * has ever reported. The gap detection was taught to expand the range; this is
			 * the same trap one layer along, and the symptom is the same sentence on the
			 * screen: an episode offered as news while it plays off the disk.
			 */
			it('says nothing new about the second half of a two-part file we hold', async () => {
				const { manager, fakes } = build();

				fakes.groups.groupChildren.mockImplementation((id: string) =>
					Promise.resolve(id === 'season-1'
						? {
							items: [{ ...episodeGroup(1, SyncState.IN_SYNC), episodeNumberEnd: 2 }],
							total: 0,
						}
						: { items: CHILDREN[id] ?? [], total: 0 }));
				fakes.indexer.search.mockResolvedValue([
					release({
						title: 'Spartacus.S01E02.1080p-GRP',
						episodeNumber: 2,
						coverage: { seasonNumber: 1, episodeNumbers: [2], wholeSeason: false, wholeSeries: false },
					}),
				]);

				const found = await manager.search({ itemId: 'series-1' });

				expect(trackerGroups(found)[0].brings).toEqual([]);
				// And no gap either, for the same reason: both halves are on the disk.
				expect(found.missing).toEqual([]);
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

		/*
		 * The same failure one field to the left, and it survived the fix above.
		 *
		 * The test beside this one sets `magnetUrl` to null, which is what a polite indexer
		 * does — and a real Prowlarr does not: it puts one of its own http links in the
		 * field called `magnetUrl`, because the name says what the link leads to rather
		 * than what it is. Trusting the name skipped the guard entirely and handed the
		 * client the very link the guard exists to resolve. Found by grabbing through the
		 * lab, where it came back as "the client accepted it and added no torrent".
		 */
		it('does not trust the magnet field to hold a magnet', async () => {
			const { manager, fakes } = build();

			global.fetch = jest.fn().mockResolvedValue({
				headers: new Headers({ location: 'magnet:?xt=urn:btih:behind-the-field' }),
			}) as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(
				release({
					magnetUrl: 'http://localhost:9696/1/download?apikey=k&link=abc',
					downloadUrl: 'http://localhost:9696/1/download?apikey=k&link=abc',
				}),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ magnetUrl: 'magnet:?xt=urn:btih:behind-the-field' }),
			);
		});

		it('passes a real magnet straight through without asking anybody', async () => {
			const { manager, fakes } = build();
			const fetched = jest.fn();

			global.fetch = fetched as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(release({ magnetUrl: 'magnet:?xt=urn:btih:already' }));

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fetched).not.toHaveBeenCalled();
			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ magnetUrl: 'magnet:?xt=urn:btih:already' }),
			);
		});

		/*
		 * The other half of the same trap, and the one that reached production.
		 *
		 * Half the private trackers serve a `.torrent` rather than a magnet. The link to it
		 * is built from the `Host` the gateway asked on, so a client in its own container
		 * resolves `localhost:9696` to itself: it fetches nothing, adds nothing, answers no
		 * error, and the refusal surfaces two layers away as "the client took something and
		 * produced no torrent". Reproduced in the lab with an indexer that offers no
		 * magnet, which is exactly what it looked like.
		 */
		it('fetches the torrent itself when there is no magnet, rather than sending a link', async () => {
			const { manager, fakes } = build();
			const bytes = new Uint8Array([0x64, 0x38, 0x3a]);

			global.fetch = jest.fn(async () => ({
				ok: true,
				headers: new Headers(),
				arrayBuffer: async () => bytes.buffer,
			})) as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(
				release({ magnetUrl: null, downloadUrl: 'http://localhost:9696/1/download?apikey=k' }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ torrentFile: bytes, magnetUrl: null }),
			);
		});

		it('fetches nothing when a magnet was already found', async () => {
			const { manager, fakes } = build();
			const fetched = jest.fn();

			global.fetch = fetched as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(release({ magnetUrl: 'magnet:?xt=urn:btih:one' }));

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fetched).not.toHaveBeenCalled();
			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ torrentFile: null }),
			);
		});

		it('still hands the link over when the bytes cannot be fetched', async () => {
			// A tracker the client can reach is a case that works, and refusing here would
			// break it for the sake of a fetch this gateway happened to fail.
			const { manager, fakes } = build();

			global.fetch = jest.fn(async () => ({ ok: false, headers: new Headers() })) as unknown as typeof fetch;
			fakes.cache.get.mockResolvedValue(
				release({ magnetUrl: null, downloadUrl: 'http://tracker.example/one.torrent' }),
			);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					torrentFile: null,
					downloadUrl: 'http://tracker.example/one.torrent',
				}),
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

			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toMatchObject({
				response: { key: ErrorKey.DOWNLOAD_PATH_UNREADABLE },
			});
		});

		it('refuses before a byte moves when a mapped local root cannot be read', async () => {
			const { manager, fakes } = build();

			fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

			/*
			 * The path is named, because the refusal is otherwise unactionable.
			 *
			 * It reads as being about the download client while what cannot be read is the
			 * folder *this gateway* was told the client's downloads appear at — so somebody
			 * goes and looks at a client where everything is fine.
			 */
			await expect(manager.grab({ releaseId: 'release-1', itemId: 'ep-2' })).rejects.toMatchObject({
				response: {
					key: ErrorKey.DOWNLOAD_PATH_UNREADABLE,
					detail: expect.stringContaining('/share/torrents'),
				},
			});
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
			// Nobody is asked anything when somebody has already said it.
			expect(fakes.client.defaultSavePath).not.toHaveBeenCalled();
		});

		/*
		 * Where the client writes, asked of the client.
		 *
		 * A root mapping translates between two spellings of a directory; it does not say
		 * that either end is writable. Handing its remote side over as the folder to write
		 * into is what told a production client to write into `/home/elewendyl`, which it
		 * answered `Permission denied` to — the torrent sat in `error` at zero bytes while
		 * every screen reported a download in progress.
		 */
		it('asks the client where it writes when nobody has configured a path', async () => {
			const { manager, fakes } = build();

			fakes.client.defaultSavePath.mockResolvedValue('/downloads/complete');

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ savePath: '/downloads/complete' }),
			);
		});

		it('sends no path at all for a client that will not say where it writes', async () => {
			/*
			 * It used to send the first root mapping's remote root, and that cost six
			 * gigabytes.
			 *
			 * `defaultSavePath` answers null for every failure — a login that hiccupped, a
			 * timeout, a client busy for a second — so one flaky call decided where files
			 * were written. On the household that reported it the mapping root is `/share`,
			 * which is the media root, and the client runs on another machine where
			 * `/share` is a different disk: the film landed at `/share/<release>.mkv` on an
			 * SD card and the gateway read nothing there. Two grabs an hour apart on the
			 * same gateway and the same client, one right and one wrong.
			 *
			 * An empty path is "you decide", and an older build with no preferences route
			 * still takes the download: it writes where it is configured to, which is a
			 * folder it chose and we cannot get wrong.
			 */
			const { manager, fakes } = build();

			fakes.client.defaultSavePath.mockResolvedValue(null);

			await manager.grab({ releaseId: 'release-1', itemId: 'ep-2' });

			expect(fakes.client.grab).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ savePath: '' }),
			);
		});
	});

	describe('retry', () => {
		/*
		 * The gesture that did not exist, from the gateway that needed it: a root mapping
		 * named a folder the client could not write, every grab failed, and once the mapping
		 * was corrected there was nothing to press. The torrents were still in the client,
		 * most of them finished.
		 */
		it('re-opens a failed download so the next poll carries on from the client', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.FAILED, error: 'the client reports error', clientId: 'hash-1' });

			fakes.grabs.findOne.mockResolvedValue(row);

			const view = await manager.retry('grab-1');

			expect(view.state).toBe(GrabState.DOWNLOADING);
			// The reason goes with it: keeping it would leave the row explaining a failure
			// that is no longer the row's state.
			expect(row.error).toBeNull();
			expect(fakes.grabs.save).toHaveBeenCalledWith(row);
		});

		it('takes back one the client had lost, which is the other half of the same repair', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.CANCELLED, clientId: 'hash-1' });

			fakes.grabs.findOne.mockResolvedValue(row);

			expect((await manager.retry('grab-1')).state).toBe(GrabState.DOWNLOADING);
		});

		it('refuses one that is still running, which is already doing what a retry would ask', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(grab({ state: GrabState.DOWNLOADING }));

			await expect(manager.retry('grab-1')).rejects.toThrow(ErrorKey.GRAB_NOT_RETRYABLE);
		});

		it('refuses one the client never took, because there is nothing to resume', async () => {
			// It failed before the download existed. What that needs is a new grab, and
			// saying so is better than re-opening a row nothing will ever move.
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(grab({ state: GrabState.FAILED, clientId: null }));

			await expect(manager.retry('grab-1')).rejects.toMatchObject({
				response: { key: ErrorKey.GRAB_NOT_RETRYABLE },
			});
		});

		it('says so when there is no such download', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(null);

			await expect(manager.retry('grab-1')).rejects.toThrow(ErrorKey.GRAB_NOT_FOUND);
		});
	});

	describe('pausing and archiving a download', () => {
		/*
		 * The other half of a queue. Somebody wanting their line back for an evening had to
		 * open the download client's own interface and find the torrent there, which is the
		 * errand this screen exists to spare them.
		 */
		it('stops a running download and keeps watching it', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING, clientId: 'hash-1' });

			fakes.grabs.findOne.mockResolvedValue(row);

			expect((await manager.pause('grab-1')).state).toBe(GrabState.PAUSED);
			expect(fakes.client.pause).toHaveBeenCalledWith(SETTINGS.downloadClient, 'hash-1');
		});

		it('lets a stopped one go again', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.PAUSED, clientId: 'hash-1' });

			fakes.grabs.findOne.mockResolvedValue(row);

			expect((await manager.resume('grab-1')).state).toBe(GrabState.DOWNLOADING);
			expect(fakes.client.start).toHaveBeenCalledWith(SETTINGS.downloadClient, 'hash-1');
		});

		it('refuses to stop one that is already filed', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(grab({ state: GrabState.PLACED, clientId: 'hash-1' }));

			await expect(manager.pause('grab-1')).rejects.toThrow(ErrorKey.GRAB_NOT_RETRYABLE);
			expect(fakes.client.pause).not.toHaveBeenCalled();
		});

		it('writes the state here as well as asking the client', async () => {
			// The client is polled every five seconds, and a button that does nothing
			// visible for five seconds is a button people press twice.
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING, clientId: 'hash-1' });

			fakes.grabs.findOne.mockResolvedValue(row);

			await manager.pause('grab-1');

			expect(fakes.grabs.save).toHaveBeenCalledWith(row);
			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.RELEASE_GRAB,
				expect.objectContaining({ state: GrabState.PAUSED }),
			);
		});

		it('takes a row off the queue and leaves the torrent alone', async () => {
			// The row and nothing else: the torrent stays in the client, seeding or stopped
			// as it was, and a file already filed stays in its library.
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(grab({ state: GrabState.FAILED }));

			await manager.archive('grab-1');

			expect(fakes.grabs.delete).toHaveBeenCalledWith({ id: 'grab-1' });
			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.RELEASE_GRAB_REMOVED,
				{ id: 'grab-1' },
			);
		});

		it('says so when there is no such download to archive', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findOne.mockResolvedValue(null);

			await expect(manager.archive('grab-1')).rejects.toThrow(ErrorKey.GRAB_NOT_FOUND);
		});
	});

	describe('where a download says it is going, before it gets there', () => {
		/*
		 * The screen somebody actually reads while a torrent runs, and it had no test at
		 * all — which is how it drifted from the placement it claims to predict.
		 *
		 * Three repairs of the placement looked like no repair whatever, because the
		 * prediction called the same chain without the one input the rule reads: it
		 * answered the category's folder for hours while the placement would have answered
		 * the show's. The gateway promising one destination and then quietly using another
		 * is indistinguishable, from outside, from a gateway that is simply wrong.
		 */
		it('runs the chain with the copy we already hold, like the placement does', async () => {
			const { manager, fakes } = build();

			await manager.plannedFolderFor('ep-3', null);

			expect(fakes.placement.resolve).toHaveBeenCalledWith(
				expect.objectContaining({ existingPath: '/media/shows/S01E02.mkv' }),
			);
		});

		it('imitates the folders that library already uses, like the placement does', async () => {
			// `Saison 1` where that is what it says, rather than promising a `Season 01`
			// the placement was never going to create.
			const { manager, fakes } = build();

			await manager.plannedFolderFor('ep-3', null);

			const request = fakes.placement.resolve.mock.calls[0][0] as {
				relativeName: (root: string) => string;
			};

			request.relativeName('/media/shows');

			expect(fakes.naming.render).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ siblingPath: '/media/shows/S01E02.mkv' }),
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

	/*
	 * The names a search order has to be written with.
	 *
	 * Typed by hand they are a guess, and a wrong guess is silent: `Generation-Free` for
	 * `Generation-Free (API)` matches nothing, orders nothing, and no screen says so. The
	 * list is suggestions and never a closed set — a tracker this gateway has not seen is
	 * still one somebody may prefer.
	 */
	describe('naming the trackers', () => {
		it('asks the configured indexer what it reaches', async () => {
			const { manager, fakes } = build();

			await expect(manager.trackers()).resolves.toEqual(['YGG', 'Sharewood']);
			expect(fakes.indexer.trackers).toHaveBeenCalled();
		});

		it('answers none when nothing is configured, rather than refusing', async () => {
			const { manager, fakes } = build();

			fakes.settings.get.mockResolvedValue(settingsWith({ indexer: null }));

			await expect(manager.trackers()).resolves.toEqual([]);
		});

		it('answers none when the indexer will not say', async () => {
			// A settings screen that would not open because a tracker list could not be
			// fetched is worse than one offering no suggestions.
			const { manager, fakes } = build();

			fakes.indexer.trackers.mockRejectedValue(new Error('down'));

			await expect(manager.trackers()).resolves.toEqual([]);
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

		/*
		 * By hash, and our category alongside it.
		 *
		 * A torrent this gateway adopted — one the client already held when it was grabbed —
		 * carries the category its owner gave it, and a poll that asked only about ours
		 * never saw it: the row stayed on `sent` while the download it was following
		 * finished, and nothing was filed. The hashes are ours either way, so nobody else's
		 * torrent can be reported on.
		 */
		it('asks about the rows it is following, by name', async () => {
			const { manager, fakes } = build();

			fakes.grabs.findLive.mockResolvedValue([grab({ state: GrabState.DOWNLOADING })]);

			await manager.poll();

			expect(fakes.client.statuses).toHaveBeenCalledWith(
				SETTINGS.downloadClient,
				'media-center-sync',
				['hash-1'],
			);
		});

		it('asks nothing when no live row has been given an identifier yet', async () => {
			// Asking with an empty list is how "tell me about nothing" becomes "tell me
			// about every torrent you have", which is somebody else's downloads.
			const { manager, fakes } = build();

			fakes.grabs.findLive.mockResolvedValue([grab({ state: GrabState.SENT, clientId: null })]);

			await manager.poll();

			expect(fakes.client.statuses).not.toHaveBeenCalled();
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

		/*
		 * A download the client has given up on, which used to be invisible.
		 *
		 * The row said `downloading` at zero bytes for as long as anybody cared to look,
		 * because the client's state word was read for the log and never for a decision —
		 * so the one gateway where it mattered had a torrent qBittorrent could not write and
		 * a screen reporting a download in progress. The client's own reason is what is
		 * recorded, because it is the only account of why.
		 */
		it('fails a download the client gave up on, with the reason the client gave', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING });

			fakes.grabs.findLive.mockResolvedValue([row]);
			fakes.client.statuses.mockResolvedValue([
				status({
					bytesDone: 0,
					failed: true,
					state: 'error',
					failedReason: 'the client reports error for this torrent, writing into /home/elewendyl',
				}),
			]);

			await manager.poll();

			expect(row.state).toBe(GrabState.FAILED);
			expect(row.error).toContain('/home/elewendyl');
			expect(fakes.grabs.save).toHaveBeenCalledWith(row);
		});

		it('says so on its own when the client gives no reason', async () => {
			const { manager, fakes } = build();
			const row = grab({ state: GrabState.DOWNLOADING });

			fakes.grabs.findLive.mockResolvedValue([row]);
			fakes.client.statuses.mockResolvedValue([status({ failed: true, state: 'missingFiles', failedReason: null })]);

			await manager.poll();

			expect(row.state).toBe(GrabState.FAILED);
			expect(row.error).toContain('missingFiles');
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

			it('keeps the size of every file it chose', async () => {
				/*
				 * The moment the client lists them is the only one at which anything knows
				 * how big a file nobody has downloaded yet is, and the queue needs a total
				 * from the first byte rather than at the end. See `GrabPlacement.bytes`.
				 */
				const { manager, fakes } = build();
				const row = partial();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status()]);
				fakes.client.files.mockResolvedValue([
					{ index: 3, name: 'Spartacus.S02/Spartacus.S02E02.1080p-GRP.mkv', size: 1_200, priority: 1 },
					{ index: 7, name: 'Spartacus.S02/Spartacus.S02E04.1080p-GRP.mkv', size: 1_300, priority: 1 },
				]);

				await manager.poll();

				expect((row.placements ?? []).map((one) => one.bytes)).toEqual([1_200, 1_300]);
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
			// The file name as a client really spells it: relative to the directory
			// everything lands in, so a multi-file torrent names its own folder first. A
			// bare `episode.mkv` beside a folder content path is a shape qBittorrent does
			// not produce, and a fixture that used one made the wrong resolution pass.
			const fetched = (): GrabEntity => grab({
				state: GrabState.DOWNLOADING,
				placements: [
					placement({ fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/episode.mkv' }),
				],
			});

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
						destination: '/media/shows/Spartacus/Season 01/Spartacus - S01E02.mkv',
						keepSource: true,
					}),
				);
				expect(row.state).toBe(GrabState.PLACED);
				expect(row.targetPath).toBe('/media/shows/Spartacus/Season 01/Spartacus - S01E02.mkv');
				expect(row.error).toBeNull();
				// Nobody asked for a link, so the client keeps a real file.
				expect(fakes.mover.move).toHaveBeenCalledWith(
					expect.objectContaining({ linkSource: false }),
				);
			});

			it('takes the folder pinned on the season over the one pinned on the series',
				async () => {
					/*
					 * The owner's report, in his words: *pas de prise en compte de la
					 * correction*. He corrected the destination on the season four page,
					 * pressed download, and the file went where it was going before.
					 *
					 * The correction dialog writes the field on the row it was opened for — a
					 * season as readily as a series — and this read the top of the tree and
					 * nowhere else. So the one control that exists to answer "where does this
					 * go" wrote an answer nothing ever read.
					 */
					const { manager, fakes } = build();
					const row = fetched();

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.items.ancestry.mockResolvedValue([
						item({ id: 'ep-2', kind: MediaKind.EPISODE, parentId: 'season-1', seasonNumber: 1 }),
						item({
							id: 'season-1',
							kind: MediaKind.SEASON,
							parentId: 'series-1',
							seasonNumber: 1,
							overrides: { targetFolder: '/share/SeriesTV/Spartacus/Saison 01' },
						}),
						item({ id: 'series-1', overrides: { targetFolder: '/elsewhere/Spartacus' } }),
					]);

					await manager.poll();

					expect(fakes.placement.resolve).toHaveBeenCalledWith(expect.objectContaining({
						pinnedPath: '/share/SeriesTV/Spartacus/Saison 01',
					}));
				});

			it('puts the season being filed into a pin that names a season', async () => {
				/*
				 * The other half of the same report: *il allait la poser dans
				 * `/share/SeriesTV/From/Saison 01`* for a season four release. A pin naming a
				 * season — which is exactly what the dialog pre-fills while somebody corrects
				 * a season one placement — was used verbatim for every later season, silently
				 * and for ever, because nothing about that is an error.
				 */
				const { manager, fakes } = build();
				const row = grab({
					state: GrabState.DOWNLOADING,
					placements: [
						placement({
							fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/Spartacus.S02E01.1080p-GRP.mkv',
						}),
					],
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.items.ancestry.mockResolvedValue([
					item({ id: 'ep-2', kind: MediaKind.EPISODE, parentId: 'season-1', seasonNumber: 1 }),
					item({ id: 'season-1', kind: MediaKind.SEASON, parentId: 'series-1', seasonNumber: 1 }),
					item({ id: 'series-1', overrides: { targetFolder: '/share/SeriesTV/Spartacus/Saison 01' } }),
				]);

				await manager.poll();

				// The season comes off the *file*, which is the only thing that knows which
				// one arrived — see `_nameableOf`.
				expect(fakes.placement.resolve).toHaveBeenCalledWith(expect.objectContaining({
					pinnedPath: '/share/SeriesTV/Spartacus/Saison 02',
				}));
			});

			/**
			 * A pack taken as a whole release, which is ten episodes and was one file.
			 *
			 * The owner pressed download on a twelve-gigabyte pack of a season and one
			 * episode was filed — *il a déplacé qu'un fichier alors que j'ai toute une
			 * saison* — with the row saying `placed` and nothing anywhere disagreeing. A
			 * partial grab has its files named by `_choose` before it starts; a whole
			 * release names nothing, and the largest file was taken to be the answer.
			 */
			describe('a pack nobody named the files of', () => {
				const pack = (): GrabEntity => grab({
					itemId: 'season-1',
					title: 'Spartacus.S01.MULTi.1080p.WEB-GRP',
					state: GrabState.DOWNLOADING,
					placements: [],
				});

				const under = (...names: { name: string; size: number }[]) =>
					names.map((one) => ({
						path: `/share/torrents/Spartacus.S01.MULTi.1080p.WEB-GRP/${one.name}`,
						size: one.size,
					}));

				it('files every episode it holds, each as its own', async () => {
					const { manager, fakes } = build();
					const row = pack();

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.filesystem.filesUnder.mockResolvedValue(under(
						{ name: 'Spartacus.S01E02.1080p-GRP.mkv', size: 1_000 },
						{ name: 'Spartacus.S01E03.1080p-GRP.mkv', size: 1_100 },
					));

					await manager.poll();

					expect(fakes.mover.move).toHaveBeenCalledTimes(2);
					// Each against its own episode row, so the landing is announced about the
					// media it fills and the gap closes.
					expect((row.placements ?? []).map((one) => [one.itemId, one.episodeNumber]))
						.toEqual([['ep-2', 2], ['ep-3', 3]]);
					expect(row.state).toBe(GrabState.PLACED);
				});

				it('counts the whole pack before copying any of it', async () => {
					/*
					 * Reported from the queue: `7,6 GB / 7,8 GB` on a thirty-nine gigabyte
					 * season for the whole of the copy, the total climbing a file at a time
					 * — *a chaque fichier transferer il refait le total pendant la copie*.
					 * It was everything already filed plus the file being copied, so the bar
					 * never advanced and the time remaining was worthless.
					 */
					const { manager, fakes } = build();
					const row = pack();
					const seen: { done: number; total: number }[] = [];

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.filesystem.filesUnder.mockResolvedValue(under(
						{ name: 'Spartacus.S01E02.1080p-GRP.mkv', size: 1_000 },
						{ name: 'Spartacus.S01E03.1080p-GRP.mkv', size: 1_100 },
					));
					fakes.mover.move.mockImplementation(
						(order: {
							onProgress?: (progress: {
								bytesDone: number;
								bytesTotal: number;
								rate: number;
							}) => void;
						}) => {
							order.onProgress?.({ bytesDone: 500, bytesTotal: 1_000, rate: 7 });
							seen.push({ done: Number(row.bytesDone), total: Number(row.bytesTotal) });

							return Promise.resolve(undefined);
						},
					);

					await manager.poll();

					// Both files from the first progress report, and the same number for the
					// second: what is done climbs, what it is out of does not.
					expect(seen).toEqual([
						{ done: 500, total: 2_100 },
						{ done: 1_000, total: 2_100 },
					]);
				});

				it('keeps the largest of two files claiming one episode', async () => {
					/*
					 * Which is how a sample loses. Only a coordinate is believed here — a
					 * sample is `sample.mkv` and a screenshot is `proof.jpg`, and neither says
					 * `S01E02` — but a sample that does carry the tag is answered by its size.
					 */
					const { manager, fakes } = build();
					const row = pack();

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.filesystem.filesUnder.mockResolvedValue(under(
						{ name: 'Spartacus.S01E02.1080p-GRP.sample.mkv', size: 10 },
						{ name: 'Spartacus.S01E02.1080p-GRP.mkv', size: 1_000 },
						{ name: 'Spartacus.S01E03.1080p-GRP.mkv', size: 1_100 },
					));

					await manager.poll();

					expect(fakes.mover.move).toHaveBeenCalledTimes(2);
					expect(fakes.mover.move).toHaveBeenCalledWith(expect.objectContaining({
						source: '/share/torrents/Spartacus.S01.MULTi.1080p.WEB-GRP/Spartacus.S01E02.1080p-GRP.mkv',
					}));
				});

				it('leaves the proof and the nfo where they are', async () => {
					// Nothing without a coordinate is filed. An extension list would be wrong
					// on somebody's library, which is why none is kept anywhere here.
					const { manager, fakes } = build();
					const row = pack();

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.filesystem.filesUnder.mockResolvedValue(under(
						{ name: 'Spartacus.S01E02.1080p-GRP.mkv', size: 1_000 },
						{ name: 'Spartacus.S01E03.1080p-GRP.mkv', size: 1_100 },
						{ name: 'proof.jpg', size: 5 },
						{ name: 'release.nfo', size: 1 },
					));

					await manager.poll();

					expect(fakes.mover.move).toHaveBeenCalledTimes(2);
				});

				it('still takes the largest file when the names say nothing', async () => {
					/*
					 * The behaviour this had, and the right answer for "this release for this
					 * episode": a torrent of one film in a folder with a sample beside it.
					 */
					const { manager, fakes } = build();
					const row = grab({ state: GrabState.DOWNLOADING, placements: [] });

					fakes.grabs.findLive.mockResolvedValue([row]);
					fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
					fakes.filesystem.filesUnder.mockResolvedValue(under(
						{ name: 'episode.mkv', size: 1_000 },
						{ name: 'sample.mkv', size: 10 },
					));

					await manager.poll();

					expect(fakes.mover.move).toHaveBeenCalledTimes(1);
					expect(fakes.filesystem.largestFileUnder).toHaveBeenCalled();
				});
			});

			it('asks for a link in the torrent’s place when the client is set to', async () => {
				/*
				 * The copy is deliberate — a file moved out from under a seeding client is
				 * somebody's ratio — and its cost is the same film on the disk twice, for as
				 * long as they keep seeding. A link in its place settles both: the client
				 * reads straight through it and the bytes exist once. Off unless asked for,
				 * because it only works where the client can reach the library.
				 */
				const { manager, fakes } = build();
				const row = fetched();

				fakes.settings.get.mockResolvedValue(
					settingsWith({
						downloadClient: { ...SETTINGS.downloadClient, linkSourceAfterCopy: true },
					}),
				);
				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.mover.move).toHaveBeenCalledWith(
					expect.objectContaining({
						source: '/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/episode.mkv',
						// Still a copy: the link replaces the original only once the copy is
						// verified and in place. See `FileMoveService._link`.
						keepSource: true,
						linkSource: true,
					}),
				);
				expect(row.state).toBe(GrabState.PLACED);
			});

			/*
			 * A pack taken for more than one episode is more than one copy.
			 *
			 * This filed the largest file and stopped, which is right for "this release for
			 * this episode" and silently wrong for everything the coverage plan does: three
			 * episodes under one info hash arrived, one was filed, two sat in the download
			 * folder for ever, and the row said `placed`. The copy that happened succeeded,
			 * so nothing anywhere reported the two that did not.
			 */
			it('files every episode the pack was taken for, not just the biggest file', async () => {
				const { manager, fakes } = build();
				const row = grab({
					state: GrabState.DOWNLOADING,
					partial: true,
					placements: [
						placement({ fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/two.mkv' }),
						placement({
							itemId: 'ep-3',
							episodeNumber: 3,
							title: 'Legends',
							fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/three.mkv',
						}),
					],
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.mover.move).toHaveBeenCalledTimes(2);
				expect(fakes.mover.move.mock.calls.map(([order]) => order.source)).toEqual([
					'/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/two.mkv',
					'/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP/three.mkv',
				]);
				// Each against its own episode's row, or three files would be filed under
				// the show's own name three times over.
				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({ kind: MediaKind.EPISODE }),
				);
				// And the folder is named after the *show*. Left to the episode's own title,
				// three episodes of one season land in three folders called Dulcinea, The
				// Big Empty and Remember the Cant — the same mistake a sync made once with
				// one show in four folders.
				const [nameable] = namedBy(
					fakes.naming.render,
					fakes.placement.resolve.mock.calls[0]?.[0] as { relativeName: (root: string) => string },
				);

				expect(nameable.seriesTitle).toBe('Spartacus');
				expect(nameable.title).toBe('The Thing in the Pit');
				// And the row says where each one went, which is what the screen reads.
				expect((row.placements ?? []).map((one) => one.targetPath)).toEqual([
					'/media/shows/Spartacus/Season 01/Spartacus - S01E02.mkv',
					'/media/shows/Spartacus/Season 01/Spartacus - S01E02.mkv',
				]);
				expect(row.state).toBe(GrabState.PLACED);
				expect(row.error).toBeNull();
				// Still a copy: the torrent is seeding and a file moved out from under a
				// client is somebody's ratio.
				expect(fakes.mover.move.mock.calls.every(([order]) => order.keepSource)).toBe(true);
			});

			it('asks for a link on every file of a pack, not just the first', async () => {
				// Each episode of a pack is its own file and its own copy, so the saving is
				// per file: honouring the setting once would leave the rest of the season
				// on the disk twice.
				const { manager, fakes } = build();
				const row = grab({
					state: GrabState.DOWNLOADING,
					partial: true,
					placements: [
						placement({ fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/two.mkv' }),
						placement({
							itemId: 'ep-3',
							episodeNumber: 3,
							title: 'Legends',
							fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/three.mkv',
						}),
					],
				});

				fakes.settings.get.mockResolvedValue(
					settingsWith({
						downloadClient: { ...SETTINGS.downloadClient, linkSourceAfterCopy: true },
					}),
				);
				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.mover.move).toHaveBeenCalledTimes(2);
				expect(fakes.mover.move.mock.calls.every(([order]) => order.linkSource)).toBe(true);
			});

			it('says which episodes it could not find, and keeps the ones it filed', async () => {
				const { manager, fakes } = build();
				const row = grab({
					state: GrabState.DOWNLOADING,
					partial: true,
					placements: [
						placement({ fileName: 'Spartacus.S01E02.1080p.WEB-DL-GRP/two.mkv' }),
						placement({ itemId: 'ep-3', episodeNumber: 3, title: 'Legends', fileName: null }),
					],
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				// A season one file short is worth having; saying nothing about the one is
				// what leaves somebody waiting for it.
				expect(fakes.mover.move).toHaveBeenCalledTimes(1);
				expect(row.state).toBe(GrabState.PLACED);
				expect(row.error).toContain('Legends');
			});

			it('refuses a file name that would climb out of the download folder', async () => {
				const { manager, fakes } = build();
				const row = grab({
					state: GrabState.DOWNLOADING,
					partial: true,
					placements: [
						placement({ fileName: '../../etc/passwd' }),
						placement({ itemId: 'ep-3', episodeNumber: 3, title: 'Legends', fileName: '../../elsewhere.mkv' }),
					],
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				// The name is the download client's string, and a client is not a thing to
				// take paths from on trust.
				expect(fakes.mover.move).not.toHaveBeenCalled();
				expect(row.state).toBe(GrabState.FAILED);
			});

			it('sends a chosen folder as a pin, above every rule', async () => {
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING, targetFolder: '/media/anime/Spartacus', targetLibraryId: 'lib-anime' });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				/*
				 * A pin rather than a rewritten strategy, and that is the whole fix.
				 *
				 * Said through `settings.placement = fixed_path`, the folder was consulted
				 * *after* the library the same dialog had chosen one line above: the library
				 * answered first, the file landed in its root, and the folder somebody typed
				 * was never reached. `pinnedPath` is a decision about one thing and outranks
				 * every rule, the chosen library included.
				 */
				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({
						preferredLibraryId: 'lib-anime',
						pinnedPath: '/media/anime/Spartacus',
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
				// A whole-release grab, where nobody named a file: the largest one under the
				// download is the answer, and a download with no file in it has none. A grab
				// that *did* name its files fails for a different reason and says which ones
				// — see above.
				const row = grab({ state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(null);

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(row.error).toContain('nothing playable');
				expect(fakes.mover.move).not.toHaveBeenCalled();
			});

			it('files the bytes from a declared root when the reported path is gone', async () => {
				/*
				 * The owner's failure, and the fix for "que ça ne se reproduise pas". Three
				 * gigabytes complete, `Échec`, and `nothing playable under
				 * /share/Spider.Man…mkv` — because he had moved the folder and the client's
				 * root mappings still named the old one. The bytes were never the problem.
				 *
				 * By exact name under a root the settings already declare, and nothing else:
				 * a guess would file the wrong film under the right name, which is worse than
				 * the failure it replaces.
				 */
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING });
				const gone = '/share/torrents/Spartacus.S01E02.1080p.WEB-DL-GRP';
				const found = '/share/downloads/Spartacus.S01E02.1080p.WEB-DL-GRP';

				fakes.settings.get.mockResolvedValue(settingsWith({
					downloadClient: {
						...SETTINGS.downloadClient,
						rootMappings: [{ remoteRoot: '/downloads', localRoot: '/share/downloads' }],
					},
				}));
				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				// Only the place somebody declared answers; the client's own spelling does not.
				fakes.filesystem.rights.mockImplementation((path: string) =>
					Promise.resolve({ readable: !path.startsWith(gone), writable: true }));
				fakes.filesystem.largestFileUnder.mockImplementation((path: string) =>
					Promise.resolve(path.startsWith(gone) ? null : `${path}/episode.mkv`));

				await manager.poll();

				expect(row.state).toBe(GrabState.PLACED);
				expect(fakes.mover.move).toHaveBeenCalledWith(expect.objectContaining({
					source: `${found}/episode.mkv`,
				}));
			});

			it('refuses a name that would reach outside the declared root', async () => {
				// The name is a client's string, and a `..` in it would reach outside the
				// root somebody declared — the one thing a recovery must not do.
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING });

				fakes.settings.get.mockResolvedValue(settingsWith({
					downloadClient: {
						...SETTINGS.downloadClient,
						rootMappings: [{ remoteRoot: '/downloads', localRoot: '/share/downloads' }],
					},
				}));
				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([
					status({ complete: true, contentPath: '/downloads/../../etc/passwd' }),
				]);
				fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(fakes.mover.move).not.toHaveBeenCalled();
			});

			it('says the same path can be two directories on two machines', async () => {
				/*
				 * The report that cost three gigabytes, and the sentence that would have
				 * ended it in a minute.
				 *
				 * His client runs on a seedbox and the gateway on the NAS. Both call the
				 * folder `/share`, and they are not the same folder: on the seedbox it is
				 * the local card, on the NAS its own tree, and only some subdirectories of
				 * each are the shared mounts. So the gateway was handed a path it could read
				 * the *name* of and told to find files that were on another machine.
				 *
				 * No mapping can detect that — both ends are valid strings and each resolves
				 * on its own host — so the only honest place for it is here, in the sentence
				 * somebody reads when it has already happened.
				 */
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(null);
				fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

				await manager.poll();

				expect(row.error).toContain('two different directories');
				expect(row.error).toContain('the same files there');
			});

			it('names the mapping when it cannot read the path the client reported', async () => {
				/*
				 * The owner's failure, and the message it used to carry was
				 * `nothing playable under /share/Spider.Man…mkv` — true, and unusable. The
				 * bytes were complete and safe with the client; what was wrong was the
				 * translation between where the client writes and where this gateway reaches
				 * the same disk, after he moved the folder.
				 *
				 * Two very different faults wore one sentence: a path this gateway cannot
				 * reach at all, and a path it reads fine that holds no video. The first is a
				 * setting on another screen and the second is a bad release.
				 */
				const { manager, fakes } = build();
				const row = grab({ state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(null);
				fakes.filesystem.rights.mockResolvedValue({ readable: false, writable: false });

				await manager.poll();

				expect(row.state).toBe(GrabState.FAILED);
				expect(row.error).toContain('root mappings');
				// And the one thing somebody reaches for that they do not need.
				expect(row.error).toContain('nothing is re-fetched');
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

			/*
			 * The half of a grab that did not exist: telling the media server.
			 *
			 * A torrent carries no poster beside it, so the artwork can only come from the
			 * media server identifying the file — and it cannot identify a file nobody told
			 * it about. Until this, a placed torrent sat in the library unindexed until
			 * whatever schedule the server keeps came round, with no metadata and no poster,
			 * while our own screens went on calling the media missing.
			 */
			it('tells the media server a file has arrived', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.landings.recordFile).toHaveBeenCalledWith(expect.objectContaining({
					itemId: 'ep-2',
					libraryId: 'lib-shows',
					path: '/media/shows/Spartacus/Season 01/Spartacus - S01E02.mkv',
					// No transfer behind it, which is the whole difference from a pull.
					transferId: null,
				}));
			});

			it('still reports the placement when the media server cannot be told', async () => {
				// The bytes are in the library and the row says so. A server that will not
				// answer is a thing to log, not a reason to report a placement as a failure.
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.landings.recordFile.mockRejectedValue(new Error('jellyfin is down'));

				await manager.poll();

				expect(row.state).toBe(GrabState.PLACED);
			});

			/*
			 * The download somebody starts from a show's page, which is most of them.
			 *
			 * The episode being grabbed is usually the one nothing here reports yet — a
			 * running show puts out an episode no server knows about — so there is no
			 * episode row to grab it against and the series is the only thing there is to
			 * press. The row is then a series, a series is not something that can be filed,
			 * and the copy landed at the **library root** named after the release:
			 * `/share/SeriesTV5/Stuart.Fails.to.Save.the.Universe.S01E10.…mkv` sitting
			 * beside the show's own folder, which no media server groups into anything.
			 *
			 * The name knows what the row does not.
			 */
			it('files a download grabbed from a series under the show, reading the name', async () => {
				const { manager, fakes } = build();
				const row = grab({
					itemId: 'series-1',
					state: GrabState.DOWNLOADING,
					sourcePath: '/share/torrents/Spartacus.S01E07.1080p.WEB-DL-GRP',
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(
					'/share/torrents/Spartacus.S01E07.1080p.WEB-DL-GRP/Spartacus.S01E07.1080p.WEB-DL-GRP.mkv',
				);

				await manager.poll();

				expect(fakes.naming.render).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						// An episode, which is the only kind the naming service builds
						// folders for: a series answers nothing and lands flat.
						kind: MediaKind.EPISODE,
						seasonNumber: 1,
						episodeNumber: 7,
						seriesTitle: 'Spartacus',
					}),
					expect.anything(),
				);
			});

			/*
			 * The episode page, which is where somebody actually presses download.
			 *
			 * The walk used to read the children of the row it was handed: right for a
			 * series and for a season, and silently wrong for an episode, which has none.
			 * So a download started from an episode found no copy of its show, was held to
			 * no library, imitated no folders, and landed wherever the category pointed —
			 * beside nothing.
			 */
			it('finds the show copy from an episode, not only from a series', async () => {
				const { manager, fakes } = build();
				const row = grab({ itemId: 'ep-3', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();

				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({ existingPath: '/media/shows/S01E02.mkv' }),
				);
			});

			/*
			 * And when the grabbed row's own tree cannot answer at all.
			 *
			 * Two shapes of the same report, both seen on the owner's gateway. A library
			 * organised as `SeriesTV/DC Comics/Séries TV/<show>` is read by a media server
			 * as one series with every show beneath it as a season, so the episodes hang
			 * from a row that is not that show. And a grab started from a page the request
			 * source supplied climbs a tree made entirely of that source's rows, not one of
			 * which carries a file — the ordinary case for an episode nothing holds yet.
			 *
			 * Neither is a special case any more. The grouping says which rows are the same
			 * media, the placement asks it, and the copy is wherever that answer points.
			 */
			it('takes the folder from the season above, which is where the others are', async () => {
				/*
				 * The owner's rule, in his words: take the folder of the season above, full
				 * stop — everything else applies only when he pins a folder or holds
				 * nothing locally. Reported several times, because the lookup kept failing
				 * in a new way while the rule itself was never in doubt.
				 *
				 * The grouping is asked about every step of the row's own ancestry and not
				 * only the top of it: two libraries can be joined at the episode, at the
				 * season or at the series, and which one they agreed on is not something
				 * this code can assume. Here they are joined at the season, which is the
				 * shape a request source produces.
				 */
				const { manager, fakes } = build();
				const row = grab({ itemId: 'ep-3', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				const localSeason = item({ id: 'local-season', kind: MediaKind.SEASON, libraryId: 'lib-shows' });
				const world = fakes.items.findOne.getMockImplementation() as
					(request: { where: { id: string } }) => Promise<unknown>;

				fakes.items.findOne.mockImplementation((request: { where: { id: string } }) =>
					request.where.id === 'local-season' ? Promise.resolve(localSeason) : world(request));
				// Nothing joined at the series, and nothing held under the grabbed row.
				fakes.items.findChildren.mockImplementation((id: string) =>
					Promise.resolve(id === 'local-season' ? [
						item({
							id: 'local-episode',
							libraryId: 'lib-shows',
							file: { path: '/media/shows/DC Comics/Series TV/Spartacus/Saison 1/S01E01.mkv', size: 1 },
						}),
					] : []));
				fakes.groups.group.mockImplementation((id: string) => Promise.resolve(
					id === 'season-1'
						? { id, sources: [{ itemId: 'local-season', local: true }] }
						: { id, sources: [] },
				));

				await manager.poll();

				expect(fakes.placement.resolve).toHaveBeenCalledWith(expect.objectContaining({
					existingPath: '/media/shows/DC Comics/Series TV/Spartacus/Saison 1/S01E01.mkv',
				}));
			});

			it('reads the season off the file rather than off the row that was pressed', async () => {
				/*
				 * The series is the one thing a grab always knows; the season and the
				 * episode are properties of the file, and the file says so in its name. A
				 * release named `S02E09` is season two whatever page somebody started from,
				 * which is also what makes a season pack and a whole-series pack file
				 * themselves correctly — each of their files answers for itself.
				 */
				const { manager, fakes } = build();
				const row = grab({ itemId: 'ep-3', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(
					'/share/torrents/Spartacus.S02E09/Spartacus.S02E09.1080p.WEB-DL-GRP.mkv',
				);

				await manager.poll();

				expect(fakes.naming.render).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({ seasonNumber: 2, episodeNumber: 9 }),
					expect.anything(),
				);
			});

			it('files beside the copy the grouping names, wherever that row hangs', async () => {
				const { manager, fakes } = build();
				const row = grab({ itemId: 'ep-3', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				// Nothing under the grabbed row's own tree, which is what both shapes look
				// like from here.
				fakes.items.findChildren.mockImplementation((id: string) =>
					Promise.resolve(id === 'stray' ? [
						item({
							id: 'stray-episode',
							libraryId: 'lib-shows',
							file: { path: '/media/shows/DC Comics/Series TV/Spartacus/S01E01.mkv', size: 1 },
						}),
					] : []));
				fakes.groups.group.mockResolvedValue({
					id: 'series-1',
					sources: [{ itemId: 'stray', local: true }],
				});
				// The stray row on top of the world the other tests share, never instead of
				// it: `findOne` also answers for the row that was grabbed.
				const stray = item({ id: 'stray', kind: MediaKind.SEASON, libraryId: 'lib-shows' });
				const world = fakes.items.findOne.getMockImplementation() as
					(request: { where: { id: string } }) => Promise<unknown>;

				fakes.items.findOne.mockImplementation((request: { where: { id: string } }) =>
					request.where.id === 'stray' ? Promise.resolve(stray) : world(request));

				await manager.poll();

				expect(fakes.placement.resolve).toHaveBeenCalledWith(expect.objectContaining({
					existingPath: '/media/shows/DC Comics/Series TV/Spartacus/S01E01.mkv',
				}));
			});

			it('ignores a copy this gateway only reaches over HTTP', async () => {
				// A friend's server holds a real copy and none of its paths mean anything
				// here. Filing an episode beside one would write into a folder that does
				// not exist on this disk.
				const { manager, fakes } = build();
				const row = grab({ itemId: 'ep-3', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.groups.group.mockResolvedValue({
					id: 'series-1',
					sources: [{ itemId: 'series-1', local: false }],
				});

				await manager.poll();

				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({ existingPath: null }),
				);
			});

			it('imitates the folders this library already uses, which a grab never did', async () => {
				// Without a sibling a torrent lands in `Season 01` beside the `Saison 1`
				// folders a library has used for years — one show in two folders, which no
				// media server shows as one. A pull from a peer has always passed this.
				const { manager, fakes } = build();
				const row = grab({ itemId: 'series-1', state: GrabState.DOWNLOADING });

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue(
					'/share/torrents/Spartacus.S01E07/Spartacus.S01E07.1080p.WEB-DL-GRP.mkv',
				);

				await manager.poll();

				expect(fakes.naming.render).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ siblingPath: '/media/shows/S01E02.mkv' }),
				);
			});

			it('leaves a name that spells out nothing exactly as it was', async () => {
				// A file at the library root is bad; a file filed under a guess is worse.
				const { manager, fakes } = build();
				const row = grab({
					itemId: 'series-1',
					state: GrabState.DOWNLOADING,
					sourcePath: '/share/torrents/whatever',
				});

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.filesystem.largestFileUnder.mockResolvedValue('/share/torrents/whatever/file.mkv');

				await manager.poll();

				expect(fakes.naming.render).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({ kind: MediaKind.SERIES }),
					expect.anything(),
				);
			});

			/*
			 * Two passes must never file one download.
			 *
			 * The timer fires every five seconds and a placement takes as long as copying
			 * tens of gigabytes takes, so the passes piled up behind it each found the same
			 * torrent complete and started **the same copy again**: half a dozen writers on
			 * one destination file, a progress bar reporting whichever of them answered
			 * last — three hundred megabytes, then one hundred — and a file shorter than its
			 * source at the end of it. The size check refusing that copy is the only reason
			 * any of it was ever noticed.
			 */
			it('never copies one download twice, however many passes overlap', async () => {
				const { manager, fakes } = build();
				const row = fetched();
				const finished: { resolve: () => void } = { resolve: () => undefined };

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				// A copy that does not finish until this test says so, which is what a
				// twenty-gigabyte season is to a five-second timer.
				fakes.mover.move.mockImplementation(() => new Promise<void>((resolve) => {
					finished.resolve = resolve;
				}));

				const first = manager.poll();

				// Let the first pass get as far as the copy, which is several awaits in.
				await new Promise((resolve) => setImmediate(resolve));

				await manager.poll();
				await manager.poll();

				expect(fakes.mover.move).toHaveBeenCalledTimes(1);

				finished.resolve();
				await first;
			});

			it('files it on a later pass once the first one has finished', async () => {
				// The guard is about overlapping, not about refusing: a row still on
				// `fetched` after a restart is exactly what the next pass is for.
				const { manager, fakes } = build();

				fakes.grabs.findLive.mockResolvedValue([fetched()]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);

				await manager.poll();
				await manager.poll();

				expect(fakes.mover.move).toHaveBeenCalledTimes(2);
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

			/*
			 * The reason as somebody reading the row will understand it.
			 *
			 * `String(error)` on a Nest exception yields its class name twice: a row read
			 * `ConflictException: Conflict Exception`, which names neither what was refused
			 * nor by whom, and the cause had to be reproduced in a lab to be learnt. The key
			 * and the detail were in the payload the whole time.
			 */
			it('records the key and the detail of a failure that carries them', async () => {
				const { manager, fakes } = build();
				const row = fetched();

				fakes.grabs.findLive.mockResolvedValue([row]);
				fakes.client.statuses.mockResolvedValue([status({ complete: true })]);
				fakes.mover.move.mockRejectedValue(new ConflictException({
					key: ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
					detail: '/share/torrents is not under any library',
				}));

				await manager.poll();

				expect(row.error).toBe(`${ErrorKey.LIBRARY_PATH_NOT_WRITABLE} (/share/torrents is not under any library)`);
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
