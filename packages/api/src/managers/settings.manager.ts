import { ErrorKey, type Settings, type UpdateSettingsRequest } from '@mcs/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
	BandwidthService,
	normaliseTargetPath,
	SchedulerService,
	SettingsService,
	TransferEngineService,
} from '@/services';
import { LibraryManager } from './library.manager';

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
 *
 * The third is the default target folder, which is a path on a real filesystem and so
 * has to be probed before it is believed. That probe lives with the library paths,
 * which is why a manager reaches for another manager here: two probes of the same
 * question drift apart, and this one already answers it.
 */
@Injectable()
export class SettingsManager {
	private readonly _logger = new Logger(SettingsManager.name);

	public constructor(
		private readonly _settings: SettingsService,
		private readonly _scheduler: SchedulerService,
		private readonly _engine: TransferEngineService,
		private readonly _bandwidth: BandwidthService,
		private readonly _libraries: LibraryManager,
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
		if (patch.defaultTargetPath !== undefined) {
			await this._requireWritable(normaliseTargetPath(patch.defaultTargetPath));
		}

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

	/**
	 * A fallback nobody can write into is worse than no fallback at all.
	 *
	 * It is the placement of last resort: whatever reaches it has already been chosen,
	 * queued and downloaded in full, and a directory that refuses the write turns that
	 * into a completed transfer with nowhere to put its file. Probed at the moment
	 * somebody types it, exactly as a library path is, rather than discovered then.
	 */
	private async _requireWritable(path: string | null): Promise<void> {
		if (path === null) {
			return;
		}

		const probe = await this._libraries.probe(path);

		if (!probe.writable) {
			this._logger.warn(`Refused ${path} as the default target: ${probe.error ?? 'not writable'}`);

			throw new BadRequestException({
				key: ErrorKey.SETTINGS_TARGET_PATH_NOT_WRITABLE,
				field: 'defaultTargetPath',
			});
		}
	}
}
