import { Injectable } from '@nestjs/common';
import { DataSource, LessThanOrEqual, Not, Repository } from 'typeorm';
import { SyncTrigger } from '@mcs/shared';
import { SyncPlan } from '@/entities';

@Injectable()
export class SyncPlanRepository extends Repository<SyncPlan> {
	public constructor(dataSource: DataSource) {
		super(SyncPlan, dataSource.createEntityManager());
	}

	public findEnabled(): Promise<SyncPlan[]> {
		return this.find({ where: { enabled: true }, order: { name: 'ASC' } });
	}

	public findByTrigger(trigger: SyncTrigger): Promise<SyncPlan[]> {
		return this.find({ where: { enabled: true, trigger }, order: { name: 'ASC' } });
	}

	/** Scheduled plans, which are the ones the scheduler has to keep a cron for. */
	public findScheduled(): Promise<SyncPlan[]> {
		return this.find({
			where: { enabled: true, trigger: SyncTrigger.SCHEDULE, schedule: Not('') },
			order: { name: 'ASC' },
		});
	}

	/**
	 * Plans whose turn has passed.
	 *
	 * Read on catch-up rather than trusted to timers alone: a gateway that was off at
	 * three in the morning would otherwise skip the night's run entirely and wait a
	 * full day.
	 */
	public findDue(now: Date = new Date()): Promise<SyncPlan[]> {
		return this.find({
			where: { enabled: true, nextRunAt: LessThanOrEqual(now) },
			order: { nextRunAt: 'ASC' },
		});
	}

	public async setRunStamps(id: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void> {
		await this.update({ id }, { lastRunAt, nextRunAt });
	}
}
