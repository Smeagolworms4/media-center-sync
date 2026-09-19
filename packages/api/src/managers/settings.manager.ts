import type { Settings, UpdateSettingsRequest } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import {
	BandwidthService,
	SchedulerService,
	SettingsService,
	TransferEngineService,
} from '@/services';

/**
 * Reading and writing the gateway's settings.
 *
 * Thin on purpose — the merge with the defaults and the bounds belong to the service
 * that owns the table. What lives here are the consequences a write has beyond the
 * row, and there are two. Several settings are schedules, and a cron expression nobody
 * re-read is a setting that takes effect on the next restart rather than when it was
 * saved. The bandwidth caps are the same problem one layer down: the engine reads them
 * when it starts a transfer, so a limit saved while something is downloading has to be
 * handed to the running token bucket or it is a control that does nothing until the
 * queue moves on.
 */
@Injectable()
export class SettingsManager {
	private readonly _logger = new Logger(SettingsManager.name);

	public constructor(
		private readonly _settings: SettingsService,
		private readonly _scheduler: SchedulerService,
		private readonly _engine: TransferEngineService,
		private readonly _bandwidth: BandwidthService,
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

		if (patch.downloadRateLimit !== undefined || patch.uploadRateLimit !== undefined) {
			// The whole settings object, not the patch: the engine holds one number and
			// a caller who sent only the upload cap must not blank the download one.
			this._engine.applyRateLimits(settings);
			// Upload has no engine to hold its bucket — bytes leave through the peer
			// endpoint, one request at a time — so its cap lives in its own service and
			// has to be pushed there too.
			this._bandwidth.apply(settings);
			this._logger.log('Bandwidth limits applied to what is already running');
		}

		return settings;
	}
}
