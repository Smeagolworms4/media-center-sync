import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventName } from '@mcs/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JobKind, type JobAnswer, type JobDone, type JobKindValue, type JobRequest }
	from '@/worker/protocol';
import { EventGatewayService } from './event-gateway.service';
import { isWorkerThread } from './runtime-role';

/**
 * How long a job may run before the gateway stops waiting for it.
 *
 * Generous, because taking a while is the entire point: a correlation over sixty
 * thousand rows is minutes of real work. What this guards is a worker that has died
 * without saying so, which would otherwise leave the caller waiting forever and the next
 * pass refusing to start.
 */
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Which thread each kind of job runs on.
 *
 * One thread per lane, and the lanes are not a tuning knob — they are the difference
 * between a projection answering in a second and a projection answering in four
 * minutes. A worker runs one job at a time by construction (see the queue at the foot
 * of `jobs.worker.ts`: a correlation holds the whole catalogue in memory with six
 * indexes over it, and two at once is twice that on a NAS and no faster). So a
 * projection sharing the scan's thread would wait behind the scan — and the moment it
 * is most needed is exactly the moment a scan has just finished and a person is
 * refreshing the page to see what arrived.
 *
 * They do not contend for the database either: the projection is a read, WAL gives any
 * number of concurrent readers, and the scan is the single writer it already was.
 *
 * Added to rather than opened up: a lane is a thread, a thread is a database connection
 * and a few megabytes, and a household's gateway cannot afford one per job kind
 * somebody felt like adding.
 */
const LANES = {
	[JobKind.CORRELATE]: 'catalogue',
	[JobKind.PROJECT]: 'projection',
} as const satisfies Record<JobKindValue, string>;

type Lane = (typeof LANES)[keyof typeof LANES];

/** Where the worker is and what it takes to start it. See `_lookUp`. */
interface WorkerEntry {
	path: string;
	execArgv: string[];
	env: NodeJS.ProcessEnv;
}

/**
 * Runs heavy code beside the gateway instead of inside it.
 *
 * `better-sqlite3` is synchronous. One long statement does not slow this process, it
 * *stops* it — and no amount of yielding between statements repairs a single slow one.
 * Measured on a household's gateway at rest: eight seconds on an API call while a static
 * file served by the same proxy, in the same second, came back in a tenth of one. The
 * event loop was not busy. It was gone.
 *
 * A worker thread is the only answer to that, and the reason is worth stating because it
 * decides how this is used: **awaiting a worker costs nothing**. An `await` on a thread
 * leaves this event loop entirely free, which is the exact opposite of awaiting
 * synchronous work on it. So a request that needs heavy work can simply wait for it while
 * every other connection goes on being served.
 *
 * Which gives two shapes, and both are right depending on what is being asked:
 *
 * - `run` — the caller waits. For work whose answer is what they asked for: a
 *   correlation somebody triggered, a search they are looking at.
 * - `start` — the caller is handed a run identifier at once and the answer arrives later
 *   on the event stream under that identifier. For work measured in minutes, where
 *   holding an HTTP request open for the duration is its own failure.
 *
 * **No Nest inside the worker**, deliberately. A second container would be a second copy
 * of every manager and service in this process, which on a NAS is the memory this gateway
 * can least afford — and the worker needs none of it. It opens one database connection
 * and runs the code. That is all a worker is.
 */
@Injectable()
export class WorkerPoolService implements OnModuleDestroy {
	private readonly _logger = new Logger(WorkerPoolService.name);

	/** One per lane, started on first use. See `LANES`. */
	private readonly _threads = new Map<Lane, Worker>();

	/** Null for "looked and there is none", undefined for "not looked yet". */
	private _resolved: WorkerEntry | null | undefined;

	private readonly _waiting = new Map<
		string,
		{
			lane: Lane;
			resolve: (output: unknown) => void;
			reject: (error: Error) => void;
			timer: NodeJS.Timeout;
			onProgress?: (payload: Record<string, unknown>) => void;
		}
	>();


	public constructor(
		private readonly _events: EventGatewayService,
		/** Read for one question only: can a second connection see these rows? */
		@InjectDataSource()
		private readonly _dataSource: DataSource,
	) {}

	/**
	 * Run a job and wait for its answer. The event loop stays free throughout.
	 *
	 * `onProgress` is for the caller that is waiting and has somewhere better to put the
	 * position than the generic stream — a scan draws it on the bar the services screen
	 * already has. It is handed the worker's payload as it came, because what a job
	 * reports is the job's business and this class decides none of it.
	 */
	public run<T>(
		kind: JobKindValue,
		input: Record<string, unknown>,
		onProgress?: (payload: Record<string, unknown>) => void,
	): Promise<T> {
		const { answer } = this._send(kind, input, onProgress);

		return answer as Promise<T>;
	}

	/**
	 * Start a job and answer at once with the identifier its result will carry.
	 *
	 * The result is pushed on the event stream rather than returned, because the caller
	 * is not waiting for it. A failure is pushed the same way: a job that died in silence
	 * is the defect this whole screen keeps reintroducing.
	 */
	public start(kind: JobKindValue, input: Record<string, unknown>): string {
		const { id, answer } = this._send(kind, input);

		answer
			.then((output) => this._announce(id, kind, output, null))
			.catch((error: unknown) => this._announce(id, kind, null, String(error)));

		return id;
	}

	/**
	 * Whether this process should delegate at all.
	 *
	 * Two conditions, and both are facts about the process rather than preferences. A
	 * worker never spawns a worker. And there has to be a built worker to spawn: the
	 * entry is emitted by the same `nest build` as everything else, so the shipped image
	 * always has it, while a unit run executes the TypeScript sources and has no `dist`
	 * at all — in that run the pass simply runs where it is called, which is what those
	 * tests are about.
	 *
	 * The missing file is said out loud, once, and that is the point: an image that
	 * somehow shipped without the worker would otherwise go back to stalling for eight
	 * seconds at a time with nothing anywhere saying why. This gateway has already
	 * shipped one release broken by a file that was not where the build expected it.
	 */
	public get available(): boolean {
		return !isWorkerThread() && this._shareable() && this._entry() !== null;
	}

	/**
	 * Whether a second connection would see the rows the first one wrote.
	 *
	 * An in-memory SQLite database belongs to the connection that opened it. A worker
	 * would open its own, find an empty schema, correlate nothing and answer zero — which
	 * is not a slow failure or a loud one, it is a scan that quietly does nothing. That is
	 * the unit and functional suites, and in them the pass runs here and is tested here.
	 *
	 * A file, or PostgreSQL, is shared — which is what WAL and `busy_timeout` in
	 * `dataSourceOptions` are for, and the thing that had to be true before any of this
	 * could move off the gateway thread.
	 */
	private _shareable(): boolean {
		return this._dataSource.options.database !== ':memory:';
	}

	/**
	 * The worker, looked up once.
	 *
	 * `__dirname` rather than a path from the repository root: the built gateway runs
	 * from `dist/`, where the sources are not, and a path that only works in development
	 * is a worker that silently never starts in the shipped image.
	 */
	private _entry(): WorkerEntry | null {
		if (this._resolved === undefined) {
			this._resolved = this._lookUp();
		}

		return this._resolved;
	}

	/**
	 * Built if there is a build, and the sources otherwise.
	 *
	 * Both, deliberately. The shipped image runs `node dist/main.js`, where the worker is
	 * emitted beside everything else. But the lab and the end-to-end run start the gateway
	 * with `ts-node src/main.ts` — so a worker that only existed in `dist` would be the
	 * one part of this gateway no journey could ever exercise, which is the worst place to
	 * put a thread that writes to the household's database.
	 *
	 * Transpiled rather than checked on the way in. The gateway process compiled the same
	 * program on its own way up, `npm run typecheck` compiles it in CI, and paying for it
	 * a third time would be twenty seconds on the first scan of every lab session.
	 */
	private _lookUp(): WorkerEntry | null {
		const built = join(__dirname, '..', 'worker', 'jobs.worker.js');

		if (existsSync(built)) {
			return { path: built, execArgv: [], env: process.env };
		}

		const source = join(__dirname, '..', 'worker', 'jobs.worker.ts');

		if (existsSync(source)) {
			return {
				path: source,
				execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
				env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
			};
		}

		this._logger.warn(
			`No worker beside ${built}: heavy passes will run on the gateway thread and block it`,
		);

		return null;
	}

	public onModuleDestroy(): void {
		for (const { reject, timer } of this._waiting.values()) {
			clearTimeout(timer);
			reject(new Error('The gateway is shutting down'));
		}

		this._waiting.clear();

		for (const worker of this._threads.values()) {
			void worker.terminate();
		}

		this._threads.clear();
	}

	private _send(
		kind: JobKindValue,
		input: Record<string, unknown>,
		onProgress?: (payload: Record<string, unknown>) => void,
	): { id: string; answer: Promise<unknown> } {
		const id = randomUUID();
		const lane = LANES[kind];
		const worker = this._start(lane);

		const answer = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._forget(id);
				reject(new Error(`The worker did not answer for ${kind}`));
			}, JOB_TIMEOUT_MS);

			// So a gateway with nothing else to do can still exit.
			timer.unref?.();

			/*
			 * Referenced while this lane has work, and that is not a nicety.
			 *
			 * A worker is unreferenced so that a gateway with nothing to do can exit —
			 * but during boot the HTTP server is not listening yet, so nothing else
			 * holds the loop either. A release shipped with an unreferenced thread
			 * awaited at boot and Node exited **code 0, silently**, eight seconds in,
			 * with no error anywhere and a container that simply reported `000`. The
			 * same mistake, in the same shape, was already paid for once in
			 * `ReadPoolService`.
			 */
			if (!this._busy(lane)) {
				worker.ref();
			}

			this._waiting.set(id, { lane, resolve, reject, timer, onProgress });

			const request: JobRequest = { id, kind, input };

			worker.postMessage(request);
		});

		return { id, answer };
	}

	/**
	 * The thread, started on first use and kept.
	 *
	 * Kept rather than started per job: a worker opens a database connection on the way
	 * up, and paying that for every pass would put back the latency this exists to
	 * remove.
	 */
	private _start(lane: Lane): Worker {
		const running = this._threads.get(lane);

		if (running) {
			return running;
		}

		const entry = this._entry();

		if (entry === null) {
			// Only reachable by a caller that did not ask `available` first. Thrown rather
			// than run here, because running it here is the stall this class exists to
			// remove and doing it without saying so is how it would come back.
			throw new Error('This process has no worker to run jobs on');
		}

		const worker = new Worker(entry.path, {
			workerData: { mcsWorker: true },
			execArgv: entry.execArgv,
			env: entry.env,
		});

		worker.on('message', (answer: JobAnswer) => this._receive(answer));
		worker.on('error', (error: Error) => this._fail(error, lane));
		worker.on('exit', (code: number) => {
			this._threads.delete(lane);

			if (code !== 0) {
				this._fail(new Error(`The worker exited with ${code}`), lane);
			}
		});
		// Unreferenced, so a worker waiting for jobs does not keep the process alive.
		// Referenced again for as long as it has one — see `_send`.
		worker.unref();

		this._threads.set(lane, worker);

		return worker;
	}

	/** Whether this lane has a job in flight, which is what decides the reference. */
	private _busy(lane: Lane): boolean {
		for (const waiting of this._waiting.values()) {
			if (waiting.lane === lane) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Forget a job and let its thread go if it was the last one.
	 *
	 * Every path that stops waiting goes through here — settled, timed out, failed —
	 * because a lane left referenced with nothing in flight is a gateway that cannot
	 * exit, which in a container is a stop that takes the full kill timeout.
	 */
	private _forget(id: string): void {
		const waiting = this._waiting.get(id);

		if (waiting === undefined) {
			return;
		}

		this._waiting.delete(id);

		if (!this._busy(waiting.lane)) {
			this._threads.get(waiting.lane)?.unref();
		}
	}

	private _receive(answer: JobAnswer): void {
		if (answer.type === 'log') {
			this._logger[answer.level](answer.message);

			return;
		}

		if (answer.type === 'progress') {
			/*
			 * Alive, so the clock starts again.
			 *
			 * What the timeout guards is a thread that has died without saying so, never a
			 * pass that is taking a while — taking a while is the entire point. Without
			 * this, a correlation that really needs forty minutes would be abandoned at
			 * thirty with the work done and nothing to show, and so would a job that spent
			 * its allowance queued behind another.
			 */
			this._reprieve(answer.id);
			// To whoever is waiting for this job, when they asked, and to the stream for
			// whoever is not. Both, because the two shapes have different audiences: a scan
			// puts it on its own bar, and a job started with `start` has nobody holding a
			// request open to hand it to.
			this._waiting.get(answer.id)?.onProgress?.(answer.payload);
			this._events.emit(EventName.JOB_PROGRESS, {
				runId: answer.id,
				kind: answer.kind,
				...answer.payload,
			});

			return;
		}

		this._settle(answer);
	}

	/** Push a waiting job's deadline back, because it has just proved it is running. */
	private _reprieve(id: string): void {
		const waiting = this._waiting.get(id);

		if (!waiting) {
			return;
		}

		clearTimeout(waiting.timer);
		waiting.timer = setTimeout(() => {
			this._forget(id);
			waiting.reject(new Error(`The worker stopped answering for ${id}`));
		}, JOB_TIMEOUT_MS);
		waiting.timer.unref?.();
	}

	private _settle(answer: JobDone): void {
		const waiting = this._waiting.get(answer.id);

		if (!waiting) {
			return;
		}

		clearTimeout(waiting.timer);
		this._forget(answer.id);

		if (answer.error === null) {
			waiting.resolve(answer.output);
		} else {
			waiting.reject(new Error(answer.error));
		}
	}

	private _announce(id: string, kind: JobKindValue, output: unknown, error: string | null): void {
		this._events.emit(EventName.JOB_FINISHED, { runId: id, kind, output, error });
	}

	/**
	 * A thread-level failure belongs to every job on *that* thread: none of them will
	 * answer. Not to the other lanes, which are a different thread and still running —
	 * rejecting them too would fail a projection because a scan died.
	 */
	private _fail(error: Error, lane: Lane): void {
		this._logger.error(`Worker failed on the ${lane} lane: ${error.message}`);

		for (const [id, waiting] of [...this._waiting]) {
			if (waiting.lane !== lane) {
				continue;
			}

			clearTimeout(waiting.timer);
			this._forget(id);
			waiting.reject(error);
		}
	}
}

export { JobKind };
