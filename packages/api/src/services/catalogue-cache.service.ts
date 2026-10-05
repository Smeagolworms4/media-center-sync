import { CacheRefreshReason, type CacheRefreshReasonValue, EventName } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { MediaMatchRepository } from '@/repositories';
import { EventGatewayService } from './event-gateway.service';

/**
 * Rebuilds the projections and says whether anything moved.
 *
 * Registered rather than injected, and that is not ceremony: this lives among the
 * services and the thing that holds the graph is a manager, which imports the services
 * barrel. Depending on it from here would close a cycle through two barrels — the kind
 * that resolves to `undefined` at boot and fails somewhere else entirely. The gateway
 * already does it this way for rescans and for source resolution.
 */
export type CatalogueRefresher = () => Promise<boolean>;

/**
 * How long a request to refresh waits for another one to arrive.
 *
 * A scan of a service with four libraries ends four times over about a second, and a
 * person moving the match threshold moves it three times before letting go of the
 * slider. Rebuilding on each is the same answer computed four times. Two seconds is
 * below what anybody notices on a screen they are not watching, and above the gap
 * between the events that bunch.
 */
export const COALESCE_MS = 2_000;

/**
 * Keeps the catalogue's shared projections warm, and says so out loud.
 *
 * The gateway's expensive artefact is the applied-match graph: the whole match table
 * walked into a union-find, which every library page, every group and every news wall
 * reads. It is cached against a version of that table, and that much was already true.
 * What was not is *who pays to rebuild it*. The cache went stale at the end of a scan
 * and was rebuilt by the next person to open a page — so the one moment the gateway
 * knew the work was coming was the one moment it did nothing about it, and somebody
 * got a nine-second page for their trouble.
 *
 * So the rebuild moved here: scheduled by whatever invalidated the cache, run away
 * from any request, coalesced so a scan ending across four libraries rebuilds once,
 * and announced at both ends. The announcement is not decoration. A rebuild that takes
 * seconds with no sign of it is indistinguishable from a gateway that has hung, and
 * the interface spent this project's whole life being blamed for silence.
 *
 * Not a worker thread, and this does not pretend otherwise. The work runs on this
 * thread, a page at a time, handing the loop back between pages — see `breathe`. What
 * moved is *when*, not *where*, and when was the part that people felt.
 */
@Injectable()
export class CatalogueCacheService {
	private readonly _logger = new Logger(CatalogueCacheService.name);

	private _timer: NodeJS.Timeout | null = null;
	private _running: Promise<void> | null = null;

	/**
	 * A refresh asked for while one was already running.
	 *
	 * Held rather than dropped: the pass in flight read its pages before that request
	 * existed, so it cannot be the answer to it. Without this, a scan finishing one
	 * second into a rebuild would leave the cache a generation behind with nothing
	 * scheduled to catch it up.
	 */
	private _again: CacheRefreshReasonValue | null = null;

	/** Set at boot by whoever owns the projections. See `CatalogueRefresher`. */
	private _refresher: CatalogueRefresher | null = null;

	public constructor(
		private readonly _matches: MediaMatchRepository,
		private readonly _events: EventGatewayService,
	) {}

	public onRefresh(refresher: CatalogueRefresher): void {
		this._refresher = refresher;
	}

	/**
	 * Ask for a rebuild. Returns immediately; the work happens on its own.
	 *
	 * Deliberately not awaitable. Every caller is finishing something else — a scan, a
	 * settings write — and a caller that could await this would, and would hand its own
	 * latency to whoever triggered it. That is the shape of the bug this exists to fix.
	 */
	public schedule(reason: CacheRefreshReasonValue): void {
		if (this._running) {
			this._again = reason;

			return;
		}

		if (this._timer) {
			return;
		}

		this._timer = setTimeout(() => {
			this._timer = null;
			void this._run(reason);
		}, COALESCE_MS);

		// So a gateway with nothing else to do can still exit.
		this._timer.unref?.();
	}

	/** Rebuild now and wait for it — for a person who pressed a button and is watching. */
	public async refreshNow(reason: CacheRefreshReasonValue = CacheRefreshReason.MANUAL): Promise<void> {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}

		await (this._running ?? this._run(reason));
	}

	/** Whether a pass is in flight, for a screen asking before any event has reached it. */
	public get refreshing(): boolean {
		return this._running !== null;
	}

	private _run(reason: CacheRefreshReasonValue): Promise<void> {
		const startedAt = new Date().toISOString();
		const began = Date.now();

		this._events.emit(EventName.CACHE_STATE, {
			refreshing: true,
			reason,
			startedAt,
			tookMs: null,
		});

		/*
		 * Nothing registered is a gateway booting, not a fault: `schedule` can be called
		 * from a hook that runs before the one that registers. Treated as "nothing moved",
		 * so the pair of events still brackets correctly and no screen is left with a
		 * spinner that never stops.
		 */
		const refresher = this._refresher ?? ((): Promise<boolean> => Promise.resolve(false));

		const pass = refresher()
			.then(async (changed) => {
				if (changed) {
					// The version is what a screen compares against to decide whether the
					// page it is holding is the current one.
					this._events.emit(EventName.CATALOGUE_CHANGED, {
						version: await this._matches.version(),
					});
				}

				this._logger.log(
					`Catalogue cache refreshed after ${reason} in ${Date.now() - began}ms`
						+ (changed ? '' : ' (already current)'),
				);
			})
			.catch((error: unknown) => {
				// A rebuild that failed leaves the previous graph in place and answering.
				// Nothing is broken by this; the cache is simply one pass behind, and the
				// next scan will ask again.
				this._logger.warn(`Could not refresh the catalogue cache: ${String(error)}`);
			})
			.finally(() => {
				this._running = null;

				this._events.emit(EventName.CACHE_STATE, {
					refreshing: false,
					reason,
					startedAt: null,
					tookMs: Date.now() - began,
				});

				const pending = this._again;

				this._again = null;

				if (pending !== null) {
					this.schedule(pending);
				}
			});

		this._running = pass;

		return pass;
	}
}
