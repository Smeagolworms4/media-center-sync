import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
	ChunkState,
	TransferState,
	UserRole,
	type ResultList,
	type Transfer,
	type TransferChunk,
	type TransferQueueStats,
} from '@mcs/shared';
import { TransferChunkRepository, TransferRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

describe('The transfer queue', () => {
	let context: TestApp;
	let manager: TestIdentity;
	let reader: TestIdentity;
	let downloading: string;
	let done: string;

	beforeAll(async () => {
		context = await createTestApp();
		manager = await signInAs(context, UserRole.ADMIN);
		reader = await signInAs(context, UserRole.USER);

		const transfers = context.app.get(TransferRepository);
		const chunks = context.app.get(TransferChunkRepository);

		const seed = async (state: TransferState, title: string): Promise<string> => {
			const id = randomUUID();

			await transfers.save(
				transfers.create({
					id,
					itemId: randomUUID(),
					title,
					state,
					targetPath: `/media/shows/${title}.mkv`,
					workPath: `/var/transfer/${id}.part`,
					bytesTotal: 4_000,
					bytesDone: state === TransferState.DONE ? 4_000 : 1_000,
					chunkSize: 1_000,
					chunksTotal: 4,
				}),
			);

			await chunks.insertPlan(id, [
				{ index: 0, start: 0, end: 999 },
				{ index: 1, start: 1_000, end: 1_999 },
				{ index: 2, start: 2_000, end: 2_999 },
				{ index: 3, start: 3_000, end: 3_999 },
			]);

			await chunks.markDone(id, 0, 1_000);

			return id;
		};

		downloading = await seed(TransferState.DOWNLOADING, 'S01E03');
		done = await seed(TransferState.DONE, 'S01E01');
		await seed(TransferState.QUEUED, 'S01E04');
	});

	afterAll(async () => {
		await context.close();
	});

	const asReader = (path: string): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/transfers${path}`)
			.set('Authorization', `Bearer ${reader.token}`);

	it('pages the queue, newest first', async () => {
		const response = await asReader('?page=1&limit=2').expect(200);
		const page = response.body as ResultList<Transfer>;

		expect(page.items).toHaveLength(2);
		expect(page.pagination).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
	});

	it('filters by state', async () => {
		const response = await asReader(`?state=${TransferState.DONE}`).expect(200);

		expect((response.body as ResultList<Transfer>).pagination.total).toBe(1);
	});

	it('counts the pieces that are really done rather than guessing from the bytes', async () => {
		const response = await asReader(`/${downloading}`).expect(200);
		const transfer = response.body as Transfer;

		expect(transfer.chunksTotal).toBe(4);
		expect(transfer.chunksDone).toBe(1);
		// Live rates are pushed on the event stream; a REST answer carrying a stale one
		// would be worse than one carrying none.
		expect(transfer.rate).toBe(0);
		expect(transfer.etaSeconds).toBeNull();
	});

	it('lists the pieces with the range each one covers', async () => {
		const response = await asReader(`/${downloading}/chunks`).expect(200);
		const chunks = response.body as TransferChunk[];

		expect(chunks).toHaveLength(4);
		expect(chunks[0]).toMatchObject({ index: 0, start: 0, end: 999, state: ChunkState.DONE });
	});

	it('answers the queue counters', async () => {
		const response = await asReader('/stats').expect(200);
		const stats = response.body as TransferQueueStats;

		expect(stats.active).toBe(1);
		expect(stats.queued).toBe(1);
		expect(stats.rate).toBeGreaterThanOrEqual(0);
	});

	it('lists the revalidations, even when there are none to explain', async () => {
		const response = await asReader(`/${downloading}/revalidations`).expect(200);

		expect(response.body).toEqual([]);
	});

	it('refuses to act on the queue without the right to manage it', async () => {
		await request(context.app.getHttpServer())
			.post(`/api/transfers/${downloading}/pause`)
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(403);
	});

	it('pauses a running transfer', async () => {
		const response = await request(context.app.getHttpServer())
			.post(`/api/transfers/${downloading}/pause`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(200);

		expect((response.body as Transfer).state).toBe(TransferState.PAUSED);
	});

	it('refuses to cancel a file that is already in the library', async () => {
		const response = await request(context.app.getHttpServer())
			.post(`/api/transfers/${done}/cancel`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(409);

		expect(response.body).toMatchObject({ message: 'error.transfer.not_resumable' });
	});

	it('refuses to retry one that finished', async () => {
		await request(context.app.getHttpServer())
			.post(`/api/transfers/${done}/retry`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(409);
	});

	it('answers a key for a transfer nobody has', async () => {
		const response = await asReader('/11111111-2222-4333-8444-555555555555').expect(404);

		expect(response.body).toMatchObject({ message: 'error.transfer.not_found' });
	});
});
