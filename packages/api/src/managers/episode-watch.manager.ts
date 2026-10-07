import { NotificationEvent, type MediaGroup } from '@mcs/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { breathe, SchedulerService, SettingsService } from '@/services';
import { MediaGroupManager } from './media-group.manager';
import { NotificationManager } from './notification.manager';
import { ReleaseManager } from './release.manager';

/**
 * How many followed shows one pass looks at.
 *
 * A ceiling rather than a page size: every show costs one search against every tracker,
 * and a household following three hundred of them would otherwise spend its whole watch
 * interval searching. The ones left out are looked at on the next pass, because the list
 * is ordered and the gaps that were filled drop out of it.
 */
export const WATCH_BATCH = 40;

/**
 * Looks for episodes of the shows this household follows, on a timer.
 *
 * The point of following something. A show that is still running puts out an episode and
 * nothing here would ever say so on its own: a scan reads what media servers hold, and a
 * tracker is nobody's library. Somebody had to open the search screen and ask, show by
 * show — which is precisely the chore a watchlist exists to remove.
 *
 * **It proposes and never fetches.** Which release to take is a decision about quality,
 * size, language and who is seeding it, and those are the household's to make on a screen
 * that shows them. A gateway that grabbed on its own would be answering a question nobody
 * asked it, with somebody else's disk.
 *
 * Only shows with a gap, and only gaps something can actually fill. The pass asks the
 * grouping for what is both followed and actionable — a show with nothing missing is not
 * searched at all — and then says something only when a search comes back with a release
 * that covers one of those gaps. A notification per pass per show that changed, never a
 * digest of everything that is still missing: the second kind arrives every six hours
 * saying the same thing and is silenced within a week.
 */
@Injectable()
export class EpisodeWatchManager implements OnModuleInit {
	private readonly _logger = new Logger(EpisodeWatchManager.name);

	/** A pass already running, so a forced one joins it rather than doubling the searches. */
	private _running: Promise<number> | null = null;

	public constructor(
		private readonly _scheduler: SchedulerService,
		private readonly _settings: SettingsService,
		private readonly _groups: MediaGroupManager,
		private readonly _releases: ReleaseManager,
		private readonly _notifications: NotificationManager,
	) {}

	public onModuleInit(): void {
		this._scheduler.onEpisodeWatch(async () => {
			await this.sweep();
		});
	}

	/**
	 * Run a pass now, and answer how many shows had something to propose.
	 *
	 * Shared with the timer rather than duplicating it: "look now" and "look every six
	 * hours" are the same work, and a button that ran a second implementation would be a
	 * button that drifts from the thing it claims to trigger.
	 */
	public sweep(): Promise<number> {
		this._running ??= this._sweep().finally(() => {
			this._running = null;
		});

		return this._running;
	}

	private async _sweep(): Promise<number> {
		const indexer = (await this._settings.get()).indexer;

		if (indexer === null || !indexer.enabled) {
			// Nothing to ask. Said once rather than once per show, which is what a loop
			// around a disabled indexer would produce.
			this._logger.debug('No indexer configured, so the episode watch has nothing to ask.');

			return 0;
		}

		const followed = await this._groups.groups({
			watched: true,
			actionable: true,
			rootsOnly: true,
			limit: WATCH_BATCH,
		});

		let proposed = 0;

		for (const show of followed.items) {
			if (await this._look(show)) {
				proposed += 1;
			}

			// One pass is dozens of searches against somebody else's indexer, each of them
			// seconds long. Handing the loop back keeps the gateway answering throughout.
			await breathe(0);
		}

		this._logger.log(
			`Episode watch looked at ${followed.items.length} followed `
			+ `${followed.items.length === 1 ? 'show' : 'shows'} and proposed something for ${proposed}`,
		);

		return proposed;
	}

	/**
	 * One show: search, and say so when a gap can be filled.
	 *
	 * Every failure is swallowed deliberately. An indexer that refuses one show must not
	 * end the pass for the thirty-nine behind it, and a tracker having a bad evening is an
	 * ordinary morning rather than something to wake anybody about.
	 */
	private async _look(show: MediaGroup): Promise<boolean> {
		try {
			const found = await this._releases.search({ itemId: show.id });
			const fillable = found.suggestions.filter(
				(one) => one.source === 'indexer' && one.release.fills.length > 0,
			);

			if (fillable.length === 0) {
				return false;
			}

			await this._notifications.notify({
				event: NotificationEvent.EPISODE_AVAILABLE,
				title: show.title,
				// What it can fill, not how many lines came back: thirty releases of one
				// episode is one episode, and saying "thirty" would be a number that means
				// nothing to the person reading it.
				body: `${found.missing.length} missing can be fetched`,
				// Straight to the show, which is where the search screen opens and where
				// the decision this is proposing actually gets made.
				link: `/library/${show.id}`,
			});

			return true;
		} catch (error: unknown) {
			this._logger.debug(`Episode watch skipped ${show.title}: ${String(error)}`);

			return false;
		}
	}
}
