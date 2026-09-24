import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MatchStrategy,
	MediaKind,
	EventName,
	MediaLandingState,
	MediaServiceType,
	SyncState,
	TransferState,
} from '@mcs/shared';
import type {
	Library,
	MediaItem,
	MediaLanding,
	MediaMatch,
	MediaService,
	Transfer,
} from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import type {
	EventGatewayService,
	HandlerRegistry,
	SettingsService,
	TransferEngineService,
} from '@/services';
import { LANDING_GRACE_MS, LANDING_SETTLE_MS, RescanOutcome } from '@/services';
import { LandingManager } from './landing.manager';

/**
 * The gap between a file arriving and a media server admitting it exists.
 *
 * Everything here is about one question — what does the gateway say about a media
 * whose bytes it has just written — so the fixture is the smallest world in which
 * that question has a right answer: one server of ours with a mapped library, one
 * friend's server that reported the episode, and a real directory on disk, because
 * "is the file still there" is a real `stat` and faking it would test the fake.
 */
const OUR_SERVICE = 'service-ours';
const THEIR_SERVICE = 'service-theirs';
const OUR_LIBRARY = 'library-ours';

const service = (overrides: Partial<MediaService> = {}): MediaService =>
	({
		id: OUR_SERVICE,
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		baseUrl: 'http://127.0.0.1:8096',
		token: 'jellyfin-token',
		username: null,
		password: null,
		filesMounted: true,
		peerId: null,
		...overrides,
	}) as MediaService;

const library = (localPath: string, overrides: Partial<Library> = {}): Library =>
	({
		id: OUR_LIBRARY,
		serviceId: OUR_SERVICE,
		externalId: 'jellyfin-shows',
		name: 'Shows',
		kind: 'shows',
		paths: ['/media/shows'],
		localPath,
		...overrides,
	}) as unknown as Library;

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'their-episode',
		serviceId: THEIR_SERVICE,
		libraryId: 'library-theirs',
		externalId: 'remote-1',
		kind: MediaKind.EPISODE,
		title: 'The Expanse S01E02',
		normalizedTitle: 'the expanse s01e02',
		syncState: SyncState.MISSING,
		file: null,
		...overrides,
	}) as MediaItem;

const transfer = (overrides: Partial<Transfer> = {}): Transfer =>
	({
		id: 'transfer-1',
		itemId: 'their-episode',
		title: 'The Expanse S01E02',
		state: TransferState.DONE,
		targetPath: '/unset',
		targetLibraryId: OUR_LIBRARY,
		contentId: 'q1-abcdef',
		bytesTotal: 4_000_000,
		...overrides,
	}) as Transfer;

interface World {
	items?: MediaItem[];
	landings?: MediaLanding[];
	matches?: MediaMatch[];
	libraries?: Library[];
	services?: MediaService[];
	rescan?: RescanOutcome | Error;
}

interface Fakes {
	/** Told when a landing goes stale, which is the one state nothing else announces. */
	events: { emit: jest.Mock; publishProgress: jest.Mock; flushProgress: jest.Mock };
	landings: MediaLanding[];
	items: MediaItem[];
	requestRescan: jest.Mock;
	setSyncState: jest.Mock;
	rescanListener: jest.Mock;
	deleted: string[];
	/** Exposed so a test can hand back a row the ordinary query would never produce. */
	findForTransfers: jest.Mock;
}

const build = (world: World = {}): { manager: LandingManager; fakes: Fakes } => {
	const landings = [...(world.landings ?? [])];
	const items = [...(world.items ?? [])];
	const matches = world.matches ?? [];
	const libraries = world.libraries ?? [];
	const services = world.services ?? [service(), service({ id: THEIR_SERVICE, filesMounted: false })];
	const deleted: string[] = [];

	const requestRescan = jest.fn(() =>
		world.rescan instanceof Error
			? Promise.reject(world.rescan)
			: Promise.resolve(world.rescan ?? RescanOutcome.LIBRARY),
	);
	const setSyncState = jest.fn((ids: string[], syncState: SyncState) => {
		for (const row of items) {
			if (ids.includes(row.id)) {
				row.syncState = syncState;
			}
		}

		return Promise.resolve();
	});
	const rescanListener = jest.fn();

	const landingRepository = {
		create: jest.fn((value: Partial<MediaLanding>) => ({ ...value })),
		save: jest.fn((row: MediaLanding) => {
			const saved = {
				...row,
				id: row.id ?? `landing-${landings.length + 1}`,
				createdAt: row.createdAt ?? new Date(),
			} as MediaLanding;
			const at = landings.findIndex((one) => one.id === saved.id);

			if (at === -1) {
				landings.push(saved);
			} else {
				landings[at] = saved;
			}

			return Promise.resolve(saved);
		}),
		delete: jest.fn((where: { id: string }) => {
			deleted.push(where.id);
			landings.splice(
				landings.findIndex((one) => one.id === where.id),
				1,
			);

			return Promise.resolve({ affected: 1 });
		}),
		findOpen: jest.fn(() => Promise.resolve([...landings])),
		findForItem: jest.fn((itemId: string) =>
			Promise.resolve(landings.find((one) => one.itemId === itemId) ?? null),
		),
		findForTransfers: jest.fn((transferIds: string[]) =>
			Promise.resolve(
				landings.filter(
					(one) => one.transferId !== null && transferIds.includes(one.transferId),
				),
			),
		),
	};

	const events = { emit: jest.fn(), publishProgress: jest.fn(), flushProgress: jest.fn() };

	const manager = new LandingManager(
		landingRepository as unknown as MediaLandingRepository,
		{
			findByIds: jest.fn((ids: string[]) =>
				Promise.resolve(items.filter((one) => ids.includes(one.id))),
			),
			findByFileHint: jest.fn((hint: string) =>
				Promise.resolve(items.filter((one) => JSON.stringify(one.file ?? {}).includes(hint))),
			),
			setSyncState,
		} as unknown as MediaItemRepository,
		{
			findForRemoteItem: jest.fn((id: string) =>
				Promise.resolve(matches.filter((one) => one.remoteItemId === id)),
			),
			findForLocalItem: jest.fn((id: string) =>
				Promise.resolve(matches.filter((one) => one.localItemId === id)),
			),
		} as unknown as MediaMatchRepository,
		{
			find: jest.fn(() => Promise.resolve(libraries)),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(libraries.find((one) => one.id === options.where.id) ?? null),
			),
		} as unknown as LibraryRepository,
		{
			find: jest.fn(() => Promise.resolve(services)),
			findWithSecrets: jest.fn((id: string) =>
				Promise.resolve(services.find((one) => one.id === id) ?? null),
			),
		} as unknown as MediaServiceRepository,
		{ find: jest.fn(() => ({ requestRescan })) } as unknown as HandlerRegistry,
		{ getValue: jest.fn().mockResolvedValue(0.8) } as unknown as SettingsService,
		{ onTransferState: jest.fn() } as unknown as TransferEngineService,
		// Told when a landing goes stale, which is the one state nothing else announces:
		// it changes on a timer, minutes after the last event on its transfer.
		events as unknown as EventGatewayService,
	);

	manager.onRescan(rescanListener);

	return {
		manager,
		fakes: {
			landings,
			items,
			requestRescan,
			setSyncState,
			rescanListener,
			deleted,
			findForTransfers: landingRepository.findForTransfers,
			events,
		},
	};
};

describe('LandingManager', () => {
	let directory = '';
	let landed = '';
	let built: LandingManager | null = null;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-landing-'));
		landed = join(directory, 'The Expanse - S01E02.mkv');

		await writeFile(landed, 'bytes');
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	afterEach(() => {
		// The follow-up scan is a real timer. Left running it would hold the worker
		// open, and the failure that produces names nothing at all.
		built?.onModuleDestroy();
		built = null;
	});

	const make = (world: World = {}): ReturnType<typeof build> => {
		const result = build(world);

		built = result.manager;

		return result;
	};

	const world = (overrides: Partial<World> = {}): World => ({
		items: [item()],
		libraries: [library(directory)],
		...overrides,
	});

	describe('remembering that a file landed', () => {
		it('records the landing as soon as the move reports success', async () => {
			const { manager, fakes } = make(world());

			await manager.record(transfer({ targetPath: landed }));

			expect(fakes.landings).toHaveLength(1);
			expect(fakes.landings[0]).toMatchObject({
				itemId: 'their-episode',
				transferId: 'transfer-1',
				libraryId: OUR_LIBRARY,
				path: landed,
				contentId: 'q1-abcdef',
				state: MediaLandingState.WAITING,
			});
		});

		it('reads as downloaded rather than missing the moment it lands', async () => {
			const { manager, fakes } = make(world());

			await manager.record(transfer({ targetPath: landed }));

			expect(fakes.items[0].syncState).toBe(SyncState.AWAITING_INDEX);
		});

		it.each([TransferState.FAILED, TransferState.CANCELLED, TransferState.PAUSED])(
			'records nothing for a transfer that ended as %s',
			async (state) => {
				const { manager, fakes } = make(world());

				await manager.record(transfer({ targetPath: landed, state }));

				expect(fakes.landings).toHaveLength(0);
				expect(fakes.items[0].syncState).toBe(SyncState.MISSING);
			},
		);

		it('gives the landing a deadline rather than letting it wait for ever', async () => {
			const { manager, fakes } = make(world());
			const before = Date.now();

			await manager.record(transfer({ targetPath: landed }));

			expect(fakes.landings[0].expiresAt.getTime()).toBeGreaterThanOrEqual(
				before + LANDING_GRACE_MS,
			);
		});

		it('leaves a copy on one of our own servers alone', async () => {
			// Pulling from one of our servers into another is ordinary, and that source
			// row already says something true about a file that plays. Painting it
			// "waiting for an index" would take a good state off a good copy.
			const ours = item({ id: 'ours-episode', serviceId: OUR_SERVICE, syncState: SyncState.IN_SYNC });
			const { manager, fakes } = make(world({ items: [ours] }));

			await manager.record(transfer({ targetPath: landed, itemId: 'ours-episode' }));

			expect(fakes.landings).toHaveLength(1);
			expect(fakes.items[0].syncState).toBe(SyncState.IN_SYNC);
		});

		it('replaces the landing of a media pulled a second time', async () => {
			const { manager, fakes } = make(world());

			await manager.record(transfer({ targetPath: landed }));
			await manager.record(transfer({ id: 'transfer-2', targetPath: landed }));

			expect(fakes.landings).toHaveLength(1);
			expect(fakes.landings[0].transferId).toBe('transfer-2');
		});
	});

	describe('asking the media server to look', () => {
		it('asks the destination library rather than the whole server', async () => {
			const { manager, fakes } = make(world());

			await manager.record(transfer({ targetPath: landed }));

			expect(fakes.requestRescan).toHaveBeenCalledTimes(1);
			expect(fakes.requestRescan.mock.calls[0][0]).toMatchObject({ id: OUR_SERVICE });
			expect(fakes.requestRescan.mock.calls[0][1]).toMatchObject({
				externalId: 'jellyfin-shows',
				paths: ['/media/shows'],
			});
			expect(fakes.landings[0].rescanOutcome).toBe(RescanOutcome.LIBRARY);
		});

		it('asks nobody when the file went outside every library', async () => {
			const { manager, fakes } = make(world());

			await manager.record(transfer({ targetPath: landed, targetLibraryId: null }));

			expect(fakes.requestRescan).not.toHaveBeenCalled();
			// Still recorded: the file is on the disk whether or not anybody scans it,
			// and this is precisely the landing that has to be able to go stale.
			expect(fakes.landings).toHaveLength(1);
		});

		it('records the landing even when the server refuses the request', async () => {
			const { manager, fakes } = make(world({ rescan: new Error('server asleep') }));

			await manager.record(transfer({ targetPath: landed }));

			expect(fakes.landings).toHaveLength(1);
			expect(fakes.items[0].syncState).toBe(SyncState.AWAITING_INDEX);
		});

		it('asks for a scan of our own index once the server has had time', async () => {
			jest.useFakeTimers();

			try {
				const { manager, fakes } = make(world());

				await manager.record(transfer({ targetPath: landed }));

				expect(fakes.rescanListener).not.toHaveBeenCalled();

				jest.advanceTimersByTime(LANDING_SETTLE_MS);

				expect(fakes.rescanListener).toHaveBeenCalledWith(OUR_SERVICE);
			} finally {
				jest.useRealTimers();
			}
		});

		it('schedules one scan for a season arriving, not one per episode', async () => {
			jest.useFakeTimers();

			try {
				const { manager, fakes } = make(world({ items: [item(), item({ id: 'their-other' })] }));

				await manager.record(transfer({ targetPath: landed }));
				await manager.record(transfer({ id: 'transfer-2', itemId: 'their-other', targetPath: landed }));

				jest.advanceTimersByTime(LANDING_SETTLE_MS);

				expect(fakes.rescanListener).toHaveBeenCalledTimes(1);
			} finally {
				jest.useRealTimers();
			}
		});

		it('does not wait on a server that cannot be told to scan', async () => {
			jest.useFakeTimers();

			try {
				const { manager, fakes } = make(world({ rescan: RescanOutcome.UNSUPPORTED }));

				await manager.record(transfer({ targetPath: landed }));
				jest.advanceTimersByTime(LANDING_SETTLE_MS);

				expect(fakes.rescanListener).not.toHaveBeenCalled();
				expect(fakes.landings[0].rescanOutcome).toBe(RescanOutcome.UNSUPPORTED);
			} finally {
				jest.useRealTimers();
			}
		});
	});

	describe('settling a landing against what a scan found', () => {
		const waiting = (overrides: Partial<MediaLanding> = {}): MediaLanding =>
			({
				id: 'landing-1',
				itemId: 'their-episode',
				transferId: 'transfer-1',
				libraryId: OUR_LIBRARY,
				path: landed,
				bytes: 4_000_000,
				contentId: 'q1-abcdef',
				state: MediaLandingState.WAITING,
				expiresAt: new Date(Date.now() + LANDING_GRACE_MS),
				createdAt: new Date(),
				rescanOutcome: RescanOutcome.LIBRARY,
				...overrides,
			}) as MediaLanding;

		/** A row one of our services now reports, with the path it reports it under. */
		const scanned = (overrides: Partial<MediaItem['file']> = {}): MediaItem =>
			item({
				id: 'our-episode',
				serviceId: OUR_SERVICE,
				libraryId: OUR_LIBRARY,
				syncState: SyncState.LOCAL_ONLY,
				file: {
					path: '/media/shows/The Expanse - S01E02.mkv',
					size: 4_000_000,
					container: 'mkv',
					videoCodec: null,
					audioCodec: null,
					width: null,
					height: null,
					durationMs: null,
					bitrate: null,
					quickHash: null,
					contentId: 'q1-abcdef',
					checksum: null,
					...overrides,
				},
			});

		it('forgets the landing once one of our services reports the file', async () => {
			const { manager, fakes } = make(
				world({
					items: [item({ syncState: SyncState.AWAITING_INDEX }), scanned()],
					landings: [waiting()],
				}),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
			expect(fakes.deleted).toEqual(['landing-1']);
		});

		it('recognises the file although the server renamed it on import', async () => {
			// The path we wrote no longer exists on that row; the fingerprint our own
			// scan computed off the bytes does, and that is why it is asked first.
			const renamed = scanned({ path: '/media/shows/The Expanse (2015) - S01E02 - Bolt.mkv' });
			const { manager, fakes } = make(
				world({ items: [item(), renamed], landings: [waiting()] }),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
		});

		it('recognises it through an applied match when neither name nor bytes survived', async () => {
			// A server that re-containers on import leaves neither our path nor our
			// fingerprint. Correlation still pairs the two rows, and an applied pair is
			// exactly "our own scan found a real media item for this".
			const remuxed = scanned({
				path: '/media/shows/The Expanse S01E02.mp4',
				contentId: 'q1-something-else',
			});
			const { manager, fakes } = make(
				world({
					items: [item(), remuxed],
					landings: [waiting()],
					matches: [
						{
							id: 'match-1',
							localItemId: 'our-episode',
							remoteItemId: 'their-episode',
							remoteServiceId: THEIR_SERVICE,
							strategy: MatchStrategy.SEASON_EPISODE,
							confidence: 0.94,
							state: SyncState.IN_SYNC,
							confirmedAt: null,
						} as MediaMatch,
					],
				}),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
		});

		it('keeps waiting on a match nobody applied', async () => {
			const remuxed = scanned({
				path: '/media/shows/other.mp4',
				contentId: 'q1-something-else',
			});
			const { manager, fakes } = make(
				world({
					items: [item(), remuxed],
					landings: [waiting()],
					matches: [
						{
							id: 'match-1',
							localItemId: 'our-episode',
							remoteItemId: 'their-episode',
							remoteServiceId: THEIR_SERVICE,
							strategy: MatchStrategy.NORMALIZED_TITLE,
							// Below the threshold: the whole meaning of that is that nobody
							// has decided these two are the same media.
							confidence: 0.4,
							state: SyncState.MISSING,
							confirmedAt: null,
						} as MediaMatch,
					],
				}),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(1);
		});

		it('keeps waiting while no service reports anything', async () => {
			const { manager, fakes } = make(world({ landings: [waiting()] }));

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(1);
			expect(fakes.landings[0].state).toBe(MediaLandingState.WAITING);
			expect(fakes.items[0].syncState).toBe(SyncState.AWAITING_INDEX);
		});

		it('forgets a landing whose file has left the disk', async () => {
			const { manager, fakes } = make(
				world({ landings: [waiting({ path: join(directory, 'deleted.mkv') })] }),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
		});
	});

	describe('a file the media server never indexes', () => {
		const expired = (overrides: Partial<MediaLanding> = {}): MediaLanding =>
			({
				id: 'landing-1',
				itemId: 'their-episode',
				transferId: 'transfer-1',
				libraryId: OUR_LIBRARY,
				path: landed,
				bytes: 4_000_000,
				contentId: 'q1-abcdef',
				state: MediaLandingState.WAITING,
				expiresAt: new Date(Date.now() - 1000),
				createdAt: new Date(Date.now() - LANDING_GRACE_MS - 1000),
				rescanOutcome: RescanOutcome.LIBRARY,
				...overrides,
			}) as MediaLanding;

		it('says so out loud instead of waiting for ever', async () => {
			const { manager, fakes } = make(world({ landings: [expired()] }));

			await manager.reconcile();

			expect(fakes.landings[0].state).toBe(MediaLandingState.STALE);
			expect(fakes.items[0].syncState).toBe(SyncState.NOT_INDEXED);
		});

		/**
		 * The one state that has to arrive on its own.
		 *
		 * It changes on a timer rather than in answer to anything anybody did — minutes
		 * after the last event on its transfer — so without a push the queue only learns
		 * it on the next reload. A file written to a disk no media server looks at would
		 * then be the thing the screen is quietest about.
		 */
		it('pushes the change, because nothing else will ever announce it', async () => {
			const { manager, fakes } = make(world({ landings: [expired()] }));

			await manager.reconcile();

			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.TRANSFER_LANDING,
				expect.objectContaining({ landing: MediaLandingState.STALE }),
			);
		});

		it('says nothing about a landing that belongs to no transfer', async () => {
			// A file the gateway placed outside the queue. There is no row on any screen
			// to put it on, so announcing it would be a frame nothing reconciles.
			const { manager, fakes } = make(world({ landings: [expired({ transferId: null })] }));

			await manager.reconcile();

			expect(fakes.events.emit).not.toHaveBeenCalledWith(
				EventName.TRANSFER_LANDING,
				expect.anything(),
			);
		});

		it('does not send the media back to missing, which would offer it again', async () => {
			const { manager, fakes } = make(world({ landings: [expired()] }));

			await manager.reconcile();

			expect(fakes.items[0].syncState).not.toBe(SyncState.MISSING);
			expect(fakes.landings).toHaveLength(1);
		});

		it('clears a stale landing the day the server finally indexes it', async () => {
			// The terminal state is terminal for the wait, not for the row: fixing a
			// mount and rescanning has to resolve it with nothing to press.
			const found = item({
				id: 'our-episode',
				serviceId: OUR_SERVICE,
				libraryId: OUR_LIBRARY,
				file: {
					path: '/media/shows/The Expanse - S01E02.mkv',
					size: 4_000_000,
					container: 'mkv',
					videoCodec: null,
					audioCodec: null,
					width: null,
					height: null,
					durationMs: null,
					bitrate: null,
					quickHash: null,
					contentId: 'q1-abcdef',
					checksum: null,
				},
			});
			const { manager, fakes } = make(
				world({
					items: [item(), found],
					landings: [expired({ state: MediaLandingState.STALE })],
				}),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
		});

		it('forgets a stale landing whose file somebody deleted', async () => {
			const { manager, fakes } = make(
				world({
					landings: [
						expired({ state: MediaLandingState.STALE, path: join(directory, 'gone.mkv') }),
					],
				}),
			);

			await manager.reconcile();

			expect(fakes.landings).toHaveLength(0);
		});
	});

	/**
	 * What the queue asks for, a page of transfers at a time.
	 *
	 * A transfer absent from the answer has nothing left to wait for, and the queue
	 * draws it as finished — so this is the only thing standing between a file no media
	 * server can see and a row claiming the download is over.
	 */
	describe('the landing state of a page of transfers', () => {
		const open = (overrides: Partial<MediaLanding> = {}): MediaLanding =>
			({
				id: 'landing-1',
				itemId: 'their-episode',
				transferId: 'transfer-1',
				libraryId: OUR_LIBRARY,
				path: landed,
				bytes: 4_000_000,
				contentId: 'q1-abcdef',
				state: MediaLandingState.WAITING,
				expiresAt: new Date(Date.now() + LANDING_GRACE_MS),
				createdAt: new Date(),
				rescanOutcome: RescanOutcome.LIBRARY,
				...overrides,
			}) as MediaLanding;

		it('answers each transfer with the state of what it landed', async () => {
			const { manager } = make(
				world({
					landings: [
						open(),
						open({
							id: 'landing-2',
							transferId: 'transfer-2',
							state: MediaLandingState.STALE,
						}),
					],
				}),
			);

			// `transfer-3` landed nothing anybody is still waiting for, and says nothing.
			await expect(
				manager.statesByTransfer(['transfer-1', 'transfer-2', 'transfer-3']),
			).resolves.toEqual(
				new Map([
					['transfer-1', MediaLandingState.WAITING],
					['transfer-2', MediaLandingState.STALE],
				]),
			);
		});

		it('asks for the whole page in one read rather than one read per row', async () => {
			// One query per row is what kept this off the queue screen in the first place.
			const { manager, fakes } = make(world({ landings: [open()] }));

			await manager.statesByTransfer(['transfer-1', 'transfer-2', 'transfer-3']);

			expect(fakes.findForTransfers).toHaveBeenCalledTimes(1);
			expect(fakes.findForTransfers).toHaveBeenCalledWith([
				'transfer-1',
				'transfer-2',
				'transfer-3',
			]);
		});

		it('says nothing at all when no transfer is asked about', async () => {
			const { manager } = make(world({ landings: [open()] }));

			await expect(manager.statesByTransfer([])).resolves.toEqual(new Map());
		});

		it('skips a landing that names no transfer at all', async () => {
			// A file somebody put in the folder themselves belongs to no row on the queue,
			// and keying it under anything would read its state onto another file's line.
			const { manager, fakes } = make(world());

			fakes.findForTransfers.mockResolvedValue([open({ transferId: null })]);

			await expect(manager.statesByTransfer(['transfer-1'])).resolves.toEqual(new Map());
		});
	});
});
