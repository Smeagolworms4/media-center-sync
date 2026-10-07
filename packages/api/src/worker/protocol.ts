/**
 * What crosses between the gateway and a worker.
 *
 * Plain data on purpose: everything here goes through `postMessage`, which structured-
 * clones its argument. An entity, a repository, anything holding a connection or a
 * closure cannot travel, and saying so in the types is what stops somebody trying.
 */

/**
 * The jobs a worker knows how to run.
 *
 * A closed set rather than a function somebody passes in. A worker is a *separate
 * thread*, not a continuation of this one: it cannot be handed a closure, and the moment
 * the set is open the protocol becomes "send me some code", which is neither typeable
 * nor safe. Adding a job is adding a case here and a branch in the worker.
 */
export const JobKind = {
	/** Re-derive which rows across every server are the same media. */
	CORRELATE: 'correlate',
} as const;

export type JobKindValue = (typeof JobKind)[keyof typeof JobKind];

export interface JobRequest {
	/** Echoed on the answer: several jobs can be in flight on one worker. */
	id: string;
	kind: JobKindValue;
	/** The job's own arguments, structured-cloned. */
	input: Record<string, unknown>;
}

/** A job finished, well or badly. */
export interface JobDone {
	type: 'done';
	id: string;
	kind: JobKindValue;
	/** Whatever the job answers. Small by design — see `WorkerPoolService`. */
	output: unknown;
	error: string | null;
}

/**
 * Something worth logging, relayed rather than written.
 *
 * A worker has its own stdout and Nest's logger is not in it, so a line written there
 * arrives without the prefix, the level or the timestamp every other line of this
 * gateway carries. Relaying keeps one log.
 */
export interface JobLog {
	type: 'log';
	level: 'debug' | 'log' | 'warn' | 'error';
	message: string;
}

/** Progress, for a job somebody is watching rather than awaiting. */
export interface JobProgress {
	type: 'progress';
	id: string;
	kind: JobKindValue;
	/** Free-form, forwarded to whoever is listening on the event stream. */
	payload: Record<string, unknown>;
}

export type JobAnswer = JobDone | JobLog | JobProgress;
