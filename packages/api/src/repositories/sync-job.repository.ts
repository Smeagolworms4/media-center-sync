import { Injectable } from '@nestjs/common';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { SyncJobState } from '@mcs/shared';
import { SyncJob } from '@/entities';

const LIVE_STATES = [SyncJobState.PENDING, SyncJobState.RUNNING, SyncJobState.PAUSED];

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

	public async deleteFinishedBefore(before: Date): Promise<number> {
		const result = await this.delete({
			state: In([SyncJobState.DONE, SyncJobState.FAILED, SyncJobState.CANCELLED]),
			finishedAt: LessThan(before),
		});

		return result.affected ?? 0;
	}
}
