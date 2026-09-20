import {
	ErrorKey,
	type Settings,
	type SettingsView,
	type UpdateSettingsRequest,
} from '@mcs/shared';
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
 *
 * The fourth is the category table, whose entries say what a category *is* and not
 * only where its files go — see `_followCategoryTargets`. It lives here, at the one
 * place settings are written, rather than in the controller or the screen, so that a
 * gateway configured over the API behaves like one configured from the interface.
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

	/**
	 * The settings a screen needs: the values, and which of them the deployment has
	 * taken out of its hands.
	 *
	 * The pinned list travels with the values rather than being a second request,
	 * because a form that renders before it arrives would offer an editable control
	 * for a locked field and then take it away — and somebody will have typed in it.
	 */
	public read(): Promise<SettingsView> {
		return this._settings.view();
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

		// Read before the write, because the table is replaced wholesale and the alias
		// rule below only acts on the entries this particular patch moved.
		const before =
			patch.categoryTargets === undefined
				? null
				: (await this._settings.get()).categoryTargets;

		const settings = await this._settings.update(patch);

		if (before !== null) {
			await this._followCategoryTargets(before, settings.categoryTargets);
		}

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
	 * A destination is also a statement about what a category is called.
	 *
	 * Saying "Séries goes to the Shows library" is saying that Séries *is* Shows on this
	 * gateway. Only half of that was ever acted on: `categoryTargets` decides where a
	 * new pull lands, `Library.alias` decides what merges into one category, and they
	 * are two mechanisms with one control. Somebody mapped their `Séries` onto `Shows`,
	 * expected one category, and kept seeing two with fourteen items stranded in the
	 * first — a reasonable reading the product did not support. So a mapping now names
	 * the category too.
	 *
	 * Only the entries that moved: re-applying the whole table on every unrelated save
	 * would put back an alias somebody deliberately removed on the libraries screen,
	 * hours later, with nothing on screen connecting the two.
	 *
	 * **Clearing a mapping leaves the alias alone**, and that is a decision rather than
	 * an omission. Once written, the alias that came from a mapping is indistinguishable
	 * from one somebody typed by hand — nothing records which wrote it, and adding that
	 * record would be a column that lies the first time the two are set in either order.
	 * Undoing it here would therefore rename libraries and re-split a category on the
	 * strength of an unrelated field being emptied, and the name somebody chose would be
	 * gone for good. Leaving it costs a stale grouping that one rename on the libraries
	 * screen undoes; destroying a name costs the name. Emptying the destination stops
	 * new files going there, which is exactly what the field says it does.
	 */
	private async _followCategoryTargets(
		before: Record<string, string>,
		after: Record<string, string>,
	): Promise<void> {
		for (const [key, libraryId] of Object.entries(after)) {
			if (before[key] === libraryId) {
				continue;
			}

			const name = await this._libraries.mergeCategoryInto(key, libraryId);

			if (name !== null) {
				this._logger.log(`Category ${key} now reads as ${name}, from its destination`);
			}
		}
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
