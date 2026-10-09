import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { QueryResult } from 'typeorm/query-runner/QueryResult';

/**
 * Something that can run a read-only statement away from this thread.
 *
 * Declared here rather than imported so this file depends on nothing in the application:
 * `ReadPoolService` implements it and hands itself over as it starts. Keeping the shape
 * local is also what lets the tests drive the patch without a worker.
 */
export interface AsynchronousReader {
	/** False when there is nothing to read on — PostgreSQL, `:memory:`, a dead pool. */
	readonly available: boolean;
	/** Whether the driver will bind these parameters as they are. */
	bindable(params: readonly unknown[]): boolean;
	all<T>(sql: string, params: readonly unknown[]): Promise<T[]>;
}

/**
 * Statements that may leave this thread.
 *
 * `SELECT` and nothing else, decided on the text. Two alternatives were considered and
 * both are worse. `better-sqlite3` exposes `stmt.reader`, which is authoritative — but
 * reading it means preparing the statement on *this* connection first, which puts SQLite
 * work back on the very thread this exists to empty. And `WITH` is deliberately absent:
 * SQLite accepts `WITH x AS (…) DELETE FROM …`, so a common table expression is not a
 * read by construction. The application generates none today; the day it does, that
 * statement runs on this thread exactly as it does now, which is slow and correct rather
 * than fast and wrong.
 */
const READ_ONLY = /^\s*select\b/i;

/**
 * The pool, held in the module rather than injected.
 *
 * This patches a prototype, so it runs outside Nest's container and cannot be given a
 * dependency. `ReadPoolService` registers itself here when the module starts and clears
 * it when the module stops — which also means every query before that point, the boot
 * migrations among them, runs on this thread. That is the right default: the readers open
 * read-only connections to a file whose schema the migrations may not have written yet.
 */
let reader: AsynchronousReader | null = null;

export const useReadPool = (pool: AsynchronousReader | null): void => {
	reader = pool;
};

interface Runner {
	isReleased: boolean;
	isTransactionActive: boolean;
	connection: {
		logger: {
			logQuery(query: string, parameters?: unknown[], runner?: unknown): void;
			log(level: 'log' | 'info' | 'warn', message: unknown, runner?: unknown): void;
		};
	};
}

type Query = (
	this: Runner,
	query: string,
	parameters?: unknown[],
	useStructuredResult?: boolean,
) => Promise<unknown>;

interface Patchable {
	query: Query;
	__mcsAsynchronous?: boolean;
}

/**
 * Makes every read non-blocking, by default, everywhere.
 *
 * `better-sqlite3` is **synchronous**: a statement is not I/O the event loop waits on, it
 * is computation the event loop *is doing*. While it runs the process reads no socket at
 * all, so one 600 ms listing is 600 ms during which every request in flight, every poster
 * still downloading and the websocket itself are simply not served. The browser reports
 * that as `ERR_NETWORK_CHANGED` on thirty requests at once, which names the symptom and
 * hides the cause completely. Measured on the owner's catalogue: stalls of 2.9 s, 3.9 s
 * and 4.3 s while browsing.
 *
 * The first attempt at this moved three hand-picked queries onto reader threads. It
 * worked — the listing it covered stopped stalling — and it was the wrong shape of fix:
 * twenty-one repositories and a hundred and thirty other reads were still synchronous, so
 * the freeze simply moved to whichever page used a different query. Blocking has to be
 * impossible rather than avoided in the places somebody remembered.
 *
 * So the routing goes where it cannot be forgotten. TypeORM funnels every statement it
 * ever runs — `find`, `findOne`, `count`, a query builder, a raw string — through one
 * method, `QueryRunner.query()`. Patching it once covers all of them and every one
 * written from now on, with nothing to opt into and no call site to remember.
 *
 * A prototype patch rather than a driver subclass because TypeORM 0.3 builds its driver
 * from `options.type` inside the `DataSource` constructor, with no seam to pass one in —
 * and because this codebase already corrects a driver exactly this way, next door, in
 * `applyPostgresCompatibility()`.
 *
 * What stays on this thread, on purpose:
 *
 * - **Anything that is not a `SELECT`.** Writes belong to the connection that owns the
 *   transaction, and the heavy ones — a scan, a correlation pass — already run in the job
 *   worker. What is left is single-row and submillisecond: marking an episode watched.
 * - **Reads inside a transaction.** A reader is a separate connection and cannot see
 *   another connection's uncommitted work, so a read between `BEGIN` and `COMMIT` must
 *   run where the writes are, or it would answer from before them.
 * - **Everything, when there is no pool.** On PostgreSQL the driver is already
 *   asynchronous and this is pointless; against `:memory:` a second connection is a
 *   second, empty database; in a worker thread nothing may spawn threads of its own.
 *
 * Correctness rests on one thing being true, and it is: the readers open the *same file*
 * with the *same driver* and run the *same statement*, so the rows they hand back are the
 * rows this connection would have produced. Nothing in the schema is binary, so nothing
 * changes type crossing between threads. And WAL — set by this connection, read back at
 * boot by the health route — gives one writer and any number of concurrent readers, with
 * a committed write visible to a reader's next statement immediately.
 *
 * A reader that fails costs latency and never an answer: the statement is simply run here
 * instead. That covers a wedged thread and a genuine SQL error alike — a bad column name
 * is re-run on this connection and raises the same `QueryFailedError` it always did, from
 * the same place, so nothing upstream can tell the difference.
 *
 * Worth redoing after a TypeORM upgrade: this patches a prototype, and nothing in the
 * type system will notice if the method it wraps is renamed or changes its result shape.
 */
export const applyAsynchronousReads = (): void => {
	const runner = BetterSqlite3QueryRunner.prototype as unknown as Patchable;

	if (runner.__mcsAsynchronous === true) {
		return;
	}

	const inThread = runner.query;

	runner.query = async function (
		this: Runner,
		query: string,
		parameters: unknown[] = [],
		useStructuredResult = false,
	): Promise<unknown> {
		const pool = reader;

		if (
			pool !== null &&
			!this.isReleased &&
			!this.isTransactionActive &&
			READ_ONLY.test(query) &&
			pool.available &&
			pool.bindable(parameters)
		) {
			this.connection.logger.logQuery(query, parameters, this);

			try {
				const rows = await pool.all<unknown>(query, parameters);
				const result = new QueryResult<unknown>();

				result.raw = rows;
				result.records = rows;

				return useStructuredResult ? result : result.raw;
			} catch (error) {
				/*
				 * Logged once here and then run on this thread, which logs the statement a
				 * second time. The duplicate is deliberate: it only happens when a reader
				 * could not answer, and seeing which statement it was is worth more than a
				 * tidy log.
				 */
				this.connection.logger.log(
					'warn',
					`A reader could not answer, running on the gateway thread: ${
						error instanceof Error ? error.message : String(error)
					}`,
					this,
				);
			}
		}

		return inThread.call(this, query, parameters, useStructuredResult);
	};

	runner.__mcsAsynchronous = true;
};
