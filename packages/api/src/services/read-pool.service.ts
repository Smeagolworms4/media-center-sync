import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
// The file rather than the barrel: `database/index` reaches the entities, and the
// entities are what the data source this service is handed was built from.
import { useReadPool } from '@/database/async-reads';
import { isWorkerThread } from './runtime-role';

/**
 * How many readers.
 *
 * Two, because the machine this runs on is a four-core Raspberry Pi already giving one
 * core to the job worker, and because the thing being removed is a *serial* block: one
 * reader already means the gateway answers while a listing runs. The second is there so
 * a second tab does not queue behind the first — a third would be competing with the
 * gateway for the cores that answer HTTP, which is the problem rather than the cure.
 */
const READERS = 2;

/**
 * How long to wait for a reader before giving up on it.
 *
 * Nothing like the half hour a correlation gets: this runs listings, and a listing that
 * has not answered in thirty seconds means the thread is wedged, not busy. Giving up
 * returns the caller to the in-thread path, which is slow but certain.
 */
const READ_TIMEOUT_MS = 30_000;

/** What `better-sqlite3` will bind. Anything else is a reason to stay on this thread. */
type Bindable = string | number | bigint | Buffer | null;

interface Pending {
	resolve: (rows: unknown[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	reader: Reader;
}

interface Reader {
	worker: Worker;
	/** How many requests this reader has not answered yet, for choosing the idlest. */
	inFlight: number;
}

/**
 * Runs read-only statements on threads of their own.
 *
 * This is the other half of the answer `WorkerPoolService` gives for writes, and it
 * exists because of one property of this gateway that no amount of care in the query
 * repairs: `better-sqlite3` is **synchronous**. A statement is not I/O the event loop
 * waits on, it is computation the event loop *is doing*. While it runs the process reads
 * no socket at all — so a 600 ms listing is 600 ms during which every request in flight,
 * every poster still downloading and the websocket itself are simply not being served.
 * The browser reports that as `ERR_NETWORK_CHANGED` on thirty requests at once, which
 * names the symptom and hides the cause completely.
 *
 * Breathing between loops — `breathe()` — was the first answer and it is not enough by
 * construction: it splits a long block into shorter ones, so the gateway stutters
 * instead of freezing, but each individual statement is still indivisible. Measured on
 * the owner's catalogue after breathing was added: stalls of 2.9 s, 3.9 s and 4.3 s
 * while browsing. The only way to stop a synchronous call from blocking a thread is to
 * run it somewhere else.
 *
 * So: a small pool of threads, each holding its own **read-only** connection to the same
 * file. WAL makes that safe — one writer and any number of concurrent readers — and WAL
 * is already on, set by the gateway's connection, checked at boot by the health route.
 * Awaiting a thread costs this event loop nothing, which is the whole point: the gateway
 * goes on answering while the listing runs.
 *
 * Nothing calls this directly. It hands itself to `applyAsynchronousReads()` as the
 * module starts, and from there TypeORM's query runner routes **every** read-only
 * statement through it — `find`, `count`, a query builder, a raw string alike. That is
 * the point: an earlier version of this had three hand-picked queries calling in, which
 * fixed the one listing it covered and left a hundred and thirty others blocking.
 *
 * Two consequences worth stating, because both are correctness and not taste:
 *
 * - A reader is a separate connection, so it cannot see another connection's
 *   uncommitted work. A read issued inside a transaction must stay on the caller's
 *   thread, and the query runner checks for exactly that before reaching here.
 * - Everything must work unchanged when `available` is false — no pool in tests, on
 *   PostgreSQL, in a worker, against `:memory:`. The pool is an optimisation, never a
 *   dependency, and a gateway that loses it gets slower rather than wrong.
 */
@Injectable()
export class ReadPoolService implements OnModuleInit, OnModuleDestroy {
	private readonly _logger = new Logger(ReadPoolService.name);

	private _readers: Reader[] | null = null;

	/** Null for "looked and there is none", undefined for "not looked yet". */
	private _file: string | null | undefined;

	private readonly _waiting = new Map<string, Pending>();

	public constructor(
		@InjectDataSource()
		private readonly _dataSource: DataSource,
	) {}

	/**
	 * Whether a caller may send work here at all.
	 *
	 * Callers ask before building anything, so the answer has to be cheap and stable.
	 */
	public get available(): boolean {
		return this._path() !== null;
	}

	/**
	 * Whether these parameters can cross to a reader.
	 *
	 * `better-sqlite3` binds a narrow set of types and throws on the rest — a `boolean`
	 * and a `Date` among them, both of which TypeORM converts on the way into its own
	 * driver. Rather than reimplement those conversions here and risk writing a
	 * *different* date format than the one in the column, anything outside the set sends
	 * the caller back to the ordinary path. It costs a slow read; guessing would cost
	 * rows that silently do not match.
	 */
	public bindable(params: readonly unknown[]): params is Bindable[] {
		return params.every(
			(value) =>
				value === null ||
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'bigint' ||
				Buffer.isBuffer(value),
		);
	}

	/**
	 * Run one statement on a reader and resolve with its raw rows.
	 *
	 * Rejects rather than falling back, because the caller is the one holding the query
	 * builder that could run it here instead — and a failure worth a log line should be
	 * logged once, by whoever decided what to do about it.
	 */
	public all<T>(sql: string, params: readonly Bindable[]): Promise<T[]> {
		const reader = this._idlest();

		if (reader === null) {
			return Promise.reject(new Error('No reader is available'));
		}

		const id = randomUUID();

		/*
		 * Referenced while it has work, released when it has none.
		 *
		 * An unreferenced worker does not keep the event loop alive, and during startup
		 * nothing else does either: the HTTP server is not listening yet. A boot that
		 * awaited a read whose only pending handles were an unreferenced worker and an
		 * unreferenced timer left Node with nothing to wait for, so it **exited, code 0,
		 * in silence** — eight seconds in, no error, no stack, the gateway simply gone.
		 * In CI that surfaced as `api 000`: the journeys found nothing listening and the
		 * stack was never up. Nothing in the logs says why, which is what makes this
		 * worth a paragraph rather than a line.
		 */
		if (reader.inFlight === 0) {
			reader.worker.ref();
		}

		reader.inFlight += 1;

		return new Promise<T[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._settle(id);
				reject(new Error('A reader did not answer'));
			}, READ_TIMEOUT_MS);

			// So a gateway with nothing else to do can still exit.
			timer.unref?.();

			this._waiting.set(id, {
				resolve: resolve as (rows: unknown[]) => void,
				reject,
				timer,
				reader,
			});

			reader.worker.postMessage({ id, sql, params });
		});
	}

	/**
	 * Offers itself to the query runner.
	 *
	 * Here rather than in the constructor so that nothing before the module is ready —
	 * the boot migrations above all — is routed to a read-only connection on a file whose
	 * schema may not be written yet.
	 */
	public onModuleInit(): void {
		useReadPool(this);
	}

	public onModuleDestroy(): void {
		// First, so that a read arriving during shutdown goes to a connection that is
		// still open rather than to a thread that is being terminated.
		useReadPool(null);

		for (const { reject, timer } of this._waiting.values()) {
			clearTimeout(timer);
			reject(new Error('The gateway is shutting down'));
		}

		this._waiting.clear();

		for (const { worker } of this._readers ?? []) {
			void worker.terminate();
		}

		this._readers = null;
	}

	/** Drops the bookkeeping for one request, whatever became of it. */
	private _settle(id: string): void {
		const pending = this._waiting.get(id);

		if (pending === undefined) {
			return;
		}

		clearTimeout(pending.timer);
		pending.reader.inFlight -= 1;
		this._waiting.delete(id);

		// Idle again: stop holding the process open, which is what lets a gateway with
		// nothing left to do exit instead of lingering on two sleeping threads.
		if (pending.reader.inFlight === 0) {
			pending.reader.worker.unref();
		}
	}

	private _idlest(): Reader | null {
		const readers = this._start();

		if (readers === null || readers.length === 0) {
			return null;
		}

		return readers.reduce((best, reader) => (reader.inFlight < best.inFlight ? reader : best));
	}

	private _start(): Reader[] | null {
		if (this._readers !== null) {
			return this._readers;
		}

		const file = this._path();

		if (file === null) {
			return null;
		}

		const entry = ReadPoolService._lookUp();

		if (entry === null) {
			this._logger.warn('No read worker beside this build: listings will run on the gateway thread');
			this._file = null;

			return null;
		}

		const readers: Reader[] = [];

		for (let index = 0; index < READERS; index += 1) {
			const worker = new Worker(entry.path, {
				execArgv: entry.execArgv,
				env: entry.env,
				workerData: { mcsWorker: true, file },
			});

			const reader: Reader = { worker, inFlight: 0 };

			worker.on('message', (answer: { id: string; rows?: unknown[]; error?: string }) => {
				const pending = this._waiting.get(answer.id);

				this._settle(answer.id);

				if (pending === undefined) {
					return;
				}

				if (answer.error !== undefined) {
					pending.reject(new Error(answer.error));

					return;
				}

				pending.resolve(answer.rows ?? []);
			});

			/*
			 * A reader that dies takes the whole pool with it, on purpose.
			 *
			 * The failures that kill one of these — the file moved, the driver failing to
			 * load, the disk gone — are failures of the connection rather than of the
			 * request, so the second reader is about to die of the same thing. Tearing the
			 * pool down puts every caller back on the in-thread path immediately instead
			 * of making half of them wait thirty seconds to find out.
			 */
			worker.on('error', (error: Error) => {
				this._logger.error(`A reader failed, listings return to the gateway thread: ${error.message}`);
				this._collapse(error);
			});

			// Idle from birth; `all()` references it for as long as it has work.
			worker.unref();
			readers.push(reader);
		}

		this._readers = readers;
		this._logger.log(`${READERS} readers opened on ${file}: listings no longer block the gateway`);

		return readers;
	}

	private _collapse(error: Error): void {
		for (const id of [...this._waiting.keys()]) {
			const pending = this._waiting.get(id);

			this._settle(id);
			pending?.reject(error);
		}

		for (const { worker } of this._readers ?? []) {
			void worker.terminate();
		}

		this._readers = null;
		// Null rather than undefined: looked, and there is none. Setting it undefined
		// would have the next caller try to open the pool again on every listing.
		this._file = null;
	}

	/**
	 * The database file a reader may open, or null when there is nothing to open.
	 *
	 * Null covers four unrelated situations that all mean the same thing to a caller:
	 * PostgreSQL, where the driver is already asynchronous and this whole class is
	 * pointless; `:memory:`, where a second connection would open a second, empty
	 * database rather than share the first; a worker thread, which must never spawn
	 * threads of its own; and a pool that has already failed.
	 */
	private _path(): string | null {
		if (this._file !== undefined) {
			return this._file;
		}

		this._file = null;

		if (isWorkerThread()) {
			return null;
		}

		const options = this._dataSource.options;

		if (options.type !== 'better-sqlite3') {
			return null;
		}

		const file = options.database;

		if (typeof file !== 'string' || file === ':memory:' || !existsSync(file)) {
			return null;
		}

		this._file = file;

		return file;
	}

	/** Where the reader is and what it takes to start it, built or from source. */
	private static _lookUp(): { path: string; execArgv: string[]; env: NodeJS.ProcessEnv } | null {
		const built = join(__dirname, '..', 'worker', 'read.worker.js');

		if (existsSync(built)) {
			return { path: built, execArgv: [], env: process.env };
		}

		const source = join(__dirname, '..', 'worker', 'read.worker.ts');

		if (existsSync(source)) {
			return {
				path: source,
				execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
				env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
			};
		}

		return null;
	}
}
