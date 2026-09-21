import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import {
	ChunkState,
	LibraryKind,
	MediaLandingState,
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
import type { Transfer as TransferEntity } from '@/entities';
import {
	LibraryRepository,
	MediaLandingRepository,
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
	let landed: string;
	let landedPath: string;
	let ourLibraryId: string;
	let theirLibraryId: string;
	let ourPath: string;
	/**
	 * Seeding from inside a test rather than only up front.
	 *
	 * The queue counters are asserted against the rows this file creates, so a state
	 * only one test needs — a transfer caught mid-placement — is created by that test
	 * instead of being added to the fixture and quietly moving somebody else's numbers.
	 */
	let seed: (
		state: TransferState,
		title: string,
		placedBy?: PlacedBy | null,
		targetPath?: string | null,
	) => Promise<string>;

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

		seed = async (
			state: TransferState,
			title: string,
			placedBy: PlacedBy | null = null,
			targetPath: string | null = null,
		): Promise<string> => {
			const id = randomUUID();

			await transfers.save(
				transfers.create({
					id,
					itemId: randomUUID(),
					title,
					state,
					targetPath: targetPath ?? `/media/shows/${title}.mkv`,
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
		// A finished transfer whose file really exists, under a directory of its own so
		// the move has something to carry: the point of the test is the bytes.
		landedPath = join(mkdtempSync(join(tmpdir(), 'mcs-landed-')), 'S01E02.mkv');
		landed = await seed(TransferState.DONE, 'S01E02', null, landedPath);
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
		expect(page.pagination).toMatchObject({ page: 1, limit: 2, total: 4, pages: 2 });
	});

	it('filters by state', async () => {
		const response = await asReader(`?state=${TransferState.DONE}`).expect(200);

		expect((response.body as ResultList<Transfer>).pagination.total).toBe(2);
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

		/*
		 * A library that is no longer registered cannot be answered for.
		 *
		 * Removing a service takes its libraries with it and leaves the transfers that
		 * wrote into them, which are history and stay readable. But the zone asks a
		 * question — move this file, or choose where the category goes — and about a
		 * shelf nothing manages any more there is no question left: listed, it stayed
		 * there for ever with no library, no category and nothing that could clear it.
		 */
		it('stops listing a file whose library has been removed, and keeps the transfer', async () => {
			const transfers = context.app.get(TransferRepository);
			const id = randomUUID();

			await transfers.save(
				transfers.create({
					id,
					itemId: randomUUID(),
					title: 'Orphaned',
					state: TransferState.DONE,
					targetPath: '/media/gone/Orphaned.mkv',
					targetLibraryId: randomUUID(),
					placedBy: PlacedBy.DEFAULT_LIBRARY,
					workPath: `/var/transfer/${id}.part`,
					bytesTotal: 1_000,
					bytesDone: 1_000,
					chunkSize: 1_000,
					chunksTotal: 1,
				}),
			);

			try {
				const response = await asReader('/unconfigured').expect(200);
				const rows = response.body as UnconfiguredPlacement[];

				expect(rows.map((row) => row.transferId)).not.toContain(id);
				await asReader(`/${id}`).expect(200);
			} finally {
				await transfers.delete({ id });
			}
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
			// Its own value: a correction to this one file, not a rule and not a run's
			// request, so the screen can word it as what it is.
			expect(transfer.placedBy).toBe(PlacedBy.CHOSEN_BY_HAND);
		});

		/**
		 * Moving bytes that are already in a library, over HTTP, with the landing
		 * following them.
		 *
		 * The landing row is the half that fails silently: it says "this file is on the
		 * disk and no media server has indexed it yet", it is resolved by path, and a
		 * move that left it naming the old one would have the next reconciliation decide
		 * the file had been deleted. The media would go back to reading `missing` with a
		 * perfectly good copy on disk, and every screen would offer to download it again.
		 */
		it('moves a file that has already landed, and the landing follows it', async () => {
			const landings = context.app.get(MediaLandingRepository);
			const transfers = context.app.get(TransferRepository);
			const row = (await transfers.findOne({ where: { id: landed } })) as TransferEntity;

			await mkdir(dirname(row.targetPath), { recursive: true });
			await writeFile(row.targetPath, 'a whole film, allegedly');

			await landings.save(
				landings.create({
					itemId: row.itemId,
					transferId: row.id,
					libraryId: null,
					path: row.targetPath,
					bytes: 4_000,
					contentId: null,
					state: MediaLandingState.WAITING,
					expiresAt: new Date(Date.now() + 3_600_000),
				}),
			);

			const response = await request(context.app.getHttpServer())
				.post(`/api/transfers/${landed}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: ourLibraryId })
				.expect(200);

			const moved = join(ourPath, 'S01E02.mkv');

			expect((response.body as Transfer).targetPath).toBe(moved);
			// The bytes, not only the row: a destination field that changes the record
			// and leaves the file where it was makes the interface lie about where
			// something is.
			await expect(readFile(moved, 'utf8')).resolves.toBe('a whole film, allegedly');
			await expect(access(row.targetPath)).rejects.toThrow();

			const landing = await landings.findForItem(row.itemId);

			expect(landing?.path).toBe(moved);
			expect(landing?.libraryId).toBe(ourLibraryId);
		});

		/**
		 * The one answer that is "not now" rather than yes or no.
		 *
		 * A key of its own and not `not_resumable`, because they mean opposite things to
		 * whoever reads the screen: one says this transfer will never move again, this
		 * one says it is being moved at this exact second and the request can be made
		 * again in a minute. Cancelling the copy in flight was rejected — see the key's
		 * own documentation — because a half-moved file is the outcome to design against.
		 */
		it('refuses while the file is being placed, with a key that says so', async () => {
			const placing = await seed(TransferState.PLACING, 'S01E05');

			const response = await request(context.app.getHttpServer())
				.post(`/api/transfers/${placing}/destination`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ libraryId: ourLibraryId })
				.expect(409);

			expect(response.body).toMatchObject({ message: 'error.transfer.being_placed' });
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
