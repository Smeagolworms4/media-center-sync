import { DEFAULT_SETTINGS, type SchedulerService, type SettingsService } from '@/services';
import { SettingsManager } from './settings.manager';

interface Fakes {
	settings: { get: jest.Mock; update: jest.Mock };
	scheduler: { reload: jest.Mock };
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
	};

	return {
		manager: new SettingsManager(
			fakes.settings as unknown as SettingsService,
			fakes.scheduler as unknown as SchedulerService,
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

	it('reads through to the service that owns the defaults', async () => {
		const { manager } = build();

		await expect(manager.read()).resolves.toEqual(DEFAULT_SETTINGS);
	});
});
