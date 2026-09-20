import {
	ErrorKey,
	MediaKind,
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
import { ConflictException } from '@nestjs/common';
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
	QualityService,
	SchedulerService,
	SettingsService,
	TransferEngineService,
} from '@/services';
import type { LibraryManager } from './library.manager';
import type { NotificationManager } from './notification.manager';
import { SyncManager } from './sync.manager';

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
	allowSwarm: true,
	rendezvousUrl: null,
	instanceName: null,
	publicUrl: null,
	defaultTargetPath: null,
	transferHistoryDays: 30,
	refreshIntervalMinutes: 15,
	fullScanCron: null,
	cacheTtlSeconds: 60,
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
		jobs: { save: jest.Mock; create: jest.Mock; findLiveForPlan: jest.Mock; findOne: jest.Mock };
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
			probe: jest.Mock;
		};
		engine: { enqueue: jest.Mock; cancel: jest.Mock; setSourceResolver: jest.Mock; onTransferState: jest.Mock };
		metadata: { discover: jest.Mock; apply: jest.Mock; mergeExternalIds: jest.Mock };
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
		/** Library identifier to category key, as the library manager answers it. */
		categoryKeys?: Record<string, string>;
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
		},
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
			find: jest.fn().mockResolvedValue(world.plans ?? []),
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<SyncPlan>) => ({ id: 'plan-1', ...value }) as SyncPlan),
			save: jest.fn((value: SyncPlan) =>
				Promise.resolve({
					...value,
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					updatedAt: new Date('2026-01-01T00:00:00.000Z'),
				} as SyncPlan),
			),
			setRunStamps: jest.fn().mockResolvedValue(undefined),
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
		} as unknown as MediaServiceRepository,
		{ findByServices: jest.fn().mockResolvedValue([]) } as unknown as LibraryRepository,
		fakes.libraryManager as unknown as LibraryManager,
		fakes.transfers as unknown as TransferRepository,
		{
			get: jest.fn().mockResolvedValue({ ...SETTINGS, ...world.settings }),
		} as unknown as SettingsService,
		fakes.naming as unknown as NamingService,
		// Asked for one label and nothing else — see the constructor. The real bands
		// are pinned down in the quality service's own suite.
		{ resolutionLabel: () => '1080p' } as unknown as QualityService,
		fakes.metadata as unknown as MetadataService,
		fakes.placement as unknown as PlacementService,
		fakes.engine as unknown as TransferEngineService,
		fakes.scheduler as unknown as SchedulerService,
		{ emit: jest.fn() } as unknown as EventGatewayService,
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

		it('asks for room for the file, so a full disk is refused before it is written to', async () => {
			const { manager, fakes } = build();

			await manager.preview({});

			expect(fakes.placement.resolve).toHaveBeenCalledWith(
				expect.objectContaining({ requiredBytes: 2_000_000 }),
			);
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
				title: 'The Trap',
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

});
