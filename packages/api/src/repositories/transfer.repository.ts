import { Injectable } from '@nestjs/common';
import { DataSource, In, LessThan, Not, Repository } from 'typeorm';
import type { TransferQueueStats } from '@mcs/shared';
import {
	FINISHED_TRANSFER_STATES,
	HistoryView,
	TransferState,
	UNCONFIGURED_PLACEMENTS,
} from '@mcs/shared';
import { MediaItem, Transfer } from '@/entities';

/** States in which a transfer is still moving, or about to. */
const LIVE_STATES = [
	TransferState.QUEUED,
	TransferState.CONNECTING,
	TransferState.DOWNLOADING,
	TransferState.VERIFYING,
	TransferState.REPAIRING,
	TransferState.PLACING,
];

/**
 * Which states a listing may return, or `null` for "no restriction at all".
 *
 * A paused transfer counts as live here although it is not moving: somebody stopped
 * it and it resumes when they say so, and a queue screen that filed it under history
 * would be a screen on which pausing a transfer loses it.
 */
const statesInView = (
	view: HistoryView | undefined,
	state: TransferState | undefined,
): TransferState[] | null => {
	const inView =
		view === HistoryView.LIVE
			? Object.values(TransferState).filter((one) => !FINISHED_TRANSFER_STATES.includes(one))
			: view === HistoryView.FINISHED
				? FINISHED_TRANSFER_STATES
				: null;

	if (state === undefined) {
		return inView;
	}

	return inView === null ? [state] : inView.filter((one) => one === state);
};

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

	/**
	 * Every transfer not yet finished whose source is an item of this service.
	 *
	 * Paused ones included: a paused transfer resumes against the same source, and
	 * one whose service is gone can only fail when it does. Joined on the item rather
	 * than read from a column, because a transfer names its source by item and the
	 * item is what carries the service.
	 */
	public findUnfinishedFromService(serviceId: string): Promise<Transfer[]> {
		return this.createQueryBuilder('transfer')
			.innerJoin(MediaItem, 'item', 'item.id = transfer.itemId')
			.where('item.serviceId = :serviceId', { serviceId })
			.andWhere('transfer.state NOT IN (:...finished)', { finished: FINISHED_TRANSFER_STATES })
			.getMany();
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
	 *
	 * `states` narrows which finished states are swept, because retention gives
	 * successes and failures different windows. Anything not finished is dropped from
	 * the list whatever the caller passed, so a mistake upstairs costs a row that is
	 * not deleted rather than a download that disappears mid-flight.
	 */
	public async deleteFinishedBefore(
		before: Date,
		states: TransferState[] = FINISHED_TRANSFER_STATES,
	): Promise<number> {
		const swept = states.filter((state) => FINISHED_TRANSFER_STATES.includes(state));

		if (swept.length === 0) {
			return 0;
		}

		const result = await this.delete({
			state: In(swept),
			finishedAt: LessThan(before),
		});

		return result.affected ?? 0;
	}

	/**
	 * One page of the queue, newest first, narrowed to a state or to half the list.
	 *
	 * The two narrowings are intersected here rather than in SQL: asking for the live
	 * half *and* for `done` is a contradiction, and an empty page says so where two
	 * find operators on one column would have answered whichever the driver rendered
	 * last.
	 */
	public pageOf(options: {
		page: number;
		limit: number;
		state?: TransferState;
		view?: HistoryView;
	}): Promise<[Transfer[], number]> {
		const allowed = statesInView(options.view, options.state);

		if (allowed !== null && allowed.length === 0) {
			return Promise.resolve([[], 0]);
		}

		return this.findAndCount({
			where: allowed === null ? {} : { state: In(allowed) },
			order: { createdAt: 'DESC' },
			skip: (options.page - 1) * options.limit,
			take: options.limit,
		});
	}
}
