import {
	ErrorKey,
	MatchStrategy,
	MediaKind,
	DEFAULT_RELEASE_PREFERENCES,
	NamingScheme,
	NotificationEvent,
	PlacedBy,
	PlacementStrategy,
	SpaceVerdict,
	SyncJobItemState,
	SyncJobState,
	SyncState,
	SyncStopReason,
	SyncTrigger,
	TransferState,
	TransferTransport,
	type MediaFileInfo,
	type Settings,
	ShareVisibility,
} from '@mcs/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FindManyOptions, FindOptionsWhere } from 'typeorm';
import type { MediaItem, MediaService, SyncJob, SyncJobItem, SyncPlan, Transfer } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	SyncJobItemRepository,
	SyncJobRepository,
	SyncPlanRepository,
	TransferRepository,
} from '@/repositories';
import type {
	EventGatewayService,
	MetadataService,
	NamingService,
	PlacementService,
	SchedulerService,
	SettingsService,
	TransferEngineService,
} from '@/services';
import { QualityService } from '@/services';
import type { LibraryManager } from './library.manager';
import type { NotificationManager } from './notification.manager';
import { jobItemStateOf, SyncManager } from './sync.manager';

const SETTINGS: Settings = {
	defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS,
	placement: PlacementStrategy.BESIDE_EXISTING,
	fixedPath: null,
	categoryTargets: {},
	defaultTargetLibraryId: null,
	namingOrder: [NamingScheme.SOURCE, NamingScheme.STANDARD],
	pullMetadata: false,
	writeNfo: false,
	preferSourceMetadata: false,
	maxParallelTransfers: 3,
	diskReserveBytes: 1_000_000,
	maxConnectionsPerSource: 4,
	chunkSize: 8 * 1024 * 1024,
	downloadRateLimit: 0,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	peerMaxDepth: 1,
	keepDiscoveredPeers: false,
	relayForPeers: false,
	allowSwarm: true,
	instanceName: null,
	publicUrl: null,
	defaultTargetPath: null,
	releasePreferences: DEFAULT_RELEASE_PREFERENCES,
	indexer: null,
	downloadClient: null,
	requestSource: null,
	transferHistoryDays: 30,
	failedHistoryDays: 180,
	refreshIntervalMinutes: 15,
	fullScanCron: null,
	cacheTtlSeconds: 60,
	dismissedLibraryHints: [],
};

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/source/S01E03.mkv',
	size: 2_000_000,
	container: 'mkv',
	videoCodec: 'hevc',
	audioCodec: 'eac3',
	width: 1920,
	height: 1080,
	durationMs: 1_200_000,
	bitrate: 8_000_000,
	quickHash: null,
	contentId: null,
	checksum: null,
	...overrides,
});

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item-fast',
		serviceId: 'service-fast',
		libraryId: 'library-1',
		externalId: 'ext-1',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'The Trap',
		normalizedTitle: 'big buck bunny',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 3,
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

const service = (id: string, priority: number, overrides: Partial<MediaService> = {}): MediaService =>
	({
		id,
		name: id,
		baseUrl: `http://${id}:8096`,
		priority,
		peerId: null,
		token: 'secret',
		username: null,
		password: null,
		...overrides,
	}) as MediaService;

/** `In([...])` hands the manager a find operator; the fakes read its values back. */
const valuesOf = (candidate: unknown): string[] => {
	if (typeof candidate === 'string') {
		return [candidate];
	}

	const operator = candidate as { value?: unknown } | undefined;

	return Array.isArray(operator?.value) ? (operator.value as string[]) : [];
};

interface World {
	manager: SyncManager;
	items: MediaItem[];
	services: MediaService[];
	fakes: {
		placement: { resolve: jest.Mock; prepare: jest.Mock };
		transfers: { save: jest.Mock; create: jest.Mock; findByJob: jest.Mock };
		jobs: {
			save: jest.Mock;
			create: jest.Mock;
			findLiveForPlan: jest.Mock;
			findOne: jest.Mock;
			pageOf: jest.Mock;
		};
		plans: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; setRunStamps: jest.Mock };
		lines: {
			save: jest.Mock;
			create: jest.Mock;
			findPage: jest.Mock;
			skipUnfinished: jest.Mock;
			findLine: jest.Mock;
			progressOf: jest.Mock;
		};
		libraryManager: {
			librariesOfCategory: jest.Mock;
			categoryKeysByLibrary: jest.Mock;
			placementLibraries: jest.Mock;
			probe: jest.Mock;
		};
		engine: { enqueue: jest.Mock; cancel: jest.Mock; setSourceResolver: jest.Mock; onTransferState: jest.Mock };
		metadata: {
			discover: jest.Mock;
			apply: jest.Mock;
			mergeExternalIds: jest.Mock;
			writeNfo: jest.Mock;
		};
		events: { emit: jest.Mock };
		naming: { render: jest.Mock };
		services: { findWithSecrets: jest.Mock };
		scheduler: { registerPlans: jest.Mock; onPlan: jest.Mock; unregisterPlan: jest.Mock; nextRunAt: jest.Mock };
		notifications: { notify: jest.Mock };
	};
}

const build = (
	world: {
		items?: MediaItem[];
		services?: MediaService[];
		matches?: unknown[];
		settings?: Partial<Settings>;
		plans?: SyncPlan[];
		localServices?: MediaService[];
		categoryLibraries?: string[];
		/** The shelves a placement may choose between. Empty unless a test needs them. */
		placementLibraries?: unknown[];
		/** Library identifier to category key, as the library manager answers it. */
		categoryKeys?: Record<string, string>;
		/** Every library, as the path translation of a local sibling reads them. */
		libraries?: unknown[];
	} = {},
): World => {
	const items = world.items ?? [
		item(),
		item({ id: 'item-slow', serviceId: 'service-slow', externalId: 'ext-2' }),
	];
	const services = world.services ?? [service('service-fast', 1), service('service-slow', 2)];
	const matches = world.matches ?? [];

	const itemRepository = {
		/**
		 * Every constraint the query carries, not the first one recognised.
		 *
		 * A scope is an intersection — a category and a subtree together mean the part
		 * of that subtree in that category — so a fake that answered on `serviceId` and
		 * ignored the `libraryId` beside it would let a broken intersection pass.
		 */
		find: jest.fn((options?: FindManyOptions<MediaItem>) => {
			const where = (options?.where ?? {}) as FindOptionsWhere<MediaItem>;
			const matching = (candidate: MediaItem): boolean => {
				if (where.id !== undefined && !valuesOf(where.id).includes(candidate.id)) {
					return false;
				}

				if (
					where.parentId !== undefined &&
					!valuesOf(where.parentId).includes(candidate.parentId ?? '')
				) {
					return false;
				}

				if (
					where.serviceId !== undefined &&
					!valuesOf(where.serviceId).includes(candidate.serviceId)
				) {
					return false;
				}

				return (
					where.libraryId === undefined ||
					valuesOf(where.libraryId).includes(candidate.libraryId)
				);
			};

			return Promise.resolve(items.filter(matching));
		}),
		findOne: jest.fn((options: { where: { id: string } }) =>
			Promise.resolve(items.find((candidate) => candidate.id === options.where.id) ?? null),
		),
		save: jest.fn((value: MediaItem) => Promise.resolve(value)),
	};

	const fakes: World['fakes'] = {
		placement: {
			// The real service renders the name once it has picked a root, because the
			// gateway files a pulled episode where that library already files the
			// others. A fake that treated the factory as a string would let a caller
			// pass one and never notice.
			resolve: jest.fn(
				({ relativeName }: { relativeName: string | ((root: string) => string) }) =>
					Promise.resolve({
						libraryId: 'library-local',
						libraryName: 'Shows',
						// The root, not just the library: a library is several directories, so
						// the lot a run pins carries the one its first file went into.
						root: '/media/shows',
						directory: '/media/shows',
						path: `/media/shows/${
							typeof relativeName === 'function' ? relativeName('/media/shows') : relativeName
						}`,
						strategy: PlacementStrategy.BESIDE_EXISTING,
						fallback: false,
						reason: null,
					}),
			),
			prepare: jest.fn().mockResolvedValue(undefined),
		},
		transfers: {
			save: jest.fn((value: Transfer) => Promise.resolve(value)),
			create: jest.fn((value: Partial<Transfer>) => value as Transfer),
			findByJob: jest.fn().mockResolvedValue([]),
		},
		jobs: {
			save: jest.fn((value: SyncJob) =>
				Promise.resolve({
					...value,
					id: 'job-1',
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
				} as SyncJob),
			),
			create: jest.fn((value: Partial<SyncJob>) => value as SyncJob),
			findLiveForPlan: jest.fn().mockResolvedValue(null),
			findOne: jest.fn().mockResolvedValue(null),
			pageOf: jest.fn().mockResolvedValue([[], 0]),
		},
		plans: {
			find: jest.fn().mockResolvedValue(world.plans ?? []),
			findOne: jest.fn().mockResolvedValue(null),
			save: jest.fn((value: SyncPlan) =>
				Promise.resolve({
					...value,
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					updatedAt: new Date('2026-01-01T00:00:00.000Z'),
				} as SyncPlan),
			),
			setRunStamps: jest.fn().mockResolvedValue(undefined),
		},
		lines: {
			save: jest.fn((value: unknown) => Promise.resolve(value)),
			create: jest.fn((value: Partial<SyncJobItem>) => value as SyncJobItem),
			findPage: jest.fn().mockResolvedValue([[], 0]),
			skipUnfinished: jest.fn().mockResolvedValue(undefined),
			findLine: jest.fn().mockResolvedValue(null),
			progressOf: jest.fn().mockResolvedValue({ done: 0, failed: 0, bytesDone: 0, open: 0 }),
		},
		libraryManager: {
			librariesOfCategory: jest.fn().mockResolvedValue(world.categoryLibraries ?? []),
			categoryKeysByLibrary: jest
				.fn()
				.mockResolvedValue(new Map(Object.entries(world.categoryKeys ?? {}))),
			// Empty unless a test says otherwise, which is what the repository fake behind
			// the old private helper answered too: the placement itself is stubbed, and a
			// list of shelves here would be a fixture nothing reads.
			placementLibraries: jest.fn().mockResolvedValue(world.placementLibraries ?? []),
			// Room to spare unless a test says otherwise: the space verdict has its own
			// table-driven suite, and every other test here would otherwise be asserting
			// about a disk it never meant to mention.
			probe: jest.fn().mockResolvedValue({
				exists: true,
				readable: true,
				writable: true,
				freeBytes: 1_000_000_000_000,
				error: null,
			}),
		},
		engine: {
			enqueue: jest.fn().mockResolvedValue(undefined),
			cancel: jest.fn().mockResolvedValue(undefined),
			setSourceResolver: jest.fn(),
			onTransferState: jest.fn(),
		},
		metadata: {
			discover: jest.fn().mockResolvedValue([]),
			apply: jest.fn().mockResolvedValue({ copied: [], kept: [], failed: [] }),
			mergeExternalIds: jest.fn(() => ({})),
			// Nothing written unless a test says otherwise, which is what the real one
			// answers when `writeNfo` is off.
			writeNfo: jest.fn().mockResolvedValue(null),
		},
		events: { emit: jest.fn() },
		naming: { render: jest.fn(() => 'Show/S01E03.mkv') },
		scheduler: {
			registerPlans: jest.fn(),
			onPlan: jest.fn(),
			unregisterPlan: jest.fn(),
			nextRunAt: jest.fn(() => null),
		},
		services: {
			findWithSecrets: jest.fn((id: string) =>
				Promise.resolve(services.find((candidate) => candidate.id === id) ?? null),
			),
		},
		notifications: { notify: jest.fn().mockResolvedValue(undefined) },
	};

	const manager = new SyncManager(
		{
			...fakes.plans,
			create: jest.fn((value: Partial<SyncPlan>) => ({ id: 'plan-1', ...value }) as SyncPlan),
		} as unknown as SyncPlanRepository,
		fakes.jobs as unknown as SyncJobRepository,
		fakes.lines as unknown as SyncJobItemRepository,
		itemRepository as unknown as MediaItemRepository,
		{
			find: jest.fn().mockResolvedValue(matches),
			findForLocalItem: jest.fn().mockResolvedValue(matches),
		} as unknown as MediaMatchRepository,
		{
			find: jest.fn().mockResolvedValue(services),
			findByPriority: jest.fn().mockResolvedValue([...services].sort((a, b) => a.priority - b.priority)),
			findLocal: jest.fn().mockResolvedValue(world.localServices ?? []),
			findWithSecrets: fakes.services.findWithSecrets,
			findOne: jest.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve({
					id: where.id,
					peerId: where.id === 'service-peer' ? 'peer-1' : null,
					filesMounted: where.id === 'service-fast',
				}),
			),
		} as unknown as MediaServiceRepository,
		{
			find: jest.fn().mockResolvedValue(world.libraries ?? []),
			findByServices: jest.fn().mockResolvedValue([]),
			// Answered by identifier, so a library on a friend's server really is a
			// different answer here: `library-theirs` sits on `service-peer`, which the
			// service fake below reports as a peer's.
			findOne: jest.fn(({ where }: { where: { id: string } }) => {
				if (where.id === 'library-ghost') {
					return Promise.resolve(null);
				}

				return Promise.resolve({
					id: where.id,
					serviceId: where.id === 'library-theirs' ? 'service-peer' : 'service-fast',
					localPath: where.id === 'library-unmapped' ? null : '/media/anime',
				});
			}),
		} as unknown as LibraryRepository,
		fakes.libraryManager as unknown as LibraryManager,
		fakes.transfers as unknown as TransferRepository,
		{
			get: jest.fn().mockResolvedValue({ ...SETTINGS, ...world.settings }),
		} as unknown as SettingsService,
		fakes.naming as unknown as NamingService,
		// Asked for one label and whether two copies are different cuts — see the
		// constructor. The label's real bands are pinned down in the quality service's
		// own suite; the cut is the real rule, because a fake one would let the planner
		// and the correlation disagree about what a different cut is.
		{
			resolutionLabel: () => '1080p',
			isConflicting: (left: MediaFileInfo | null, right: MediaFileInfo | null) =>
				new QualityService().isConflicting(left, right),
		} as unknown as QualityService,
		fakes.metadata as unknown as MetadataService,
		fakes.placement as unknown as PlacementService,
		fakes.engine as unknown as TransferEngineService,
		fakes.scheduler as unknown as SchedulerService,
		fakes.events as unknown as EventGatewayService,
		fakes.notifications as unknown as NotificationManager,
		{ getOrThrow: () => ({ root: '/media', transferRoot: '/var/transfer' }) } as unknown as ConfigService,
	);

	return { manager, items, services, fakes };
};

describe('SyncManager', () => {
	describe('resolving sources', () => {
		it('follows the plan’s ordered list', async () => {
			const { manager } = build();

			const planning = await manager.plan({ sourceServiceIds: ['service-slow', 'service-fast'] });

			expect(planning.items).toHaveLength(1);
			expect(planning.items[0].sourceServiceId).toBe('service-slow');
		});

		it('follows the configured service priority when the list is empty', async () => {
			const { manager } = build();

			const planning = await manager.plan({ sourceServiceIds: [] });

			expect(planning.items[0].sourceServiceId).toBe('service-fast');
		});

		it('plans one transfer for one episode held by two services', async () => {
			const { manager } = build();

			const planning = await manager.plan({});

			expect(planning.itemsPlanned).toBe(1);
		});

		/**
		 * Two versions of one film are two transfers, and one file is one.
		 *
		 * The grouping used to be the title alone, so a theatrical cut and an extended
		 * one — same title, same year, same identifier — collapsed into a single planned
		 * item and whichever the service order put first was fetched, with the run
		 * reporting that the media had been dealt with.
		 */
		it('plans one transfer per version when two services hold different files', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'item-theatrical',
						serviceId: 'service-fast',
						file: file({ contentId: 'q1-theatrical', path: '/source/Titanic.mkv' }),
					}),
					item({
						id: 'item-extended',
						serviceId: 'service-slow',
						externalId: 'ext-2',
						file: file({ contentId: 'q1-extended', path: '/source/Titanic.Extended.mkv' }),
					}),
				],
			});

			const planning = await manager.plan({
				sourceServiceIds: ['service-fast', 'service-slow'],
			});

			expect(planning.items.map((planned) => planned.itemId).sort()).toEqual([
				'item-extended',
				'item-theatrical',
			]);
			expect(planning.estimate.itemCount).toBe(2);
		});

		it('still plans one transfer for one file two services both hold', async () => {
			// The case that must not break: the same bytes on two servers is one thing to
			// pull, and splitting on the row would download it twice into one path.
			const { manager } = build({
				items: [
					item({ id: 'item-fast', file: file({ contentId: 'q1-same' }) }),
					item({
						id: 'item-slow',
						serviceId: 'service-slow',
						externalId: 'ext-2',
						file: file({ contentId: 'q1-same' }),
					}),
				],
			});

			expect((await manager.plan({})).itemsPlanned).toBe(1);
		});

		it('refuses to plan when no service is registered at all', async () => {
			const { manager } = build({ services: [] });

			await expect(manager.plan({})).rejects.toThrow(ErrorKey.SYNC_NO_SOURCE);
		});
	});

	describe('preview and run', () => {
		it('preview is exactly what run will do', async () => {
			const { manager, fakes } = build();

			const preview = await manager.preview({});

			await manager.run({});

			const created = fakes.transfers.create.mock.calls.map(
				(call) => call[0] as Partial<Transfer>,
			);

			expect(created).toHaveLength(preview.items.length);
			expect(created[0].itemId).toBe(preview.items[0].itemId);
			expect(created[0].targetPath).toBe(preview.items[0].targetPath);
			expect(Number(created[0].bytesTotal)).toBe(preview.items[0].bytes);
		});

		it('preview writes nothing', async () => {
			const { manager, fakes } = build();

			await manager.preview({});

			expect(fakes.transfers.save).not.toHaveBeenCalled();
			expect(fakes.jobs.save).not.toHaveBeenCalled();
			expect(fakes.engine.enqueue).not.toHaveBeenCalled();
		});

		it('queues every transfer it created', async () => {
			const { manager, fakes } = build();

			await manager.run({});

			expect(fakes.engine.enqueue).toHaveBeenCalledTimes(1);
		});

		it('writes the pieces beside the database, never into the library', async () => {
			const { manager, fakes } = build();

			await manager.run({});

			const created = fakes.transfers.create.mock.calls[0][0] as Partial<Transfer>;

			expect(created.workPath).toMatch(/^\/var\/transfer\/.+\.part$/);
			expect(created.targetPath).toBe('/media/shows/Show/S01E03.mkv');
		});

		it('finishes a run that has nothing to do instead of leaving it open', async () => {
			const { manager, fakes } = build({ items: [] });

			const job = await manager.run({});

			expect(job.itemsPlanned).toBe(0);
			expect(job.state).toBe('done');
			expect(fakes.engine.enqueue).not.toHaveBeenCalled();
		});
	});

	describe('placement', () => {
		it('refuses rather than guessing when nothing is writable', async () => {
			const { manager, fakes } = build();

			fakes.placement.resolve.mockRejectedValue(
				new ConflictException({ key: ErrorKey.LIBRARY_PATH_NOT_WRITABLE }),
			);

			await expect(manager.preview({})).rejects.toThrow(ConflictException);
		});

		it('offers the plan’s target library to the placement service', async () => {
			const { manager, fakes } = build();

			await manager.preview({ targetLibraryId: 'library-chosen' });

			expect(fakes.placement.resolve).toHaveBeenCalledWith(
				expect.objectContaining({ preferredLibraryId: 'library-chosen' }),
			);
		});

		/**
		 * A preference on the plan, and what a run does with it.
		 *
		 * The decision this pins down: the destination lives on the plan and every run
		 * of that plan uses it, because a run is one execution of a standing intent —
		 * a library attached to a single run is a choice with nowhere to live
		 * afterwards, and the next run would quietly go back to the old shelf with
		 * nothing connecting the two.
		 */
		describe('a plan that prefers a library', () => {
			const preferring = (manager: SyncManager): void => {
				const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

				plans.findOne.mockResolvedValue({
					id: 'plan-1',
					scope: {},
					filter: {},
					sourceServiceIds: [],
					preferredLibraryId: 'library-anime',
					maxItemsPerRun: null,
					maxBytesPerRun: null,
				} as unknown as SyncPlan);
			};

			it('is what its runs place with, without anybody naming it again', async () => {
				const { manager, fakes } = build();

				preferring(manager);

				await manager.preview({ planId: 'plan-1' });

				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({
						preferredLibraryId: 'library-anime',
						preferredBy: PlacedBy.PLAN_PREFERENCE,
					}),
				);
			});

			it('is recorded as the plan’s and not as something a run asked for', async () => {
				const { manager, fakes } = build();

				preferring(manager);
				fakes.placement.resolve.mockResolvedValue({
					libraryId: 'library-anime',
					libraryName: 'Animes',
					directory: '/media/anime/Show',
					path: '/media/anime/Show/S01E03.mkv',
					strategy: PlacementStrategy.DEFAULT_LIBRARY,
					fallback: false,
					reason: null,
					placedBy: PlacedBy.PLAN_PREFERENCE,
				});

				const planning = await manager.plan({ planId: 'plan-1' });

				expect(planning.items[0].placedBy).toBe(PlacedBy.PLAN_PREFERENCE);
			});

			it('gives way to a library this one run named instead', async () => {
				const { manager, fakes } = build();

				preferring(manager);

				await manager.preview({ planId: 'plan-1', targetLibraryId: 'library-films' });

				// A one-off, and recorded as one: somebody reading the run next month must
				// not be sent to edit a plan whose preference had nothing to do with it.
				expect(fakes.placement.resolve).toHaveBeenCalledWith(
					expect.objectContaining({
						preferredLibraryId: 'library-films',
						preferredBy: PlacedBy.REQUESTED,
					}),
				);
			});
		});

		it('asks for room for the file, so a full disk is refused before it is written to', async () => {
			const { manager, fakes } = build();

			await manager.preview({});

			expect(fakes.placement.resolve).toHaveBeenCalledWith(
				expect.objectContaining({ requiredBytes: 2_000_000 }),
			);
		});
	});

	/**
	 * A download is a lot, and a run may carry several of them.
	 *
	 * What somebody pressed download on is one film, one series, one season or one
	 * episode, and every file under it belongs in one place. Resolving each file on its
	 * own let the chain answer differently halfway down a season — a disk that filled, a
	 * sibling found for one episode and not the next — and the season ended up split
	 * across two libraries, which no media server shows as one series.
	 *
	 * Both halves are pinned down here: files reached through one root share a lot, and
	 * roots named beside each other do not, because three shows asked for at once are
	 * three downloads and not one.
	 */
	describe('a download as one lot', () => {
		const episode = (id: string, number: number, overrides: Partial<MediaItem> = {}): MediaItem =>
			item({
				id,
				externalId: `ext-${id}`,
				// Told apart on purpose: two rows that look like the same media collapse into
				// one planned item, and the test would then be asserting about a single lot
				// by accident.
				normalizedTitle: `the expanse ${number}`,
				episodeNumber: number,
				file: file({ path: `/source/S01E0${number}.mkv`, contentId: `q1-${id}` }),
				...overrides,
			});

		const oneSeries = (): MediaItem[] => [
			item({ id: 'series-1', kind: MediaKind.SERIES, title: 'The Expanse', file: null }),
			episode('episode-1', 1, { parentId: 'series-1' }),
			episode('episode-2', 2, { parentId: 'series-1' }),
		];

		/** One folder per episode, so a drifting root is visible in the path itself. */
		const naming = (world: World): void => {
			world.fakes.naming.render.mockImplementation(
				(_order: unknown, nameable: { episodeNumber: number | null }) =>
					`The Expanse/S01E0${nameable.episodeNumber}.mkv`,
			);
		};

		interface FakeRequest {
			pinned: { root: string } | null;
			relativeName: string | ((root: string) => string);
		}

		const landing = (root: string, request: FakeRequest) => ({
			libraryId: root === '/media/shows' ? 'library-local' : 'library-anime',
			libraryName: root === '/media/shows' ? 'Shows' : 'Animes',
			root,
			directory: root,
			path: `${root}/${
				typeof request.relativeName === 'function'
					? request.relativeName(root)
					: request.relativeName
			}`,
			strategy: PlacementStrategy.DEFAULT_LIBRARY,
			fallback: false,
			reason: null,
			placedBy: PlacedBy.DEFAULT_LIBRARY,
		});

		/**
		 * A chain that answers a different shelf every time it is asked to decide.
		 *
		 * Which is what the real one does under any of a dozen ordinary conditions. A
		 * pinned item is honoured, exactly as the placement service honours it, so what
		 * this asserts is whether the manager hands the first answer down.
		 */
		const drifting = (world: World, shelves: string[]): void => {
			let decided = 0;

			world.fakes.placement.resolve.mockImplementation((request: FakeRequest) => {
				if (request.pinned) {
					return Promise.resolve(landing(request.pinned.root, request));
				}

				const shelf = shelves[Math.min(decided, shelves.length - 1)];

				decided += 1;

				return Promise.resolve(landing(shelf, request));
			});
		};

		/**
		 * A shelf that takes the first file of a lot and then has no room left.
		 *
		 * The second shelf stays writable throughout, which is the whole situation: it is
		 * there, it would work, and a lot must refuse it rather than leave half a season
		 * on one disk and half on another.
		 */
		const fillsUp = (world: World, shelves: string[]): void => {
			let decided = 0;

			world.fakes.placement.resolve.mockImplementation((request: FakeRequest) => {
				if (request.pinned) {
					return Promise.reject(new ConflictException(ErrorKey.TRANSFER_NO_SPACE));
				}

				const shelf = shelves[Math.min(decided, shelves.length - 1)];

				decided += 1;

				return Promise.resolve(landing(shelf, request));
			});
		};

		it('is the series, for every episode reached through it', async () => {
			const { manager } = build({ items: oneSeries() });

			const planning = await manager.plan({ scope: { rootItemIds: ['series-1'] } });

			expect(planning.items.map((planned) => [planned.itemId, planned.lot])).toEqual([
				['episode-1', 'series-1'],
				['episode-2', 'series-1'],
			]);
		});

		/**
		 * The hole the scope left, and the case nobody presses a button for.
		 *
		 * A lot is the subtree somebody named — press fetch on a series and the series is
		 * the lot. A run naming no subtree at all, the nightly "everything missing", had
		 * no lots whatever: every episode decided for itself and a season could still
		 * land in two libraries. That is exactly the guarantee this mechanism exists to
		 * give, lost in the one case nobody asked for by hand.
		 */
		it('takes the show as the lot when the scope named no subtree', async () => {
			const { manager } = build({ items: oneSeries() });

			const planning = await manager.plan({});

			expect(planning.items.map((planned) => planned.lot)).toEqual([
				'series-1',
				'series-1',
			]);
		});

		it('is the item itself, when the scope named them one by one', async () => {
			const { manager } = build({ items: [episode('episode-1', 1), episode('episode-2', 2)] });

			const planning = await manager.plan({
				scope: { rootItemIds: ['episode-1', 'episode-2'] },
			});

			// Two downloads in one run, and that is what the plan has to be able to say.
			expect(planning.items.map((planned) => planned.lot)).toEqual([
				'episode-1',
				'episode-2',
			]);
		});

		it('sends the whole season where its first episode went', async () => {
			const world = build({ items: oneSeries() });

			naming(world);
			drifting(world, ['/media/shows', '/media/anime']);

			const planning = await world.manager.plan({ scope: { rootItemIds: ['series-1'] } });

			// The second episode never gets to decide, so `/media/anime` — which the chain
			// would have handed it — is not where it lands.
			expect(planning.items.map((planned) => planned.targetPath)).toEqual([
				'/media/shows/The Expanse/S01E01.mkv',
				'/media/shows/The Expanse/S01E02.mkv',
			]);
		});

		it('lets two episodes asked for separately decide separately', async () => {
			// The other half of the same rule, and the proof that the drift above is real:
			// nothing was pressed that makes these two one download, so nothing pins them
			// together.
			const world = build({ items: [episode('episode-1', 1), episode('episode-2', 2)] });

			naming(world);
			drifting(world, ['/media/shows', '/media/anime']);

			const planning = await world.manager.plan({
				scope: { rootItemIds: ['episode-1', 'episode-2'] },
			});

			expect(planning.items.map((planned) => planned.targetPath)).toEqual([
				'/media/shows/The Expanse/S01E01.mkv',
				'/media/anime/The Expanse/S01E02.mkv',
			]);
		});

		it('fails the lot rather than scattering its tail onto the shelf next door', async () => {
			/*
			 * The reason the destination is a pin and not a preference. A writable shelf is
			 * sitting right there and is deliberately not used: half a season in the library
			 * somebody chose and half in one they did not is worse than a refusal, because a
			 * refusal can be acted on and the split is discovered months later.
			 */
			const world = build({ items: oneSeries() });

			naming(world);
			fillsUp(world, ['/media/shows', '/media/anime']);

			await expect(
				world.manager.plan({ scope: { rootItemIds: ['series-1'] } }),
			).rejects.toThrow(ErrorKey.TRANSFER_NO_SPACE);
		});

		it('still places two separate downloads when one of the shelves fills up', async () => {
			// Same disk, same moment, and no refusal: neither of these is the tail of
			// anything, so each may take the shelf that can hold it.
			const world = build({ items: [episode('episode-1', 1), episode('episode-2', 2)] });

			naming(world);
			fillsUp(world, ['/media/shows', '/media/anime']);

			const planning = await world.manager.plan({
				scope: { rootItemIds: ['episode-1', 'episode-2'] },
			});

			expect(planning.items.map((planned) => planned.targetLibraryName)).toEqual([
				'Shows',
				'Animes',
			]);
		});

		it('gives an episode reached through two named roots a single lot', async () => {
			/*
			 * The series and one of its episodes, both named. Belonging to two lots would
			 * mean two destinations for one file, which is the outcome all of this exists to
			 * prevent — so the first root that reaches it owns it.
			 */
			const { manager } = build({ items: oneSeries() });

			const planning = await manager.plan({
				scope: { rootItemIds: ['series-1', 'episode-2'] },
			});

			expect(planning.items.map((planned) => planned.lot)).toEqual([
				'series-1',
				'series-1',
			]);
		});

		/**
		 * The lot has to outlive the plan, which is the whole reason it is a column.
		 *
		 * Everything that reads a lot reads it months later — the queue groups on it, and
		 * redirecting a season has to find the episodes an earlier run already landed. A
		 * lot that only existed while `plan()` ran left both of those deriving it again
		 * from `jobId`, which answers a different question: the same season pulled over
		 * three nights came out as three unrelated blocks.
		 */
		it('reaches the transfer row the run writes', async () => {
			const { manager, fakes } = build({ items: oneSeries() });

			await manager.run({ scope: { rootItemIds: ['series-1'] } });

			const rows = fakes.transfers.create.mock.calls.map(
				([row]: [Partial<Transfer>]) => row.lot,
			);

			expect(rows).toEqual(['series-1', 'series-1']);
		});

		it('writes the show as the lot on a run that named no subtree', async () => {
			// The nightly "everything missing" is the run nobody presses a button for, and
			// the one whose rows would otherwise carry no lot at all.
			const { manager, fakes } = build({ items: oneSeries() });

			await manager.run({});

			const rows = fakes.transfers.create.mock.calls.map(
				([row]: [Partial<Transfer>]) => row.lot,
			);

			expect(rows).toEqual(['series-1', 'series-1']);
		});
	});

	describe('filters', () => {
		it('drops a node that carries no file: a series is a folder, not a transfer', async () => {
			const { manager } = build({ items: [item({ kind: MediaKind.SERIES, file: null })] });

			await expect(manager.plan({})).resolves.toMatchObject({ itemsPlanned: 0 });
		});

		it('drops anything over the size ceiling', async () => {
			const { manager } = build();

			await expect(manager.plan({ filter: { maxBytes: 1_000 } })).resolves.toMatchObject({
				itemsPlanned: 0,
			});
		});

		it('keeps only the kinds asked for', async () => {
			const { manager } = build();

			await expect(
				manager.plan({ filter: { kinds: [MediaKind.MOVIE] } }),
			).resolves.toMatchObject({ itemsPlanned: 0 });
		});

		it('never replaces a copy we already hold unless it is told to', async () => {
			const world = {
				items: [item(), item({ id: 'item-local', serviceId: 'service-local', externalId: 'ours' })],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
			};

			await expect(build(world).manager.plan({})).resolves.toMatchObject({ itemsPlanned: 0 });
		});

		it('replaces it when the remote copy is better and the filter allows it', async () => {
			const world = {
				items: [
					item({ syncState: SyncState.OUTDATED }),
					item({ id: 'item-local', serviceId: 'service-local', externalId: 'ours' }),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
			};

			const planning = await build(world).manager.plan({ filter: { replaceOutdated: true } });

			expect(planning.itemsPlanned).toBe(1);
			expect(planning.items[0].localItemId).toBe('item-local');
			expect(planning.items[0].state).toBe(SyncState.OUTDATED);
		});

		it('fetches a copy somebody named although another is already here', async () => {
			/*
			 * The owner pressed fetch on a 4K copy of a film he held in 1080p and got a
			 * run that planned nothing, finished in no time and said nothing. The rule is
			 * right for a plan — one that re-fetched every film beside a copy of it would
			 * fill a disk every night — and wrong for a row somebody pointed at, where
			 * naming the copy is the decision.
			 *
			 * The state is left alone on purpose: this keeps both copies rather than
			 * replacing one, and the new file lands beside the old under a name
			 * `disambiguate` makes distinct.
			 */
			const world = {
				items: [
					item({ syncState: SyncState.IN_SYNC }),
					item({ id: 'item-local', serviceId: 'service-local', externalId: 'ours' }),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
			};

			const planning = await build(world).manager.plan({ filter: { includeHeld: true } });

			expect(planning.itemsPlanned).toBe(1);
			expect(planning.items[0].localItemId).toBe('item-local');
		});

		it('still leaves it alone when nobody said so', async () => {
			// The counterpart, and the reason the flag exists rather than the rule simply
			// going: an automatic run must go on treating "we already hold this" as
			// "leave it alone".
			const world = {
				items: [
					item({ syncState: SyncState.IN_SYNC }),
					item({ id: 'item-local', serviceId: 'service-local', externalId: 'ours' }),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
			};

			await expect(build(world).manager.plan({})).resolves.toMatchObject({ itemsPlanned: 0 });
		});

		it('keeps only what is missing when the filter says so', async () => {
			const world = {
				items: [
					item({ syncState: SyncState.OUTDATED }),
					item({ id: 'item-local', serviceId: 'service-local', externalId: 'ours' }),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
			};

			await expect(
				build(world).manager.plan({ filter: { replaceOutdated: true, missingOnly: true } }),
			).resolves.toMatchObject({ itemsPlanned: 0 });
		});
	});

	/**
	 * A theatrical cut on our disk and an extended one on a friend's server.
	 *
	 * Correlation puts the two together on their shared IMDb number and reads the pair
	 * as a conflict. Everything here is the other half of that bargain: being grouped
	 * must never make one cut stand in for the other.
	 */
	describe('two cuts of one film', () => {
		const theatrical = (overrides: Partial<MediaItem> = {}): MediaItem =>
			item({
				id: 'item-theatrical',
				serviceId: 'service-local',
				externalId: 'ours',
				kind: MediaKind.MOVIE,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'titanic',
				externalIds: { imdb: 'tt0120338' },
				syncState: SyncState.CONFLICT,
				file: file({
					path: '/media/films/Titanic (1997).mkv',
					contentId: 'q1-theatrical',
					durationMs: 11_640_000,
				}),
				...overrides,
			});
		const extended = (overrides: Partial<MediaItem> = {}): MediaItem =>
			item({
				id: 'item-extended',
				serviceId: 'service-fast',
				kind: MediaKind.MOVIE,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'titanic',
				externalIds: { imdb: 'tt0120338' },
				syncState: SyncState.CONFLICT,
				file: file({
					path: '/source/Titanic (1997) {edition-Extended}.mkv',
					contentId: 'q1-extended',
					durationMs: 12_540_000,
					height: 2160,
				}),
				...overrides,
			});
		const cutConflict = {
			localItemId: 'item-theatrical',
			remoteItemId: 'item-extended',
			strategy: MatchStrategy.EXTERNAL_ID,
			state: SyncState.CONFLICT,
		};
		const world = (overrides: Parameters<typeof build>[0] = {}): Parameters<typeof build>[0] => ({
			items: [theatrical(), extended()],
			services: [service('service-fast', 1), service('service-local', 3)],
			localServices: [service('service-local', 3)],
			matches: [cutConflict],
			...overrides,
		});

		it('fetches the extended cut when all we hold is the theatrical one', async () => {
			const { manager } = build(world());

			const planning = await manager.plan({ scope: { itemIds: ['item-extended'] } });

			expect(planning.items).toEqual([
				expect.objectContaining({
					itemId: 'item-extended',
					localItemId: null,
					state: SyncState.MISSING,
				}),
			]);
		});

		it('never writes one cut over the other, even when told to replace outdated copies', async () => {
			const { manager, fakes } = build(world());

			const planning = await manager.plan({ filter: { replaceOutdated: true } });

			expect(planning.items.map((planned) => planned.localItemId)).toEqual([null]);
			expect(fakes.placement.resolve).toHaveBeenCalledWith(
				expect.objectContaining({ replacesPath: null, existingPath: null }),
			);
		});

		it('does not count a cut nobody fingerprinted as holding the other', async () => {
			// No content identity on either side, so both fall into one bucket of the
			// planner's identity and only the running time tells them apart.
			const { manager } = build(
				world({
					items: [
						theatrical({ file: file({ contentId: null, durationMs: 11_640_000 }) }),
						extended({ file: file({ contentId: null, durationMs: 12_540_000 }) }),
					],
					matches: [],
				}),
			);

			const planning = await manager.plan({});

			expect(planning.items.map((planned) => planned.itemId)).toEqual(['item-extended']);
		});

		it('still counts the same bytes under two episode numbers as held', async () => {
			// The other kind of conflict: the content is proven identical and only the
			// label is disputed. Refusing it would fetch a file already on the disk.
			const { manager } = build({
				items: [
					item({ file: file({ contentId: 'q1-same' }) }),
					item({
						id: 'item-local',
						serviceId: 'service-local',
						externalId: 'ours',
						episodeNumber: 4,
						syncState: SyncState.CONFLICT,
						file: file({ contentId: 'q1-same' }),
					}),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [
					{
						localItemId: 'item-local',
						remoteItemId: 'item-fast',
						strategy: MatchStrategy.CHECKSUM,
						state: SyncState.CONFLICT,
					},
				],
			});

			await expect(manager.plan({})).resolves.toMatchObject({ itemsPlanned: 0 });
		});

		it('never takes ranges for one cut from a server holding the other', async () => {
			const { manager } = build(
				world({
					items: [extended(), theatrical({ serviceId: 'service-slow' })],
					services: [service('service-fast', 1), service('service-slow', 2)],
				}),
			);

			const sources = await manager.resolveSources({ itemId: 'item-extended' } as Transfer);

			expect(sources.map((source) => source.serviceId)).toEqual(['service-fast']);
		});

		it('never lays one cut\'s subtitles over the other', async () => {
			const { manager, fakes } = build(world());

			const [result] = await manager.pullCompanions(['item-theatrical']);

			expect(fakes.metadata.discover).not.toHaveBeenCalled();
			expect(result.error).toBe(ErrorKey.SYNC_NO_SOURCE);
		});
	});

	describe('running a plan twice', () => {
		it('refuses a second run while one is still in flight', async () => {
			const { manager, fakes } = build();

			fakes.jobs.findLiveForPlan.mockResolvedValue({ id: 'job-0' } as SyncJob);

			await expect(manager.run({ planId: 'plan-1' })).rejects.toThrow(
				ErrorKey.SYNC_ALREADY_RUNNING,
			);
		});
	});

	describe('sources handed to the engine', () => {
		it('registers the resolver before the engine can rebuild its queue', () => {
			const { manager, fakes } = build();

			manager.onModuleInit();

			expect(fakes.engine.setSourceResolver).toHaveBeenCalled();
		});

		it('orders the sources by service priority, best first', async () => {
			const { manager } = build({
				items: [item(), item({ id: 'item-slow', serviceId: 'service-slow' })],
				matches: [{ localItemId: 'item-slow', remoteItemId: 'item-fast' }],
			});

			const sources = await manager.resolveSources({ itemId: 'item-fast' } as Transfer);

			expect(sources.map((source) => source.serviceId)).toEqual([
				'service-fast',
				'service-slow',
			]);
			expect(sources[0].transport).toBe(TransferTransport.HTTP_RANGE);
			expect(sources[0].connection?.token).toBe('secret');
		});

		it('reaches a peer’s service over the peer link, not over HTTP', async () => {
			const { manager } = build({
				items: [item({ serviceId: 'service-peer' })],
				services: [service('service-peer', 1, { peerId: 'peer-1' })],
			});

			const sources = await manager.resolveSources({ itemId: 'item-fast' } as Transfer);

			expect(sources[0].transport).toBe(TransferTransport.PEER_DIRECT);
			expect(sources[0].connection).toBeUndefined();
		});

		it('answers with nothing for a transfer whose item has been forgotten', async () => {
			const { manager } = build();

			await expect(manager.resolveSources({ itemId: 'ghost' } as Transfer)).resolves.toEqual([]);
		});
	});

	describe('metadata', () => {
		it('brings the companions across, beside the file that has not arrived yet', async () => {
			const { manager, fakes } = build({ settings: { pullMetadata: true } });

			fakes.metadata.discover.mockResolvedValue([
				{ name: 'S01E03.srt', kind: 'subtitle', size: 100, open: jest.fn() },
			]);

			await manager.run({});

			expect(fakes.metadata.discover).toHaveBeenCalledWith(
				'/source/S01E03.mkv',
				'/media/shows/Show/S01E03.mkv',
			);
			expect(fakes.metadata.apply).toHaveBeenCalledWith(
				'/media/shows/Show/S01E03.mkv',
				[expect.objectContaining({ name: 'S01E03.srt' })],
				expect.objectContaining({ pullMetadata: true }),
			);
		});

		it('leaves the companions alone when the settings say not to pull them', async () => {
			const { manager, fakes } = build();

			await manager.run({});

			expect(fakes.metadata.discover).not.toHaveBeenCalled();
		});

		it('does not lose a transfer over a subtitle it could not read', async () => {
			const { manager, fakes } = build({ settings: { pullMetadata: true } });

			fakes.metadata.discover.mockRejectedValue(new Error('EACCES'));

			await expect(manager.run({})).resolves.toBeDefined();
			expect(fakes.engine.enqueue).toHaveBeenCalled();
		});
	});

	describe('plans', () => {
		it('hands the whole set to the scheduler on every change', async () => {
			const { manager, fakes } = build();

			await manager.createPlan({
				name: 'Nightly',
				trigger: SyncTrigger.SCHEDULE,
				schedule: '0 4 * * *',
				scope: { categoryKeys: ['shows'] },
			});

			expect(fakes.scheduler.registerPlans).toHaveBeenCalled();
		});

		it('registers what is stored once the database is up', async () => {
			const { manager, fakes } = build({
				plans: [{ id: 'plan-1', name: 'Nightly', schedule: '0 4 * * *', enabled: true } as SyncPlan],
			});

			await manager.onApplicationBootstrap();

			expect(fakes.scheduler.registerPlans).toHaveBeenCalledWith([
				expect.objectContaining({ id: 'plan-1' }),
			]);
		});

		it('answers a key for a plan nobody has', async () => {
			const { manager } = build();

			await expect(manager.readPlan('ghost')).rejects.toThrow(ErrorKey.SYNC_PLAN_NOT_FOUND);
		});

		/**
		 * A preference is only worth storing if it can ever be honoured.
		 *
		 * The same rule the queue applies to a re-pointed transfer, for the same reason:
		 * a library on somebody else's server, or on one of ours whose files this gateway
		 * does not hold, accepts everything and produces nothing anybody can watch — and
		 * the failure is silent, because the pull succeeds. Refused when it is chosen
		 * rather than discovered at four in the morning.
		 */
		describe('the library a plan prefers', () => {
			const creating = (preferredLibraryId: string) => ({
				name: 'Animes',
				trigger: SyncTrigger.MANUAL,
				scope: { categoryKeys: ['animes'] },
				preferredLibraryId,
			});

			it('is kept when it is one of ours the gateway holds the files of', async () => {
				const { manager } = build();

				await expect(manager.createPlan(creating('library-anime'))).resolves.toMatchObject({
					preferredLibraryId: 'library-anime',
				});
			});

			it('is refused when it belongs to a peer', async () => {
				const { manager } = build();

				await expect(manager.createPlan(creating('library-theirs'))).rejects.toThrow(
					ErrorKey.TRANSFER_DESTINATION_INVALID,
				);
			});

			it('is refused when this gateway has no path into it', async () => {
				// One of our own services, but nothing tells us where its files are from
				// here. Writing to a library we cannot address is not a thing that exists.
				const { manager } = build();

				await expect(manager.createPlan(creating('library-unmapped'))).rejects.toThrow(
					ErrorKey.TRANSFER_DESTINATION_INVALID,
				);
			});

			it('is refused when nobody has it', async () => {
				const { manager } = build();

				await expect(manager.createPlan(creating('library-ghost'))).rejects.toThrow(
					ErrorKey.LIBRARY_NOT_FOUND,
				);
			});

			it('can always be cleared, whatever is reachable today', async () => {
				const { manager } = build();
				const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

				plans.findOne.mockResolvedValue({
					id: 'plan-1',
					scope: { categoryKeys: ['animes'] },
					filter: {},
					sourceServiceIds: [],
					preferredLibraryId: 'library-theirs',
					enabled: true,
				} as unknown as SyncPlan);

				await expect(
					manager.updatePlan('plan-1', { preferredLibraryId: null }),
				).resolves.toMatchObject({ preferredLibraryId: null });
			});
		});
	});

	describe('scope', () => {
		it('resolves a merged category into the libraries behind it', async () => {
			const { manager, fakes } = build({
				items: [
					item({ id: 'item-shows', libraryId: 'library-shows' }),
					item({ id: 'item-films', libraryId: 'library-films', externalId: 'ext-2' }),
				],
				categoryLibraries: ['library-shows'],
			});

			const planning = await manager.plan({ scope: { categoryKeys: ['shows'] } });

			expect(fakes.libraryManager.librariesOfCategory).toHaveBeenCalledWith('shows');
			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-shows']);
		});

		it('intersects the fields rather than adding them up', async () => {
			const { manager } = build({
				items: [
					item({ id: 'item-shows', libraryId: 'library-shows' }),
					item({ id: 'item-films', libraryId: 'library-films', externalId: 'ext-2' }),
				],
				categoryLibraries: ['library-shows', 'library-films'],
			});

			// The part of that subtree in that category, which is what somebody filling
			// in a form means by naming both.
			const planning = await manager.plan({
				scope: { categoryKeys: ['everything'], itemIds: ['item-films'] },
			});

			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-films']);
		});

		it('runs nothing when the scope names something that no longer exists', async () => {
			const { manager } = build({ categoryLibraries: [] });

			// Falling through to "no restriction" here would turn a category somebody
			// deleted into a sync of everything, at four in the morning.
			const planning = await manager.plan({ scope: { categoryKeys: ['gone'] } });

			expect(planning.items).toHaveLength(0);
		});

		it('echoes back what it was asked for, so a preview reads on its own', async () => {
			const { manager } = build();
			const scope = { itemIds: ['item-fast'] };

			expect((await manager.plan({ scope })).scope).toEqual(scope);
		});
	});

	describe('estimate', () => {
		it('counts the scope, not the run the ceilings allow', async () => {
			const { manager } = build({
				items: [
					item({ id: 'item-a', normalizedTitle: 'a' }),
					item({ id: 'item-b', normalizedTitle: 'b', externalId: 'ext-2' }),
				],
			});

			const planning = await manager.plan({
				scope: { itemIds: ['item-a', 'item-b'] },
				maxItemsPerRun: 1,
			});

			expect(planning.estimate).toMatchObject({ itemCount: 2, bytes: 4_000_000 });
			expect(planning.itemsPlanned).toBe(1);
			expect(planning.bytesPlanned).toBe(2_000_000);
			expect(planning.stoppedBy).toBe(SyncStopReason.MAX_ITEMS);
			expect(planning.dropped).toHaveLength(1);
		});

		it('says a scope that names nothing is unbounded', async () => {
			const { manager } = build();

			expect((await manager.plan({})).estimate.unbounded).toBe(true);
			expect(
				(await manager.plan({ scope: { itemIds: ['item-fast'] } })).estimate.unbounded,
			).toBe(false);
		});

		it('answers for a stored plan without touching what is stored', async () => {
			const { manager } = build();
			const plans = (manager as unknown as { _plans: { findOne: jest.Mock; save: jest.Mock } })
				._plans;

			plans.findOne.mockResolvedValue({
				id: 'plan-1',
				scope: { itemIds: ['item-fast'] },
				filter: {},
				sourceServiceIds: [],
				targetLibraryId: null,
				maxItemsPerRun: null,
				maxBytesPerRun: null,
			} as unknown as SyncPlan);

			const estimate = await manager.estimatePlan('plan-1');

			expect(estimate).toMatchObject({ itemCount: 1, unbounded: false, truncated: false });
			expect(plans.save).not.toHaveBeenCalled();
		});

		/**
		 * A count and a size do not depend on where the files would land.
		 *
		 * Going through placement made a gateway with no writable library (a clean
		 * install, a household that only reads a friend's server) answer 409 for a
		 * question that writes nothing, and the dialog asking it could only say nobody
		 * had worked the figure out. The run still refuses; the estimate does not.
		 */
		it('answers with nowhere to land, where the run still refuses', async () => {
			const { manager, fakes } = build({
				items: [
					item({ id: 'item-a', normalizedTitle: 'a' }),
					item({ id: 'item-b', normalizedTitle: 'b', externalId: 'ext-2' }),
				],
			});

			fakes.placement.resolve.mockRejectedValue(
				new ConflictException(ErrorKey.LIBRARY_PATH_NOT_WRITABLE),
			);

			const estimate = await manager.estimateScope({ scope: { itemIds: ['item-a', 'item-b'] } });

			expect(estimate).toMatchObject({ itemCount: 2, bytes: 4_000_000, unbounded: false });
			await expect(manager.preview({ scope: { itemIds: ['item-a', 'item-b'] } }))
				.rejects.toThrow(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		});
	});

	describe('a pull landing where nobody chose', () => {
		/**
		 * The one event that is on by default, and the reason the feature exists.
		 *
		 * The condition is never re-derived from the strategy: `placedBy` is what the
		 * placement service actually decided, and `UNCONFIGURED_PLACEMENTS` is the list
		 * of steps that mean nobody chose. Reading the strategy instead gives a
		 * different answer the day a step is added.
		 */
		const placedBy = (step: PlacedBy) => {
			const world = build();

			world.fakes.placement.resolve.mockResolvedValue({
				libraryId: 'library-local',
				libraryName: 'Shows',
				directory: '/media/shows',
				path: '/media/shows/Show/S01E03.mkv',
				strategy: PlacementStrategy.DEFAULT_LIBRARY,
				fallback: true,
				reason: null,
				placedBy: step,
			});

			return world;
		};

		it('says so when the fallback folder caught the file', async () => {
			const { manager, fakes } = placedBy(PlacedBy.FALLBACK_PATH);

			await manager.run({});

			expect(fakes.notifications.notify).toHaveBeenCalledWith(
				expect.objectContaining({ event: NotificationEvent.PLACEMENT_UNCONFIGURED }),
			);
		});

		it('says nothing when a category named the destination', async () => {
			// Every run would otherwise notify, which is how somebody turns the whole
			// thing off and stops hearing about the runs that did go wrong.
			const { manager, fakes } = placedBy(PlacedBy.CATEGORY);

			await manager.run({});

			expect(fakes.notifications.notify).not.toHaveBeenCalledWith(
				expect.objectContaining({ event: NotificationEvent.PLACEMENT_UNCONFIGURED }),
			);
		});

		it('sends one message for the run rather than one per file', async () => {
			// Four hundred episodes into an unconfigured category is four hundred
			// notifications, and the second one is already too many.
			const { manager, fakes } = placedBy(PlacedBy.ANY_WRITABLE);

			await manager.run({});

			const placements = fakes.notifications.notify.mock.calls.filter(
				([sent]: [{ event: NotificationEvent }]) =>
					sent.event === NotificationEvent.PLACEMENT_UNCONFIGURED,
			);

			expect(placements).toHaveLength(1);
		});
	});

	describe('free space', () => {
		/** A destination with exactly this much room, for a plan of two megabytes. */
		const withFreeBytes = (freeBytes: number | null, settings: Partial<Settings> = {}) => {
			const world = build({ settings });

			world.fakes.libraryManager.probe.mockResolvedValue({
				exists: true,
				readable: true,
				writable: true,
				freeBytes,
				error: null,
			});

			return world;
		};

		it('refuses a run a destination cannot take, and creates nothing', async () => {
			const { manager, fakes } = withFreeBytes(1000);

			await expect(manager.run({})).rejects.toMatchObject({
				response: { key: ErrorKey.SYNC_NOT_ENOUGH_SPACE },
			});
			expect(fakes.jobs.save).not.toHaveBeenCalled();
			expect(fakes.engine.enqueue).not.toHaveBeenCalled();
		});

		/**
		 * Said while it is still worth saying.
		 *
		 * The arithmetic is known before a byte moves, and that is the whole difference
		 * between this and a failed transfer: said in time somebody frees space, said
		 * afterwards it is thirty gigabytes downloaded twice.
		 */
		it('tells somebody the destination is full, with the numbers', async () => {
			const { manager, fakes } = withFreeBytes(1000);

			await expect(manager.run({})).rejects.toMatchObject({
				response: { key: ErrorKey.SYNC_NOT_ENOUGH_SPACE },
			});

			expect(fakes.notifications.notify).toHaveBeenCalledWith(
				expect.objectContaining({
					event: NotificationEvent.DISK_FULL,
					body: expect.stringContaining('1000 free'),
				}),
			);
		});

		it('refuses it however loudly the caller acknowledges', async () => {
			// The refusal is arithmetic. Starting anyway buys a truncated file the media
			// server indexes as real, which no flag makes acceptable.
			const { manager } = withFreeBytes(1000);

			await expect(manager.run({ acknowledgeSpace: true })).rejects.toMatchObject({
				response: { key: ErrorKey.SYNC_NOT_ENOUGH_SPACE },
			});
		});

		it('asks before crossing the reserve, and goes ahead once told to', async () => {
			const { manager } = withFreeBytes(3_000_000, { diskReserveBytes: 5_000_000 });

			await expect(manager.run({})).rejects.toMatchObject({
				response: { key: ErrorKey.SYNC_SPACE_NOT_ACKNOWLEDGED },
			});
			await expect(manager.run({ acknowledgeSpace: true })).resolves.toBeDefined();
		});

		it('never reads a disk it could not probe as room', async () => {
			const { manager } = withFreeBytes(null);

			await expect(manager.run({})).rejects.toMatchObject({
				response: { key: ErrorKey.SYNC_SPACE_NOT_ACKNOWLEDGED },
			});
		});

		it('reports the room left on every destination it would write into', async () => {
			const { manager } = withFreeBytes(100_000_000);
			const planning = await manager.plan({});

			expect(planning.targets).toEqual([
				expect.objectContaining({
					libraryId: 'library-local',
					requiredBytes: 2_000_000,
					freeBytes: 100_000_000,
					remainingBytes: 98_000_000,
					verdict: SpaceVerdict.FITS,
				}),
			]);
		});
	});

	describe('the detail of a run', () => {
		it('writes a line for every item, before a single transfer exists', async () => {
			const { manager, fakes } = build();

			await manager.run({});

			const [rows] = fakes.lines.save.mock.calls[0] as [SyncJobItem[]];

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				// The coordinates with the episode's own name — see `episodeLabel`.
				title: 'S01E03 — The Trap',
				state: SyncJobItemState.PENDING,
				bytes: 2_000_000,
				// Null until something is actually moving it: a queued line has no bytes
				// to reach.
				transferId: null,
			});
			expect(fakes.lines.save.mock.invocationCallOrder[0]).toBeLessThan(
				fakes.transfers.save.mock.invocationCallOrder[0],
			);
		});

		it('keeps the lines a ceiling dropped, marked as skipped', async () => {
			const { manager, fakes } = build({
				items: [
					item({ id: 'item-a', normalizedTitle: 'a' }),
					item({ id: 'item-b', normalizedTitle: 'b', externalId: 'ext-2' }),
				],
			});

			await manager.run({ maxItemsPerRun: 1 });

			const [rows] = fakes.lines.save.mock.calls[0] as [SyncJobItem[]];

			// Without them, `stoppedBy` is something the reader has to take on faith.
			expect(rows.map((row) => row.state)).toEqual([
				SyncJobItemState.PENDING,
				SyncJobItemState.SKIPPED,
			]);
		});

		it('follows the transfer it hands out, rather than asking on a timer', async () => {
			const { manager, fakes } = build();

			manager.onModuleInit();

			const line = {
				id: 'line-1',
				jobId: 'job-1',
				itemId: 'item-fast',
				state: SyncJobItemState.PENDING,
				transferId: null,
			} as SyncJobItem;

			fakes.lines.findLine.mockResolvedValue(line);
			fakes.lines.progressOf.mockResolvedValue({
				done: 1,
				failed: 0,
				bytesDone: 2_000_000,
				open: 0,
			});
			fakes.jobs.findOne.mockResolvedValue({
				id: 'job-1',
				planId: null,
				state: SyncJobState.RUNNING,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
			} as SyncJob);

			const listener = fakes.engine.onTransferState.mock.calls[0][0] as (
				transfer: Transfer,
			) => Promise<void>;

			await listener({
				id: 'transfer-1',
				jobId: 'job-1',
				itemId: 'item-fast',
				state: TransferState.DOWNLOADING,
				bytesDone: 1_000_000,
				error: null,
				startedAt: new Date('2026-01-01T00:01:00.000Z'),
				finishedAt: null,
			} as Transfer);

			expect(fakes.lines.save).toHaveBeenCalledWith(
				expect.objectContaining({
					state: SyncJobItemState.RUNNING,
					// The line names its transfer, which is what lets a progress bar be
					// opened rather than only watched.
					transferId: 'transfer-1',
					bytesDone: 1_000_000,
				}),
			);
			// Counted from the lines, never incremented: a resumed transfer reports
			// `done` twice, and a job that says 901 of 900 is one nobody believes again.
			expect(fakes.jobs.save).toHaveBeenCalledWith(
				expect.objectContaining({ itemsDone: 1, state: SyncJobState.DONE }),
			);
		});

		it('leaves a cancelled run cancelled, whatever its transfers report next', async () => {
			const { manager, fakes } = build();

			manager.onModuleInit();

			fakes.lines.findLine.mockResolvedValue({ id: 'line-1', jobId: 'job-1' } as SyncJobItem);
			fakes.lines.progressOf.mockResolvedValue({ done: 0, failed: 0, bytesDone: 0, open: 0 });
			fakes.jobs.findOne.mockResolvedValue({
				id: 'job-1',
				planId: null,
				state: SyncJobState.CANCELLED,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
			} as SyncJob);

			const listener = fakes.engine.onTransferState.mock.calls[0][0] as (
				transfer: Transfer,
			) => Promise<void>;

			await listener({
				id: 'transfer-1',
				jobId: 'job-1',
				itemId: 'item-fast',
				state: TransferState.CANCELLED,
				bytesDone: 0,
				error: null,
				startedAt: null,
				finishedAt: new Date('2026-01-01T00:02:00.000Z'),
			} as Transfer);

			// A stop button that reports "done" once the transfers finish stopping looks
			// like it failed.
			expect(fakes.jobs.save).toHaveBeenCalledWith(
				expect.objectContaining({ state: SyncJobState.CANCELLED }),
			);
		});

		it('records the scope and the free space against the job itself', async () => {
			const { manager, fakes } = build();

			await manager.run({ scope: { itemIds: ['item-fast'] } });

			expect(fakes.jobs.create).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: { itemIds: ['item-fast'] },
					targets: [expect.objectContaining({ libraryId: 'library-local' })],
				}),
			);
		});
	});

	describe('a plan that says everything', () => {
		const unbounded = { name: 'Nightly', trigger: SyncTrigger.SCHEDULE, schedule: '0 4 * * *' };

		it('refuses to be enabled without somebody saying so on purpose', async () => {
			const { manager } = build();

			await expect(manager.createPlan(unbounded)).rejects.toThrow(
				ErrorKey.SYNC_SCOPE_UNBOUNDED,
			);
		});

		it('is created when the scope is acknowledged', async () => {
			const { manager } = build();

			await expect(
				manager.createPlan({ ...unbounded, acknowledgeUnbounded: true }),
			).resolves.toBeDefined();
		});

		it('is created disabled without any acknowledgement', async () => {
			// Nothing runs, so nothing runs away. The acknowledgement is asked for at the
			// moment somebody enables it.
			const { manager } = build();

			await expect(manager.createPlan({ ...unbounded, enabled: false })).resolves.toBeDefined();
		});

		it('refuses to be switched on later, on a body that says only that', async () => {
			const { manager } = build();
			const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

			plans.findOne.mockResolvedValue({
				id: 'plan-1',
				scope: {},
				filter: {},
				sourceServiceIds: [],
				enabled: false,
			} as unknown as SyncPlan);

			await expect(manager.updatePlan('plan-1', { enabled: true })).rejects.toThrow(
				ErrorKey.SYNC_SCOPE_UNBOUNDED,
			);
		});
	});

	/**
	 * A plan made from the media it is about, which is the only way anybody makes one.
	 *
	 * The blank form asks for a name, a trigger, sources, a scope, a filter and a
	 * ceiling before somebody has said the one thing they meant — *this show* — so
	 * nobody fills it in and the feature the product exists for goes unused. Everything
	 * pinned down below is one of those questions being answered from the media instead
	 * of being asked.
	 */
	describe('keeping one media in sync', () => {
		const series = item({
			id: 'series-1',
			kind: MediaKind.SERIES,
			title: 'The Expanse',
			file: null,
			parentId: null,
		});

		const season = item({
			id: 'season-1',
			kind: MediaKind.SEASON,
			title: 'Season 1',
			file: null,
			parentId: 'series-1',
		});

		const tree = [series, season, item({ id: 'item-fast', parentId: 'season-1' })];

		const plan = (overrides: Partial<SyncPlan> = {}): SyncPlan =>
			({
				id: 'plan-existing',
				name: 'The Expanse',
				enabled: true,
				trigger: SyncTrigger.MANUAL,
				schedule: null,
				sourceServiceIds: [],
				preferredLibraryId: null,
				scope: { rootItemIds: ['series-1'] },
				filter: {},
				maxItemsPerRun: null,
				maxBytesPerRun: null,
				lastRunAt: null,
				nextRunAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
				...overrides,
			}) as SyncPlan;

		it('covers the series, and is called after it', async () => {
			const { manager } = build({ items: tree });

			const created = await manager.createPlanForItem({
				itemId: 'series-1',
				trigger: SyncTrigger.MANUAL,
			});

			expect(created.scope).toEqual({ rootItemIds: ['series-1'] });
			expect(created.name).toBe('The Expanse');
		});

		/**
		 * "Season 1" is three plans with the same name the day somebody keeps two shows
		 * in step, and a list of plans is read six months later by somebody who has
		 * forgotten which was which.
		 */
		it('covers the season alone, and says which show the season belongs to', async () => {
			const { manager } = build({ items: tree });

			const created = await manager.createPlanForItem({
				itemId: 'season-1',
				trigger: SyncTrigger.MANUAL,
			});

			expect(created.scope).toEqual({ rootItemIds: ['season-1'] });
			expect(created.name).toBe('The Expanse — Season 1');
		});

		/**
		 * Empty is the decision, not the omission: a show that turns up on a friend's
		 * server next month is found without anybody editing the plan, and a list pinned
		 * today is a plan that quietly stops finding anything the day a server moves.
		 */
		it('pins no source, so the plan follows the configured priority', async () => {
			const { manager } = build({ items: tree });

			const created = await manager.createPlanForItem({
				itemId: 'series-1',
				trigger: SyncTrigger.MANUAL,
			});

			expect(created.sourceServiceIds).toEqual([]);
			// Filling holes, never replacing a file somebody chose — and no ceiling,
			// because a ceiling on a named show only leaves half a season behind.
			expect(created.filter).toEqual({ missingOnly: true });
			expect(created.maxItemsPerRun).toBeNull();
		});

		it('refuses a second plan for a show one already covers', async () => {
			const { manager } = build({ items: tree, plans: [plan()] });

			await expect(
				manager.createPlanForItem({ itemId: 'series-1', trigger: SyncTrigger.MANUAL }),
			).rejects.toThrow(ErrorKey.SYNC_ITEM_ALREADY_COVERED);
		});

		/** A plan on the series speaks for every season under it, and says which plan. */
		it('reads a plan on the series as covering the season below it', async () => {
			const { manager } = build({ items: tree, plans: [plan()] });

			const answer = await manager.itemPlans('season-1');

			expect(answer.covering).toHaveLength(1);
			expect(answer.covering[0]).toMatchObject({
				coveredItemId: 'series-1',
				exact: false,
			});
			expect(answer.covering[0].plan.id).toBe('plan-existing');
			expect(answer.suggestedName).toBe('The Expanse — Season 1');
		});

		it('adds the show to a plan that exists rather than standing up a second', async () => {
			const { manager } = build({ items: tree });
			const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

			plans.findOne.mockResolvedValue(plan({ scope: { rootItemIds: ['another-show'] } }));

			const extended = await manager.createPlanForItem({
				itemId: 'series-1',
				trigger: SyncTrigger.MANUAL,
				extendPlanId: 'plan-existing',
			});

			expect(extended.scope).toEqual({ rootItemIds: ['another-show', 'series-1'] });
		});

		it('changes nothing when the plan already names that subtree', async () => {
			const { manager } = build({ items: tree });
			const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

			plans.findOne.mockResolvedValue(plan());

			const extended = await manager.createPlanForItem({
				itemId: 'series-1',
				trigger: SyncTrigger.MANUAL,
				extendPlanId: 'plan-existing',
			});

			expect(extended.scope).toEqual({ rootItemIds: ['series-1'] });
		});

		/**
		 * The fields of a scope intersect, so a root added to a plan scoped by category
		 * means "the part of that show in that category" — a silent rewrite of somebody
		 * else's standing intent, and never what "add this show to that plan" asked for.
		 */
		it.each([
			['a category', { categoryKeys: ['shows'] }],
			['everything', {}],
		])('refuses to add a subtree to a plan that covers %s', async (_label, scope) => {
			const { manager } = build({ items: tree });
			const plans = (manager as unknown as { _plans: { findOne: jest.Mock } })._plans;

			plans.findOne.mockResolvedValue(plan({ scope }));

			await expect(
				manager.createPlanForItem({
					itemId: 'series-1',
					trigger: SyncTrigger.MANUAL,
					extendPlanId: 'plan-existing',
				}),
			).rejects.toThrow(ErrorKey.SYNC_PLAN_NOT_EXTENDABLE);
		});

		it('offers only the plans a subtree could be added to', async () => {
			const { manager } = build({
				items: tree,
				plans: [
					plan({ id: 'plan-subtrees', scope: { rootItemIds: ['another-show'] } }),
					plan({ id: 'plan-category', scope: { categoryKeys: ['shows'] } }),
					plan({ id: 'plan-everything', scope: {} }),
				],
			});

			const answer = await manager.itemPlans('series-1');

			expect(answer.extendable.map((one) => one.id)).toEqual(['plan-subtrees']);
		});

		/**
		 * A plan that says it runs nightly and carries no cron is registered nowhere and
		 * fires never. Nothing reports it; the first anybody hears is the episodes that
		 * did not arrive.
		 */
		it('refuses a schedule with nothing to schedule', async () => {
			const { manager } = build({ items: tree });

			await expect(
				manager.createPlanForItem({ itemId: 'series-1', trigger: SyncTrigger.SCHEDULE }),
			).rejects.toThrow(ErrorKey.SYNC_SCHEDULE_REQUIRED);
		});

		it('answers a key for a media nobody holds', async () => {
			const { manager } = build({ items: tree });

			await expect(
				manager.createPlanForItem({ itemId: 'nothing-here', trigger: SyncTrigger.MANUAL }),
			).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});

		/**
		 * What the subtree comes to, before there is a plan to ask it of.
		 *
		 * From a season it is two episodes and from a series a whole show, and that
		 * number is the difference between a standing intent and a surprise — asked for
		 * afterwards, from the edit screen, it arrives after the decision was taken.
		 */
		it('says what the subtree comes to before anything is saved', async () => {
			const { manager } = build({ items: tree });

			const estimate = await manager.estimateScope({ scope: { rootItemIds: ['series-1'] } });

			expect(estimate).toMatchObject({ itemCount: 1, bytes: 2_000_000, unbounded: false });
		});
	});

	/**
	 * The bytes are on the disk and the media server has not indexed them yet.
	 *
	 * Nothing local holds the media — that is what "not indexed" means — so the plain
	 * reading of the index calls it missing, and every run of every plan covering it
	 * fetches the same file into the same folder again. It is the bug those two states
	 * were added for, and this is where a plan has to read them.
	 */
	describe('a file that has landed but is not indexed', () => {
		it.each([SyncState.AWAITING_INDEX, SyncState.NOT_INDEXED])(
			'is not counted as missing when it reads %s',
			async (syncState) => {
				const { manager } = build({ items: [item({ syncState })] });

				const planning = await manager.plan({});

				expect(planning.items).toHaveLength(0);
				expect(planning.estimate.itemCount).toBe(0);
			},
		);

		it('still plans the copy of it that nobody has landed', async () => {
			const { manager } = build({
				items: [
					item({ syncState: SyncState.AWAITING_INDEX }),
					item({
						id: 'item-other',
						serviceId: 'service-slow',
						externalId: 'ext-other',
						normalizedTitle: 'another show',
						file: file({ contentId: 'q1-other', path: '/source/Other.mkv' }),
					}),
				],
			});

			const planning = await manager.plan({});

			expect(planning.items.map((one) => one.itemId)).toEqual(['item-other']);
		});
	});

	describe('fetching only the companions', () => {
		/** An item whose only interesting part is where its file sits. */
		const withFile = (id: string, path: string | null) =>
			item({
				id,
				title: 'Dulcinea',
				file: path === null ? null : { ...(item().file as NonNullable<MediaItem['file']>), path },
			});

		it('copies what sits beside a counterpart, without moving the video again', async () => {
			// The case this exists for: an episode already on the disk that arrived bare,
			// because it was pulled before the setting was on or from a source that had
			// none. Re-pulling forty gigabytes to get a .nfo beside it is not an answer.
			const { manager, fakes } = build({
				items: [withFile('item-local', '/media/local.mkv'), withFile('item-remote', '/remote/source.mkv')],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-remote' }],
			});

			fakes.metadata.discover.mockResolvedValue([{ role: 'nfo' }]);
			fakes.metadata.apply.mockResolvedValue({ copied: ['local.nfo'], kept: [] });

			const [result] = await manager.pullCompanions(['item-local']);

			expect(fakes.metadata.discover).toHaveBeenCalledWith('/remote/source.mkv', '/media/local.mkv');
			expect(result).toMatchObject({ itemId: 'item-local', copied: ['local.nfo'], error: null });
		});

		it('says so when nothing anywhere holds a counterpart', async () => {
			const { manager } = build({
				items: [withFile('item-local', '/media/local.mkv')],
				matches: [],
			});

			const [result] = await manager.pullCompanions(['item-local']);

			expect(result.error).toBe(ErrorKey.SYNC_NO_SOURCE);
		});

		it('refuses an item with no file of its own rather than reporting nothing found', async () => {
			// A series or a season has nothing to put companions beside, and saying
			// 'nothing copied' would read as a source having none.
			const { manager } = build({
				items: [withFile('item-series', null)],
				matches: [],
			});

			const [result] = await manager.pullCompanions(['item-series']);

			expect(result.error).toBe(ErrorKey.MEDIA_NOT_FOUND);
		});

		it('keeps going when one source cannot be read', async () => {
			// A run over two hundred episodes that stops on the first sleeping NAS has
			// helped nobody.
			const { manager, fakes } = build({
				items: [
					withFile('item-local', '/media/local.mkv'),
					withFile('item-a', '/gone/a.mkv'),
					withFile('item-b', '/remote/b.mkv'),
				],
				matches: [
					{ localItemId: 'item-local', remoteItemId: 'item-a' },
					{ localItemId: 'item-local', remoteItemId: 'item-b' },
				],
			});

			fakes.metadata.discover
				.mockRejectedValueOnce(new Error('ENOENT'))
				.mockResolvedValueOnce([{ role: 'poster' }]);
			fakes.metadata.apply.mockResolvedValue({ copied: ['poster.jpg'], kept: [] });

			const [result] = await manager.pullCompanions(['item-local']);

			expect(result.copied).toEqual(['poster.jpg']);
			expect(result.error).toBeNull();
		});
	});

	describe('a run started by the schedule', () => {
		const nightly = {
			id: 'plan-nightly',
			name: 'Nightly',
			scope: {},
			sourceServiceIds: [],
			filter: {},
			preferredLibraryId: null,
			maxItemsPerRun: null,
			maxBytesPerRun: null,
		} as unknown as SyncPlan;

		it('runs the plan the scheduler names, and records it as scheduled', async () => {
			const { manager, fakes } = build();

			fakes.plans.findOne.mockResolvedValue(nightly);
			manager.onModuleInit();

			const tick = fakes.scheduler.onPlan.mock.calls[0][0] as (planId: string) => Promise<void>;

			await tick('plan-nightly');

			// Recorded as the schedule's, not as somebody's click: a run nobody started
			// is the first thing a person reading the history at breakfast asks about.
			expect(fakes.jobs.create).toHaveBeenCalledWith(
				expect.objectContaining({ planId: 'plan-nightly', trigger: SyncTrigger.SCHEDULE }),
			);
		});

		it('stamps the plan with when it ran and when it next will, and names the run after it', async () => {
			const { manager, fakes } = build();
			const next = new Date('2026-01-02T04:00:00.000Z');

			fakes.plans.findOne.mockResolvedValue(nightly);
			fakes.scheduler.nextRunAt.mockReturnValue(next);

			const job = await manager.run({ planId: 'plan-nightly' });

			expect(fakes.plans.setRunStamps).toHaveBeenCalledWith('plan-nightly', expect.any(Date), next);
			expect(job.planName).toBe('Nightly');
		});

		it('stamps nothing for a run no plan asked for', async () => {
			const { manager, fakes } = build();

			const job = await manager.run({});

			expect(fakes.plans.setRunStamps).not.toHaveBeenCalled();
			expect(job.planName).toBeNull();
		});
	});

	describe('stopping a run', () => {
		const job = (overrides: Partial<SyncJob> = {}): SyncJob =>
			({
				id: 'job-1',
				planId: null,
				state: SyncJobState.RUNNING,
				trigger: SyncTrigger.MANUAL,
				startedAt: new Date('2026-01-01T00:00:00.000Z'),
				finishedAt: null,
				itemsPlanned: 5,
				itemsDone: 1,
				itemsFailed: 1,
				bytesPlanned: 0,
				bytesDone: 0,
				scope: {},
				targets: [],
				stoppedBy: null,
				error: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				...overrides,
			}) as SyncJob;

		it('stops what is still moving, and leaves what already ended alone', async () => {
			const { manager, fakes } = build();

			fakes.jobs.findOne.mockResolvedValue(job());
			fakes.transfers.findByJob.mockResolvedValue([
				{ id: 'queued', state: TransferState.QUEUED },
				{ id: 'moving', state: TransferState.DOWNLOADING },
				{ id: 'done', state: TransferState.DONE },
				{ id: 'failed', state: TransferState.FAILED },
				{ id: 'cancelled', state: TransferState.CANCELLED },
			]);

			const stopped = await manager.cancel('job-1');

			// A stop that only stopped the bookkeeping would leave the downloads running.
			expect(fakes.engine.cancel.mock.calls.map(([id]) => id as string)).toEqual([
				'queued',
				'moving',
			]);
			expect(fakes.lines.skipUnfinished).toHaveBeenCalledWith('job-1');
			expect(stopped.state).toBe(SyncJobState.CANCELLED);
			expect(stopped.finishedAt).not.toBeNull();
			expect(fakes.events.emit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ id: 'job-1', state: SyncJobState.CANCELLED }),
			);
		});

		it('skips the lines before the job is marked, so a failure leaves it still running', async () => {
			const { manager, fakes } = build();

			fakes.jobs.findOne.mockResolvedValue(job());
			fakes.lines.skipUnfinished.mockRejectedValue(new Error('database is locked'));

			await expect(manager.cancel('job-1')).rejects.toThrow('database is locked');
			expect(fakes.jobs.save).not.toHaveBeenCalled();
		});

		it.each([SyncJobState.DONE, SyncJobState.FAILED, SyncJobState.CANCELLED])(
			'hands back a run that is already %s as it is',
			async (state) => {
				const { manager, fakes } = build();

				fakes.jobs.findOne.mockResolvedValue(job({ state }));

				const answer = await manager.cancel('job-1');

				// Rewriting a finished run as cancelled would erase how it really ended.
				expect(answer.state).toBe(state);
				expect(fakes.engine.cancel).not.toHaveBeenCalled();
				expect(fakes.jobs.save).not.toHaveBeenCalled();
			},
		);

		it('answers a key for a run nobody has, to a stop and to a read alike', async () => {
			const { manager } = build();

			await expect(manager.cancel('ghost')).rejects.toThrow(
				new NotFoundException(ErrorKey.SYNC_JOB_NOT_FOUND),
			);
			await expect(manager.readJob('ghost')).rejects.toThrow(
				new NotFoundException(ErrorKey.SYNC_JOB_NOT_FOUND),
			);
		});

		it('reads a run whose plan was deleted since as belonging to no plan', async () => {
			const { manager, fakes } = build();

			fakes.jobs.findOne.mockResolvedValue(job({ planId: 'plan-gone' }));

			const answer = await manager.readJob('job-1');

			expect(answer.planId).toBe('plan-gone');
			expect(answer.planName).toBeNull();
		});

		it('names every run of the history after its plan, and none after a plan since deleted', async () => {
			const { manager, fakes } = build();

			fakes.jobs.pageOf.mockResolvedValue([
				[
					job({ id: 'job-a', planId: 'plan-a' }),
					job({ id: 'job-b', planId: 'plan-gone' }),
					job({ id: 'job-c', planId: null }),
				],
				3,
			]);
			fakes.plans.find.mockResolvedValue([{ id: 'plan-a', name: 'Nightly' }]);

			const page = await manager.jobs({});

			expect(page.items.map((one) => [one.id, one.planName])).toEqual([
				['job-a', 'Nightly'],
				['job-b', null],
				['job-c', null],
			]);
			expect(page.pagination.total).toBe(3);
		});

		it('reads a history page of manual runs without asking for any plan', async () => {
			const { manager, fakes } = build();

			fakes.jobs.pageOf.mockResolvedValue([[job({ planId: null })], 1]);

			const page = await manager.jobs({});

			expect(page.items[0].planName).toBeNull();
			expect(fakes.plans.find).not.toHaveBeenCalled();
		});
	});

	describe('what a transfer tells its run', () => {
		const transfer = (overrides: Partial<Transfer> = {}): Transfer =>
			({
				id: 'transfer-1',
				jobId: 'job-1',
				itemId: 'item-fast',
				title: 'The Trap',
				state: TransferState.FAILED,
				bytesDone: 0,
				error: null,
				errorKind: null,
				startedAt: null,
				finishedAt: null,
				...overrides,
			}) as Transfer;

		const listen = (world: World): ((one: Transfer) => Promise<void>) => {
			world.manager.onModuleInit();

			return world.fakes.engine.onTransferState.mock.calls[0][0] as (
				one: Transfer,
			) => Promise<void>;
		};

		it('says a failure had no recorded reason rather than sending an empty message', async () => {
			const world = build();

			await listen(world)(transfer({ jobId: null }));

			expect(world.fakes.notifications.notify).toHaveBeenCalledWith(
				expect.objectContaining({ body: 'unknown — no reason recorded' }),
			);
		});

		it('names the failure and its kind when they are known', async () => {
			const world = build();

			await listen(world)(
				transfer({ jobId: null, errorKind: 'disk_full', error: 'error.transfer.no_space' } as Partial<Transfer>),
			);

			expect(world.fakes.notifications.notify).toHaveBeenCalledWith(
				expect.objectContaining({ body: 'disk_full — error.transfer.no_space' }),
			);
			// Started by hand: there is no run to bring up to date.
			expect(world.fakes.lines.findLine).not.toHaveBeenCalled();
		});

		it('leaves the run alone when the transfer has no line in it', async () => {
			const world = build();

			await listen(world)(transfer({ state: TransferState.DONE }));

			expect(world.fakes.lines.save).not.toHaveBeenCalled();
			expect(world.fakes.jobs.save).not.toHaveBeenCalled();
		});

		it('records the line but settles nothing for a run that no longer exists', async () => {
			const world = build();

			world.fakes.lines.findLine.mockResolvedValue({ id: 'line-1' } as SyncJobItem);

			await listen(world)(transfer({ state: TransferState.DONE }));

			expect(world.fakes.lines.save).toHaveBeenCalledWith(
				expect.objectContaining({ state: SyncJobItemState.DONE, transferId: 'transfer-1' }),
			);
			expect(world.fakes.jobs.save).not.toHaveBeenCalled();
			expect(world.fakes.events.emit).not.toHaveBeenCalled();
		});

		it('forgets the transfer of a line that went back to waiting', async () => {
			const world = build();

			world.fakes.lines.findLine.mockResolvedValue({ id: 'line-1' } as SyncJobItem);

			await listen(world)(transfer({ state: TransferState.PAUSED }));

			// A progress bar opened on a paused transfer would sit still and look broken.
			expect(world.fakes.lines.save).toHaveBeenCalledWith(
				expect.objectContaining({ state: SyncJobItemState.PENDING, transferId: null }),
			);
		});
	});

	describe('the line a transfer state reads as', () => {
		it.each([
			[TransferState.DONE, SyncJobItemState.DONE],
			[TransferState.FAILED, SyncJobItemState.FAILED],
			[TransferState.CANCELLED, SyncJobItemState.SKIPPED],
			[TransferState.QUEUED, SyncJobItemState.PENDING],
			[TransferState.PAUSED, SyncJobItemState.PENDING],
			[TransferState.CONNECTING, SyncJobItemState.RUNNING],
			[TransferState.DOWNLOADING, SyncJobItemState.RUNNING],
			[TransferState.VERIFYING, SyncJobItemState.RUNNING],
		])('%s reads as %s', (state, expected) => {
			expect(jobItemStateOf(state)).toBe(expected);
		});
	});

	describe('the document written beside a pulled file', () => {
		const series = item({ id: 'series-1', kind: MediaKind.SERIES, title: 'The Expanse', file: null });
		const season = item({
			id: 'season-1',
			kind: MediaKind.SEASON,
			title: 'Season 1',
			file: null,
			parentId: 'series-1',
		});

		it('names the show an episode belongs to, two parents up', async () => {
			const { manager, fakes } = build({
				items: [series, season, item({ parentId: 'season-1' })],
				settings: { pullMetadata: true },
			});

			fakes.metadata.writeNfo.mockResolvedValue('/media/shows/Show/S01E03.nfo');

			await manager.run({});

			// The episode's own title twice and no show is the document a media server
			// files under the wrong series when two share an episode title.
			expect(fakes.metadata.writeNfo).toHaveBeenCalledWith(
				'/media/shows/Show/S01E03.mkv',
				expect.objectContaining({ title: 'The Trap', showTitle: 'The Expanse' }),
				expect.anything(),
			);
		});

		it('names no show for a film', async () => {
			const { manager, fakes } = build({
				items: [item({ kind: MediaKind.MOVIE, parentId: 'series-1' }), series],
				settings: { pullMetadata: true },
			});

			await manager.run({});

			expect(fakes.metadata.writeNfo).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ kind: MediaKind.MOVIE, showTitle: null }),
				expect.anything(),
			);
		});

		it('names no show rather than a wrong one when the parents are not recorded', async () => {
			const { manager, fakes } = build({
				items: [item({ parentId: 'season-forgotten' })],
				settings: { pullMetadata: true },
			});

			await manager.run({});

			expect(fakes.metadata.writeNfo).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ showTitle: null }),
				expect.anything(),
			);
		});

		it('adds the source identifiers to the copy it replaces', async () => {
			const world = build({
				items: [
					item({ syncState: SyncState.OUTDATED, externalIds: { tvdb: '81189' } }),
					item({
						id: 'item-local',
						serviceId: 'service-local',
						externalId: 'ours',
						externalIds: { tmdb: '1396' },
					}),
				],
				services: [service('service-fast', 1), service('service-local', 3)],
				localServices: [service('service-local', 3)],
				matches: [{ localItemId: 'item-local', remoteItemId: 'item-fast' }],
				settings: { pullMetadata: true },
			});

			world.fakes.metadata.mergeExternalIds.mockImplementation(
				(local: Record<string, string>, source: Record<string, string>) => ({ ...source, ...local }),
			);

			await world.manager.run({ filter: { replaceOutdated: true } });

			// Holding both numbers is what makes every later correlation of this show cheap.
			expect(world.items.find((one) => one.id === 'item-local')?.externalIds).toEqual({
				tvdb: '81189',
				tmdb: '1396',
			});
		});
	});

	describe('the name a pulled episode is filed under', () => {
		const nameableOf = (render: jest.Mock): { seriesTitle: string | null } =>
			render.mock.calls[0][1] as { seriesTitle: string | null };

		it('is the show’s title, not the episode’s', async () => {
			const { manager, fakes } = build({
				items: [
					item({ id: 'series-1', kind: MediaKind.SERIES, title: 'The Expanse', file: null }),
					item({ id: 'season-1', kind: MediaKind.SEASON, title: 'Season 1', file: null, parentId: 'series-1' }),
					item({ parentId: 'season-1' }),
				],
			});

			await manager.plan({});

			// Filed under its own title, every episode would get a folder of its own.
			expect(nameableOf(fakes.naming.render).seriesTitle).toBe('The Expanse');
		});

		it('is the season’s title when no show is recorded above it', async () => {
			const { manager, fakes } = build({
				items: [
					item({ id: 'season-1', kind: MediaKind.SEASON, title: 'The Expanse S1', file: null }),
					item({ parentId: 'season-1' }),
				],
			});

			await manager.plan({});

			expect(nameableOf(fakes.naming.render).seriesTitle).toBe('The Expanse S1');
		});

		it('is left to the template when neither parent is recorded', async () => {
			const { manager, fakes } = build({ items: [item({ parentId: 'season-forgotten' })] });

			await manager.plan({});

			expect(nameableOf(fakes.naming.render).seriesTitle).toBeNull();
		});

		/**
		 * The lookup that never once matched, and the four folders it cost.
		 *
		 * It asked for a local row normalising to the *episode's* title — `monstres` —
		 * and the only row that could ever answer is the copy we do not have, since not
		 * having it is what makes this a pull. So it found nothing, every time, and the
		 * naming fell through to the template without a word. The show's own title is
		 * what says which shelf a file belongs beside.
		 */
		it('imitates our own copy of the show, as the gateway sees its path', async () => {
			const mine = service('service-local', 3, { filesMounted: true });
			const { manager, fakes } = build({
				items: [
					// Theirs, the one being fetched: an episode of a show we hold.
					item({ id: 'series-1', kind: MediaKind.SERIES, title: 'Big Buck Bunny', file: null }),
					item({ id: 'season-1', kind: MediaKind.SEASON, title: 'Season 1', file: null, parentId: 'series-1' }),
					item({ parentId: 'season-1' }),
					// Ours: the show, with an episode of it already on the disk. The series
					// row carries no file — no server puts one there — so the folder
					// spelling can only be read off what is underneath it.
					item({
						id: 'ours-series',
						serviceId: 'service-local',
						libraryId: 'library-mine',
						externalId: 'ours-series',
						kind: MediaKind.SERIES,
						title: 'Big Buck Bunny',
						file: null,
					}),
					item({
						id: 'item-e1',
						serviceId: 'service-local',
						libraryId: 'library-mine',
						externalId: 'ours-e1',
						parentId: 'ours-series',
						episodeNumber: 1,
						file: file({ path: '/media/Shows/Big Buck Bunny/S01E01.mkv' }),
					}),
				],
				services: [service('service-fast', 1), mine],
				localServices: [mine],
				libraries: [{ id: 'library-mine', paths: ['/media/Shows'], localPath: '/mnt/nas/Shows' }],
			});

			await manager.plan({});

			const context = fakes.naming.render.mock.calls[0][2] as { siblingPath: string | null };

			// The server's own path would never match the destination root, and the
			// imitation would be skipped without a word.
			expect(context.siblingPath).toBe('/mnt/nas/Shows/Big Buck Bunny/S01E01.mkv');
		});

		it('does not look for a sibling under the episode\'s own title', async () => {
			/*
			 * The shape that hid the bug for so long: a local row whose title happens to
			 * match the episode being fetched, under a different show entirely. Matching
			 * on it would file a Spartacus episode beside a documentary that shares a
			 * word, which is worse than the template.
			 */
			const mine = service('service-local', 3, { filesMounted: true });
			const { manager, fakes } = build({
				items: [
					item({ id: 'series-1', kind: MediaKind.SERIES, title: 'Big Buck Bunny', file: null }),
					item({ id: 'season-1', kind: MediaKind.SEASON, title: 'Season 1', file: null, parentId: 'series-1' }),
					item({ parentId: 'season-1', normalizedTitle: 'the flight' }),
					item({
						id: 'namesake',
						serviceId: 'service-local',
						libraryId: 'library-mine',
						externalId: 'namesake',
						kind: MediaKind.MOVIE,
						// The same normalised title as the episode, and nothing to do with it.
						title: 'The Flight',
						normalizedTitle: 'the flight',
						file: file({ path: '/media/Shows/Elsewhere/The Flight.mkv' }),
					}),
				],
				services: [service('service-fast', 1), mine],
				localServices: [mine],
				libraries: [{ id: 'library-mine', paths: ['/media/Shows'], localPath: '/mnt/nas/Shows' }],
			});

			await manager.plan({});

			const context = fakes.naming.render.mock.calls[0][2] as { siblingPath: string | null };

			expect(context.siblingPath).toBeNull();
		});

		it('imitates nothing from a library the gateway has no path into', async () => {
			const mine = service('service-local', 3, { filesMounted: true });
			const { manager, fakes } = build({
				items: [
					item(),
					item({
						id: 'item-e1',
						serviceId: 'service-local',
						libraryId: 'library-unknown',
						externalId: 'ours-e1',
						episodeNumber: 1,
					}),
				],
				services: [service('service-fast', 1), mine],
				localServices: [mine],
				libraries: [],
			});

			await manager.plan({});

			const context = fakes.naming.render.mock.calls[0][2] as { siblingPath: string | null };

			expect(context.siblingPath).toBeNull();
		});
	});

	describe('a scope naming two fields of the same kind', () => {
		it('keeps only the named items that sit inside the subtree', async () => {
			const { manager } = build({
				items: [
					item({ id: 'season-1', kind: MediaKind.SEASON, file: null }),
					item({ id: 'item-inside', parentId: 'season-1' }),
					item({ id: 'item-outside', normalizedTitle: 'sintel', externalId: 'ext-2' }),
				],
			});

			const planning = await manager.plan({
				scope: { rootItemIds: ['season-1'], itemIds: ['item-inside', 'item-outside'] },
			});

			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-inside']);
		});

		it('keeps only the named libraries that belong to the category', async () => {
			const { manager } = build({
				items: [
					item({ id: 'item-shows', libraryId: 'library-shows' }),
					item({ id: 'item-films', libraryId: 'library-films', normalizedTitle: 'sintel' }),
				],
				categoryLibraries: ['library-shows'],
			});

			const planning = await manager.plan({
				scope: { categoryKeys: ['shows'], libraryIds: ['library-shows', 'library-films'] },
			});

			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-shows']);
		});
	});

	describe('filters on the media itself', () => {
		const world = () =>
			build({
				items: [
					item({ id: 'item-bunny', normalizedTitle: 'big buck bunny', year: 2008 }),
					item({ id: 'item-sintel', normalizedTitle: 'sintel', year: 2010, externalId: 'ext-2' }),
					item({ id: 'item-undated', normalizedTitle: 'elephants dream', year: null, externalId: 'ext-3' }),
				],
			});

		it('drops anything older than the year asked for, and anything whose year nobody knows', async () => {
			const planning = await world().manager.plan({ filter: { minYear: 2009 } });

			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-sintel']);
		});

		it('keeps only titles containing what was typed, whatever its case', async () => {
			const planning = await world().manager.plan({ filter: { titleMatches: 'BUCK' } });

			expect(planning.items.map((entry) => entry.itemId)).toEqual(['item-bunny']);
		});

		it('reads an empty title filter as no filter', async () => {
			const planning = await world().manager.plan({ filter: { titleMatches: '' } });

			expect(planning.itemsPlanned).toBe(3);
		});
	});

	describe('editing a plan', () => {
		const stored = (): SyncPlan =>
			({
				id: 'plan-1',
				name: 'The Expanse',
				enabled: true,
				trigger: SyncTrigger.SCHEDULE,
				schedule: '0 4 * * *',
				sourceServiceIds: [],
				preferredLibraryId: null,
				scope: { rootItemIds: ['series-1'] },
				filter: {},
				maxItemsPerRun: 50,
				maxBytesPerRun: 1_000_000,
			}) as unknown as SyncPlan;

		it('keeps what the patch does not mention', async () => {
			const { manager, fakes } = build();

			fakes.plans.findOne.mockResolvedValue(stored());

			const updated = await manager.updatePlan('plan-1', { name: 'Renamed' });

			expect(updated).toMatchObject({
				name: 'Renamed',
				schedule: '0 4 * * *',
				maxItemsPerRun: 50,
				maxBytesPerRun: 1_000_000,
			});
		});

		it('clears a ceiling the patch sets to null, rather than reading null as "unchanged"', async () => {
			const { manager, fakes } = build();

			fakes.plans.findOne.mockResolvedValue(stored());

			const updated = await manager.updatePlan('plan-1', {
				maxItemsPerRun: null,
				maxBytesPerRun: null,
			});

			expect(updated.maxItemsPerRun).toBeNull();
			expect(updated.maxBytesPerRun).toBeNull();
		});

		it('refuses to clear the schedule of a plan that runs on one', async () => {
			const { manager, fakes } = build();

			fakes.plans.findOne.mockResolvedValue(stored());

			await expect(manager.updatePlan('plan-1', { schedule: null })).rejects.toThrow(
				new ConflictException(ErrorKey.SYNC_SCHEDULE_REQUIRED),
			);
			expect(fakes.plans.save).not.toHaveBeenCalled();
		});

		it('clears the schedule once the plan is switched to manual in the same patch', async () => {
			const { manager, fakes } = build();

			fakes.plans.findOne.mockResolvedValue(stored());

			const updated = await manager.updatePlan('plan-1', {
				trigger: SyncTrigger.MANUAL,
				schedule: null,
			});

			expect(updated.schedule).toBeNull();
		});
	});

	describe('naming and placing a plan made from one media', () => {
		it('does not repeat the show when the season already names it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'series-1', kind: MediaKind.SERIES, title: 'The Expanse', file: null }),
					item({
						id: 'season-2',
						kind: MediaKind.SEASON,
						title: 'The Expanse Season 2',
						file: null,
						parentId: 'series-1',
					}),
				],
			});

			const answer = await manager.itemPlans('season-2');

			expect(answer.suggestedName).toBe('The Expanse Season 2');
		});

		it('stops at a parent chain that loops back on itself instead of walking it for ever', async () => {
			const { manager } = build({
				items: [
					item({ id: 'season-a', kind: MediaKind.SEASON, title: 'A', file: null, parentId: 'season-b' }),
					item({ id: 'season-b', kind: MediaKind.SEASON, title: 'B', file: null, parentId: 'season-a' }),
				],
				plans: [
					{
						id: 'plan-b',
						name: 'B',
						scope: { rootItemIds: ['season-b'] },
						createdAt: new Date('2026-01-01T00:00:00.000Z'),
						updatedAt: new Date('2026-01-01T00:00:00.000Z'),
					} as SyncPlan,
				],
			});

			const answer = await manager.itemPlans('season-a');

			// The row somebody's scanner wrote is reported on, not hung on.
			expect(answer.covering.map((one) => one.coveredItemId)).toEqual(['season-b']);
		});
	});
});
