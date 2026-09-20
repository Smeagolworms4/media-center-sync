import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SettingsService } from './settings.service';

/** Job names, so a re-registration replaces rather than duplicates. */
const REFRESH_JOB = 'mcs:refresh';
const FULL_SCAN_JOB = 'mcs:full-scan';
const CLEANUP_JOB = 'mcs:cleanup';
const PLAN_PREFIX = 'mcs:plan:';

/** Cleanup runs once a day at an hour nobody is watching. */
const CLEANUP_CRON = '0 3 * * *';

export type ScheduledTask = () => Promise<void> | void;

/**
 * Every task this service will ever call, by name.
 *
 * It exists so that "does anybody actually listen to this?" is a question code can
 * ask. Three of these fired into `null` for the whole life of the product: the
 * periodic refresh, the scheduled full rescan and the daily retention cleanup were
 * configurable in the interface, scheduled faithfully at boot, and did nothing,
 * because no one had ever called `onRefresh`, `onFullScan` or `onCleanup`. Nothing
 * failed and nothing logged, which is why it lasted.
 *
 * `unsubscribedHooks()` turns that into a test. Adding a value here and forgetting
 * the subscriber now breaks the suite instead of shipping a feature that is only a
 * screen.
 */
export enum SchedulerHook {
	REFRESH = 'refresh',
	FULL_SCAN = 'fullScan',
	CLEANUP = 'cleanup',
	PLAN = 'plan',
}

/** A plan as the scheduler needs it: an identifier, an expression, enabled or not. */
export interface SchedulablePlan {
	id: string;
	name: string;
	schedule: string | null;
	enabled: boolean;
}

/**
 * The clock.
 *
 * Nothing here decides anything: the tasks are handed in by the managers, and this
 * class only knows when to call them. That is the whole reason it can be a service —
 * "run the refresh every fifteen minutes" is a schedule, "this library needs
 * refreshing" is a decision.
 *
 * Plans are registered dynamically because a plan is a row somebody edits, not a
 * decorator: a schedule changed in the interface has to take effect without a
 * restart, which means removing the old job and adding the new one under the same
 * name. Forgetting the removal is how a plan ends up running twice per tick, and
 * then four times, once somebody has edited it twice.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly _logger = new Logger(SchedulerService.name);

	/**
	 * The subscribers, in one map rather than in four fields.
	 *
	 * Four fields cannot be counted, and counting them is the point: `unsubscribedHooks`
	 * reads this against `SchedulerHook` and is what keeps a task from being scheduled
	 * with nobody on the other end.
	 */
	private readonly _tasks = new Map<SchedulerHook, (...args: never[]) => Promise<void> | void>();

	public constructor(
		private readonly _scheduler: SchedulerRegistry,
		private readonly _settings: SettingsService,
	) {}

	public onRefresh(task: ScheduledTask): void {
		this._subscribe(SchedulerHook.REFRESH, task);
	}

	public onFullScan(task: ScheduledTask): void {
		this._subscribe(SchedulerHook.FULL_SCAN, task);
	}

	/**
	 * Takes no argument, and that is the fix rather than an omission.
	 *
	 * It used to be handed `transferHistoryDays`, read once when the job was
	 * registered. That put a business decision — which setting governs retention — in
	 * the clock, and froze the value: changing the retention only took effect on the
	 * next `reload()`, which nothing triggers for that field. The manager reads the
	 * settings when the tick arrives, so a number saved at noon is in force that night.
	 */
	public onCleanup(task: ScheduledTask): void {
		this._subscribe(SchedulerHook.CLEANUP, task);
	}

	public onPlan(task: (planId: string) => Promise<void> | void): void {
		this._subscribe(SchedulerHook.PLAN, task);
	}

	/** The hooks this service will call and nobody has claimed. Empty, or it is a bug. */
	public unsubscribedHooks(): SchedulerHook[] {
		return Object.values(SchedulerHook).filter((hook) => !this._tasks.has(hook));
	}

	public async onApplicationBootstrap(): Promise<void> {
		await this.reload();
	}

	/**
	 * Re-read the settings and rebuild the fixed jobs.
	 *
	 * Called at boot and whenever the settings change, because the refresh interval
	 * and the full-scan expression both live there and neither is worth a restart.
	 */
	public async reload(): Promise<void> {
		const settings = await this._settings.get();

		this._replaceInterval(REFRESH_JOB, settings.refreshIntervalMinutes * 60 * 1000, async () => {
			await this._safely(REFRESH_JOB, this._task(SchedulerHook.REFRESH));
		});

		if (settings.fullScanCron) {
			this._replaceCron(FULL_SCAN_JOB, settings.fullScanCron, async () => {
				await this._safely(FULL_SCAN_JOB, this._task(SchedulerHook.FULL_SCAN));
			});
		} else {
			// An empty expression disables the full scan on purpose: the button in the
			// interface always works, and somebody with a slow NAS is entitled to never
			// run one automatically.
			this._remove(FULL_SCAN_JOB);
		}

		this._replaceCron(CLEANUP_JOB, CLEANUP_CRON, async () => {
			await this._safely(CLEANUP_JOB, this._task(SchedulerHook.CLEANUP));
		});
	}

	/**
	 * Register every plan that has a schedule, replacing what was there.
	 *
	 * Takes the whole set rather than one plan, so a plan deleted in the interface
	 * disappears from the scheduler without anybody having to remember to say so.
	 */
	public registerPlans(plans: SchedulablePlan[]): void {
		const wanted = new Set(
			plans
				.filter((plan) => plan.enabled && !!plan.schedule)
				.map((plan) => `${PLAN_PREFIX}${plan.id}`),
		);

		for (const name of this._planJobNames()) {
			if (!wanted.has(name)) {
				this._remove(name);
			}
		}

		for (const plan of plans) {
			const name = `${PLAN_PREFIX}${plan.id}`;

			if (!plan.enabled || !plan.schedule) {
				this._remove(name);

				continue;
			}

			this._replaceCron(name, plan.schedule, async () => {
				const onPlan = this._task<(planId: string) => Promise<void> | void>(SchedulerHook.PLAN);

				await this._safely(name, () => onPlan?.(plan.id));
			});
		}
	}

	public unregisterPlan(planId: string): void {
		this._remove(`${PLAN_PREFIX}${planId}`);
	}

	/** When each job is due, for the plans screen. */
	public nextRunAt(planId: string): Date | null {
		try {
			const job = this._scheduler.getCronJob(`${PLAN_PREFIX}${planId}`);
			const next = job.nextDate();

			return next ? new Date(next.toMillis()) : null;
		} catch {
			return null;
		}
	}

	public onModuleDestroy(): void {
		for (const name of [REFRESH_JOB, FULL_SCAN_JOB, CLEANUP_JOB, ...this._planJobNames()]) {
			this._remove(name);
		}
	}

	private _subscribe(hook: SchedulerHook, task: (...args: never[]) => Promise<void> | void): void {
		this._tasks.set(hook, task);
	}

	/**
	 * The map holds four signatures, so reading one back needs a cast.
	 *
	 * Confined to this one line rather than spread over four call sites: what a hook's
	 * task takes is stated by the `onX` method that accepts it, and no other code here
	 * is in a position to get it wrong.
	 */
	private _task<T = ScheduledTask>(hook: SchedulerHook): T | undefined {
		return this._tasks.get(hook) as T | undefined;
	}

	private _planJobNames(): string[] {
		return [...this._scheduler.getCronJobs().keys()].filter((name) =>
			name.startsWith(PLAN_PREFIX),
		);
	}

	private _replaceCron(name: string, expression: string, task: ScheduledTask): void {
		this._remove(name);

		try {
			const job = new CronJob(expression, () => {
				void task();
			});

			this._scheduler.addCronJob(name, job as unknown as Parameters<SchedulerRegistry['addCronJob']>[1]);
			job.start();
		} catch (error) {
			// A cron expression comes from a form. One that does not parse must not stop
			// the gateway, and the plan simply never fires until somebody fixes it.
			this._logger.error(`Job "${name}" has an invalid schedule "${expression}": ${String(error)}`);
		}
	}

	private _replaceInterval(name: string, milliseconds: number, task: ScheduledTask): void {
		this._remove(name);

		const handle = setInterval(() => {
			void task();
		}, Math.max(60_000, milliseconds));

		this._scheduler.addInterval(name, handle);
	}

	private _remove(name: string): void {
		try {
			this._scheduler.deleteCronJob(name);
		} catch {
			// Not a cron job, or not registered. Both are fine; this is a removal.
		}

		try {
			this._scheduler.deleteInterval(name);
		} catch {
			// Same.
		}
	}

	/**
	 * A task that throws must not take the schedule with it.
	 *
	 * An unhandled rejection inside a cron callback kills the process on a modern
	 * Node, which would turn one unreachable media server into a gateway that
	 * restarts every fifteen minutes.
	 */
	private async _safely(name: string, task: ScheduledTask | null | undefined): Promise<void> {
		if (!task) {
			return;
		}

		try {
			await task();
		} catch (error) {
			this._logger.error(`Scheduled job "${name}" failed: ${String(error)}`);
		}
	}
}
