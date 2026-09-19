import { ChunkState, ErrorKey, EventName, MediaKind, TransferState } from '@mcs/shared';
import { ConflictException } from '@nestjs/common';
import type { Transfer } from '@/entities';
import type {
	MediaItemRepository,
	MediaServiceRepository,
	RevalidationRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import type {
	EventGatewayService,
	TransferEngineService,
	VerificationService,
} from '@/services';
import { TransferManager } from './transfer.manager';

interface Fakes {
	transfers: {
		findOne: jest.Mock;
		findAndCount: jest.Mock;
		save: jest.Mock;
		queueStats: jest.Mock;
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
	events: { emit: jest.Mock };
}

const transfer = (overrides: Partial<Transfer> = {}): Transfer =>
	({
		id: 'transfer-1',
		jobId: null,
		itemId: 'item-1',
		contentId: null,
		title: 'S01E03',
		state: TransferState.DOWNLOADING,
		targetPath: '/media/shows/S01E03.mkv',
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
			save: jest.fn((value: Transfer) => Promise.resolve(value)),
			queueStats: jest
				.fn()
				.mockResolvedValue({ active: 1, queued: 2, paused: 0, failed: 0, bytesRemaining: 600 }),
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
		events: { emit: jest.fn() },
	};

	const manager = new TransferManager(
		fakes.transfers as unknown as TransferRepository,
		fakes.chunks as unknown as TransferChunkRepository,
		{ findForTransfer: jest.fn().mockResolvedValue([]) } as unknown as RevalidationRepository,
		{
			find: jest.fn().mockResolvedValue([{ id: 'item-1', kind: MediaKind.EPISODE }]),
		} as unknown as MediaItemRepository,
		{ find: jest.fn().mockResolvedValue([]) } as unknown as MediaServiceRepository,
		fakes.engine as unknown as TransferEngineService,
		fakes.verification as unknown as VerificationService,
		fakes.events as unknown as EventGatewayService,
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
