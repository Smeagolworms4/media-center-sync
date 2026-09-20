import type { DataSource } from 'typeorm';
import { HistoryView, SyncJobState, SyncTrigger } from '@mcs/shared';
import { createTestDataSource } from '../../test/utils/database';
import { SyncJobRepository } from './sync-job.repository';

describe('SyncJobRepository', () => {
	let dataSource: DataSource;
	let jobs: SyncJobRepository;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		jobs = new SyncJobRepository(dataSource);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	const ago = (days: number): Date => new Date(Date.now() - days * 86_400_000);

	const aJob = (state: SyncJobState, finishedAt?: Date) =>
		jobs.save(
			jobs.create({
				planId: null,
				trigger: SyncTrigger.MANUAL,
				state,
				finishedAt: finishedAt ?? null,
			}),
		);

	describe('retention', () => {
		it('forgets a finished run that is past the window', async () => {
			await aJob(SyncJobState.DONE, ago(90));

			await expect(jobs.deleteFinishedBefore(ago(30))).resolves.toBe(1);
			await expect(jobs.count()).resolves.toBe(0);
		});

		it('takes nothing that finished inside the window', async () => {
			await aJob(SyncJobState.DONE, ago(29));
			await aJob(SyncJobState.FAILED, ago(1));

			await expect(jobs.deleteFinishedBefore(ago(30))).resolves.toBe(0);
			await expect(jobs.count()).resolves.toBe(2);
		});

		it('leaves a run that has not finished, however old it is', async () => {
			// A run still pending was planned by somebody and has not happened yet.
			await aJob(SyncJobState.RUNNING);
			await aJob(SyncJobState.PENDING);

			await expect(jobs.deleteFinishedBefore(ago(0))).resolves.toBe(0);
			await expect(jobs.count()).resolves.toBe(2);
		});

		it('sweeps only the states it was given', async () => {
			// Successes and failures get different windows, which is why this takes a
			// list of states rather than always meaning all three.
			await aJob(SyncJobState.DONE, ago(90));
			await aJob(SyncJobState.FAILED, ago(90));

			await expect(jobs.deleteFinishedBefore(ago(30), [SyncJobState.DONE])).resolves.toBe(1);
			await expect(jobs.findOne({ where: { state: SyncJobState.FAILED } })).resolves.not.toBeNull();
		});

		it('refuses to sweep a state that is not finished, whatever it is asked', async () => {
			await aJob(SyncJobState.RUNNING);

			await expect(jobs.deleteFinishedBefore(ago(0), [SyncJobState.RUNNING])).resolves.toBe(0);
			await expect(jobs.count()).resolves.toBe(1);
		});
	});

	describe('paging the history', () => {
		it('answers everything when no view is asked for', async () => {
			await aJob(SyncJobState.RUNNING);
			await aJob(SyncJobState.DONE, new Date());

			const [, total] = await jobs.pageOf({ page: 1, limit: 20 });

			expect(total).toBe(2);
		});

		it('splits what is still going from what is over', async () => {
			await aJob(SyncJobState.RUNNING);
			await aJob(SyncJobState.PENDING);
			await aJob(SyncJobState.DONE, new Date());
			await aJob(SyncJobState.CANCELLED, new Date());

			const [live] = await jobs.pageOf({ page: 1, limit: 20, view: HistoryView.LIVE });
			const [finished] = await jobs.pageOf({ page: 1, limit: 20, view: HistoryView.FINISHED });

			expect(live).toHaveLength(2);
			expect(finished).toHaveLength(2);
		});

		it('answers nothing when the state and the view contradict each other', async () => {
			await aJob(SyncJobState.DONE, new Date());

			await expect(
				jobs.pageOf({ page: 1, limit: 20, state: SyncJobState.DONE, view: HistoryView.LIVE }),
			).resolves.toEqual([[], 0]);
		});
	});
});
