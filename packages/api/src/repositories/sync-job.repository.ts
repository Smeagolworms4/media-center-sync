import { Injectable } from '@nestjs/common';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { FINISHED_SYNC_JOB_STATES, HistoryView, SyncJobState } from '@mcs/shared';
import { SyncJob } from '@/entities';

const LIVE_STATES = [SyncJobState.PENDING, SyncJobState.RUNNING, SyncJobState.PAUSED];

/**
 * Which states a listing may return, or `null` for "no restriction at all".
 *
 * Null rather than the full list of states, so that the common case — no filter —
 * produces a query with no `state` clause rather than one enumerating every value.
 */
const statesInView = (view: HistoryView | undefined, state: SyncJobState | undefined): SyncJobState[] | null => {
	const inView =
		view === HistoryView.LIVE
			? LIVE_STATES
			: view === HistoryView.FINISHED
				? FINISHED_SYNC_JOB_STATES
				: null;

	if (state === undefined) {
		return inView;
	}

	return inView === null ? [state] : inView.filter((one) => one === state);
};

@Injectable()
export class SyncJobRepository extends Repository<SyncJob> {
	public constructor(dataSource: DataSource) {
		super(SyncJob, dataSource.createEntityManager());
	}

	public findRunning(): Promise<SyncJob[]> {
		return this.find({ where: { state: SyncJobState.RUNNING }, order: { startedAt: 'ASC' } });
	}

	/** Anything not finished, which is what a restart has to adopt or fail. */
	public findLive(): Promise<SyncJob[]> {
		return this.find({ where: { state: In(LIVE_STATES) }, order: { createdAt: 'ASC' } });
	}

	/**
	 * Whether that plan already has a run in flight.
	 *
	 * Starting a second one would have two jobs pulling the same missing episodes into
	 * the same paths at the same time.
	 */
	public findLiveForPlan(planId: string): Promise<SyncJob | null> {
		return this.findOne({ where: { planId, state: In(LIVE_STATES) } });
	}

	public findByPlan(planId: string, limit = 20): Promise<SyncJob[]> {
		return this.find({ where: { planId }, order: { createdAt: 'DESC' }, take: limit });
	}

	public findRecent(limit = 20): Promise<SyncJob[]> {
		return this.find({ order: { createdAt: 'DESC' }, take: limit });
	}

	public async setState(id: string, state: SyncJobState, error: string | null = null): Promise<void> {
		await this.update({ id }, { state, error });
	}

	/**
	 * Forgets finished runs older than the retention window.
	 *
	 * `states` narrows which finished states are swept, because retention gives
	 * successes and failures different windows — a run that failed is the record of why
	 * a series has a hole in it, and a run that succeeded is described by the files it
	 * produced. Defaulting to every finished state keeps the plain "forget everything
	 * older than this" call meaning what it says.
	 *
	 * Only finished ones, whatever is passed: a run still pending was planned by
	 * somebody and has not happened yet.
	 */
	public async deleteFinishedBefore(
		before: Date,
		states: SyncJobState[] = FINISHED_SYNC_JOB_STATES,
	): Promise<number> {
		const swept = states.filter((state) => FINISHED_SYNC_JOB_STATES.includes(state));

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
	 * One page of the history, newest first, narrowed to a state or to half the list.
	 *
	 * The `where` is built here rather than in the manager so that "finished" is one
	 * list of states in one file.
	 *
	 * The two narrowings are intersected in TypeScript rather than in SQL: a request
	 * for the live half *and* for `done` is a contradiction, and resolving it here
	 * answers an empty page instead of letting one condition silently win. Composing
	 * two find operators on the same column would have produced whichever the driver
	 * rendered last, which is the kind of answer nobody can debug from the screen.
	 */
	public pageOf(options: {
		page: number;
		limit: number;
		state?: SyncJobState;
		view?: HistoryView;
	}): Promise<[SyncJob[], number]> {
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
