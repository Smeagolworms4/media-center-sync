import { ChunkState } from '@mcs/shared';
import {
	MAX_CHUNKS,
	MIN_CHUNK_SIZE,
	pendingChunks,
	planChunks,
	planMatchesSize,
	resolveChunkSize,
} from './chunk-planner';

describe('chunk-planner', () => {
	describe('resolveChunkSize', () => {
		it('honours what the settings asked for when it is reasonable', () => {
			expect(resolveChunkSize(100 * 1024 * 1024, 8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
		});

		it('refuses a chunk size below the floor', () => {
			expect(resolveChunkSize(100 * 1024 * 1024, 1024)).toBe(MIN_CHUNK_SIZE);
		});

		it('raises the size rather than producing tens of thousands of rows', () => {
			const size = 64 * 1024 * 1024 * 1024;
			const chunkSize = resolveChunkSize(size, MIN_CHUNK_SIZE);

			expect(Math.ceil(size / chunkSize)).toBeLessThanOrEqual(MAX_CHUNKS);
			expect(chunkSize % (1024 * 1024)).toBe(0);
		});
	});

	describe('planChunks', () => {
		it('cuts a file into contiguous, inclusive ranges', () => {
			// The requested size is raised to the floor, so the sizes here are stated in
			// terms of it rather than in round numbers that would silently be ignored.
			const plan = planChunks(MIN_CHUNK_SIZE * 2 + 10, MIN_CHUNK_SIZE, []);

			expect(plan.chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
				[0, MIN_CHUNK_SIZE - 1],
				[MIN_CHUNK_SIZE, MIN_CHUNK_SIZE * 2 - 1],
				[MIN_CHUNK_SIZE * 2, MIN_CHUNK_SIZE * 2 + 9],
			]);
			expect(plan.chunksTotal).toBe(3);
		});

		it('leaves no gap and no overlap', () => {
			const plan = planChunks(1_000_003, MIN_CHUNK_SIZE, []);

			for (let index = 1; index < plan.chunks.length; index += 1) {
				expect(plan.chunks[index].start).toBe(plan.chunks[index - 1].end + 1);
			}

			expect(plan.chunks[plan.chunks.length - 1].end).toBe(1_000_002);
		});

		it('makes the last chunk as short as it needs to be', () => {
			const plan = planChunks(MIN_CHUNK_SIZE + 1, MIN_CHUNK_SIZE, []);

			expect(plan.chunks).toHaveLength(2);
			expect(plan.chunks[1].size).toBe(1);
		});

		it('puts a tiny file in a single chunk', () => {
			const plan = planChunks(12, MIN_CHUNK_SIZE, []);

			expect(plan.chunks).toHaveLength(1);
			expect(plan.chunks[0]).toMatchObject({ start: 0, end: 11, size: 12 });
		});

		it('plans nothing at all for an empty file', () => {
			// A chunk for zero bytes would become a request for `bytes=0--1`, which
			// servers answer in creative and inconsistent ways.
			const plan = planChunks(0, MIN_CHUNK_SIZE, []);

			expect(plan.chunks).toHaveLength(0);
			expect(plan.chunksTotal).toBe(0);
		});

		it('starts everything pending', () => {
			const plan = planChunks(10, 4, []);

			expect(plan.chunks.every((chunk) => chunk.state === ChunkState.PENDING)).toBe(true);
			expect(plan.bytesDone).toBe(0);
			expect(plan.resumed).toBe(false);
		});
	});

	describe('resume', () => {
		const existing = [
			{ index: 0, start: 0, end: 3, state: ChunkState.DONE, bytesDone: 4 },
			{ index: 1, start: 4, end: 7, state: ChunkState.ACTIVE, bytesDone: 2, attempts: 1 },
			{ index: 2, start: 8, end: 9, state: ChunkState.CORRUPT, bytesDone: 2, attempts: 2 },
		];

		it('keeps the stored geometry even when the setting has changed', () => {
			// Re-cutting a half-finished transfer would reinterpret every completed
			// offset: the bytes on disk belong to the old layout.
			const plan = planChunks(10, 1024 * 1024, existing);

			expect(plan.chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
				[0, 3],
				[4, 7],
				[8, 9],
			]);
			expect(plan.resumed).toBe(true);
		});

		it('keeps finished chunks and counts their bytes', () => {
			const plan = planChunks(10, 4, existing);

			expect(plan.chunks[0].state).toBe(ChunkState.DONE);
			expect(plan.bytesDone).toBe(4);
		});

		it('sends everything that was in flight back to pending with nothing done', () => {
			const plan = planChunks(10, 4, existing);

			expect(plan.chunks[1]).toMatchObject({ state: ChunkState.PENDING, bytesDone: 0 });
			expect(plan.chunks[2]).toMatchObject({ state: ChunkState.PENDING, bytesDone: 0 });
		});

		it('remembers how often a chunk has already failed', () => {
			const plan = planChunks(10, 4, existing);

			expect(plan.chunks[2].attempts).toBe(2);
		});

		it('sorts a plan that came back out of order', () => {
			const plan = planChunks(10, 4, [...existing].reverse());

			expect(plan.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
		});
	});

	describe('pendingChunks and planMatchesSize', () => {
		it('lists everything that is not done', () => {
			const plan = planChunks(10, 4, [
				{ index: 0, start: 0, end: 3, state: ChunkState.DONE },
				{ index: 1, start: 4, end: 7, state: ChunkState.PENDING },
				{ index: 2, start: 8, end: 9, state: ChunkState.PENDING },
			]);

			expect(pendingChunks(plan).map((chunk) => chunk.index)).toEqual([1, 2]);
		});

		it('notices that the source is now a different size', () => {
			const plan = planChunks(10, 4, []);

			expect(planMatchesSize(plan, 10)).toBe(true);
			expect(planMatchesSize(plan, 11)).toBe(false);
		});

		it('treats an empty plan as matching an empty file', () => {
			const plan = planChunks(0, 4, []);

			expect(planMatchesSize(plan, 0)).toBe(true);
			expect(planMatchesSize(plan, 1)).toBe(false);
		});
	});
});
