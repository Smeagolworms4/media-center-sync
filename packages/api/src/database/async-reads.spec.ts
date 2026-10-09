import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { QueryResult } from 'typeorm/query-runner/QueryResult';
import { applyAsynchronousReads, type AsynchronousReader, useReadPool } from './async-reads';

/*
 * The in-thread path, replaced.
 *
 * The real one needs a `better-sqlite3` connection, and what is under test is not SQLite
 * — it is the decision of *where* a statement runs. So the original method is swapped for
 * a mock before the patch wraps it, and "stayed on this thread" becomes an assertion
 * about this mock rather than about a database.
 */
const inThread = jest.fn(async (): Promise<unknown> => 'this thread');

const logQuery = jest.fn();
const log = jest.fn();

interface Runner {
	isReleased: boolean;
	isTransactionActive: boolean;
	connection: { logger: { logQuery: typeof logQuery; log: typeof log } };
}

type Query = (
	this: Runner,
	query: string,
	parameters?: unknown[],
	useStructuredResult?: boolean,
) => Promise<unknown>;

const patched = (): Query => (BetterSqlite3QueryRunner.prototype as unknown as { query: Query }).query;

const runner = (over: Partial<Runner> = {}): Runner => ({
	isReleased: false,
	isTransactionActive: false,
	connection: { logger: { logQuery, log } },
	...over,
});

const rows = [{ id: 'a' }, { id: 'b' }];

const pool = (over: Partial<AsynchronousReader> = {}): AsynchronousReader => ({
	available: true,
	bindable: () => true,
	all: jest.fn(async () => rows) as AsynchronousReader['all'],
	...over,
});

/** Runs a statement through the patched method, as TypeORM would. */
const run = (
	sql: string,
	options: { on?: Partial<Runner>; parameters?: unknown[]; structured?: boolean } = {},
): Promise<unknown> =>
	patched().call(runner(options.on), sql, options.parameters ?? [], options.structured ?? false);

describe('applyAsynchronousReads', () => {
	beforeAll(() => {
		(BetterSqlite3QueryRunner.prototype as unknown as { query: Query }).query =
			inThread as unknown as Query;

		applyAsynchronousReads();
	});

	beforeEach(() => {
		jest.clearAllMocks();
		useReadPool(pool());
	});

	afterEach(() => {
		useReadPool(null);
	});

	describe('what leaves this thread', () => {
		it('sends a SELECT to a reader and answers with its rows', async () => {
			const reads = pool();

			useReadPool(reads);

			await expect(run('SELECT * FROM media_item')).resolves.toEqual(rows);
			expect(reads.all).toHaveBeenCalledWith('SELECT * FROM media_item', []);
			expect(inThread).not.toHaveBeenCalled();
		});

		it('passes the parameters through as they are', async () => {
			const reads = pool();

			useReadPool(reads);
			await run('select id from media_item where id = ?', { parameters: ['x', 2] });

			expect(reads.all).toHaveBeenCalledWith('select id from media_item where id = ?', ['x', 2]);
		});

		it('tolerates the leading whitespace a query builder leaves', async () => {
			await expect(run('\n\t  SELECT 1')).resolves.toEqual(rows);
			expect(inThread).not.toHaveBeenCalled();
		});

		it('logs the statement, so a routed read is as visible as any other', async () => {
			await run('SELECT 1');

			expect(logQuery).toHaveBeenCalledWith('SELECT 1', [], expect.anything());
		});

		it('returns a QueryResult when TypeORM asked for one', async () => {
			const result = await run('SELECT 1', { structured: true });

			expect(result).toBeInstanceOf(QueryResult);
			expect(result).toMatchObject({ raw: rows, records: rows });
		});
	});

	/*
	 * The cases that must stay here, and the reason the list is short and firm: each of
	 * these would be a *wrong answer* on a reader, not a slow one.
	 */
	describe('what must stay on this thread', () => {
		it.each([
			['an insert', 'INSERT INTO media_item (id) VALUES (?)'],
			['an update', 'UPDATE media_item SET title = ?'],
			['a delete', 'DELETE FROM media_item'],
			['a pragma', 'PRAGMA table_info("media_item")'],
			['a schema change', 'CREATE TABLE things (id varchar)'],
			['a transaction boundary', 'BEGIN TRANSACTION'],
			['a common table expression, which SQLite also lets write', 'WITH x AS (SELECT 1) DELETE FROM media_item'],
		])('keeps %s here', async (_label, sql) => {
			await expect(run(sql)).resolves.toBe('this thread');
			expect(inThread).toHaveBeenCalledTimes(1);
		});

		it('keeps a read inside a transaction here, which would otherwise miss uncommitted work', async () => {
			await expect(run('SELECT 1', { on: { isTransactionActive: true } })).resolves.toBe('this thread');
		});

		it('keeps everything here once the runner is released', async () => {
			await expect(run('SELECT 1', { on: { isReleased: true } })).resolves.toBe('this thread');
		});

		it('keeps everything here when no pool ever registered', async () => {
			useReadPool(null);

			await expect(run('SELECT 1')).resolves.toBe('this thread');
		});

		it('keeps everything here when the pool says it has nothing to read on', async () => {
			useReadPool(pool({ available: false }));

			await expect(run('SELECT 1')).resolves.toBe('this thread');
		});

		it('keeps a statement here when a parameter will not bind', async () => {
			useReadPool(pool({ bindable: () => false }));

			await expect(run('SELECT 1', { parameters: [new Date()] })).resolves.toBe('this thread');
		});
	});

	describe('when a reader cannot answer', () => {
		it('runs the statement here instead, so a broken pool costs speed and never an answer', async () => {
			useReadPool(pool({ all: jest.fn(async () => Promise.reject(new Error('wedged'))) as AsynchronousReader['all'] }));

			await expect(run('SELECT 1')).resolves.toBe('this thread');
			expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('wedged'), expect.anything());
		});

		it('says something even when what was thrown is not an error', async () => {
			useReadPool(pool({ all: jest.fn(async () => Promise.reject('exploded')) as AsynchronousReader['all'] }));

			await expect(run('SELECT 1')).resolves.toBe('this thread');
			expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('exploded'), expect.anything());
		});
	});

	it('patches once, however many times it is called', () => {
		const before = patched();

		applyAsynchronousReads();

		expect(patched()).toBe(before);
	});
});
