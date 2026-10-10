import { EventEmitter } from 'node:events';
import { EventName } from '@mcs/shared';

/*
 * The thread, replaced by an object that remembers what it was told.
 *
 * A real one would need `dist/worker/jobs.worker.js`, which a unit run does not build —
 * so what is pinned here is the protocol: which request goes out, which answer settles
 * which caller, and what happens to the callers when the thread dies. That the built
 * worker really answers is proven in the lab, where the image exists.
 */
class FakeWorker extends EventEmitter {
	public static readonly spawned: FakeWorker[] = [];

	public readonly posted: unknown[] = [];

	public terminated = 0;

	public unreferenced = 0;

	public referenced = 0;

	public constructor(
		public readonly entry: string,
		public readonly options: { workerData?: unknown; execArgv?: string[]; env?: NodeJS.ProcessEnv },
	) {
		super();
		FakeWorker.spawned.push(this);
	}

	public postMessage(message: unknown): void {
		this.posted.push(message);
	}

	public terminate(): Promise<number> {
		this.terminated += 1;

		return Promise.resolve(0);
	}

	public unref(): void {
		this.unreferenced += 1;
	}

	public ref(): void {
		this.referenced += 1;
	}
}

/*
 * Whether the built worker is on disk, which a unit run decides for itself.
 *
 * The entry is emitted by `nest build`, and these tests execute the TypeScript sources,
 * so the honest answer here is "no". It is a mock rather than a fixture because both
 * answers are rules worth pinning: with the file, the pool delegates; without it, it
 * says so and refuses rather than quietly running the pass on this thread.
 */
const onDisk = jest.fn((path: string) => path.endsWith('jobs.worker.js'));

jest.mock('node:fs', () => ({
	...jest.requireActual<Record<string, unknown>>('node:fs'),
	existsSync: (path: string) => (path.includes('jobs.worker') ? onDisk(path) : true),
}));

jest.mock('node:worker_threads', () => ({
	Worker: class {
		public constructor(entry: string, options: { workerData?: unknown }) {
			return new FakeWorker(entry, options) as unknown as never;
		}
	},
	// The gateway's half: `isWorkerThread` reads these, and a pool that believed it was
	// already inside a worker would refuse to delegate at all.
	isMainThread: true,
	workerData: null,
}));

import { JobKind } from '@/worker/protocol';
import type { DataSource } from 'typeorm';
import type { EventGatewayService } from './event-gateway.service';
import { JOB_TIMEOUT_MS, WorkerPoolService } from './worker-pool.service';

const build = (database = '/var/gateway.db'): {
	pool: WorkerPoolService;
	emit: jest.Mock;
} => {
	const emit = jest.fn();
	const pool = new WorkerPoolService(
		{ emit } as unknown as EventGatewayService,
		{ options: { database } } as unknown as DataSource,
	);

	return { pool, emit };
};

/** The thread the pool started, which the tests answer on its behalf. */
const spawned = (): FakeWorker => {
	const worker = FakeWorker.spawned.at(-1);

	if (worker === undefined) {
		throw new Error('no thread was started');
	}

	return worker;
};

const sent = (worker: FakeWorker): { id: string; kind: string; input: unknown } =>
	worker.posted.at(-1) as { id: string; kind: string; input: unknown };

describe('WorkerPoolService', () => {
	beforeEach(() => {
		FakeWorker.spawned.length = 0;
		jest.clearAllMocks();
		onDisk.mockImplementation((path: string) => path.endsWith('jobs.worker.js'));
	});

	describe('waiting for an answer', () => {
		it('sends the job and settles the caller with what came back', async () => {
			const { pool } = build();
			const answer = pool.run<number>(JobKind.CORRELATE, { serviceId: 'svc-a', threshold: 0.8 });
			const worker = spawned();
			const request = sent(worker);

			expect(request).toMatchObject({
				kind: JobKind.CORRELATE,
				input: { serviceId: 'svc-a', threshold: 0.8 },
			});

			worker.emit('message', {
				type: 'done',
				id: request.id,
				kind: JobKind.CORRELATE,
				output: 42,
				error: null,
			});

			await expect(answer).resolves.toBe(42);
		});

		it('never settles one caller with another job’s answer', async () => {
			// Several jobs can be in flight on one thread, which is the whole reason the
			// identifier is echoed. Matching on anything else would hand the wrong number
			// to the wrong screen.
			const { pool } = build();
			const first = pool.run<number>(JobKind.CORRELATE, {});
			const worker = spawned();
			const mine = sent(worker).id;

			worker.emit('message', {
				type: 'done',
				id: 'somebody-else',
				kind: JobKind.CORRELATE,
				output: 1,
				error: null,
			});

			let settled = false;

			void first.then(() => {
				settled = true;
			});
			await Promise.resolve();

			expect(settled).toBe(false);

			worker.emit('message', { type: 'done', id: mine, kind: JobKind.CORRELATE, output: 7, error: null });

			await expect(first).resolves.toBe(7);
		});

		it('rejects with the message the worker reported', async () => {
			const { pool } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			worker.emit('message', {
				type: 'done',
				id: sent(worker).id,
				kind: JobKind.CORRELATE,
				output: null,
				error: 'no such table: media_services',
			});

			await expect(answer).rejects.toThrow('no such table: media_services');
		});

		it('relays a line the worker logged without settling anything', async () => {
			// A worker has its own stdout and none of this gateway's formatting. A log that
			// counted as an answer would end the job at its first sentence.
			const { pool } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			worker.emit('message', { type: 'log', level: 'warn', message: 'something to say' });

			let settled = false;

			void answer.then(() => {
				settled = true;
			}, () => {
				settled = true;
			});
			await Promise.resolve();

			expect(settled).toBe(false);

			worker.emit('message', {
				type: 'done',
				id: sent(worker).id,
				kind: JobKind.CORRELATE,
				output: 0,
				error: null,
			});
			await expect(answer).resolves.toBe(0);
		});

		it('pushes progress onto the event stream under the run identifier', async () => {
			const { pool, emit } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();
			const id = sent(worker).id;

			worker.emit('message', {
				type: 'progress',
				id,
				kind: JobKind.CORRELATE,
				payload: { done: 200, total: 4000 },
			});

			expect(emit).toHaveBeenCalledWith(EventName.JOB_PROGRESS, {
				runId: id,
				kind: JobKind.CORRELATE,
				done: 200,
				total: 4000,
			});

			worker.emit('message', { type: 'done', id, kind: JobKind.CORRELATE, output: 0, error: null });
			await answer;
		});

		it('starts the clock again on every sign of life', async () => {
			/*
			 * What the timeout guards is a thread that died in silence, never a pass that
			 * is taking a while — taking a while is the entire point. A correlation that
			 * really needs forty minutes would otherwise be abandoned at thirty with the
			 * work done and nothing to show for it.
			 */
			jest.useFakeTimers();

			try {
				const { pool } = build();
				const answer = pool.run<number>(JobKind.CORRELATE, {});
				const worker = spawned();
				const id = sent(worker).id;

				jest.advanceTimersByTime(JOB_TIMEOUT_MS - 1000);
				worker.emit('message', {
					type: 'progress',
					id,
					kind: JobKind.CORRELATE,
					payload: { done: 1000, total: 60_000 },
				});
				jest.advanceTimersByTime(JOB_TIMEOUT_MS - 1000);

				worker.emit('message', { type: 'done', id, kind: JobKind.CORRELATE, output: 5, error: null });

				await expect(answer).resolves.toBe(5);
			} finally {
				jest.useRealTimers();
			}
		});

		it('gives up on a thread that went quiet after reporting progress', async () => {
			jest.useFakeTimers();

			try {
				const { pool } = build();
				const answer = pool.run(JobKind.CORRELATE, {});
				const worker = spawned();

				worker.emit('message', {
					type: 'progress',
					id: sent(worker).id,
					kind: JobKind.CORRELATE,
					payload: { phase: 'reading' },
				});
				jest.advanceTimersByTime(JOB_TIMEOUT_MS);

				await expect(answer).rejects.toThrow('stopped answering');
			} finally {
				jest.useRealTimers();
			}
		});

		it('gives up on a thread that has died without saying so', async () => {
			// What the timeout guards is not a slow pass — those are minutes and allowed —
			// but a thread that will never answer, which would otherwise leave the caller
			// waiting for ever and the next pass refusing to start.
			jest.useFakeTimers();

			try {
				const { pool } = build();
				const answer = pool.run(JobKind.CORRELATE, {});

				jest.advanceTimersByTime(JOB_TIMEOUT_MS);

				await expect(answer).rejects.toThrow('did not answer');
			} finally {
				jest.useRealTimers();
			}
		});
	});

	describe('being told later', () => {
		it('answers with an identifier at once and announces the result on it', async () => {
			const { pool, emit } = build();
			const runId = pool.start(JobKind.CORRELATE, { serviceId: 'svc-a' });
			const worker = spawned();

			expect(sent(worker)).toMatchObject({ id: runId, input: { serviceId: 'svc-a' } });

			worker.emit('message', {
				type: 'done',
				id: runId,
				kind: JobKind.CORRELATE,
				output: 12,
				error: null,
			});
			await Promise.resolve();
			await Promise.resolve();

			expect(emit).toHaveBeenCalledWith(EventName.JOB_FINISHED, {
				runId,
				kind: JobKind.CORRELATE,
				output: 12,
				error: null,
			});
		});

		it('announces a failure too, because a job that died in silence is the defect', async () => {
			const { pool, emit } = build();
			const runId = pool.start(JobKind.CORRELATE, {});
			const worker = spawned();

			worker.emit('message', {
				type: 'done',
				id: runId,
				kind: JobKind.CORRELATE,
				output: null,
				error: 'it went wrong',
			});
			await Promise.resolve();
			await Promise.resolve();

			expect(emit).toHaveBeenCalledWith(
				EventName.JOB_FINISHED,
				expect.objectContaining({ runId, output: null, error: expect.stringContaining('it went wrong') }),
			);
		});
	});

	describe('the thread itself', () => {
		it('starts one thread and keeps it, because opening a database is not free', () => {
			const { pool } = build();

			void pool.run(JobKind.CORRELATE, {});
			void pool.run(JobKind.CORRELATE, {});

			expect(FakeWorker.spawned).toHaveLength(1);
			expect(spawned().posted).toHaveLength(2);
		});

		it('starts it with the flag the worker refuses to answer without', () => {
			const { pool } = build();

			void pool.run(JobKind.CORRELATE, {});

			expect(spawned().options.workerData).toEqual({ mcsWorker: true });
			// Nothing to register for a built worker: it is plain JavaScript.
			expect(spawned().options.execArgv).toEqual([]);
			// Unreferenced, so a gateway with nothing else to do can still exit.
			expect(spawned().unreferenced).toBe(1);
		});

		it('fails every job in flight when the thread itself fails', async () => {
			// None of them will answer: whatever broke took the thread, not one job.
			const { pool } = build();
			const first = pool.run(JobKind.CORRELATE, {});
			const second = pool.run(JobKind.CORRELATE, {});

			spawned().emit('error', new Error('out of memory'));

			await expect(first).rejects.toThrow('out of memory');
			await expect(second).rejects.toThrow('out of memory');
		});

		it('gives a projection a thread of its own rather than the scan\u2019s queue', () => {
			/*
			 * The whole point of the lanes. A worker runs one job at a time, and a
			 * correlation is minutes of work — so a projection sharing its thread would
			 * wait for the scan, which is exactly the moment somebody is reloading the
			 * page to see what the scan found.
			 */
			const { pool } = build();

			void pool.run(JobKind.CORRELATE, {});
			void pool.run(JobKind.PROJECT, {});

			expect(FakeWorker.spawned).toHaveLength(2);
			expect(FakeWorker.spawned[0]?.posted).toHaveLength(1);
			expect(FakeWorker.spawned[1]?.posted).toHaveLength(1);
		});

		it('keeps one thread per lane rather than one per job', () => {
			const { pool } = build();

			void pool.run(JobKind.PROJECT, {});
			void pool.run(JobKind.PROJECT, {});

			expect(FakeWorker.spawned).toHaveLength(1);
			expect(spawned().posted).toHaveLength(2);
		});

		it('fails only the lane that died, because the other one is still running', async () => {
			const { pool } = build();
			const scan = pool.run(JobKind.CORRELATE, {});
			const projection = pool.run(JobKind.PROJECT, {});
			const projecting = spawned();

			FakeWorker.spawned[0]?.emit('error', new Error('out of memory'));

			await expect(scan).rejects.toThrow('out of memory');

			// Still waiting, and answered when its own thread answers: rejecting it too
			// would fail a library page because a scan ran out of memory.
			projecting.emit('message', {
				type: 'done',
				id: sent(projecting).id,
				kind: JobKind.PROJECT,
				output: { version: '3', roots: {} },
				error: null,
			});

			await expect(projection).resolves.toEqual({ version: '3', roots: {} });
		});

		it('holds the thread referenced only while that lane has work', async () => {
			/*
			 * An unreferenced thread does not hold the event loop — and during boot the
			 * HTTP server is not listening yet, so nothing else does either. A release
			 * shipped with a thread awaited at boot and Node exited code 0, silently,
			 * eight seconds in, with nothing anywhere saying why.
			 */
			const { pool } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			expect(worker.referenced).toBe(1);
			expect(worker.unreferenced).toBe(1);

			worker.emit('message', {
				type: 'done',
				id: sent(worker).id,
				kind: JobKind.CORRELATE,
				output: 1,
				error: null,
			});

			await answer;

			// Let go again, so a gateway with nothing else to do can still exit.
			expect(worker.unreferenced).toBe(2);
		});

		it('starts a fresh thread after one has exited', async () => {
			const { pool } = build();
			const first = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			worker.emit('exit', 1);

			await expect(first).rejects.toThrow('exited with 1');

			void pool.run(JobKind.CORRELATE, {});

			expect(FakeWorker.spawned).toHaveLength(2);
		});

		it('says nothing about a thread that exited cleanly', async () => {
			const { pool } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			worker.emit('message', {
				type: 'done',
				id: sent(worker).id,
				kind: JobKind.CORRELATE,
				output: 3,
				error: null,
			});
			worker.emit('exit', 0);

			await expect(answer).resolves.toBe(3);
		});

		it('reports no thread when the worker was never built, rather than hiding it', () => {
			// The shipped image always has it: it comes out of the same build. An image
			// that somehow did not would otherwise go back to stalling for eight seconds
			// with nothing saying why — this gateway has shipped one release broken by a
			// file that was not where the build expected it.
			onDisk.mockReturnValue(false);

			const { pool } = build();

			expect(pool.available).toBe(false);
			// And a caller that asked anyway is told, not quietly served on this thread.
			expect(() => pool.run(JobKind.CORRELATE, {})).toThrow('no worker');
			expect(FakeWorker.spawned).toHaveLength(0);
		});

		it('refuses to delegate over a database no second connection can read', () => {
			// An in-memory SQLite database belongs to the connection that opened it. A
			// worker would open its own, find an empty schema and answer zero — a scan
			// that quietly does nothing, which is worse than a slow one.
			const { pool } = build(':memory:');

			expect(pool.available).toBe(false);
		});

		it('looks for the worker once rather than on every job', () => {
			const { pool } = build();

			expect(pool.available).toBe(true);
			expect(pool.available).toBe(true);

			void pool.run(JobKind.CORRELATE, {});

			// One look, whatever is asked afterwards: three calls above, one `existsSync`.
			expect(onDisk).toHaveBeenCalledTimes(1);
		});

		it('starts the sources under their loader when there is no build', () => {
			/*
			 * The lab and the end-to-end run start this gateway with `ts-node src/main.ts`.
			 * A worker that only existed in `dist` would be the one part of this gateway no
			 * journey could ever exercise, which is the worst place to put a thread that
			 * writes to the household's database.
			 */
			onDisk.mockImplementation((path: string) => path.endsWith('jobs.worker.ts'));

			const { pool } = build();

			expect(pool.available).toBe(true);

			void pool.run(JobKind.CORRELATE, {});

			expect(spawned().entry).toMatch(/jobs\.worker\.ts$/);
			expect(spawned().options.execArgv).toEqual([
				'-r',
				'ts-node/register',
				'-r',
				'tsconfig-paths/register',
			]);
			// Transpiled rather than checked: the gateway compiled the same program on its
			// own way up, and paying for it again is twenty seconds on the first scan.
			expect(spawned().options.env?.TS_NODE_TRANSPILE_ONLY).toBe('true');
		});

		it('refuses to delegate from inside a worker: a thread never spawns a thread', () => {
			const { pool } = build();

			// `isMainThread` is true in this run — see the module mock — so the gateway's
			// answer is yes. The other half of the rule is `isWorkerThread`, which is
			// tested where it is read.
			expect(pool.available).toBe(true);
		});

		it('tells whoever is waiting on shutdown rather than leaving them hanging', async () => {
			const { pool } = build();
			const answer = pool.run(JobKind.CORRELATE, {});
			const worker = spawned();

			pool.onModuleDestroy();

			await expect(answer).rejects.toThrow('shutting down');
			expect(worker.terminated).toBe(1);
		});
	});
});
