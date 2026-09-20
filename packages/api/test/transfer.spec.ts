import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	ChunkState,
	LibraryKind,
	MediaServiceType,
	PlacedBy,
	TransferState,
	UserRole,
	type ResultList,
	type Transfer,
	type TransferChunk,
	type TransferQueueStats,
	type UnconfiguredPlacement,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaServiceRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

describe('The transfer queue', () => {
	let context: TestApp;
	let manager: TestIdentity;
	let reader: TestIdentity;
	let downloading: string;
	let done: string;
	let unconfigured: string;
	let ourLibraryId: string;
	let theirLibraryId: string;
	let ourPath: string;

	beforeAll(async () => {
		context = await createTestApp();
		manager = await signInAs(context, UserRole.ADMIN);
		reader = await signInAs(context, UserRole.USER);

		const transfers = context.app.get(TransferRepository);
		const chunks = context.app.get(TransferChunkRepository);
		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);

		// A directory that really exists and really is writable, because the manager
		// probes the path rather than trusting the row: a made-up one would be refused
		// for the right reason and prove nothing about the route.
		ourPath = mkdtempSync(join(tmpdir(), 'mcs-destination-'));

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:41',
			}),
		);

		const theirs = await services.save(
			services.create({
				name: "A friend's server",
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:42',
			}),
		);

		ourLibraryId = (
			await libraries.save(
				libraries.create({
					serviceId: ours.id,
					externalId: 'lib-anime',
					name: 'Animes',
					kind: LibraryKind.SHOWS,
					paths: [ourPath],
					localPath: ourPath,
					writable: true,
				}),
			)
		).id;

		theirLibraryId = (
			await libraries.save(
				libraries.create({
					serviceId: theirs.id,
					externalId: 'lib-their-shows',
					name: 'Their shows',
					kind: LibraryKind.SHOWS,
					paths: ['/media/theirs'],
					localPath: '/media/theirs',
					writable: true,
				}),
			)
		).id;

		const seed = async (
			state: TransferState,
			title: string,
			placedBy: PlacedBy | null = null,
		): Promise<string> => {
			const id = randomUUID();

			await transfers.save(
				transfers.create({
					id,
					itemId: randomUUID(),
					title,
					state,
					targetPath: `/media/shows/${title}.mkv`,
					targetLibraryId: null,
					placedBy,
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
		unconfigured = await seed(TransferState.QUEUED, 'S01E04', PlacedBy.FALLBACK_PATH);
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

	/**
	 * The one place a file that landed where nobody chose is ever mentioned.
	 *
	 * The transfer succeeded, so there is no error, no failed state and no log line to
	 * find. Without this list the only symptom is a folder somebody did not plan,
	 * discovered months later.
	 */
	describe('what landed where nobody chose', () => {
		it('lists only the transfers a step nobody configured placed', async () => {
			const response = await asReader('/unconfigured').expect(200);
			const rows = response.body as UnconfiguredPlacement[];

			expect(rows.map((row) => row.transferId)).toEqual([unconfigured]);
			expect(rows[0].placedBy).toBe(PlacedBy.FALLBACK_PATH);
		});

		it('is a reading, not a management right', async () => {
			await request(context.app.getHttpServer())
				.get('/api/transfers/unconfigured')
				.expect(401);
		});
	});

	describe('changing where a transfer goes', () => {
		it('rewrites the target path while the file is still downloading', async () => {
			const response = await request(context.app.getHttpServer())
				.post(`/api/transfers/${downloading}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: ourLibraryId })
				.expect(200);

			const transfer = response.body as Transfer;

			// Nothing has been placed, so this cost one row write rather than a move.
			expect(transfer.targetPath).toBe(join(ourPath, 'S01E03.mkv'));
			expect(transfer.targetLibraryId).toBe(ourLibraryId);
			expect(transfer.placedBy).toBe(PlacedBy.REQUESTED);
		});

		/**
		 * The refusal the whole destination rule exists for.
		 *
		 * A library on somebody else's server is a directory this gateway cannot write
		 * into and none of our media servers scan. Accepting it buys a transfer that
		 * reports success and produces nothing anybody can watch.
		 */
		it('refuses a library that is not on one of our own services', async () => {
			const response = await request(context.app.getHttpServer())
				.post(`/api/transfers/${done}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: theirLibraryId })
				.expect(409);

			expect(response.body).toMatchObject({ message: 'error.transfer.destination_invalid' });
		});

		it('refuses a library nobody has', async () => {
			await request(context.app.getHttpServer())
				.post(`/api/transfers/${done}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: '11111111-2222-4333-8444-555555555555' })
				.expect(404);
		});

		it('refuses a path where a library identifier belongs', async () => {
			await request(context.app.getHttpServer())
				.post(`/api/transfers/${done}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: '/media/somewhere' })
				.expect(400);
		});

		it('refuses to move anything without the right to manage the queue', async () => {
			await request(context.app.getHttpServer())
				.post(`/api/transfers/${done}/destination`)
				.set('Authorization', `Bearer ${reader.token}`)
				.send({ libraryId: ourLibraryId })
				.expect(403);
		});
	});
});
