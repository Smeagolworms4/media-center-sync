import type { DataSource } from 'typeorm';
import { ChunkState } from '@mcs/shared';
import { createTestDataSource } from '../../test/utils/database';
import { TransferChunkRepository, type ChunkPlanEntry } from './transfer-chunk.repository';

const plan = (count: number, size = 1_000): ChunkPlanEntry[] =>
	Array.from({ length: count }, (_value, index) => ({
		index,
		start: index * size,
		end: (index + 1) * size - 1,
	}));

describe('TransferChunkRepository', () => {
	let dataSource: DataSource;
	let chunks: TransferChunkRepository;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		chunks = new TransferChunkRepository(dataSource);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	it('writes a whole plan, past the size of a single batch', async () => {
		// A season-sized plan is thousands of rows; the batching is the difference
		// between a transfer that starts now and one that starts in a minute.
		await expect(chunks.insertPlan('transfer-1', plan(1_200))).resolves.toBe(1_200);
		await expect(chunks.count({ where: { transferId: 'transfer-1' } })).resolves.toBe(1_200);
	});

	it('writes nothing for an empty plan', async () => {
		await expect(chunks.insertPlan('transfer-1', [])).resolves.toBe(0);
		await expect(chunks.count()).resolves.toBe(0);
	});

	it('starts every piece pending, in file order', async () => {
		await chunks.insertPlan('transfer-1', plan(3));

		const pending = await chunks.findPending('transfer-1');

		expect(pending.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
		expect(pending.every((chunk) => chunk.state === ChunkState.PENDING)).toBe(true);
	});

	it('brings failed and corrupt pieces back as work to do', async () => {
		await chunks.insertPlan('transfer-1', plan(3));
		await chunks.markDone('transfer-1', 0, 1_000);
		await chunks.updateState('transfer-1', 1, { state: ChunkState.CORRUPT });
		await chunks.updateState('transfer-1', 2, { state: ChunkState.FAILED, attempts: 2 });

		await expect(chunks.findPending('transfer-1')).resolves.toHaveLength(2);
		await expect(chunks.findCorrupt('transfer-1')).resolves.toHaveLength(1);
	});

	it('sums what is already on disk, which is where a resumed transfer starts', async () => {
		await chunks.insertPlan('transfer-1', plan(3));
		await chunks.markDone('transfer-1', 0, 1_000);
		await chunks.markDone('transfer-1', 1, 400);

		await expect(chunks.sumBytesDone('transfer-1')).resolves.toBe(1_400);
	});

	it('sums to zero for a transfer with no pieces yet', async () => {
		await expect(chunks.sumBytesDone('transfer-1')).resolves.toBe(0);
	});

	it('counts every state, including the ones no piece is in', async () => {
		await chunks.insertPlan('transfer-1', plan(2));
		await chunks.markDone('transfer-1', 0, 1_000);

		const counts = await chunks.countByState('transfer-1');

		expect(counts[ChunkState.DONE]).toBe(1);
		expect(counts[ChunkState.PENDING]).toBe(1);
		expect(counts[ChunkState.ACTIVE]).toBe(0);
	});

	it('keeps the pieces of one transfer out of another', async () => {
		await chunks.insertPlan('transfer-1', plan(2));
		await chunks.insertPlan('transfer-2', plan(3));

		await expect(chunks.deleteForTransfer('transfer-1')).resolves.toBe(2);
		await expect(chunks.findByTransfer('transfer-2')).resolves.toHaveLength(3);
	});
});
