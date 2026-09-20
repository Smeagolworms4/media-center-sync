import request from 'supertest';
import {
	HistoryView,
	SyncJobState,
	SyncTrigger,
	TransferState,
	UserRole,
	type ResultList,
	type SyncJob,
	type Transfer,
} from '@mcs/shared';
import { MaintenanceManager } from '@/managers';
import { SyncJobRepository, TransferRepository } from '@/repositories';
import { SchedulerService } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The retention that was declared and never ran, over the real application.
 *
 * `SyncJobRepository.deleteFinishedBefore` and its transfer counterpart existed and
 * were unit-tested for a long time while nothing in the application ever called
 * either, so `transferHistoryDays` was a setting that was validated, displayed, and
 * read by nothing. Testing it against the container rather than against a manager and
 * two fakes is the only way that class of defect shows up: a fake repository would
 * have been deleted from happily whether or not anything was wired to it.
 */
describe('retention and the scheduled maintenance', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let jobs: SyncJobRepository;
	let transfers: TransferRepository;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		jobs = context.app.get(SyncJobRepository);
		transfers = context.app.get(TransferRepository);
	});

	afterAll(async () => {
		await context.close();
	});

	beforeEach(async () => {
		// `delete({})` is refused by TypeORM as an empty criteria, which is the right
		// default everywhere but here.
		await transfers.clear();
		await jobs.clear();
	});

	const ago = (days: number): Date => new Date(Date.now() - days * DAY);

	const aJob = (state: SyncJobState, finishedAt: Date | null): Promise<SyncJob & { id: string }> =>
		jobs.save(
			jobs.create({ planId: null, trigger: SyncTrigger.MANUAL, state, finishedAt }),
		) as unknown as Promise<SyncJob & { id: string }>;

	const aTransfer = (state: TransferState, finishedAt: Date | null, title: string) =>
		transfers.save(
			transfers.create({
				itemId: 'item-1',
				title,
				state,
				targetPath: `/media/Shows/${title}.mkv`,
				workPath: `/var/transfer/${title}.part`,
				bytesTotal: 1_000,
				bytesDone: state === TransferState.DONE ? 1_000 : 0,
				finishedAt,
			}),
		);

	const listJobs = async (query = ''): Promise<ResultList<SyncJob>> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/sync/jobs${query}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as ResultList<SyncJob>;
	};

	const listTransfers = async (query = ''): Promise<ResultList<Transfer>> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/transfers${query}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as ResultList<Transfer>;
	};

	const setRetention = (body: Record<string, number>): request.Test =>
		request(context.app.getHttpServer())
			.patch('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body)
			.expect(200);

	/**
	 * The guard the whole rework exists for.
	 *
	 * The scheduler knows about four tasks and, for the life of the product, three of
	 * them had no subscriber anywhere: the periodic refresh, the scheduled full rescan
	 * and this retention pass were armed at every boot and fired into `null`. Asked of
	 * the real container, so adding a hook and forgetting to subscribe in a module that
	 * is never instantiated fails here too.
	 */
	it('has a subscriber for every task the scheduler will run', () => {
		expect(context.app.get(SchedulerService).unsubscribedHooks()).toEqual([]);
	});

	it('removes a finished run that is past the window and leaves a running one', async () => {
		const stale = await aJob(SyncJobState.DONE, ago(90));
		const running = await aJob(SyncJobState.RUNNING, null);

		await setRetention({ transferHistoryDays: 30 });
		await context.app.get(MaintenanceManager).cleanup();

		const page = await listJobs('?page=1&limit=50');
		const ids = page.items.map((job) => job.id);

		expect(ids).not.toContain(stale.id);
		expect(ids).toContain(running.id);
	});

	it('leaves a run that finished inside the window exactly where it was', async () => {
		const recent = await aJob(SyncJobState.DONE, ago(2));

		await setRetention({ transferHistoryDays: 30 });
		await context.app.get(MaintenanceManager).cleanup();

		expect((await listJobs('?page=1&limit=50')).items.map((job) => job.id)).toContain(recent.id);
	});

	it('is the setting that decides, not a constant', async () => {
		// The point of the whole exercise: `transferHistoryDays` was declared,
		// validated, displayed and read by nothing at all.
		const week = await aJob(SyncJobState.DONE, ago(10));

		await setRetention({ transferHistoryDays: 30 });
		await context.app.get(MaintenanceManager).cleanup();

		expect((await listJobs('?page=1&limit=50')).items.map((job) => job.id)).toContain(week.id);

		await setRetention({ transferHistoryDays: 7 });
		await context.app.get(MaintenanceManager).cleanup();

		expect((await listJobs('?page=1&limit=50')).items.map((job) => job.id)).not.toContain(week.id);
	});

	it('keeps a failure long after the success beside it has gone', async () => {
		// A transfer that failed three weeks ago is the evidence of why a series is
		// incomplete, and deleting it on the same schedule as a success destroys the
		// answer before anybody thinks to ask the question.
		await aTransfer(TransferState.DONE, ago(60), 'S01E01');
		await aTransfer(TransferState.FAILED, ago(60), 'S01E02');

		await setRetention({ transferHistoryDays: 30, failedHistoryDays: 180 });
		await context.app.get(MaintenanceManager).cleanup();

		const page = await listTransfers('?page=1&limit=50');

		expect(page.items.map((one) => one.title)).toEqual(['S01E02']);
	});

	it('never touches a transfer that has not finished, however old', async () => {
		await aTransfer(TransferState.DOWNLOADING, null, 'S02E01');
		await aTransfer(TransferState.PAUSED, null, 'S02E02');

		await setRetention({ transferHistoryDays: 0, failedHistoryDays: 0 });
		await context.app.get(MaintenanceManager).cleanup();

		expect((await listTransfers('?page=1&limit=50')).pagination.total).toBe(2);
	});

	describe('the live half of a list', () => {
		it('leaves finished runs out, and keeps them one query away', async () => {
			const running = await aJob(SyncJobState.RUNNING, null);
			const done = await aJob(SyncJobState.DONE, new Date());

			const live = await listJobs(`?page=1&limit=50&view=${HistoryView.LIVE}`);
			const finished = await listJobs(`?page=1&limit=50&view=${HistoryView.FINISHED}`);

			expect(live.items.map((job) => job.id)).toEqual([running.id]);
			expect(finished.items.map((job) => job.id)).toEqual([done.id]);
		});

		it('counts a paused transfer as live, because somebody will resume it', async () => {
			await aTransfer(TransferState.PAUSED, null, 'S03E01');
			await aTransfer(TransferState.CANCELLED, new Date(), 'S03E02');

			const live = await listTransfers(`?page=1&limit=50&view=${HistoryView.LIVE}`);

			expect(live.items.map((one) => one.title)).toEqual(['S03E01']);
		});

		it('still answers everything when nothing asks for a half', async () => {
			// The home screen reads its failed transfers out of the unfiltered list, so
			// a default that had started hiding finished rows would have silenced the
			// only place it reports a pull that went wrong.
			await aTransfer(TransferState.DONE, new Date(), 'S04E01');
			await aTransfer(TransferState.DOWNLOADING, null, 'S04E02');

			expect((await listTransfers('?page=1&limit=50')).pagination.total).toBe(2);
		});

		it('refuses a view it does not know rather than guessing', async () => {
			await request(context.app.getHttpServer())
				.get('/api/transfers?view=recent')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(400);
		});
	});
});
