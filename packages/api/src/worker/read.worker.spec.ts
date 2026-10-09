import { EventEmitter } from 'node:events';

/*
 * The port and the driver, both replaced.
 *
 * What is under test is the contract the reader keeps with the pool: one answer per
 * request, carrying the request's identifier, whether the statement worked or not. A
 * reader that let an exception escape would reach the pool as a thread-level failure
 * and take down every other caller with it, which is the one outcome a bad `WHERE`
 * must not have.
 */
const port = new EventEmitter() as EventEmitter & { postMessage: jest.Mock };

port.postMessage = jest.fn();

const all = jest.fn(() => [{ id: 'a' }]);
const prepare = jest.fn((_sql: string) => ({ all }));
const pragma = jest.fn();
const opened: { file: string; options: unknown }[] = [];

jest.mock('node:worker_threads', () => ({
	parentPort: port,
	workerData: { mcsWorker: true, file: '/var/gateway.db' },
}));

jest.mock('node:module', () => ({
	createRequire: () => () =>
		class {
			public prepare = prepare;

			public pragma = pragma;

			public constructor(file: string, options: unknown) {
				opened.push({ file, options });
			}
		},
}));

/** Every answer the reader has posted, oldest first. */
const answers = (): { id: string; rows?: unknown[]; error?: string }[] =>
	port.postMessage.mock.calls.map(([answer]) => answer as { id: string });

const ask = (request: { id: string; sql: string; params: unknown[] }): void => {
	port.emit('message', request);
};

describe('read.worker', () => {
	beforeAll(async () => {
		// Imported once the mocks are in place, and inside the test rather than at the
		// top of the file: the module opens its connection and registers its listener as
		// it is evaluated, the way a thread entry does.
		await import('./read.worker');
	});

	beforeEach(() => {
		port.postMessage.mockClear();
		prepare.mockClear();
		all.mockClear();
		all.mockImplementation(() => [{ id: 'a' }]);
	});

	it('opens the file it was handed, read-only', () => {
		expect(opened).toEqual([
			{ file: '/var/gateway.db', options: { fileMustExist: true, readonly: true } },
		]);
	});

	it('waits for a contended read rather than failing it', () => {
		expect(pragma).toHaveBeenCalledWith('busy_timeout = 5000');
	});

	it('answers with the rows, under the identifier it was asked with', () => {
		ask({ id: 'one', sql: 'SELECT 1', params: ['x'] });

		expect(all).toHaveBeenCalledWith('x');
		expect(answers()).toEqual([{ id: 'one', rows: [{ id: 'a' }] }]);
	});

	it('prepares a statement once and runs it again with other parameters', () => {
		ask({ id: 'one', sql: 'SELECT 2', params: ['x'] });
		ask({ id: 'two', sql: 'SELECT 2', params: ['y'] });

		expect(prepare).toHaveBeenCalledTimes(1);
		expect(all).toHaveBeenNthCalledWith(2, 'y');
	});

	it('answers the failure instead of throwing, so one bad statement costs one caller', () => {
		all.mockImplementation(() => {
			throw new Error('no such column: nope');
		});

		ask({ id: 'three', sql: 'SELECT nope', params: [] });

		expect(answers()).toEqual([{ id: 'three', error: 'no such column: nope' }]);
	});

	it('says something even when what was thrown is not an error', () => {
		all.mockImplementation(() => {
			throw 'sqlite exploded';
		});

		ask({ id: 'four', sql: 'SELECT 1', params: [] });

		expect(answers()).toEqual([{ id: 'four', error: 'sqlite exploded' }]);
	});
});
