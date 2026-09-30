import { Injectable } from '@nestjs/common';
import { DataSource, In, LessThan, Not, Repository } from 'typeorm';
import type { TransferQueueStats } from '@mcs/shared';
import {
	FINISHED_TRANSFER_STATES,
	HistoryView,
	TransferSort,
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
 * What a file is grouped under to make a download, rendered by both engines.
 *
 * The lot, failing that the run, failing that the file itself — the same order the
 * interface used when it did this grouping on its own, kept identical on purpose: the two
 * answering differently would move a row from one block to another the instant a progress
 * frame arrived.
 *
 * Every term is cast, and that is not decoration. `lot` is a `varchar` and `jobId` is a
 * `uuid`, and PostgreSQL refuses `COALESCE` over the two outright — "types character
 * varying and uuid cannot be matched" — while SQLite, which has no uuid type, accepts the
 * uncast version happily. So the mistake runs green through every test here and fails
 * only on somebody's PostgreSQL deployment.
 */
const LOT_KEY =
	'COALESCE(transfer.lot, CAST(transfer.jobId AS varchar), CAST(transfer.id AS varchar))';

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
	 * Every file of these lots, whichever run pulled it.
	 *
	 * The counterpart of `findByJob`, and the query the lot column exists for: a season
	 * somebody redirects was very often pulled over several nights, and the episodes
	 * that landed during the first of them belong to a run nobody is looking at. Asking
	 * by run finds the tail and leaves the head where it was, which is the split on the
	 * disk this whole area exists to prevent.
	 *
	 * Cancelled and failed transfers are left out. There is no file behind them and
	 * nothing aimed anywhere, so including them buys nothing — and it costs something
	 * real: a lot pulled twice holds two rows for the same episode, both of which
	 * compute the same new path, and the second would be refused as landing on the
	 * first.
	 */
	public findByLots(lots: string[]): Promise<Transfer[]> {
		if (lots.length === 0) {
			return Promise.resolve([]);
		}

		return this.find({
			where: {
				lot: In(lots),
				state: Not(In([TransferState.FAILED, TransferState.CANCELLED])),
			},
			order: { createdAt: 'ASC' },
		});
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
		sort?: TransferSort;
	}): Promise<[Transfer[], number]> {
		const allowed = statesInView(options.view, options.state);

		if (allowed !== null && allowed.length === 0) {
			return Promise.resolve([[], 0]);
		}

		const query = this.createQueryBuilder('transfer')
			.skip((options.page - 1) * options.limit)
			.take(options.limit);

		if (allowed !== null) {
			query.where('transfer.state IN (:...allowed)', { allowed });
		}

		/*
		 * What is moving, first — because that is the half somebody came to look at.
		 *
		 * Newest first put a queue of eighty behind whatever finished a minute ago, so
		 * the rows being watched were on page two. The `CASE` is rendered by both
		 * engines and is the only portable way to rank by a set of values; ordering on
		 * the state column itself would sort alphabetically, which means `cancelled`
		 * before `downloading`.
		 *
		 * The other orders exist because this one is a default and not a law: somebody
		 * looking for what a run did last night wants it by date, and somebody clearing
		 * a disk wants it by size.
		 */
		const live = 'CASE WHEN transfer.state IN (:...live) THEN 0 ELSE 1 END';

		switch (options.sort ?? TransferSort.ACTIVITY) {
			case TransferSort.OLDEST: {
				query.orderBy('transfer.createdAt', 'ASC');

				break;
			}

			case TransferSort.LARGEST: {
				query.orderBy('transfer.bytesTotal', 'DESC');

				break;
			}

			case TransferSort.TITLE: {
				query.orderBy('transfer.title', 'ASC');

				break;
			}

			case TransferSort.NEWEST: {
				query.orderBy('transfer.createdAt', 'DESC');

				break;
			}

			default: {
				query.setParameter('live', LIVE_STATES)
					.orderBy(live, 'ASC')
					.addOrderBy('transfer.createdAt', 'DESC');
			}
		}

		return query.getManyAndCount();
	}

	/**
	 * One page of **downloads**, as the keys of the lots on it.
	 *
	 * Keys and not rows, in two queries rather than one, because the two questions are
	 * genuinely different: which downloads belong on this page is a question about groups,
	 * and what a download is made of is a question about files. Answering both at once
	 * means `GROUP BY` with the rows attached, which no portable SQL does — and the
	 * version that limits the files instead is the bug this replaces, where a page of
	 * twenty files cut a season of twenty-two into two blocks.
	 *
	 * The filter chooses which lots appear and never which of their files do. A live view
	 * showing a season minus the four episodes that already landed would report `16 files`
	 * for a season of twenty and a percentage computed against the wrong total, and the
	 * files somebody is looking for would be the ones missing.
	 */
	public async pageOfLots(options: {
		page: number;
		limit: number;
		state?: TransferState;
		view?: HistoryView;
		sort?: TransferSort;
	}): Promise<[string[], number]> {
		const allowed = statesInView(options.view, options.state);

		if (allowed !== null && allowed.length === 0) {
			return [[], 0];
		}

		const query = this.createQueryBuilder('transfer')
			.select(LOT_KEY, 'key')
			.groupBy(LOT_KEY)
			// `offset`/`limit` and not `skip`/`take`: the latter pair make TypeORM wrap the
			// statement in a subquery to paginate entities, and there are no entities here.
			.offset((options.page - 1) * options.limit)
			.limit(options.limit);

		if (allowed !== null) {
			query.where('transfer.state IN (:...allowed)', { allowed });
		}

		/*
		 * The same orders as a page of files, read over the group: a download is as recent
		 * as its newest file, as large as the sum of them, and as live as the liveliest one
		 * of them. `MIN` over the ranking `CASE` is what puts a season with one file still
		 * moving above a download that finished last night.
		 */
		switch (options.sort ?? TransferSort.ACTIVITY) {
			case TransferSort.OLDEST: {
				query.orderBy('MIN(transfer.createdAt)', 'ASC');

				break;
			}

			case TransferSort.LARGEST: {
				query.orderBy('SUM(transfer.bytesTotal)', 'DESC');

				break;
			}

			case TransferSort.TITLE: {
				query.orderBy('MIN(transfer.title)', 'ASC');

				break;
			}

			case TransferSort.NEWEST: {
				query.orderBy('MAX(transfer.createdAt)', 'DESC');

				break;
			}

			default: {
				query
					.setParameter('live', LIVE_STATES)
					.orderBy(
						'MIN(CASE WHEN transfer.state IN (:...live) THEN 0 ELSE 1 END)',
						'ASC',
					)
					.addOrderBy('MAX(transfer.createdAt)', 'DESC');
			}
		}

		const rows = await query.getRawMany<{ key: string }>();

		return [rows.map((row) => row.key), await this._countLots(allowed)];
	}

	/**
	 * Every file of the named downloads, whatever page it would have fallen on.
	 *
	 * Ordered by creation and then by title so that a season reads in the order it was
	 * planned, which for a pack is episode order — the interface groups by season on top
	 * of this and does not re-sort, so this order is the one somebody sees.
	 */
	public findByLotKeys(keys: string[]): Promise<Transfer[]> {
		if (keys.length === 0) {
			return Promise.resolve([]);
		}

		return this.createQueryBuilder('transfer')
			.where(`${LOT_KEY} IN (:...keys)`, { keys })
			.orderBy('transfer.createdAt', 'ASC')
			.addOrderBy('transfer.title', 'ASC')
			.getMany();
	}

	/**
	 * How many downloads the filter holds, which is not how many rows it holds.
	 *
	 * Counted apart from the page because `GROUP BY` with a `LIMIT` counts the page and
	 * not the set, and a pagination built on that figure says "1-20 of 20" forever.
	 */
	private async _countLots(allowed: TransferState[] | null): Promise<number> {
		const counter = this.createQueryBuilder('transfer').select(
			`COUNT(DISTINCT ${LOT_KEY})`,
			'total',
		);

		if (allowed !== null) {
			counter.where('transfer.state IN (:...allowed)', { allowed });
		}

		const row = await counter.getRawOne<{ total: number | string }>();

		return Number(row?.total ?? 0);
	}
}
