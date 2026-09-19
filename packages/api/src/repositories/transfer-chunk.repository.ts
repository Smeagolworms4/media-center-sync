import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { ChunkState } from '@mcs/shared';
import { TransferChunk } from '@/entities';

/** One piece of the plan, before it has an identifier. */
export interface ChunkPlanEntry {
	index: number;
	start: number;
	end: number;
	checksum?: string | null;
}

/**
 * How many rows go in one statement.
 *
 * Large enough that a season-sized plan is a handful of round trips, small enough to
 * stay under the parameter limit drivers impose on a single statement.
 */
const INSERT_BATCH = 500;

@Injectable()
export class TransferChunkRepository extends Repository<TransferChunk> {
	public constructor(dataSource: DataSource) {
		super(TransferChunk, dataSource.createEntityManager());
	}

	/** The pieces still to fetch, in file order so a resumed transfer stays sequential. */
	public findPending(transferId: string): Promise<TransferChunk[]> {
		return this.find({
			where: { transferId, state: In([ChunkState.PENDING, ChunkState.FAILED, ChunkState.CORRUPT]) },
			order: { index: 'ASC' },
		});
	}

	public findByTransfer(transferId: string): Promise<TransferChunk[]> {
		return this.find({ where: { transferId }, order: { index: 'ASC' } });
	}

	/** The pieces a verification pass rejected: what a repair has to fetch again. */
	public findCorrupt(transferId: string): Promise<TransferChunk[]> {
		return this.find({ where: { transferId, state: ChunkState.CORRUPT }, order: { index: 'ASC' } });
	}

	public async markDone(transferId: string, index: number, bytesDone: number): Promise<void> {
		await this.update({ transferId, index }, { state: ChunkState.DONE, bytesDone });
	}

	/**
	 * Writes back what the worker now knows about one piece.
	 *
	 * Everything that changes together changes in one statement — the state, the bytes
	 * held, the source that served them and the attempt count. Split into separate
	 * writes, a crash between two of them leaves a piece marked done with the byte
	 * count of the attempt before, and a resumed transfer then skips bytes it never
	 * wrote.
	 */
	public async updateState(
		transferId: string,
		index: number,
		patch: Partial<Pick<TransferChunk, 'state' | 'bytesDone' | 'sourceServiceId' | 'attempts'>>,
	): Promise<void> {
		await this.update({ transferId, index }, patch);
	}

	/**
	 * Writes a whole chunk plan in batched inserts.
	 *
	 * A forty-gigabyte season split into four-megabyte pieces is ten thousand rows.
	 * Saving them one at a time is ten thousand round trips, and that is precisely the
	 * minute that passes between pressing sync and seeing the first byte move — for
	 * work that is not the transfer at all.
	 */
	public async insertPlan(transferId: string, entries: ChunkPlanEntry[]): Promise<number> {
		for (let offset = 0; offset < entries.length; offset += INSERT_BATCH) {
			const batch = entries.slice(offset, offset + INSERT_BATCH).map((entry) => ({
				transferId,
				index: entry.index,
				start: entry.start,
				end: entry.end,
				checksum: entry.checksum ?? null,
				state: ChunkState.PENDING,
				bytesDone: 0,
				attempts: 0,
				sourceServiceId: null,
			}));

			await this.insert(batch);
		}

		return entries.length;
	}

	/** Bytes actually held on disk, which is what a resumed transfer starts from. */
	public async sumBytesDone(transferId: string): Promise<number> {
		const row = await this.createQueryBuilder('chunk')
			.select('SUM(chunk.bytesDone)', 'total')
			.where('chunk.transferId = :transferId', { transferId })
			.getRawOne<{ total: string | number | null }>();

		return Number(row?.total ?? 0);
	}

	public async countByState(transferId: string): Promise<Record<ChunkState, number>> {
		const rows = await this.createQueryBuilder('chunk')
			.select('chunk.state', 'state')
			.addSelect('COUNT(1)', 'total')
			.where('chunk.transferId = :transferId', { transferId })
			.groupBy('chunk.state')
			.getRawMany<{ state: ChunkState; total: string | number }>();

		const counts = Object.values(ChunkState).reduce<Record<ChunkState, number>>(
			(accumulator, state) => ({ ...accumulator, [state]: 0 }),
			{} as Record<ChunkState, number>,
		);

		for (const row of rows) {
			counts[row.state] = Number(row.total);
		}

		return counts;
	}

	public async deleteForTransfer(transferId: string): Promise<number> {
		const result = await this.delete({ transferId });

		return result.affected ?? 0;
	}
}
