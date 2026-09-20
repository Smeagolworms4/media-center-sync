import { Injectable } from '@nestjs/common';
import { DataSource, In, LessThan, Not, Repository } from 'typeorm';
import type { TransferQueueStats } from '@mcs/shared';
import { TransferState, UNCONFIGURED_PLACEMENTS } from '@mcs/shared';
import { Transfer } from '@/entities';

/** States in which a transfer is still moving, or about to. */
const LIVE_STATES = [
	TransferState.QUEUED,
	TransferState.CONNECTING,
	TransferState.DOWNLOADING,
	TransferState.VERIFYING,
	TransferState.REPAIRING,
	TransferState.PLACING,
];

const FINISHED_STATES = [TransferState.DONE, TransferState.FAILED, TransferState.CANCELLED];

@Injectable()
export class TransferRepository extends Repository<Transfer> {
	public constructor(dataSource: DataSource) {
		super(Transfer, dataSource.createEntityManager());
	}

	/**
	 * Everything the worker pool is holding open.
	 *
	 * This is also what a restart reads first: a transfer left in a live state by a
	 * process that died has to be picked up again, not left showing progress nobody
	 * is making.
	 */
	public findActive(): Promise<Transfer[]> {
		return this.find({
			where: { state: In(LIVE_STATES.filter((state) => state !== TransferState.QUEUED)) },
			order: { startedAt: 'ASC' },
		});
	}

	/**
	 * What a restarting gateway has to take back in hand.
	 *
	 * Every state that was moving, queued included: the process that was carrying them
	 * is gone, so nothing will advance them until something picks them up again. Paused
	 * transfers are deliberately left out — somebody paused them, and a restart is not
	 * a reason to overrule that.
	 */
	public findResumable(): Promise<Transfer[]> {
		return this.find({ where: { state: In(LIVE_STATES) }, order: { createdAt: 'ASC' } });
	}

	public findQueued(limit = 20): Promise<Transfer[]> {
		return this.find({
			where: { state: TransferState.QUEUED },
			order: { createdAt: 'ASC' },
			take: limit,
		});
	}

	public findByJob(jobId: string): Promise<Transfer[]> {
		return this.find({ where: { jobId }, order: { createdAt: 'ASC' } });
	}

	public findByItem(itemId: string): Promise<Transfer[]> {
		return this.find({ where: { itemId }, order: { createdAt: 'DESC' } });
	}

	/** Other transfers pulling the same file, which is how a swarm finds its peers. */
	public findByContentId(contentId: string): Promise<Transfer[]> {
		return this.find({ where: { contentId } });
	}

	/**
	 * The queue counters, minus the instantaneous rate.
	 *
	 * A rate is measured over a window of the last few seconds and lives in the cache;
	 * nothing in the database could answer it, and a rate read from stored bytes would
	 * be an average since the transfer started rather than what is happening now. The
	 * manager adds it before the figures go out.
	 */
	public async queueStats(): Promise<Omit<TransferQueueStats, 'rate'>> {
		const rows = await this.createQueryBuilder('transfer')
			.select('transfer.state', 'state')
			.addSelect('COUNT(1)', 'total')
			.addSelect('SUM(transfer.bytesTotal - transfer.bytesDone)', 'remaining')
			.groupBy('transfer.state')
			.getRawMany<{ state: TransferState; total: string | number; remaining: string | number | null }>();

		const counts = new Map<TransferState, number>();
		let bytesRemaining = 0;

		for (const row of rows) {
			counts.set(row.state, Number(row.total));

			if (LIVE_STATES.includes(row.state)) {
				bytesRemaining += Number(row.remaining ?? 0);
			}
		}

		return {
			active: LIVE_STATES.filter((state) => state !== TransferState.QUEUED).reduce(
				(total, state) => total + (counts.get(state) ?? 0),
				0,
			),
			queued: counts.get(TransferState.QUEUED) ?? 0,
			paused: counts.get(TransferState.PAUSED) ?? 0,
			failed: counts.get(TransferState.FAILED) ?? 0,
			bytesRemaining,
		};
	}

	/**
	 * Transfers that landed — or are about to — on a step nobody configured.
	 *
	 * Cancelled and failed ones are left out: their file is not in a library and never
	 * will be, so offering to file it properly would be offering to move nothing. The
	 * ones still downloading are kept in on purpose, because that is the cheap moment
	 * to correct the destination — the work file is still in the scratch directory and
	 * changing where it goes rewrites a path rather than moving bytes.
	 *
	 * Newest first and capped, because this feeds a zone on the home screen. A gateway
	 * that has never had a destination configured has one of these rows per file it has
	 * ever pulled, and the answer to that is not a longer list.
	 */
	public findUnconfigured(limit = 50): Promise<Transfer[]> {
		return this.find({
			where: {
				placedBy: In(UNCONFIGURED_PLACEMENTS),
				state: Not(In([TransferState.FAILED, TransferState.CANCELLED])),
			},
			order: { createdAt: 'DESC' },
			take: limit,
		});
	}

	public async setState(id: string, state: TransferState): Promise<void> {
		await this.update({ id }, { state });
	}

	/**
	 * Forgets finished transfers older than the retention window.
	 *
	 * Only finished ones: a queued transfer created a month ago by a plan that never
	 * ran is still something somebody is waiting for.
	 */
	public async deleteFinishedBefore(before: Date): Promise<number> {
		const result = await this.delete({
			state: In(FINISHED_STATES),
			finishedAt: LessThan(before),
		});

		return result.affected ?? 0;
	}
}
