/*
 * The worker's own entry. Read `WorkerPoolService` first: this is the other end of it.
 *
 * `reflect-metadata` before anything else, and it is not optional. The entities carry
 * TypeORM decorators, which write their column metadata the moment the class is
 * evaluated; without the shim the first `import` of an entity throws
 * `Reflect.getMetadata is not a function`, from a stack that names neither the entity nor
 * this line. `main.ts` does the same thing for the same reason — a worker is a second
 * process entry and inherits nothing from the first.
 */
import 'reflect-metadata';
import { parentPort, workerData } from 'node:worker_threads';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '@/database';
import {
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { CorrelationService } from '@/services/correlation.service';
import { MatchingService } from '@/services/matching.service';
import { QualityService } from '@/services/quality.service';
import { JobKind, type JobAnswer, type JobRequest } from './protocol';

const say = (answer: JobAnswer): void => {
	parentPort?.postMessage(answer);
};

const log = (level: 'debug' | 'log' | 'warn' | 'error', message: string): void => {
	say({ type: 'log', level, message });
};

/**
 * No Nest, no container, no second copy of the application.
 *
 * This is the whole reason the correlation was lifted out of `MediaManager`: a second
 * container would be every manager, handler and registry built twice in one process,
 * which on a NAS is the memory this gateway can least afford — and none of it is needed
 * to walk a catalogue. Five objects are, and here they are, built by hand.
 *
 * Built once and kept. A worker is kept alive between jobs by the pool precisely so that
 * opening the database is paid once rather than per pass.
 */
let connection: Promise<{ correlation: CorrelationService }> | null = null;

const open = async (): Promise<{ correlation: CorrelationService }> => {
	/*
	 * Never the migrations, and this is the one place that difference matters.
	 *
	 * The gateway runs them on the way up, which is how a container that has just been
	 * updated serves anything at all. A worker that also ran them would be a second
	 * process altering the schema of a database the first one is reading — on SQLite, in
	 * the same file, with WAL and a five-second busy timeout standing between the
	 * household and a corrupted table. The worker opens a database somebody else has
	 * already brought up to date.
	 */
	const dataSource = new DataSource({ ...dataSourceOptions(), migrationsRun: false });

	await dataSource.initialize();

	const correlation = new CorrelationService(
		new MediaItemRepository(dataSource),
		new MediaMatchRepository(dataSource),
		new MediaServiceRepository(dataSource),
		new MediaLandingRepository(dataSource),
		new MatchingService(new QualityService()),
	);

	log('log', 'Worker ready');

	return { correlation };
};

const correlate = async (id: string, input: Record<string, unknown>): Promise<unknown> => {
	const serviceId = input.serviceId;
	const threshold = input.threshold;

	/*
	 * Checked rather than cast, because `postMessage` carries whatever it was given.
	 * A structured clone preserves no types, so the only thing standing between a typo
	 * on the calling side and a pass that correlates `undefined` is this.
	 */
	if (typeof serviceId !== 'string' || typeof threshold !== 'number') {
		throw new Error('A correlation needs a serviceId and a threshold');
	}

	connection ??= open();

	const { correlation } = await connection;

	// Relayed as it comes: the pass decides how often to speak — see `PROGRESS_EVERY`
	// there — and a second throttle here would be two numbers to keep in step.
	return correlation.correlate(serviceId, threshold, (done, total) => {
		say({ type: 'progress', id, kind: JobKind.CORRELATE, payload: { done, total } });
	});
};

const run = async (request: JobRequest): Promise<unknown> => {
	if (request.kind === JobKind.CORRELATE) {
		/*
		 * Said as the job leaves the queue, before it has read a row.
		 *
		 * It is a sign of life rather than a measurement, and the pool needs one: its
		 * timeout exists to catch a thread that has died without saying so, and a job
		 * that waited behind another would otherwise spend its whole allowance queued.
		 * See `_settle`, which pushes the deadline back on every message a job sends.
		 */
		say({ type: 'progress', id: request.id, kind: request.kind, payload: { phase: 'reading' } });

		return correlate(request.id, request.input);
	}

	// Unreachable while `JobKind` is a closed set, and answered rather than thrown
	// anyway: a worker that dies on an unknown job takes every other job in flight with
	// it, and the caller is left waiting for the timeout to explain it.
	throw new Error(`The worker has no job called ${String(request.kind)}`);
};

/*
 * A thread started by anything but the pool answers nothing, loudly.
 *
 * `workerData.mcsWorker` is what `isWorkerThread` reads, and the two have to agree: a
 * thread that answered jobs while every bootstrap hook believed it was the gateway would
 * arm the household's schedules twice. So the flag is the condition for listening at
 * all, rather than a line in a log nobody reads.
 */
/**
 * One job at a time, however many the gateway sends.
 *
 * A correlation holds the whole catalogue in memory, with six indexes over it. Two at
 * once is twice that on a NAS and no faster: they contend for the same database, which
 * has one writer by construction. The gateway can start a scan per service — the guard
 * in `ServiceManager` is keyed on the service, not on the gateway — so this is a real
 * arrangement rather than a hypothetical one.
 *
 * A chain of promises rather than a lock, because that is all a queue is here: each job
 * runs after the one before it, and a job that fails does not take the queue with it —
 * the handler never rejects.
 */
let queue: Promise<void> = Promise.resolve();

const answer = async (request: JobRequest): Promise<void> => {
	try {
		const output = await run(request);

		say({ type: 'done', id: request.id, kind: request.kind, output, error: null });
	} catch (error: unknown) {
		/*
		 * Every failure comes back as an answer, never as a dead thread.
		 *
		 * An exception escaping here would reach the pool as `worker.on('error')`, which
		 * rejects *every* job in flight — one bad input would fail the passes queued
		 * behind it, and the message would name none of them.
		 */
		say({
			type: 'done',
			id: request.id,
			kind: request.kind,
			output: null,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

if ((workerData as { mcsWorker?: boolean } | null)?.mcsWorker === true) {
	parentPort?.on('message', (request: JobRequest) => {
		queue = queue.then(() => answer(request));
	});
} else {
	log('error', 'A worker was started without mcsWorker and will answer nothing');
}
