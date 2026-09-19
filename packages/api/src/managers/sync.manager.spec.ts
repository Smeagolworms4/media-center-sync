import {
	ErrorKey,
	MediaKind,
	NamingScheme,
	PlacementStrategy,
	SyncState,
	SyncTrigger,
	TransferTransport,
	type MediaFileInfo,
	type Settings,
} from '@mcs/shared';
import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FindManyOptions, FindOptionsWhere } from 'typeorm';
import type { MediaItem, MediaService, SyncJob, SyncPlan, Transfer } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
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
import { SyncManager } from './sync.manager';

const SETTINGS: Settings = {
	placement: PlacementStrategy.BESIDE_EXISTING,
	fixedPath: null,
	naming: NamingScheme.SOURCE,
	pullMetadata: false,
	preferSourceMetadata: false,
	maxParallelTransfers: 3,
	maxConnectionsPerSource: 4,
	chunkSize: 8 * 1024 * 1024,
	downloadRateLimit: 0,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	allowFriendsOfFriends: false,
	allowSwarm: true,
	rendezvousUrl: null,
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
		engine: { enqueue: jest.Mock; cancel: jest.Mock; setSourceResolver: jest.Mock };
		metadata: { discover: jest.Mock; apply: jest.Mock; mergeExternalIds: jest.Mock };
		naming: { render: jest.Mock };
		services: { findWithSecrets: jest.Mock };
		scheduler: { registerPlans: jest.Mock; onPlan: jest.Mock; unregisterPlan: jest.Mock; nextRunAt: jest.Mock };
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
	} = {},
): World => {
	const items = world.items ?? [
		item(),
		item({ id: 'item-slow', serviceId: 'service-slow', externalId: 'ext-2' }),
	];
	const services = world.services ?? [service('service-fast', 1), service('service-slow', 2)];
	const matches = world.matches ?? [];

	const itemRepository = {
		find: jest.fn((options?: FindManyOptions<MediaItem>) => {
			const where = (options?.where ?? {}) as FindOptionsWhere<MediaItem>;

			if (where.id !== undefined) {
				const wanted = valuesOf(where.id);

				return Promise.resolve(items.filter((candidate) => wanted.includes(candidate.id)));
			}

			if (where.parentId !== undefined) {
				const wanted = valuesOf(where.parentId);

				return Promise.resolve(
					items.filter((candidate) => wanted.includes(candidate.parentId ?? '')),
				);
			}

			if (where.serviceId !== undefined) {
				const wanted = valuesOf(where.serviceId);

				return Promise.resolve(items.filter((candidate) => wanted.includes(candidate.serviceId)));
			}

			return Promise.resolve(items);
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
		engine: {
			enqueue: jest.fn().mockResolvedValue(undefined),
			cancel: jest.fn().mockResolvedValue(undefined),
			setSourceResolver: jest.fn(),
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
		fakes.transfers as unknown as TransferRepository,
		{
			get: jest.fn().mockResolvedValue({ ...SETTINGS, ...world.settings }),
		} as unknown as SettingsService,
		fakes.naming as unknown as NamingService,
		fakes.metadata as unknown as MetadataService,
		fakes.placement as unknown as PlacementService,
		fakes.engine as unknown as TransferEngineService,
		fakes.scheduler as unknown as SchedulerService,
		{ emit: jest.fn() } as unknown as EventGatewayService,
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

	describe('fetching only the companions', () => {
		it('copies what sits beside a counterpart, without moving the video again', async () => {
			// The case this exists for: an episode already on the disk that arrived bare,
			// because it was pulled before the setting was on or from a source that had
			// none. Re-pulling forty gigabytes to get a .nfo beside it is not an answer.
			const { manager, fakes } = build({
				items: [
					{ id: 'item-local', title: 'Dulcinea', file: { path: '/media/local.mkv' }, externalIds: {} },
					{ id: 'item-remote', title: 'Dulcinea', file: { path: '/remote/source.mkv' }, externalIds: { tvdb: '1' } },
				],
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
				items: [{ id: 'item-local', title: 'Dulcinea', file: { path: '/media/local.mkv' }, externalIds: {} }],
				matches: [],
			});

			const [result] = await manager.pullCompanions(['item-local']);

			expect(result.error).toBe(ErrorKey.SYNC_NO_SOURCE);
		});

		it('refuses an item with no file of its own rather than reporting nothing found', async () => {
			// A series or a season has nothing to put companions beside, and saying
			// 'nothing copied' would read as a source having none.
			const { manager } = build({
				items: [{ id: 'item-series', title: 'The Expanse', file: null, externalIds: {} }],
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
					{ id: 'item-local', title: 'Dulcinea', file: { path: '/media/local.mkv' }, externalIds: {} },
					{ id: 'item-a', title: 'Dulcinea', file: { path: '/gone/a.mkv' }, externalIds: {} },
					{ id: 'item-b', title: 'Dulcinea', file: { path: '/remote/b.mkv' }, externalIds: {} },
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
