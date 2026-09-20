import { SyncJobState, TransferState, type Settings } from '@mcs/shared';
import type { MediaService as MediaServiceEntity } from '@/entities';
import type { MediaServiceRepository, SyncJobRepository, TransferRepository } from '@/repositories';
import { DEFAULT_SETTINGS, type SchedulerService, type SettingsService } from '@/services';
import type { ServiceManager } from './service.manager';
import { MaintenanceManager } from './maintenance.manager';

const DAY = 24 * 60 * 60 * 1000;

/** One deletion the repository was asked for: a cut-off and the states it applies to. */
interface Sweep {
	before: Date;
	states: string[];
}

describe('MaintenanceManager', () => {
	let settings: Settings;
	let jobSweeps: Sweep[];
	let transferSweeps: Sweep[];
	let refreshed: string[];
	let scanned: string[];
	let services: MediaServiceEntity[];
	let scheduler: {
		onRefresh: jest.Mock;
		onFullScan: jest.Mock;
		onCleanup: jest.Mock;
	};
	let manager: MaintenanceManager;

	beforeEach(() => {
		settings = { ...DEFAULT_SETTINGS };
		jobSweeps = [];
		transferSweeps = [];
		refreshed = [];
		scanned = [];
		services = [
			{ id: 'svc-1', name: 'Living room' } as MediaServiceEntity,
			{ id: 'svc-2', name: 'Attic' } as MediaServiceEntity,
		];

		scheduler = {
			onRefresh: jest.fn(),
			onFullScan: jest.fn(),
			onCleanup: jest.fn(),
		};

		manager = new MaintenanceManager(
			scheduler as unknown as SchedulerService,
			{ get: async () => settings } as unknown as SettingsService,
			{ findOwned: async () => services } as unknown as MediaServiceRepository,
			{
				refresh: async (id: string) => {
					refreshed.push(id);
				},
				scan: async (id: string) => {
					scanned.push(id);
				},
			} as unknown as ServiceManager,
			{
				deleteFinishedBefore: async (before: Date, states: string[]) => {
					jobSweeps.push({ before, states });

					return states.length;
				},
			} as unknown as SyncJobRepository,
			{
				deleteFinishedBefore: async (before: Date, states: string[]) => {
					transferSweeps.push({ before, states });

					return states.length;
				},
			} as unknown as TransferRepository,
		);
	});

	/** All the states any sweep was asked to remove, flattened. */
	const sweptStates = (sweeps: Sweep[]): string[] => sweeps.flatMap((sweep) => sweep.states);

	/** How many days back a sweep's cut-off is, rounded to the nearest day. */
	const daysBack = (sweep: Sweep): number => Math.round((Date.now() - sweep.before.getTime()) / DAY);

	describe('subscribing to the clock', () => {
		it('claims the refresh, the full scan and the cleanup', () => {
			// The defect this class exists for: all three were scheduled at every boot
			// and nobody had ever subscribed to any of them.
			manager.onModuleInit();

			expect(scheduler.onRefresh).toHaveBeenCalledTimes(1);
			expect(scheduler.onFullScan).toHaveBeenCalledTimes(1);
			expect(scheduler.onCleanup).toHaveBeenCalledTimes(1);
		});

		it('hands in tasks that actually do the work', async () => {
			manager.onModuleInit();

			await (scheduler.onRefresh.mock.calls[0][0] as () => Promise<void>)();
			await (scheduler.onFullScan.mock.calls[0][0] as () => Promise<void>)();
			await (scheduler.onCleanup.mock.calls[0][0] as () => Promise<void>)();

			expect(refreshed).toEqual(['svc-1', 'svc-2']);
			expect(scanned).toEqual(['svc-1', 'svc-2']);
			expect(jobSweeps.length).toBeGreaterThan(0);
		});
	});

	describe('refreshing and scanning', () => {
		it('asks every service we own, and only those', async () => {
			expect(await manager.refreshEverything()).toBe(2);
			expect(refreshed).toEqual(['svc-1', 'svc-2']);
		});

		it('lets one unreachable server cost only itself', async () => {
			// Unguarded, a rejected promise would abandon the loop and one unplugged NAS
			// would stop every other service being refreshed, silently.
			manager = new MaintenanceManager(
				scheduler as unknown as SchedulerService,
				{ get: async () => settings } as unknown as SettingsService,
				{ findOwned: async () => services } as unknown as MediaServiceRepository,
				{
					refresh: async (id: string) => {
						if (id === 'svc-1') {
							throw new Error('connect ECONNREFUSED');
						}

						refreshed.push(id);
					},
				} as unknown as ServiceManager,
				{ deleteFinishedBefore: async () => 0 } as unknown as SyncJobRepository,
				{ deleteFinishedBefore: async () => 0 } as unknown as TransferRepository,
			);

			expect(await manager.refreshEverything()).toBe(1);
			expect(refreshed).toEqual(['svc-2']);
		});
	});

	describe('retention', () => {
		it('sweeps successes on the transfer history window', async () => {
			settings.transferHistoryDays = 30;

			await manager.cleanup();

			const successes = jobSweeps.find((sweep) => sweep.states.includes(SyncJobState.DONE));

			expect(successes).toBeDefined();
			expect(daysBack(successes as Sweep)).toBe(30);
			expect((successes as Sweep).states).toEqual([SyncJobState.DONE]);
		});

		it('keeps failures and cancellations on their own, longer window', async () => {
			// A transfer that failed three weeks ago is the evidence of why a series is
			// incomplete. Treating it like a success would destroy the answer before
			// anybody thought to ask the question.
			settings.transferHistoryDays = 30;
			settings.failedHistoryDays = 180;

			await manager.cleanup();

			const kept = transferSweeps.find((sweep) => sweep.states.includes(TransferState.FAILED));

			expect(kept).toBeDefined();
			expect(daysBack(kept as Sweep)).toBe(180);
			expect((kept as Sweep).states).toEqual([TransferState.FAILED, TransferState.CANCELLED]);
		});

		it('never asks for a state that is not finished', async () => {
			await manager.cleanup();

			for (const state of [...sweptStates(jobSweeps), ...sweptStates(transferSweeps)]) {
				expect([
					SyncJobState.DONE,
					SyncJobState.FAILED,
					SyncJobState.CANCELLED,
				]).toContain(state);
			}
		});

		it('follows the setting rather than a constant', async () => {
			settings.transferHistoryDays = 7;
			settings.failedHistoryDays = 7;

			await manager.cleanup();

			for (const sweep of [...jobSweeps, ...transferSweeps]) {
				expect(daysBack(sweep)).toBe(7);
			}
		});

		it('reads the settings on every pass, not once at startup', async () => {
			// The old design handed the retention in when the job was registered, which
			// froze it until a reload nothing triggers for that field.
			settings.transferHistoryDays = 30;
			await manager.cleanup();

			settings.transferHistoryDays = 1;
			jobSweeps = [];
			transferSweeps = [];
			await manager.cleanup();

			const successes = jobSweeps.find((sweep) => sweep.states.includes(SyncJobState.DONE));

			expect(daysBack(successes as Sweep)).toBe(1);
		});

		it('reads a retention of zero as now, not as the epoch', async () => {
			// Somebody who sets it to zero wants no history at all. A cut-off of 1970
			// would keep every row forever, which is the opposite, silently.
			settings.transferHistoryDays = 0;

			await manager.cleanup();

			const successes = jobSweeps.find((sweep) => sweep.states.includes(SyncJobState.DONE));

			expect(Date.now() - (successes as Sweep).before.getTime()).toBeLessThan(5_000);
		});

		it('reports what it removed, so the log line says something', async () => {
			const report = await manager.cleanup();

			expect(report.jobs).toBe(3);
			expect(report.transfers).toBe(3);
		});
	});
});
