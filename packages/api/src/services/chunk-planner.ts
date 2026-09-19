import { ChunkState } from '@mcs/shared';

/**
 * How many pieces a transfer is allowed to be cut into.
 *
 * Every chunk is a database row written and rewritten as it progresses, and a
 * forty-gigabyte film at the default eight megabytes is already five thousand of
 * them. Past this the bookkeeping costs more than the parallelism buys, so the
 * chunk size is raised instead — the person configured a granularity, not a row
 * count, and honouring the number literally would make large transfers slower.
 */
export const MAX_CHUNKS = 4096;

/** Below this, splitting costs more in round trips than it saves in parallelism. */
export const MIN_CHUNK_SIZE = 256 * 1024;

export interface PlannedChunk {
	index: number;
	start: number;
	/** Inclusive, like an HTTP range. */
	end: number;
	size: number;
	state: ChunkState;
	bytesDone: number;
	sourceServiceId: string | null;
	attempts: number;
	checksum: string | null;
}

/** A chunk already in the database, as the engine rebuilds its queue from it. */
export interface ExistingChunk {
	index: number;
	start: number;
	end: number;
	state: ChunkState;
	bytesDone?: number;
	sourceServiceId?: string | null;
	attempts?: number;
	checksum?: string | null;
}

export interface ChunkPlan {
	chunkSize: number;
	chunksTotal: number;
	chunks: PlannedChunk[];
	bytesTotal: number;
	bytesDone: number;
	/** True when an existing plan was continued rather than a new one laid out. */
	resumed: boolean;
}

/**
 * The chunk size actually used, given what was asked for and how big the file is.
 *
 * Rounded up to a whole number of chunks rather than down, because a size that
 * leaves a two-kilobyte final chunk wastes a whole round trip on nothing.
 */
export function resolveChunkSize(totalBytes: number, configured: number): number {
	const requested = Math.max(MIN_CHUNK_SIZE, Math.floor(configured) || MIN_CHUNK_SIZE);

	if (totalBytes <= requested) {
		return requested;
	}

	if (Math.ceil(totalBytes / requested) <= MAX_CHUNKS) {
		return requested;
	}

	// Round the raised size up to a whole mebibyte so the offsets stay readable in a
	// log, which is where anybody debugging a bad range is looking.
	const needed = Math.ceil(totalBytes / MAX_CHUNKS);

	return Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
}

/**
 * Lay out the pieces of a transfer, continuing an existing plan when there is one.
 *
 * Pure on purpose: this is the one place where an off-by-one costs a corrupt file
 * that verifies as intact right up to the last piece, and a pure function is one
 * that can be tested against every awkward size — zero, one byte, exactly one
 * chunk, one byte over — without a filesystem or a server in the way.
 */
export function planChunks(
	totalBytes: number,
	configuredChunkSize: number,
	existing: ExistingChunk[] = [],
): ChunkPlan {
	const size = Math.max(0, Math.floor(totalBytes) || 0);

	if (existing.length > 0) {
		return resumePlan(size, existing);
	}

	const chunkSize = resolveChunkSize(size, configuredChunkSize);
	const chunks: PlannedChunk[] = [];

	// A zero-byte file has nothing to fetch. Returning one empty chunk would have the
	// engine open a range request for `bytes=0--1`, which servers answer in creative
	// and inconsistent ways.
	for (let start = 0; start < size; start += chunkSize) {
		const end = Math.min(start + chunkSize, size) - 1;

		chunks.push({
			index: chunks.length,
			start,
			end,
			size: end - start + 1,
			state: ChunkState.PENDING,
			bytesDone: 0,
			sourceServiceId: null,
			attempts: 0,
			checksum: null,
		});
	}

	return {
		chunkSize,
		chunksTotal: chunks.length,
		chunks,
		bytesTotal: size,
		bytesDone: 0,
		resumed: false,
	};
}

/**
 * Continue a plan that already exists.
 *
 * The stored geometry is kept whatever the settings now say. Re-cutting a
 * half-finished transfer because somebody changed the chunk size in the meantime
 * would reinterpret every completed offset — the bytes on disk belong to the old
 * layout — and produce a file that is wrong in the middle and verifies fine at the
 * ends. The new size applies to the next transfer, not to this one.
 */
export function resumePlan(totalBytes: number, existing: ExistingChunk[]): ChunkPlan {
	const ordered = [...existing].sort((left, right) => left.index - right.index);
	const chunks: PlannedChunk[] = ordered.map((chunk) => {
		const size = chunk.end - chunk.start + 1;
		const done = chunk.state === ChunkState.DONE;

		return {
			index: chunk.index,
			start: chunk.start,
			end: chunk.end,
			size,
			// Anything that was in flight when the process stopped goes back to
			// pending: the last write may have been sitting in a buffer the kernel
			// never flushed, and there is no way to tell from here. Refetching a chunk
			// costs seconds; trusting a truncated one costs the whole file.
			state: done ? ChunkState.DONE : ChunkState.PENDING,
			bytesDone: done ? size : 0,
			sourceServiceId: chunk.sourceServiceId ?? null,
			// Attempts survive, so a chunk that has already failed four times against
			// one source is not handed back to it forever.
			attempts: chunk.attempts ?? 0,
			checksum: chunk.checksum ?? null,
		};
	});

	const chunkSize = chunks.length > 0 ? chunks[0].size : 0;
	const bytesDone = chunks.reduce((total, chunk) => total + chunk.bytesDone, 0);

	return {
		chunkSize,
		chunksTotal: chunks.length,
		chunks,
		bytesTotal: totalBytes,
		bytesDone,
		resumed: true,
	};
}

/** Everything still to fetch, in order. The engine hands these to its connections. */
export function pendingChunks(plan: ChunkPlan): PlannedChunk[] {
	return plan.chunks.filter((chunk) => chunk.state !== ChunkState.DONE);
}

/**
 * Does a stored plan still describe this file?
 *
 * A source that reports a different size than the one the plan was built for is not
 * the same file any more — re-encoded overnight, or a different release entirely —
 * and resuming into it would interleave two encodings.
 */
export function planMatchesSize(plan: ChunkPlan, totalBytes: number): boolean {
	if (plan.chunks.length === 0) {
		return totalBytes === 0;
	}

	const last = plan.chunks[plan.chunks.length - 1];

	return last.end + 1 === totalBytes;
}
