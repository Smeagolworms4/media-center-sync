import { isMainThread, workerData } from 'node:worker_threads';

/**
 * Which half of the process this code is running in.
 *
 * The gateway answers requests. A worker does the long database work that would
 * otherwise block it — `better-sqlite3` is synchronous, so one slow statement stops the
 * whole process, and no amount of yielding between statements repairs a single slow one.
 * Measured on a household's gateway at rest: eight seconds on an API call while a static
 * file served by the same proxy, in the same second, answered in a tenth of one.
 *
 * **A worker builds no Nest container.** It is a thread that opens a database and runs
 * one function — see `jobs.worker.ts`, which constructs the five objects a correlation
 * needs by hand. That is the whole reason the pass was lifted out of `MediaManager`: a
 * second container would be every manager, handler and registry built twice in one
 * process, which on a NAS is the memory this gateway can least afford.
 *
 * So what is this read for, if there is no container in there to guard? Two things, and
 * only two. `WorkerPoolService.available` asks it so that a thread never spawns a thread.
 * And every bootstrap hook that arms a schedule, restarts the transfer engine, opens the
 * peer gateway or expires the sessions asks it too — not because a worker reaches them
 * today, but because those are the hooks that would give the household two of everything
 * if one ever did, and an invariant stated in ten `if`s cannot be undone by somebody
 * changing how a thread is started.
 *
 * It is a function of how the thread was started rather than a setting, because it must
 * be impossible to get wrong by deployment: there is no environment variable to forget.
 */
export const isWorkerThread = (): boolean =>
	!isMainThread && (workerData as { mcsWorker?: boolean } | null)?.mcsWorker === true;
