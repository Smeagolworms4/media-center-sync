import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
	KEPT_LONGER_SYNC_JOB_STATES,
	KEPT_LONGER_TRANSFER_STATES,
	SyncJobState,
	TransferState,
	type Settings,
} from '@mcs/shared';
import { MediaServiceRepository, SyncJobRepository, TransferRepository } from '@/repositories';
import { SchedulerService, SettingsService } from '@/services';
import { ServiceManager } from './service.manager';

/** What one cleanup pass removed, so the log line says something. */
export interface CleanupReport {
	jobs: number;
	transfers: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The gateway's own housekeeping: the periodic refresh, the scheduled full rescan and
 * the daily retention pass.
 *
 * This class exists because those three were the scheduler's three orphans. It knew
 * when to run them, `reload()` scheduled all three at every boot, and nothing had ever
 * called `onRefresh`, `onFullScan` or `onCleanup` — so the refresh interval, the full
 * scan expression and `transferHistoryDays` were three controls in the interface that
 * changed nothing at all. Nothing failed, because firing a task into `null` is not an
 * error; the features simply did not exist. `SchedulerHook` and
 * `SchedulerService.unsubscribedHooks()` are what stop the next one going the same
 * way, and the test that reads them is the point of both.
 *
 * Subscribing in `onModuleInit` rather than at bootstrap matters: the scheduler arms
 * its jobs in `onApplicationBootstrap`, and a subscription made then would race the
 * first tick. Subscriptions also survive `SettingsService` writes — `reload()` rebuilds
 * the jobs and never touches who listens to them — so a settings save cannot
 * disconnect the gateway from its own maintenance.
 */
@Injectable()
export class MaintenanceManager implements OnModuleInit {
	private readonly _logger = new Logger(MaintenanceManager.name);

	public constructor(
		private readonly _scheduler: SchedulerService,
		private readonly _settings: SettingsService,
		private readonly _services: MediaServiceRepository,
		private readonly _serviceManager: ServiceManager,
		private readonly _jobs: SyncJobRepository,
		private readonly _transfers: TransferRepository,
	) {}

	public onModuleInit(): void {
		this._scheduler.onRefresh(async () => {
			await this.refreshEverything();
		});
		this._scheduler.onFullScan(async () => {
			await this.scanEverything();
		});
		this._scheduler.onCleanup(async () => {
			await this.cleanup();
		});
	}

	/**
	 * Ask every one of our own services what changed.
	 *
	 * Only our own: a peer's services are indexed from what the peer tells us over the
	 * link, and walking them ourselves would be this gateway scanning somebody else's
	 * library on their hardware every fifteen minutes.
	 *
	 * The manager's own `_start` already refuses a second pass over a service that is
	 * still indexing, so a slow NAS makes the next tick a no-op rather than a second
	 * walk fighting the first.
	 */
	public async refreshEverything(): Promise<number> {
		return this._forEachOwnedService('refresh', (id) => this._serviceManager.refresh(id));
	}

	/** The same walk with full reach, for what a refresh structurally cannot see. */
	public async scanEverything(): Promise<number> {
		return this._forEachOwnedService('full scan', (id) => this._serviceManager.scan(id));
	}

	/**
	 * Forget finished work that is past its window.
	 *
	 * **Deletion, not archival, and that is a decision rather than the default.** The
	 * owner asked for one or the other and did not choose. Archiving — a flag, a second
	 * table, rows that stop being listed but survive — buys the ability to answer a
	 * question months later at the cost of a schema change on two drivers, a second
	 * meaning of "finished" everywhere something counts rows, and a table that still
	 * grows without bound, only invisibly. What it actually protects is narrower than
	 * it looks, because a successful transfer's row says nothing its file does not.
	 *
	 * What is worth protecting is the failures, so they get their own window instead:
	 * successes go after `transferHistoryDays` (thirty days), failures and
	 * cancellations after `failedHistoryDays` (six months). A transfer that failed
	 * three weeks ago is the answer to "why is this series incomplete", and it is still
	 * there when somebody finally asks. The cost of this choice against archival is
	 * that the answer is eventually gone for good rather than merely hidden; the cost
	 * of archival would have been a migration, a permanently growing table and two
	 * definitions of what a finished row is, for evidence nobody reads after half a
	 * year.
	 *
	 * The settings are read here, at the moment the tick arrives, rather than handed in
	 * when the job was registered — which is what made `transferHistoryDays` take
	 * effect only after a restart back when it took effect at all.
	 */
	public async cleanup(): Promise<CleanupReport> {
		const settings = await this._settings.get();
		const succeeded = this._cutOff(settings.transferHistoryDays);
		const failed = this._cutOff(settings.failedHistoryDays);

		const report: CleanupReport = {
			jobs:
				(await this._jobs.deleteFinishedBefore(succeeded, [SyncJobState.DONE])) +
				(await this._jobs.deleteFinishedBefore(failed, KEPT_LONGER_SYNC_JOB_STATES)),
			transfers:
				(await this._transfers.deleteFinishedBefore(succeeded, [TransferState.DONE])) +
				(await this._transfers.deleteFinishedBefore(failed, KEPT_LONGER_TRANSFER_STATES)),
		};

		if (report.jobs > 0 || report.transfers > 0) {
			this._logger.log(
				`Retention removed ${report.jobs} finished runs and ${report.transfers} finished transfers`,
			);
		}

		return report;
	}

	/**
	 * The instant before which a row of that age is past its window.
	 *
	 * Zero days means keep nothing, and has to resolve to "now" rather than to the
	 * epoch: somebody who sets the retention to zero is saying they never want history,
	 * and a cut-off of 1970 would keep all of it forever — the opposite of what they
	 * asked for, silently.
	 */
	private _cutOff(days: Settings['transferHistoryDays']): Date {
		return new Date(Date.now() - Math.max(0, days) * MILLISECONDS_PER_DAY);
	}

	/**
	 * Run a pass over every owned service, and let one failure cost only that service.
	 *
	 * A media server that is off returns a rejected promise. Left unguarded it would
	 * abandon the loop, so one unplugged NAS would stop every other service being
	 * refreshed — and the scheduler's own guard would log it once a night as a single
	 * failed job, naming neither the service nor the ones that were skipped.
	 */
	private async _forEachOwnedService(
		what: string,
		run: (serviceId: string) => Promise<void>,
	): Promise<number> {
		const services = await this._services.findOwned();
		let started = 0;

		for (const service of services) {
			try {
				await run(service.id);
				started += 1;
			} catch (error) {
				this._logger.warn(`Scheduled ${what} of ${service.name} failed: ${String(error)}`);
			}
		}

		return started;
	}
}
