import type { Settings, UpdateSettingsRequest } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { SchedulerService, SettingsService } from '@/services';

/**
 * Reading and writing the gateway's settings.
 *
 * Thin on purpose — the merge with the defaults and the bounds belong to the service
 * that owns the table. What lives here is the one consequence a write has beyond the
 * row: several settings are schedules, and a cron expression nobody re-read is a
 * setting that takes effect on the next restart rather than when it was saved.
 */
@Injectable()
export class SettingsManager {
	private readonly _logger = new Logger(SettingsManager.name);

	public constructor(
		private readonly _settings: SettingsService,
		private readonly _scheduler: SchedulerService,
	) {}

	public read(): Promise<Settings> {
		return this._settings.get();
	}

	/**
	 * A merge, never a replacement: only the keys that were sent are written.
	 *
	 * Two screens saving at the same time would otherwise overwrite each other's
	 * unrelated fields, and the one that saved first would see its change disappear
	 * with nothing reporting anything.
	 */
	public async write(patch: UpdateSettingsRequest): Promise<Settings> {
		const settings = await this._settings.update(patch);

		if (patch.refreshIntervalMinutes !== undefined || patch.fullScanCron !== undefined) {
			await this._scheduler.reload();
			this._logger.log('Schedules reloaded after a settings change');
		}

		return settings;
	}
}
