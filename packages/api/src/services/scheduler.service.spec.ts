import type { SchedulerRegistry } from '@nestjs/schedule';
import type { Settings } from '@mcs/shared';
import { SchedulerHook, SchedulerService, type SchedulablePlan } from './scheduler.service';
import { DEFAULT_SETTINGS, type SettingsService } from './settings.service';

interface FakeJob {
	/** The real `CronJob` is what gets registered; only these two are used here. */
	start: jest.Mock;
	stop: jest.Mock;
}

describe('SchedulerService', () => {
	let cronJobs: Map<string, FakeJob>;
	let intervals: Map<string, NodeJS.Timeout>;
	let registry: SchedulerRegistry;
	let settings: Settings;
	let service: SchedulerService;

	beforeEach(() => {
		cronJobs = new Map();
		intervals = new Map();
		settings = { ...DEFAULT_SETTINGS };

		registry = {
			addCronJob: jest.fn((name: string, job: FakeJob) => cronJobs.set(name, job)),
			deleteCronJob: jest.fn((name: string) => {
				const job = cronJobs.get(name);

				if (!job) {
					throw new Error('no such job');
				}

				// The real registry stops a job it removes. Without this the CronJob's
				// own timer stays armed and the test process never exits.
				job.stop();
				cronJobs.delete(name);
			}),
			getCronJobs: jest.fn(() => cronJobs),
			getCronJob: jest.fn((name: string) => {
				const job = cronJobs.get(name);

				if (!job) {
					throw new Error('no such job');
				}

				return job;
			}),
			addInterval: jest.fn((name: string, handle: NodeJS.Timeout) => intervals.set(name, handle)),
			deleteInterval: jest.fn((name: string) => {
				const handle = intervals.get(name);

				if (!handle) {
					throw new Error('no such interval');
				}

				clearInterval(handle);
				intervals.delete(name);
			}),
		} as unknown as SchedulerRegistry;

		service = new SchedulerService(registry, {
			get: async () => settings,
		} as unknown as SettingsService);
	});

	afterEach(() => {
		service.onModuleDestroy();
	});

	function plan(overrides: Partial<SchedulablePlan> = {}): SchedulablePlan {
		return { id: 'plan-1', name: 'Nightly', schedule: '0 2 * * *', enabled: true, ...overrides };
	}

	it('registers the refresh, the full scan and the cleanup at boot', async () => {
		await service.onApplicationBootstrap();

		expect(intervals.has('mcs:refresh')).toBe(true);
		expect(cronJobs.has('mcs:full-scan')).toBe(true);
		expect(cronJobs.has('mcs:cleanup')).toBe(true);
	});

	it('leaves the full scan unregistered when it is disabled', async () => {
		// Somebody with a slow NAS is entitled never to run one automatically; the
		// button in the interface still works.
		settings.fullScanCron = null;

		await service.reload();

		expect(cronJobs.has('mcs:full-scan')).toBe(false);
	});

	it('replaces the fixed jobs rather than stacking them', async () => {
		await service.reload();
		await service.reload();

		expect(cronJobs.size + intervals.size).toBe(3);
	});

	it('registers a plan that has a schedule', () => {
		service.registerPlans([plan()]);

		expect(cronJobs.has('mcs:plan:plan-1')).toBe(true);
	});

	it('does not register a disabled plan, or one with no schedule', () => {
		service.registerPlans([
			plan({ id: 'off', enabled: false }),
			plan({ id: 'manual', schedule: null }),
		]);

		expect(cronJobs.size).toBe(0);
	});

	it('removes a plan that is no longer in the set', () => {
		// A plan deleted in the interface has to disappear without anybody remembering
		// to say so.
		service.registerPlans([plan()]);
		service.registerPlans([]);

		expect(cronJobs.has('mcs:plan:plan-1')).toBe(false);
	});

	it('re-registers a plan whose schedule changed, exactly once', () => {
		// Forgetting the removal is how a plan ends up running twice per tick, and then
		// four times.
		service.registerPlans([plan()]);
		service.registerPlans([plan({ schedule: '0 5 * * *' })]);

		expect(cronJobs.size).toBe(1);
	});

	it('unregisters one plan on demand', () => {
		service.registerPlans([plan()]);
		service.unregisterPlan('plan-1');

		expect(cronJobs.has('mcs:plan:plan-1')).toBe(false);
	});

	it('survives a cron expression that does not parse', () => {
		// It comes from a form. The plan never fires until somebody fixes it, and the
		// gateway keeps running.
		expect(() => service.registerPlans([plan({ schedule: 'not a cron' })])).not.toThrow();
		expect(cronJobs.has('mcs:plan:plan-1')).toBe(false);
	});

	it('starts the job it registers, under the name of the plan', () => {
		service.onPlan(jest.fn());
		service.registerPlans([plan()]);

		const [name] = (registry.addCronJob as jest.Mock).mock.calls[0] as [string];

		expect(name).toBe('mcs:plan:plan-1');
		expect(cronJobs.get('mcs:plan:plan-1')?.start).toBeDefined();
	});

	it('does not let a failing task take the schedule down', async () => {
		// An unhandled rejection inside a cron callback kills the process on a modern
		// Node, which would turn one unreachable media server into a restart loop.
		const failing = jest.fn(async () => {
			throw new Error('media server unreachable');
		});

		service.onRefresh(failing);
		await service.reload();

		const handle = intervals.get('mcs:refresh') as NodeJS.Timeout & { _onTimeout?: () => void };

		await expect(Promise.resolve(handle._onTimeout?.())).resolves.toBeUndefined();
	});

	/**
	 * The guard that the whole rework exists for.
	 *
	 * Three of these hooks had no subscriber anywhere in the application for the life
	 * of the product: the refresh, the full scan and the retention cleanup were
	 * scheduled at every boot and fired into nothing. A hook added to the enum and
	 * never subscribed now fails here and in the functional suite, where the real
	 * container is the one being asked.
	 */
	describe('subscriptions', () => {
		it('reports every hook as unsubscribed when nobody has claimed one', () => {
			expect(service.unsubscribedHooks()).toEqual(Object.values(SchedulerHook));
		});

		it('reports none once all four are claimed', () => {
			service.onRefresh(jest.fn());
			service.onFullScan(jest.fn());
			service.onCleanup(jest.fn());
			service.onPlan(jest.fn());

			expect(service.unsubscribedHooks()).toEqual([]);
		});

		it('names exactly the hook that was forgotten', () => {
			service.onRefresh(jest.fn());
			service.onFullScan(jest.fn());
			service.onPlan(jest.fn());

			expect(service.unsubscribedHooks()).toEqual([SchedulerHook.CLEANUP]);
		});
	});

	it('answers nothing for the next run of a plan it does not hold', () => {
		expect(service.nextRunAt('unknown')).toBeNull();
	});

	it('says when a plan it holds is next due', () => {
		// The plans screen shows it, and a null there reads as "never" rather than as
		// "this service could not work it out".
		service.registerPlans([plan({ schedule: '0 2 * * *' })]);

		const next = service.nextRunAt('plan-1');

		expect(next).toBeInstanceOf(Date);
		expect((next as Date).getTime()).toBeGreaterThan(Date.now());
	});

	describe('when a job fires', () => {
		/** The real `CronJob` is what is registered, so the tick is fired through it. */
		async function fire(name: string): Promise<void> {
			const job = cronJobs.get(name) as unknown as { fireOnTick: () => Promise<void> | void };

			await job.fireOnTick();
			// The callbacks are started rather than awaited by `CronJob`, so the tasks
			// they run settle a turn of the loop later.
			await new Promise((resolve) => setImmediate(resolve));
		}

		it('runs the full scan that was handed in', async () => {
			const fullScan = jest.fn(async () => undefined);

			service.onFullScan(fullScan);
			await service.reload();
			await fire('mcs:full-scan');

			expect(fullScan).toHaveBeenCalledTimes(1);
		});

		it('runs the cleanup, and tells it nothing about the retention', async () => {
			// The retention used to be read here and handed over when the job was
			// registered, which froze it until the next reload — and nothing reloads on
			// that field. The subscriber reads the settings when the tick arrives, so a
			// number saved at noon is in force that night.
			const cleanup = jest.fn(async () => undefined);

			settings.transferHistoryDays = 7;
			service.onCleanup(cleanup);
			await service.reload();
			await fire('mcs:cleanup');

			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith();
		});

		it('runs the refresh that was handed in', async () => {
			const refresh = jest.fn(async () => undefined);

			service.onRefresh(refresh);
			await service.reload();

			const handle = intervals.get('mcs:refresh') as NodeJS.Timeout & { _onTimeout?: () => void };

			await handle._onTimeout?.();

			expect(refresh).toHaveBeenCalledTimes(1);
		});

		it('runs the plan the job is named after, and no other', async () => {
			const onPlan = jest.fn(async () => undefined);

			service.onPlan(onPlan);
			service.registerPlans([plan(), plan({ id: 'plan-2', schedule: '0 5 * * *' })]);
			await fire('mcs:plan:plan-2');

			expect(onPlan).toHaveBeenCalledWith('plan-2');
			expect(onPlan).toHaveBeenCalledTimes(1);
		});

		it('does nothing at all when nobody handed a task in', async () => {
			// The jobs are registered at boot and the managers attach their tasks
			// afterwards, so a tick landing in that window has nothing to call.
			await service.reload();

			await expect(fire('mcs:cleanup')).resolves.toBeUndefined();
			await expect(fire('mcs:full-scan')).resolves.toBeUndefined();
		});

		it('does not let a failing plan take the schedule down', async () => {
			service.onPlan(async () => {
				throw new Error('the library is not mounted');
			});
			service.registerPlans([plan()]);

			await expect(fire('mcs:plan:plan-1')).resolves.toBeUndefined();
			expect(cronJobs.has('mcs:plan:plan-1')).toBe(true);
		});
	});

	it('drops every job when the module goes down', async () => {
		await service.reload();
		service.registerPlans([plan()]);

		service.onModuleDestroy();

		expect(cronJobs.size).toBe(0);
		expect(intervals.size).toBe(0);
	});
});
