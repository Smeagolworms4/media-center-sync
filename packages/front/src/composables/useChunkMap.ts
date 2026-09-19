import type { TransferChunk } from '@mcs/shared';
import { ChunkState } from '@mcs/shared';

export interface ChunkCell {
	/** Index of the first chunk this cell stands for. */
	from: number;
	/** Index of the last chunk this cell stands for, inclusive. */
	to: number;
	/** The state worth looking at among the chunks folded into this cell. */
	state: ChunkState;
	count: number;
}

export interface ChunkMap {
	cells: ChunkCell[];
	counts: Record<ChunkState, number>;
	/** How many chunks each cell stands for. One, unless the map was folded. */
	scale: number;
}

/**
 * Which state wins when several chunks share a cell.
 *
 * The worst one, deliberately: a map that averaged its buckets would hide the two
 * corrupt pieces in a season that is otherwise done, and those two are the only
 * reason anybody opened it.
 */
const SEVERITY: ChunkState[] = [
	ChunkState.CORRUPT,
	ChunkState.FAILED,
	ChunkState.ACTIVE,
	ChunkState.PENDING,
	ChunkState.DONE,
];

function worst (states: ChunkState[]): ChunkState {
	for (const state of SEVERITY) {
		if (states.includes(state)) {
			return state;
		}
	}
	return ChunkState.PENDING;
}

/**
 * Folds a chunk list into at most `maxCells` cells.
 *
 * A forty-gigabyte season at four megabytes a chunk is ten thousand pieces, and
 * ten thousand elements in a row nobody has expanded is a page that stutters while
 * scrolling. Folding keeps the shape of the transfer — where the holes are — at a
 * cost that does not depend on the file size.
 */
export function buildChunkMap (chunks: TransferChunk[], maxCells = 240): ChunkMap {
	const counts = {
		[ChunkState.PENDING]: 0,
		[ChunkState.ACTIVE]: 0,
		[ChunkState.DONE]: 0,
		[ChunkState.FAILED]: 0,
		[ChunkState.CORRUPT]: 0,
	} as Record<ChunkState, number>;

	for (const chunk of chunks) {
		if (counts[chunk.state] === undefined) {
			counts[chunk.state] = 0;
		}
		counts[chunk.state] += 1;
	}

	if (chunks.length === 0) {
		return { cells: [], counts, scale: 1 };
	}

	const scale = Math.max(1, Math.ceil(chunks.length / maxCells));
	const cells: ChunkCell[] = [];

	for (let start = 0; start < chunks.length; start += scale) {
		const slice = chunks.slice(start, start + scale);
		cells.push({
			from: slice[0].index,
			to: slice.at(-1)!.index,
			state: worst(slice.map(one => one.state)),
			count: slice.length,
		});
	}

	return { cells, counts, scale };
}

export const CHUNK_STATE_COLOR: Record<ChunkState, string> = {
	[ChunkState.PENDING]: 'state-unknown',
	[ChunkState.ACTIVE]: 'state-syncing',
	[ChunkState.DONE]: 'state-in-sync',
	[ChunkState.FAILED]: 'state-conflict',
	[ChunkState.CORRUPT]: 'state-outdated',
};

export function useChunkMap () {
	return { buildChunkMap, CHUNK_STATE_COLOR };
}
