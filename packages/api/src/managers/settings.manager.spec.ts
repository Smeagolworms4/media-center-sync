import {
	DEFAULT_SETTINGS,
	type BandwidthService,
	type SchedulerService,
	type SettingsService,
	type TransferEngineService,
} from '@/services';
import { SettingsManager } from './settings.manager';

interface Fakes {
	settings: { get: jest.Mock; update: jest.Mock };
	scheduler: { reload: jest.Mock };
	engine: { applyRateLimits: jest.Mock };
	bandwidth: { apply: jest.Mock };
}

const build = (): { manager: SettingsManager; fakes: Fakes } => {
	const fakes: Fakes = {
		settings: {
			get: jest.fn().mockResolvedValue(DEFAULT_SETTINGS),
			update: jest.fn((patch: Record<string, unknown>) =>
				Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
			),
		},
		scheduler: { reload: jest.fn().mockResolvedValue(undefined) },
		engine: { applyRateLimits: jest.fn() },
		bandwidth: { apply: jest.fn() },
	};

	return {
		manager: new SettingsManager(
			fakes.settings as unknown as SettingsService,
			fakes.scheduler as unknown as SchedulerService,
			fakes.engine as unknown as TransferEngineService,
			fakes.bandwidth as unknown as BandwidthService,
		),
		fakes,
	};
};

describe('SettingsManager', () => {
	it('writes only what was sent, so two screens cannot overwrite each other', async () => {
		const { manager, fakes } = build();

		await manager.write({ maxParallelTransfers: 8 });

		expect(fakes.settings.update).toHaveBeenCalledWith({ maxParallelTransfers: 8 });
	});

	it('reloads the schedules when the refresh interval moves', async () => {
		const { manager, fakes } = build();

		await manager.write({ refreshIntervalMinutes: 30 });

		expect(fakes.scheduler.reload).toHaveBeenCalled();
	});

	it('reloads them when the full-scan expression moves, emptied included', async () => {
		const { manager, fakes } = build();

		await manager.write({ fullScanCron: null });

		expect(fakes.scheduler.reload).toHaveBeenCalled();
	});

	it('leaves the clock alone for a setting that has nothing to do with it', async () => {
		const { manager, fakes } = build();

		await manager.write({ downloadRateLimit: 1_000_000 });

		expect(fakes.scheduler.reload).not.toHaveBeenCalled();
	});

	it('pushes a new bandwidth cap into the transfers already running', async () => {
		const { manager, fakes } = build();

		await manager.write({ downloadRateLimit: 1_000_000 });

		// The whole settings object, not the patch: the engine holds one number, and a
		// caller who only sent one of the two caps must not blank the other.
		expect(fakes.engine.applyRateLimits).toHaveBeenCalledWith(
			expect.objectContaining({ downloadRateLimit: 1_000_000 }),
		);
	});

	it('pushes it for an upload cap too, since both live in the same engine', async () => {
		const { manager, fakes } = build();

		await manager.write({ uploadRateLimit: 500_000 });

		expect(fakes.engine.applyRateLimits).toHaveBeenCalled();
	});

	it('leaves the engine alone for a setting that has nothing to do with bandwidth', async () => {
		const { manager, fakes } = build();

		await manager.write({ maxParallelTransfers: 8 });

		expect(fakes.engine.applyRateLimits).not.toHaveBeenCalled();
	});

	it('reads through to the service that owns the defaults', async () => {
		const { manager } = build();

		await expect(manager.read()).resolves.toEqual(DEFAULT_SETTINGS);
	});
});
