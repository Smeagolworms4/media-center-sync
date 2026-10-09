import { EventEmitter } from 'node:events';

/*
 * The reader, replaced by an object that remembers what it was told.
 *
 * A real one would need `dist/worker/read.worker.js` and a database file, neither of
 * which a unit run has — so what is pinned here is the contract: which statement goes
 * out, which answer settles which caller, what a dead reader does to the callers still
 * waiting, and the refusals that keep a caller on its own thread. That a real reader
 * returns the same rows as the gateway's own connection is proven against a copy of the
 * catalogue, not here.
 */
class FakeWorker extends EventEmitter {
	public static readonly spawned: FakeWorker[] = [];

	public readonly posted: { id: string; sql: string; params: unknown[] }[] = [];

	public terminated = 0;

	public unreferenced = 0;

	public constructor(
		public readonly entry: string,
		public readonly options: { workerData?: unknown; execArgv?: string[] },
	) {
		super();
		FakeWorker.spawned.push(this);
	}

	public postMessage(message: { id: string; sql: string; params: unknown[] }): void {
		this.posted.push(message);
	}

	public terminate(): Promise<number> {
		this.terminated += 1;

		return Promise.resolve(0);
	}

	public unref(): void {
		this.unreferenced += 1;
	}
}

/*
 * Whether the reader's entry and the database file are on disk.
 *
 * Both answers are rules worth pinning: without the entry the pool stands down and the
 * caller reads on its own thread, and a `database` naming a file that is not there must
 * not start a reader that would fail on its first statement.
 */
const onDisk = jest.fn((_path: string) => true);

jest.mock('node:fs', () => ({
	...jest.requireActual<Record<string, unknown>>('node:fs'),
	existsSync: (path: string) => onDisk(path),
}));

jest.mock('node:worker_threads', () => ({
	Worker: class {
		public constructor(entry: string, options: { workerData?: unknown }) {
			return new FakeWorker(entry, options) as unknown as never;
		}
	},
	// A thread must never open threads of its own, and `isWorkerThread` reads these.
	isMainThread: true,
	workerData: null,
}));

import type { DataSource } from 'typeorm';
import { ReadPoolService } from './read-pool.service';

/*
 * Every pool a test builds, so that `afterEach` can shut it down.
 *
 * Several tests leave a call unanswered on purpose — that is how routing and the idlest
 * reader are observed — and an unanswered call holds a thirty-second timer whose
 * rejection would surface long after the suite has moved on, as an unhandled rejection
 * attributed to nothing. Shutting the pool down settles them where they were made.
 */
const built: ReadPoolService[] = [];

const build = (options: Record<string, unknown> = {}): ReadPoolService => {
	const pool = new ReadPoolService({
		options: { type: 'better-sqlite3', database: '/var/gateway.db', ...options },
	} as unknown as DataSource);

	built.push(pool);

	return pool;
};

/** The readers the pool started, in the order it started them. */
const readers = (): FakeWorker[] => FakeWorker.spawned;

describe('ReadPoolService', () => {
	beforeEach(() => {
		FakeWorker.spawned.length = 0;
		built.length = 0;
		jest.clearAllMocks();
		onDisk.mockImplementation(() => true);
	});

	afterEach(() => {
		for (const pool of built) {
			pool.onModuleDestroy();
		}
	});

	describe('deciding whether there is anything to open', () => {
		it('opens on a SQLite file', () => {
			expect(build().available).toBe(true);
		});

		it('stands down on PostgreSQL, where the driver already is asynchronous', () => {
			expect(build({ type: 'postgres', database: 'gateway' }).available).toBe(false);
		});

		it('stands down on :memory:, where a second connection is a second, empty database', () => {
			expect(build({ database: ':memory:' }).available).toBe(false);
		});

		it('stands down when the file is not there', () => {
			onDisk.mockImplementation(() => false);

			expect(build().available).toBe(false);
		});

		it('looks once and remembers, so a listing does not stat the disk every time', () => {
			const pool = build();

			expect(pool.available).toBe(true);
			onDisk.mockImplementation(() => false);
			expect(pool.available).toBe(true);
		});
	});

	describe('what may cross to a reader', () => {
		it.each([
			['strings', ['a', 'b']],
			['numbers', [1, 2.5]],
			['nulls', [null]],
			['bigints', [1n]],
			['nothing at all', []],
		])('binds %s', (_label, params) => {
			expect(build().bindable(params)).toBe(true);
		});

		/*
		 * The two the driver throws on, and the reason the check exists rather than a
		 * conversion: a `Date` written in a different format than the column holds
		 * matches nothing, and nothing anywhere says why.
		 */
		it.each([
			['booleans', [true]],
			['dates', [new Date()]],
			['objects', [{}]],
			['undefined', [undefined]],
		])('refuses %s', (_label, params) => {
			expect(build().bindable(params)).toBe(false);
		});
	});

	describe('running a statement', () => {
		it('starts its readers once and sends the statement to one of them', async () => {
			const pool = build();
			const rows = pool.all('SELECT 1', []);

			expect(readers()).toHaveLength(2);
			expect(readers()[0].posted.at(-1)).toMatchObject({ sql: 'SELECT 1', params: [] });

			readers()[0].emit('message', { id: readers()[0].posted[0].id, rows: [{ id: 'a' }] });

			await expect(rows).resolves.toEqual([{ id: 'a' }]);

			void pool.all('SELECT 2', []).catch(() => undefined);
			expect(readers()).toHaveLength(2);
		});

		it('hands the reader the file and marks it as a worker thread', () => {
			void build().all('SELECT 1', []).catch(() => undefined);

			expect(readers()[0].options.workerData).toEqual({ mcsWorker: true, file: '/var/gateway.db' });
		});

		it('spreads two calls over both readers rather than queueing on one', () => {
			const pool = build();

			void pool.all('SELECT 1', []).catch(() => undefined);
			void pool.all('SELECT 2', []).catch(() => undefined);

			expect(readers()[0].posted).toHaveLength(1);
			expect(readers()[1].posted).toHaveLength(1);
		});

		it('comes back to the first reader once it has answered', async () => {
			const pool = build();
			const first = pool.all('SELECT 1', []);

			void pool.all('SELECT 2', []).catch(() => undefined);
			readers()[0].emit('message', { id: readers()[0].posted[0].id, rows: [] });
			await first;

			void pool.all('SELECT 3', []).catch(() => undefined);

			expect(readers()[0].posted).toHaveLength(2);
		});

		it('rejects with what the reader said went wrong', async () => {
			const pool = build();
			const rows = pool.all('SELECT bad', []);

			readers()[0].emit('message', { id: readers()[0].posted[0].id, error: 'no such column' });

			await expect(rows).rejects.toThrow('no such column');
		});

		it('ignores an answer to a request it is no longer waiting for', () => {
			const pool = build();

			void pool.all('SELECT 1', []).catch(() => undefined);

			expect(() => readers()[0].emit('message', { id: 'someone else', rows: [] })).not.toThrow();
		});

		it('refuses when there is no entry to start, so the caller reads on its own thread', async () => {
			onDisk.mockImplementation((path: string) => !path.includes('read.worker'));

			const pool = build();

			await expect(pool.all('SELECT 1', [])).rejects.toThrow('No reader is available');
			expect(readers()).toHaveLength(0);
			// And it does not try again on the next listing.
			expect(pool.available).toBe(false);
		});
	});

	describe('when a reader dies', () => {
		it('fails the callers still waiting rather than leaving them for the timeout', async () => {
			const pool = build();
			const rows = pool.all('SELECT 1', []);

			readers()[0].emit('error', new Error('the disk went away'));

			await expect(rows).rejects.toThrow('the disk went away');
		});

		it('takes the whole pool down, because the other reader is about to die of the same thing',
			async () => {
				const pool = build();

				void pool.all('SELECT 1', []).catch(() => undefined);
				readers()[0].emit('error', new Error('the disk went away'));

				expect(readers()[0].terminated).toBe(1);
				expect(readers()[1].terminated).toBe(1);
				await expect(pool.all('SELECT 2', [])).rejects.toThrow('No reader is available');
			});
	});

	describe('shutting down', () => {
		it('releases the callers and the threads', async () => {
			const pool = build();
			const rows = pool.all('SELECT 1', []);

			pool.onModuleDestroy();

			await expect(rows).rejects.toThrow('The gateway is shutting down');
			expect(readers()[0].terminated).toBe(1);
			expect(readers()[1].terminated).toBe(1);
		});

		it('leaves the process free to exit while a reader is idle', () => {
			void build().all('SELECT 1', []).catch(() => undefined);

			expect(readers()[0].unreferenced).toBe(1);
		});
	});
});
