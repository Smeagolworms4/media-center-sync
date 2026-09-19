import type { DataSource } from 'typeorm';
import { TransferState } from '@mcs/shared';
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

	it('forgets old finished transfers and keeps the ones still waiting', async () => {
		const old = new Date(Date.now() - 90 * 86_400_000);

		await aTransfer(TransferState.DONE, 1_000, 1_000, old);
		await aTransfer(TransferState.QUEUED, 1_000, 0);

		await expect(
			transfers.deleteFinishedBefore(new Date(Date.now() - 30 * 86_400_000)),
		).resolves.toBe(1);
		await expect(transfers.count()).resolves.toBe(1);
	});
});
