import { EventEmitter } from 'node:events';
import type { JobAnswer, JobRequest } from './protocol';
import { JobKind } from './protocol';

/*
 * The port, and the five objects the worker would have built.
 *
 * Everything the real entry reaches for is replaced here, because what is under test is
 * not the correlation — that has its own suite — but the contract the thread keeps with
 * the pool: one answer per request, carrying the request's identifier, whatever happens.
 * A worker that threw instead would reach the pool as a thread-level failure and reject
 * every other job in flight.
 */
const port = new EventEmitter() as EventEmitter & { postMessage: jest.Mock };

port.postMessage = jest.fn();

const initialize = jest.fn().mockResolvedValue(undefined);
const correlate = jest.fn().mockResolvedValue(0);

jest.mock('node:worker_threads', () => ({
	parentPort: port,
	workerData: { mcsWorker: true },
}));

jest.mock('typeorm', () => ({
	DataSource: class {
		public initialize = initialize;

		public createEntityManager = (): unknown => ({});
	},
}));

jest.mock('@/database', () => ({ dataSourceOptions: () => ({ type: 'better-sqlite3' }) }));

// The repositories, faked as classes rather than loaded: the real ones extend TypeORM's
// `Repository`, which the mock above no longer provides, and none of them is what this
// file decides.
jest.mock('@/repositories', () => ({
	MediaItemRepository: class {},
	MediaMatchRepository: class {},
	MediaServiceRepository: class {},
	MediaLandingRepository: class {},
}));

jest.mock('@/services/correlation.service', () => ({
	CorrelationService: class {
		public correlate = correlate;
	},
}));

jest.mock('@/services/matching.service', () => ({ MatchingService: class {} }));
jest.mock('@/services/quality.service', () => ({ QualityService: class {} }));

/** Every answer the worker has posted, oldest first. */
const answers = (): JobAnswer[] => port.postMessage.mock.calls.map(([answer]) => answer as JobAnswer);

const done = (): Extract<JobAnswer, { type: 'done' }> | undefined =>
	answers().find((answer): answer is Extract<JobAnswer, { type: 'done' }> => answer.type === 'done');

/** Hand the worker a request and wait for it to have answered. */
const ask = async (request: Partial<JobRequest> = {}): Promise<void> => {
	port.emit('message', {
		id: 'run-1',
		kind: JobKind.CORRELATE,
		input: { serviceId: 'svc-a', threshold: 0.8 },
		...request,
	});

	// The handler is asynchronous; a few turns of the loop is all it needs here.
	for (let turn = 0; turn < 10; turn += 1) {
		await Promise.resolve();
	}
};

describe('the jobs worker', () => {
	beforeEach(async () => {
		jest.resetModules();
		port.removeAllListeners();
		port.postMessage.mockClear();
		initialize.mockClear().mockResolvedValue(undefined);
		correlate.mockClear().mockResolvedValue(0);
		// Imported per test rather than at the top: the entry attaches to the port and
		// caches its connection as it is evaluated, so each test needs its own copy.
		await import('./jobs.worker');
	});

	it('runs the pass and answers under the identifier it was given', async () => {
		await ask({ id: 'run-7' });

		expect(correlate).toHaveBeenCalledWith('svc-a', 0.8, expect.any(Function));
		expect(done()).toEqual({
			type: 'done',
			id: 'run-7',
			kind: JobKind.CORRELATE,
			output: 0,
			error: null,
		});
	});

	it('opens the database once, however many jobs arrive', async () => {
		// A worker is kept alive between jobs precisely so that this is paid once.
		await ask({ id: 'a' });
		await ask({ id: 'b' });

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(correlate).toHaveBeenCalledTimes(2);
	});

	it('relays each position the pass reports, deciding none of them itself', async () => {
		correlate.mockImplementation(
			async (_service: string, _threshold: number, onProgress: (done: number, total: number) => void) => {
				for (let walked = 1; walked <= 400; walked += 1) {
					onProgress(walked, 400);
				}

				return 400;
			},
		);

		await ask();

		const walked = answers().filter(
			(answer) => answer.type === 'progress' && 'done' in answer.payload,
		);

		/*
		 * Every one of them, because how often to speak is the pass's decision and not
		 * this file's — see `PROGRESS_EVERY` in `CorrelationService`. A second throttle
		 * here would be two numbers to keep in step, and it was: the in-process path ran
		 * unthrottled while the worker trimmed its own messages, so the same pass reported
		 * once per row or once per two hundred depending on where it happened to run.
		 */
		expect(walked).toHaveLength(400);
		expect(walked.at(-1)).toMatchObject({ payload: { done: 400, total: 400 } });
	});

	it('runs one job at a time, however many arrive at once', async () => {
		/*
		 * A correlation holds the whole catalogue in memory with six indexes over it. Two
		 * at once is twice that on a NAS and no faster: they contend for the same
		 * database, which has one writer by construction. And the gateway really can send
		 * two — its guard against a competing scan is keyed on the service, not on itself.
		 */
		let running = 0;
		let together = 0;

		correlate.mockImplementation(async () => {
			running += 1;
			together = Math.max(together, running);

			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});

			running -= 1;

			return 1;
		});

		port.emit('message', { id: 'a', kind: JobKind.CORRELATE, input: { serviceId: 's', threshold: 0.8 } });
		port.emit('message', { id: 'b', kind: JobKind.CORRELATE, input: { serviceId: 's', threshold: 0.8 } });

		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});

		expect(together).toBe(1);
		// And both were answered: a queue that drops the second is not a queue.
		expect(answers().filter((one) => one.type === 'done').map((one) => (one as { id: string }).id))
			.toEqual(['a', 'b']);
	});

	it('keeps the queue after a job that failed', async () => {
		// A job that threw must not take the passes behind it with it.
		correlate.mockRejectedValueOnce(new Error('the first one broke')).mockResolvedValue(4);

		port.emit('message', { id: 'a', kind: JobKind.CORRELATE, input: { serviceId: 's', threshold: 0.8 } });
		port.emit('message', { id: 'b', kind: JobKind.CORRELATE, input: { serviceId: 's', threshold: 0.8 } });

		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});

		const settled = answers().filter((one) => one.type === 'done');

		expect(settled).toMatchObject([
			{ id: 'a', error: 'the first one broke' },
			{ id: 'b', output: 4, error: null },
		]);
	});

	it('says it has begun before it has read a row', async () => {
		// The pool's timeout means "no sign of life", so a job that waited behind another
		// needs to say when it starts or it spends its whole allowance queued.
		await ask();

		expect(answers()[0]).toMatchObject({ type: 'progress', payload: { phase: 'reading' } });
	});

	it('answers a failure rather than dying, so the jobs beside it survive', async () => {
		correlate.mockRejectedValue(new Error('no such table: media_services'));

		await ask({ id: 'run-9' });

		expect(done()).toMatchObject({ id: 'run-9', output: null, error: 'no such table: media_services' });
	});

	it('refuses a request whose arguments did not survive the crossing', async () => {
		// `postMessage` structured-clones whatever it was handed and preserves no types,
		// so this check is the only thing between a typo on the calling side and a pass
		// correlating `undefined`.
		await ask({ input: { serviceId: 'svc-a' } });

		expect(correlate).not.toHaveBeenCalled();
		expect(done()).toMatchObject({ error: 'A correlation needs a serviceId and a threshold' });
	});

	it('answers an unknown job instead of taking the thread down with it', async () => {
		await ask({ kind: 'something-else' as never });

		expect(done()).toMatchObject({ error: 'The worker has no job called something-else' });
	});
});

describe('a worker started by something other than the pool', () => {
	it('answers nothing at all', async () => {
		jest.resetModules();
		jest.doMock('node:worker_threads', () => ({ parentPort: port, workerData: null }));
		port.removeAllListeners();
		port.postMessage.mockClear();

		await import('./jobs.worker');

		// It said so, and then it did not listen: a thread answering jobs while every
		// bootstrap hook believed it was the gateway would arm the schedules twice.
		expect(answers()).toEqual([
			{ type: 'log', level: 'error', message: 'A worker was started without mcsWorker and will answer nothing' },
		]);

		port.postMessage.mockClear();
		await ask();

		expect(answers()).toEqual([]);
	});
});
