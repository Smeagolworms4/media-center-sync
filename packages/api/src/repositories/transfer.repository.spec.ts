import type { DataSource } from 'typeorm';
import { HistoryView, TransferState } from '@mcs/shared';
import { createTestDataSource } from '../../test/utils/database';
import { TransferRepository } from './transfer.repository';

describe('TransferRepository', () => {
	let dataSource: DataSource;
	let transfers: TransferRepository;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		transfers = new TransferRepository(dataSource);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	const aTransfer = (state: TransferState, bytesTotal = 1_000, bytesDone = 0, finishedAt?: Date) =>
		transfers.save(
			transfers.create({
				itemId: 'item-1',
				title: 'An episode',
				state,
				targetPath: '/media/Shows/episode.mkv',
				workPath: '/var/transfer/episode.part',
				bytesTotal,
				bytesDone,
				finishedAt: finishedAt ?? null,
			}),
		);

	it('separates what is running from what is only waiting', async () => {
		await aTransfer(TransferState.DOWNLOADING);
		await aTransfer(TransferState.QUEUED);

		await expect(transfers.findActive()).resolves.toHaveLength(1);
		await expect(transfers.findQueued()).resolves.toHaveLength(1);
	});

	it('picks up a transfer left mid-verification by a process that died', async () => {
		await aTransfer(TransferState.VERIFYING);

		await expect(transfers.findActive()).resolves.toHaveLength(1);
	});

	it('counts the queue by state', async () => {
		await aTransfer(TransferState.DOWNLOADING);
		await aTransfer(TransferState.QUEUED);
		await aTransfer(TransferState.QUEUED);
		await aTransfer(TransferState.PAUSED);
		await aTransfer(TransferState.FAILED);

		const stats = await transfers.queueStats();

		expect(stats).toMatchObject({ active: 1, queued: 2, paused: 1, failed: 1 });
	});

	it('counts the bytes still to come, and ignores what will never arrive', async () => {
		await aTransfer(TransferState.DOWNLOADING, 1_000, 400);
		await aTransfer(TransferState.QUEUED, 500, 0);
		// Cancelled and failed transfers are not remaining work: counting them would
		// show a queue that never empties.
		await aTransfer(TransferState.CANCELLED, 9_000, 0);

		await expect(transfers.queueStats()).resolves.toMatchObject({ bytesRemaining: 1_100 });
	});

	it('answers zeroes on an empty queue rather than nothing at all', async () => {
		await expect(transfers.queueStats()).resolves.toEqual({
			active: 0,
			queued: 0,
			paused: 0,
			failed: 0,
			bytesRemaining: 0,
		});
	});

	it('groups a job’s transfers oldest first, and an item’s newest first', async () => {
		// A job detail reads down its transfers in the order they were planned; an
		// item's history reads the most recent attempt first, which is the one anybody
		// asking about an item wants to see.
		const first = await transfers.save(
			transfers.create({
				jobId: 'job-1',
				itemId: 'item-1',
				title: 'First',
				state: TransferState.DONE,
				targetPath: '/media/a.mkv',
				workPath: '/var/a.part',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
			}),
		);
		const second = await transfers.save(
			transfers.create({
				jobId: 'job-1',
				itemId: 'item-1',
				title: 'Second',
				state: TransferState.QUEUED,
				targetPath: '/media/b.mkv',
				workPath: '/var/b.part',
				createdAt: new Date('2026-02-01T00:00:00.000Z'),
			}),
		);

		await expect(transfers.findByJob('job-1')).resolves.toMatchObject([
			{ id: first.id },
			{ id: second.id },
		]);
		await expect(transfers.findByItem('item-1')).resolves.toMatchObject([
			{ id: second.id },
			{ id: first.id },
		]);
		await expect(transfers.findByJob('job-2')).resolves.toEqual([]);
	});

	/**
	 * The query the lot column exists for.
	 *
	 * A season is routinely pulled over several nights, so the files of one download sit
	 * under several runs — and redirecting it by run finds the tail and leaves the head
	 * where it was. Cancelled and failed rows are left out because there is no file behind
	 * them: a lot pulled twice holds two rows for the same episode, both computing the
	 * same new path, and the dead one would be refused as landing on the live one.
	 */
	it('finds a download across the runs that pulled it, minus what never arrived', async () => {
		const landed = await transfers.save(
			transfers.create({
				jobId: 'job-1',
				itemId: 'item-1',
				lot: 'season-1',
				title: 'Last night',
				state: TransferState.DONE,
				targetPath: '/media/a.mkv',
				workPath: '/var/a.part',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
			}),
		);
		const coming = await transfers.save(
			transfers.create({
				jobId: 'job-2',
				itemId: 'item-2',
				lot: 'season-1',
				title: 'Tonight',
				state: TransferState.QUEUED,
				targetPath: '/media/b.mkv',
				workPath: '/var/b.part',
				createdAt: new Date('2026-02-01T00:00:00.000Z'),
			}),
		);

		await transfers.save(
			transfers.create({
				jobId: 'job-0',
				itemId: 'item-1',
				lot: 'season-1',
				title: 'A first attempt that failed',
				state: TransferState.FAILED,
				targetPath: '/media/a.mkv',
				workPath: '/var/a-old.part',
			}),
		);
		await transfers.save(
			transfers.create({
				jobId: 'job-2',
				itemId: 'item-3',
				lot: 'season-2',
				title: 'Another season entirely',
				state: TransferState.QUEUED,
				targetPath: '/media/c.mkv',
				workPath: '/var/c.part',
			}),
		);

		await expect(transfers.findByLots(['season-1'])).resolves.toMatchObject([
			{ id: landed.id },
			{ id: coming.id },
		]);
		// No lots, no query: a gateway upgrading in place has a table full of rows with a
		// null lot, and gathering them would be one enormous download.
		await expect(transfers.findByLots([])).resolves.toEqual([]);
	});

	it('finds the other transfers pulling the same file, which is how a swarm forms', async () => {
		await transfers.save(
			transfers.create({
				itemId: 'item-1',
				contentId: 'q1-abc',
				title: 'Ours',
				state: TransferState.DOWNLOADING,
				targetPath: '/media/a.mkv',
				workPath: '/var/a.part',
			}),
		);
		await transfers.save(
			transfers.create({
				itemId: 'item-2',
				contentId: 'q1-other',
				title: 'Somebody else’s',
				state: TransferState.DOWNLOADING,
				targetPath: '/media/b.mkv',
				workPath: '/var/b.part',
			}),
		);

		await expect(transfers.findByContentId('q1-abc')).resolves.toHaveLength(1);
	});

	it('moves a transfer to a state without reading the row first', async () => {
		const transfer = await aTransfer(TransferState.QUEUED);

		await transfers.setState(transfer.id, TransferState.PAUSED);

		await expect(transfers.findOneBy({ id: transfer.id })).resolves.toMatchObject({
			state: TransferState.PAUSED,
		});
	});

	it('forgets old finished transfers and keeps the ones still waiting', async () => {
		const old = new Date(Date.now() - 90 * 86_400_000);

		await aTransfer(TransferState.DONE, 1_000, 1_000, old);
		await aTransfer(TransferState.QUEUED, 1_000, 0);

		await expect(
			transfers.deleteFinishedBefore(new Date(Date.now() - 30 * 86_400_000)),
		).resolves.toBe(1);
		await expect(transfers.count()).resolves.toBe(1);
	});

	describe('retention', () => {
		const ago = (days: number): Date => new Date(Date.now() - days * 86_400_000);

		it('takes nothing that finished inside the window', async () => {
			await aTransfer(TransferState.DONE, 1_000, 1_000, ago(29));
			await aTransfer(TransferState.FAILED, 1_000, 10, ago(1));

			await expect(transfers.deleteFinishedBefore(ago(30))).resolves.toBe(0);
			await expect(transfers.count()).resolves.toBe(2);
		});

		it('sweeps only the states it was given', async () => {
			// Successes and failures get different windows, which is the whole reason
			// this takes a list at all.
			await aTransfer(TransferState.DONE, 1_000, 1_000, ago(90));
			await aTransfer(TransferState.FAILED, 1_000, 10, ago(90));

			await expect(
				transfers.deleteFinishedBefore(ago(30), [TransferState.DONE]),
			).resolves.toBe(1);
			await expect(transfers.findOne({ where: { state: TransferState.FAILED } })).resolves
				.not.toBeNull();
		});

		it('refuses to sweep a state that is not finished, whatever it is asked', async () => {
			// A mistake upstairs must cost a row that is not deleted, never a download
			// that disappears mid-flight.
			await aTransfer(TransferState.DOWNLOADING, 1_000, 10, ago(90));

			await expect(
				transfers.deleteFinishedBefore(ago(30), [TransferState.DOWNLOADING]),
			).resolves.toBe(0);
			await expect(transfers.count()).resolves.toBe(1);
		});

		it('leaves a finished transfer with no finish date alone', async () => {
			// Rows written before the column existed, or by a crash between the state
			// and the timestamp. Nothing can say whether they are past a window.
			await aTransfer(TransferState.DONE, 1_000, 1_000);

			await expect(transfers.deleteFinishedBefore(ago(0))).resolves.toBe(0);
		});
	});

	describe('paging the queue', () => {
		it('answers everything when no view is asked for', async () => {
			await aTransfer(TransferState.DOWNLOADING);
			await aTransfer(TransferState.DONE, 1_000, 1_000, new Date());

			await expect(transfers.pageOf({ page: 1, limit: 20 })).resolves.toMatchObject([
				expect.anything(),
				2,
			]);
		});

		it('keeps a paused transfer in the live half', async () => {
			// Somebody stopped it and it resumes when they say so. A queue view that
			// filed it under history would be one where pausing loses the transfer.
			await aTransfer(TransferState.PAUSED);

			const [rows] = await transfers.pageOf({ page: 1, limit: 20, view: HistoryView.LIVE });

			expect(rows).toHaveLength(1);
		});

		it('puts done, failed and cancelled on the finished side', async () => {
			await aTransfer(TransferState.DONE, 1_000, 1_000, new Date());
			await aTransfer(TransferState.FAILED, 1_000, 10, new Date());
			await aTransfer(TransferState.CANCELLED, 1_000, 10, new Date());
			await aTransfer(TransferState.QUEUED);

			const [live] = await transfers.pageOf({ page: 1, limit: 20, view: HistoryView.LIVE });
			const [finished] = await transfers.pageOf({
				page: 1,
				limit: 20,
				view: HistoryView.FINISHED,
			});

			expect(live).toHaveLength(1);
			expect(finished).toHaveLength(3);
		});

		it('answers nothing when the state and the view contradict each other', async () => {
			await aTransfer(TransferState.DONE, 1_000, 1_000, new Date());

			await expect(
				transfers.pageOf({ page: 1, limit: 20, state: TransferState.DONE, view: HistoryView.LIVE }),
			).resolves.toEqual([[], 0]);
		});
	});
});
