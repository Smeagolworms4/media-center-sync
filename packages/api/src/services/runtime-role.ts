import { isMainThread, workerData } from 'node:worker_threads';

/**
 * Which half of the process this code is running in.
 *
 * The gateway answers requests. The worker does the long database work that would
 * otherwise block it — `better-sqlite3` is synchronous, so one slow statement stops the
 * whole process, and no amount of yielding between statements repairs a single slow one.
 * Measured on a household's gateway at rest: eight seconds on an API call while a static
 * file served by the same proxy, in the same second, answered in a tenth of one.
 *
 * Both halves build the same Nest container, because the scan pipeline is the whole
 * application — handlers, settings, the media manager, the landings. What they must not
 * share is the *bootstrap*: the hooks that arm the schedules, restart the transfer
 * engine, open the peer gateway and expire the sessions belong to the gateway alone, and
 * a worker that ran them would give the household two of everything — two cron schedules,
 * two transfer queues, and every session revoked a second time.
 *
 * So each of those hooks asks this first. It is a function of how the thread was started
 * rather than a setting, because it must be impossible to get wrong by deployment: there
 * is no environment variable to forget.
 */
export const isWorkerThread = (): boolean =>
	!isMainThread && (workerData as { mcsWorker?: boolean } | null)?.mcsWorker === true;

/** What a worker is handed when it starts, and what it hands back. */
export interface ScanRequest {
	type: 'scan';
	serviceId: string;
	full: boolean;
}

/** An event the worker produced, to be re-emitted by the gateway that owns the sockets. */
export interface WorkerEvent {
	type: 'event';
	event: string;
	payload: unknown;
}

/** A pass finished, so the gateway can warm its own caches. */
export interface ScanDone {
	type: 'done';
	serviceId: string;
	error: string | null;
}

export type WorkerMessage = WorkerEvent | ScanDone;
