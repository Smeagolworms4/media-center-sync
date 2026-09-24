import {
	ChunkState,
	ErrorKey,
	EventName,
	MediaKind,
	PlacedBy,
	TransferErrorKind,
	TransferState,
} from '@mcs/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Transfer } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	RevalidationRepository,
	SyncJobItemRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import { FileMoveError, FileMoveOutcome } from '@/services';
import type {
	EventGatewayService,
	FileMoveService,
	SettingsService,
	TransferEngineService,
	VerificationService,
} from '@/services';
import type { LandingManager } from './landing.manager';
import type { LibraryManager } from './library.manager';
import type { ServiceManager } from './service.manager';
import { TransferManager } from './transfer.manager';

interface Fakes {
	transfers: {
		findOne: jest.Mock;
		findAndCount: jest.Mock;
		pageOf: jest.Mock;
		save: jest.Mock;
		queueStats: jest.Mock;
		findUnconfigured: jest.Mock;
		findUnfinishedFromService: jest.Mock;
	};
	chunks: {
		findByTransfer: jest.Mock;
		countByState: jest.Mock;
		updateState: jest.Mock;
		deleteForTransfer: jest.Mock;
		sumBytesDone: jest.Mock;
	};
	engine: {
		pause: jest.Mock;
		resume: jest.Mock;
		cancel: jest.Mock;
		enqueue: jest.Mock;
		stats: jest.Mock;
		progressOf: jest.Mock;
	};
	verification: { verify: jest.Mock };
	events: { emit: jest.Mock; publishProgress: jest.Mock; flushProgress: jest.Mock };
	libraries: { findOne: jest.Mock; find: jest.Mock };
	lines: { findLine: jest.Mock; save: jest.Mock };
	libraryManager: { probe: jest.Mock; categories: jest.Mock };
	mover: { move: jest.Mock };
	landings: { record: jest.Mock };
	/** Holds what registered with it, so a test can remove a service the way the manager would. */
	serviceManager: { onRemoving: jest.Mock; listeners: ((serviceId: string) => Promise<void>)[] };
}

/** A library on one of our own services, writable, which is the only valid target. */
const OURS = {
	id: 'lib-anime',
	name: 'Animes',
	alias: null,
	serviceId: 'service-1',
	localPath: '/media/anime',
};

const transfer = (overrides: Partial<Transfer> = {}): Transfer =>
	({
		id: 'transfer-1',
		jobId: null,
		itemId: 'item-1',
		contentId: null,
		title: 'S01E03',
		state: TransferState.DOWNLOADING,
		targetPath: '/media/shows/S01E03.mkv',
		targetLibraryId: 'lib-shows',
		placedBy: PlacedBy.DEFAULT_LIBRARY,
		workPath: '/var/transfer/transfer-1.part',
		bytesTotal: 1000,
		bytesDone: 400,
		chunkSize: 100,
		chunksTotal: 10,
		chunksRepaired: 0,
		error: null,
		errorKind: null,
		lastVerifiedAt: null,
		startedAt: null,
		finishedAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Transfer;

const build = (state = TransferState.DOWNLOADING): { manager: TransferManager; fakes: Fakes } => {
	const row = transfer({ state });
	const fakes: Fakes = {
		transfers: {
			findOne: jest.fn().mockResolvedValue(row),
			findAndCount: jest.fn().mockResolvedValue([[row], 1]),
			pageOf: jest.fn().mockResolvedValue([[row], 1]),
			save: jest.fn((value: Transfer) => Promise.resolve(value)),
			queueStats: jest
				.fn()
				.mockResolvedValue({ active: 1, queued: 2, paused: 0, failed: 0, bytesRemaining: 600 }),
			findUnconfigured: jest.fn().mockResolvedValue([]),
			findUnfinishedFromService: jest.fn().mockResolvedValue([]),
		},
		chunks: {
			findByTransfer: jest.fn().mockResolvedValue([
				{ index: 0, start: 0, end: 99, state: ChunkState.DONE, sourceServiceId: 'service-1', checksum: 'a' },
				{ index: 1, start: 100, end: 199, state: ChunkState.DONE, sourceServiceId: 'service-1', checksum: 'b' },
			]),
			countByState: jest.fn().mockResolvedValue({ [ChunkState.DONE]: 4 }),
			updateState: jest.fn().mockResolvedValue(undefined),
			deleteForTransfer: jest.fn().mockResolvedValue(2),
			sumBytesDone: jest.fn().mockResolvedValue(100),
		},
		engine: {
			pause: jest.fn().mockResolvedValue(undefined),
			resume: jest.fn().mockResolvedValue(undefined),
			cancel: jest.fn().mockResolvedValue(undefined),
			enqueue: jest.fn().mockResolvedValue(undefined),
			stats: jest.fn(() => ({ active: 1, queued: 2, paused: 0, failed: 0, rate: 4_200, bytesRemaining: 600 })),
			// Null is the engine's answer for a transfer it is not running, which is
			// every transfer in these tests: they are about what the manager decides,
			// not about bytes moving.
			progressOf: jest.fn(() => null),
		},
		verification: {
			verify: jest.fn().mockResolvedValue({
				transferId: 'transfer-1',
				ok: true,
				chunksChecked: 2,
				chunksCorrupt: 0,
				bytesToRepair: 0,
				checkedAt: '2026-01-01T00:00:00.000Z',
				corruptChunks: [],
				detail: null,
			}),
		},
		events: { emit: jest.fn(), publishProgress: jest.fn(), flushProgress: jest.fn() },
		libraries: {
			findOne: jest.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve(
					where.id === OURS.id
						? OURS
						: { id: 'lib-shows', name: 'Shows', alias: null, serviceId: 'service-1', localPath: '/media/shows' },
				),
			),
			// Both shelves `findOne` answers for: a fake world where a library can be read
			// one by one but is missing from the list would be one no gateway can be in.
			find: jest.fn().mockResolvedValue([
				OURS,
				{ id: 'lib-shows', name: 'Shows', alias: null, serviceId: 'service-1', localPath: '/media/shows' },
			]),
		},
		lines: { findLine: jest.fn().mockResolvedValue(null), save: jest.fn() },
		libraryManager: {
			// Writable, and nothing is at the destination yet: the ordinary case, which
			// each test that cares about the opposite overrides for itself.
			probe: jest.fn().mockResolvedValue({ exists: false, readable: true, writable: true }),
			categories: jest.fn().mockResolvedValue([]),
		},
		mover: {
			move: jest
				.fn()
				.mockResolvedValue({ outcome: FileMoveOutcome.RENAMED, bytesCopied: 0, partialPath: null }),
		},
		landings: { record: jest.fn().mockResolvedValue(undefined) },
		serviceManager: { onRemoving: jest.fn(), listeners: [] },
	};

	fakes.serviceManager.onRemoving.mockImplementation((listener: (serviceId: string) => Promise<void>) => {
		fakes.serviceManager.listeners.push(listener);
	});

	const manager = new TransferManager(
		fakes.transfers as unknown as TransferRepository,
		fakes.chunks as unknown as TransferChunkRepository,
		{ findForTransfer: jest.fn().mockResolvedValue([]) } as unknown as RevalidationRepository,
		{
			find: jest
				.fn()
				.mockResolvedValue([{ id: 'item-1', kind: MediaKind.EPISODE, libraryId: 'lib-source' }]),
		} as unknown as MediaItemRepository,
		{
			find: jest.fn().mockResolvedValue([]),
			// Answered by identifier rather than fixed, so that a library sitting on a
			// friend's server really is a different answer here.
			findOne: jest.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve({
					id: where.id,
					peerId: null,
					filesMounted: where.id === 'service-1',
				}),
			),
		} as unknown as MediaServiceRepository,
		fakes.libraries as unknown as LibraryRepository,
		fakes.lines as unknown as SyncJobItemRepository,
		fakes.libraryManager as unknown as LibraryManager,
		fakes.landings as unknown as LandingManager,
		{
			get: jest
				.fn()
				.mockResolvedValue({ diskReserveBytes: 0, defaultTargetPath: '/media/incoming' }),
		} as unknown as SettingsService,
		fakes.mover as unknown as FileMoveService,
		fakes.engine as unknown as TransferEngineService,
		fakes.verification as unknown as VerificationService,
		fakes.events as unknown as EventGatewayService,
		fakes.serviceManager as unknown as ServiceManager,
	);

	return { manager, fakes };
};

describe('TransferManager', () => {
	describe('pause', () => {
		it('pauses a queued transfer, which is what pressing pause is for', async () => {
			const { manager, fakes } = build(TransferState.QUEUED);

			await manager.pause('transfer-1');

			expect(fakes.engine.pause).toHaveBeenCalledWith('transfer-1');
		});

		it('refuses a transfer that has already finished', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await expect(manager.pause('transfer-1')).rejects.toThrow(ConflictException);
			expect(fakes.engine.pause).not.toHaveBeenCalled();
		});

		it('is a no-op on a transfer already paused', async () => {
			const { manager, fakes } = build(TransferState.PAUSED);

			await manager.pause('transfer-1');

			expect(fakes.engine.pause).not.toHaveBeenCalled();
		});
	});

	describe('resume', () => {
		it('picks a failed transfer back up rather than fetching it again', async () => {
			const { manager, fakes } = build(TransferState.FAILED);

			await manager.resume('transfer-1');

			expect(fakes.engine.resume).toHaveBeenCalledWith('transfer-1');
			expect(fakes.chunks.deleteForTransfer).not.toHaveBeenCalled();
		});

		it('refuses a transfer that is already running', async () => {
			const { manager } = build(TransferState.DOWNLOADING);

			await expect(manager.resume('transfer-1')).rejects.toThrow(
				ErrorKey.TRANSFER_NOT_RESUMABLE,
			);
		});
	});

	describe('cancel', () => {
		it('refuses to cancel a file that is already in the library', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await expect(manager.cancel('transfer-1')).rejects.toThrow(ConflictException);
			expect(fakes.engine.cancel).not.toHaveBeenCalled();
		});

		it('is a no-op on one that already failed', async () => {
			const { manager, fakes } = build(TransferState.FAILED);

			await manager.cancel('transfer-1');

			expect(fakes.engine.cancel).not.toHaveBeenCalled();
		});
	});

	/**
	 * A service removed while it was still feeding the queue.
	 *
	 * Left alone, its transfers outlived it and failed later on a source nobody could
	 * find, reading as a fault to investigate. They are stopped at removal instead,
	 * with a reason of their own; which rows count as unfinished is the repository's
	 * query, pinned by the functional test against a real database.
	 */
	describe('a source service removed', () => {
		const removeService = async (fakes: Fakes, serviceId: string): Promise<void> => {
			for (const listener of fakes.serviceManager.listeners) {
				await listener(serviceId);
			}
		};

		it('listens for removals once the application is up', () => {
			const { manager, fakes } = build();

			expect(fakes.serviceManager.listeners).toHaveLength(0);

			manager.onApplicationBootstrap();

			expect(fakes.serviceManager.listeners).toHaveLength(1);
		});

		it('cancels what the service was feeding, saying the service was removed', async () => {
			const { manager, fakes } = build();

			fakes.transfers.findUnfinishedFromService.mockResolvedValue([
				transfer({ id: 'queued', state: TransferState.QUEUED }),
				transfer({ id: 'running', state: TransferState.DOWNLOADING }),
				transfer({ id: 'paused', state: TransferState.PAUSED }),
			]);
			manager.onApplicationBootstrap();

			await removeService(fakes, 'service-gone');

			expect(fakes.transfers.findUnfinishedFromService).toHaveBeenCalledWith('service-gone');
			expect(fakes.engine.cancel.mock.calls).toEqual([
				['queued', TransferErrorKind.SERVICE_REMOVED],
				['running', TransferErrorKind.SERVICE_REMOVED],
				['paused', TransferErrorKind.SERVICE_REMOVED],
			]);
		});

		it('keeps going when one transfer cannot be stopped', async () => {
			const { manager, fakes } = build();

			fakes.transfers.findUnfinishedFromService.mockResolvedValue([
				transfer({ id: 'stuck' }),
				transfer({ id: 'fine' }),
			]);
			fakes.engine.cancel.mockRejectedValueOnce(new Error('row vanished'));

			await expect(manager.cancelFromService('service-gone')).resolves.toBe(1);
			expect(fakes.engine.cancel).toHaveBeenLastCalledWith('fine', TransferErrorKind.SERVICE_REMOVED);
		});
	});

	describe('retry', () => {
		it('resets the pieces of a cancelled transfer, whose bytes are gone', async () => {
			const { manager, fakes } = build(TransferState.CANCELLED);

			await manager.retry('transfer-1');

			expect(fakes.chunks.deleteForTransfer).toHaveBeenCalledWith('transfer-1');

			const saved = fakes.transfers.save.mock.calls[0][0] as Transfer;

			expect(saved.state).toBe(TransferState.QUEUED);
			expect(saved.bytesDone).toBe(0);
			expect(saved.error).toBeNull();
			expect(fakes.engine.enqueue).toHaveBeenCalledWith('transfer-1');
		});

		it('refuses a transfer that is still running', async () => {
			const { manager } = build(TransferState.DOWNLOADING);

			await expect(manager.retry('transfer-1')).rejects.toThrow(ErrorKey.TRANSFER_NOT_RESUMABLE);
		});

		it('refuses one that is already in the library', async () => {
			const { manager } = build(TransferState.DONE);

			await expect(manager.retry('transfer-1')).rejects.toThrow(ErrorKey.TRANSFER_NOT_RESUMABLE);
		});
	});

	describe('verify and repair', () => {
		it('verify writes nothing, whatever it finds', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.verification.verify.mockResolvedValue({
				transferId: 'transfer-1',
				ok: false,
				chunksChecked: 2,
				chunksCorrupt: 1,
				bytesToRepair: 100,
				checkedAt: '2026-01-01T00:00:00.000Z',
				corruptChunks: [1],
				detail: 'piece 1 does not match',
			});

			const report = await manager.verify('transfer-1');

			expect(report.chunksCorrupt).toBe(1);
			expect(fakes.transfers.save).not.toHaveBeenCalled();
			expect(fakes.chunks.updateState).not.toHaveBeenCalled();
			expect(fakes.engine.enqueue).not.toHaveBeenCalled();
		});

		it('verify tells the interface what it found even when it found nothing wrong', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await manager.verify('transfer-1');

			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.TRANSFER_VERIFIED,
				expect.objectContaining({ ok: true }),
			);
		});

		it('repair marks only the failing pieces and queues the transfer again', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.verification.verify.mockResolvedValue({
				transferId: 'transfer-1',
				ok: false,
				chunksChecked: 2,
				chunksCorrupt: 1,
				bytesToRepair: 100,
				checkedAt: '2026-01-01T00:00:00.000Z',
				corruptChunks: [1],
				detail: null,
			});

			await manager.repair('transfer-1');

			expect(fakes.chunks.updateState).toHaveBeenCalledTimes(1);
			expect(fakes.chunks.updateState).toHaveBeenCalledWith('transfer-1', 1, {
				state: ChunkState.CORRUPT,
				bytesDone: 0,
			});

			const saved = fakes.transfers.save.mock.calls[0][0] as Transfer;

			expect(saved.state).toBe(TransferState.REPAIRING);
			expect(fakes.engine.enqueue).toHaveBeenCalledWith('transfer-1');
		});

		it('repair leaves a whole file alone rather than queueing work nobody found', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await manager.repair('transfer-1');

			expect(fakes.transfers.save).not.toHaveBeenCalled();
			expect(fakes.engine.enqueue).not.toHaveBeenCalled();
		});
	});

	/**
	 * Changing where a file goes, which costs two wildly different things.
	 *
	 * Before it lands, nothing has been placed and the bytes are piling up in the
	 * scratch directory: the change is one row write. After it lands, the same request
	 * moves real bytes between two real filesystems. The tests below pin that
	 * difference down, because a caller that assumed the second cost for the first case
	 * would never offer the cheap one — which is the only one worth offering while a
	 * forty-gigabyte season is still downloading.
	 */
	describe('changing the destination', () => {
		it('only rewrites the path while the file is still downloading', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			expect(fakes.mover.move).not.toHaveBeenCalled();

			const saved = fakes.transfers.save.mock.calls[0][0] as Transfer;

			expect(saved.targetPath).toBe('/media/anime/S01E03.mkv');
			expect(saved.targetLibraryId).toBe('lib-anime');
			expect(saved.state).toBe(TransferState.DOWNLOADING);
		});

		it('writes into the folder somebody chose, keeping the layout under it', async () => {
			/*
			 * A library is not one folder, and redirecting offered only its root — so a
			 * household with five directories called `Series TV` could put a show on the
			 * first and nowhere else. The chosen folder replaces the root and nothing
			 * else: the show keeps its own folder and its season under it, because those
			 * are what a media server groups a series by.
			 */
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.transfers.findOne.mockResolvedValue(
				transfer({
					state: TransferState.DOWNLOADING,
					targetPath: '/media/shows/The Expanse/Season 1/S01E02.mkv',
					targetLibraryId: 'lib-shows',
				}),
			);

			await manager.changeDestination('transfer-1', {
				libraryId: 'lib-anime',
				folder: '/media/anime/Seasonal',
			});

			expect((fakes.transfers.save.mock.calls[0][0] as Transfer).targetPath).toBe(
				'/media/anime/Seasonal/The Expanse/Season 1/S01E02.mkv',
			);
		});

		it('refuses a folder outside the library it was asked to go to', async () => {
			// The guarantee the whole area rests on: a directory under a root the service
			// declared is a directory that service scans, and a path somebody typed can be
			// anywhere. A file written where no server looks reports success and produces
			// nothing.
			const { manager } = build(TransferState.DOWNLOADING);

			await expect(
				manager.changeDestination('transfer-1', {
					libraryId: 'lib-anime',
					folder: '/somewhere/else',
				}),
			).rejects.toThrow(ErrorKey.TRANSFER_DESTINATION_INVALID);
		});

		it('takes a folder that does not exist yet, and creates nothing', async () => {
			// It appears when the bytes are written, so a redirection somebody changes
			// their mind about leaves no empty folders behind.
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			await manager.changeDestination('transfer-1', {
				libraryId: 'lib-anime',
				folder: '/media/anime/Nouveau',
			});

			expect((fakes.transfers.save.mock.calls[0][0] as Transfer).targetPath).toBe(
				'/media/anime/Nouveau/S01E03.mkv',
			);
			expect(fakes.mover.move).not.toHaveBeenCalled();
		});

		it('keeps the folders the file already sits in, one library over', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.transfers.findOne.mockResolvedValue(
				transfer({
					state: TransferState.DOWNLOADING,
					targetPath: '/media/shows/The Expanse/Season 1/S01E02.mkv',
					targetLibraryId: 'lib-shows',
				}),
			);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			// A season flattened to a file name is a season no media server groups.
			expect((fakes.transfers.save.mock.calls[0][0] as Transfer).targetPath).toBe(
				'/media/anime/The Expanse/Season 1/S01E02.mkv',
			);
		});

		/**
		 * The case this whole screen is full of.
		 *
		 * A file in the fallback folder belongs to no library, so there is no library
		 * root to measure its folders against — and without the fallback folder being
		 * looked at too, every row here would be the one that loses them.
		 */
		it('keeps the folders of a file that was left in the fallback folder', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.transfers.findOne.mockResolvedValue(
				transfer({
					state: TransferState.DOWNLOADING,
					targetPath: '/media/incoming/Frieren/Season 1/S01E04.mkv',
					targetLibraryId: null,
				}),
			);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			expect((fakes.transfers.save.mock.calls[0][0] as Transfer).targetPath).toBe(
				'/media/anime/Frieren/Season 1/S01E04.mkv',
			);
		});

		it('moves the bytes once the file is in a library, and says so while it runs', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			expect(fakes.mover.move).toHaveBeenCalledWith(
				expect.objectContaining({
					source: '/media/shows/S01E03.mkv',
					destination: '/media/anime/S01E03.mkv',
				}),
			);

			// The state the interface already draws a bar for, pushed before the copy
			// starts rather than after it finishes.
			const states = fakes.events.emit.mock.calls
				.filter(([name]: [string]) => name === EventName.TRANSFER_STATE)
				.map(([, payload]: [string, { state: TransferState }]) => payload.state);

			expect(states[0]).toBe(TransferState.PLACING);
			expect(states.at(-1)).toBe(TransferState.DONE);
		});

		it('leaves the transfer where it was when the move is refused', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.mover.move.mockRejectedValue(
				new FileMoveError(ErrorKey.TRANSFER_NO_SPACE, 'ENOSPC: no space left on device'),
			);

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_NO_SPACE);

			// The file is still whole, in the library it was in. A transfer stuck on
			// `placing` would make a recoverable refusal look like a hung job.
			const saved = fakes.transfers.save.mock.calls.at(-1) as [Transfer];

			expect(saved[0].state).toBe(TransferState.DONE);
			expect(saved[0].targetPath).toBe('/media/shows/S01E03.mkv');
		});

		/**
		 * The refusal this whole area exists for.
		 *
		 * A library on somebody else's server is a directory this gateway cannot write
		 * into and no media server of ours scans. A transfer sent there reports success
		 * and produces nothing.
		 */
		it('refuses a library that is not on one of our own services', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.libraries.findOne.mockResolvedValue({ ...OURS, serviceId: 'peer-service' });

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_DESTINATION_INVALID);
			expect(fakes.mover.move).not.toHaveBeenCalled();
		});

		it('refuses one on a service we share but do not hold the files of', async () => {
			// Sharing and holding are two answers now, and only the second one decides a
			// destination: a pull has to land on a path the media server actually scans,
			// and nothing about offering its libraries to peers puts one there.
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			// `service-2` is an ordinary Jellyfin this gateway holds no files of — the
			// fake above answers `filesMounted` per identifier — and nothing about its
			// sharing switch enters into this refusal.
			fakes.libraries.findOne.mockResolvedValue({ ...OURS, serviceId: 'service-2' });

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_DESTINATION_INVALID);
			expect(fakes.mover.move).not.toHaveBeenCalled();
		});

		it('refuses a library of ours the gateway cannot write into', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.libraryManager.probe.mockResolvedValue({
				exists: true,
				readable: true,
				writable: false,
			});

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		});

		it('refuses a library nobody has', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.libraries.findOne.mockResolvedValue(null);

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-ghost' }),
			).rejects.toThrow(NotFoundException);
		});

		it('refuses to land on somebody else\'s file', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			fakes.libraryManager.probe.mockResolvedValue({
				exists: true,
				readable: true,
				writable: true,
			});

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_TARGET_OCCUPIED);
		});

		/**
		 * The one moment the answer is "not now" rather than yes or no.
		 *
		 * A key of its own, and not `TRANSFER_NOT_RESUMABLE`, because the two mean
		 * opposite things to whoever is reading the screen: one says this transfer will
		 * never move again, and this one says it is moving right now and the request can
		 * be made again in a minute.
		 */
		it('refuses while the engine is placing the file at this exact moment', async () => {
			const { manager, fakes } = build(TransferState.PLACING);

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_BEING_PLACED);
			expect(fakes.transfers.save).not.toHaveBeenCalled();
			expect(fakes.mover.move).not.toHaveBeenCalled();
		});

		it('marks a destination somebody chose by hand as its own kind of decision', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			// Not `REQUESTED`, which belongs to a run that named a library for everything
			// it pulled: this is a correction to one file, and no rule underneath it moved.
			expect((fakes.transfers.save.mock.calls[0][0] as Transfer).placedBy).toBe(
				PlacedBy.CHOSEN_BY_HAND,
			);
		});

		/**
		 * The interaction that fails silently, and the reason this is tested at all.
		 *
		 * `media_landings` records that a file is on the disk before any media server has
		 * indexed it, and the reconciliation resolves a row by path. A move that left the
		 * row naming the old path makes the next pass stat a file that is not there,
		 * conclude it was deleted and forget the landing — so the media goes back to
		 * reading `missing` with a perfectly good copy on disk, and every screen offers a
		 * download of it again. Nothing fails, nothing is logged, and the only symptom is
		 * the same episode arriving twice.
		 */
		it('re-records the landing so it names the file where it now is', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			expect(fakes.landings.record).toHaveBeenCalledTimes(1);

			const [recorded] = fakes.landings.record.mock.calls[0] as [Transfer];

			// Recorded from the transfer as it is *after* the move, or the row would be
			// rewritten with exactly the path that has just stopped being true.
			expect(recorded.targetPath).toBe('/media/anime/S01E03.mkv');
			expect(recorded.targetLibraryId).toBe('lib-anime');
			expect(recorded.state).toBe(TransferState.DONE);
		});

		it('leaves the landing alone when no byte moved', async () => {
			const { manager, fakes } = build(TransferState.DOWNLOADING);

			await manager.changeDestination('transfer-1', { libraryId: 'lib-anime' });

			// Nothing has landed yet, so there is nothing on any disk to point at — and
			// writing a landing here would mark a media as held while it is still being
			// downloaded.
			expect(fakes.landings.record).not.toHaveBeenCalled();
		});

		it('does not re-record a landing for a move that was refused', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.mover.move.mockRejectedValue(
				new FileMoveError(ErrorKey.TRANSFER_NO_SPACE, 'ENOSPC: no space left on device'),
			);

			await expect(
				manager.changeDestination('transfer-1', { libraryId: 'lib-anime' }),
			).rejects.toThrow(ErrorKey.TRANSFER_NO_SPACE);

			// The file never left the library it was in, so the row that names it is still
			// correct and must not be pointed at a path nothing reached.
			expect(fakes.landings.record).not.toHaveBeenCalled();
		});
	});

	describe('what landed where nobody chose', () => {
		it('names the category to go and fix, rather than the step it fell to', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.transfers.findUnconfigured.mockResolvedValue([
				transfer({ state: TransferState.DONE, placedBy: PlacedBy.DEFAULT_LIBRARY }),
			]);
			fakes.libraryManager.categories.mockResolvedValue([
				{ key: 'animes', name: 'Animés', libraryIds: ['lib-source'] },
			]);

			const rows = await manager.unconfigured();

			expect(rows).toHaveLength(1);
			expect(rows[0].categoryName).toBe('Animés');
			expect(rows[0].placedBy).toBe(PlacedBy.DEFAULT_LIBRARY);
		});

		it('leaves out a file whose library has since been removed', async () => {
			const { manager, fakes } = build(TransferState.DONE);

			fakes.transfers.findUnconfigured.mockResolvedValue([
				transfer({ id: 'orphaned', targetLibraryId: 'lib-gone', placedBy: PlacedBy.DEFAULT_LIBRARY }),
				transfer({ id: 'fallback', targetLibraryId: null, placedBy: PlacedBy.FALLBACK_PATH }),
			]);

			const rows = await manager.unconfigured();

			// Nothing manages that shelf any more, so there is no decision left to offer.
			// The fallback folder belongs to no library by design and stays.
			expect(rows.map((row) => row.transferId)).toEqual(['fallback']);
		});

		it('says nothing at all when every file went where it was meant to', async () => {
			const { manager } = build();

			await expect(manager.unconfigured()).resolves.toEqual([]);
		});
	});

	describe('reading the queue', () => {
		it('takes the counts from the database and the rate from the engine', async () => {
			const { manager } = build();

			await expect(manager.stats()).resolves.toEqual({
				active: 1,
				queued: 2,
				paused: 0,
				failed: 0,
				bytesRemaining: 600,
				rate: 4_200,
			});
		});

		it('fills the kind from the item, which is where it lives', async () => {
			const { manager } = build();

			const page = await manager.list({});

			expect(page.items[0].kind).toBe(MediaKind.EPISODE);
			expect(page.items[0].chunksDone).toBe(4);
			expect(page.pagination).toEqual({ page: 1, limit: 50, total: 1, pages: 1 });
		});

		it('answers a key for a transfer nobody has', async () => {
			const { manager, fakes } = build();

			fakes.transfers.findOne.mockResolvedValue(null);

			await expect(manager.read('ghost')).rejects.toThrow(ErrorKey.TRANSFER_NOT_FOUND);
		});
	});
});
