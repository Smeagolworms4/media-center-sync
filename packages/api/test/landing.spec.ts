import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaLandingState,
	MediaServiceStatus,
	MediaServiceType,
	ServerStructureSupport,
	SyncState,
	TransferState,
	UserRole,
	type MediaGroup,
	type MediaItem,
	type ResultList,
	type ServerStructure,
} from '@mcs/shared';
import { LandingManager } from '@/managers';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaLandingRepository,
	MediaServiceRepository,
	TransferRepository,
} from '@/repositories';
import {
	HandlerRegistry,
	RescanOutcome,
	type LibraryRefresh,
	type MediaServiceHandler,
	type NormalisedLibrary,
	type NormalisedMediaItem,
} from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A media server that reports exactly what the test put in it, and never a socket.
 *
 * Everything a landing depends on is on this side of the wire — what a scan finds,
 * and whether the server can be asked to look — so the far end is a fixture. A lab
 * Jellyfin would make the answer depend on a container being up.
 */
class FakeHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.JELLYFIN;

	public items: NormalisedMediaItem[] = [];

	public readonly rescans: (string | null)[] = [];

	/**
	 * The items the gateway asked for metadata about, once each was indexed.
	 *
	 * A scan looks at the disk and not at the providers, so a file that has just landed
	 * is a row with a name and nothing else. Asking is the whole point; asking about the
	 * *library* instead of the item is what must never come back.
	 */
	public readonly refreshed: string[] = [];

	public probe(): never {
		throw new Error('not part of this test');
	}

	public authenticate(): never {
		throw new Error('not part of this test');
	}

	public listLibraries(): Promise<NormalisedLibrary[]> {
		return Promise.resolve([]);
	}

	/** No server to ask, and a landing never asks one. */
	public listServerDirectories(): Promise<ServerStructure> {
		return Promise.resolve({
			support: ServerStructureSupport.UNSUPPORTED,
			path: null,
			parent: null,
			entries: [],
		});
	}

	public async *scanLibrary(): AsyncIterable<NormalisedMediaItem> {
		for (const item of this.items) {
			yield item;
		}
	}

	public refreshLibrary(): Promise<LibraryRefresh> {
		return Promise.resolve({ items: this.items, cursor: null });
	}

	public refreshItem(_connection: unknown, externalId: string): Promise<boolean> {
		this.refreshed.push(externalId);

		return Promise.resolve(true);
	}

	public requestRescan(
		_connection: unknown,
		library: NormalisedLibrary | null,
	): Promise<RescanOutcome> {
		this.rescans.push(library?.externalId ?? null);

		// Answered as unsupported so no follow-up scan is scheduled: this file drives
		// the scan itself, and a timer firing a second walk mid-assertion would make
		// the results depend on how long the previous expectation took.
		return Promise.resolve(RescanOutcome.UNSUPPORTED);
	}

	public getItem(): Promise<NormalisedMediaItem | null> {
		return Promise.resolve(null);
	}

	public openArtwork(): never {
		throw new Error('not part of this test');
	}

	public openStream(): never {
		throw new Error('not part of this test');
	}

	public getDownloadUrl(): Promise<string | null> {
		return Promise.resolve(null);
	}
}

/**
 * A file that arrived, over the real application and a real database.
 *
 * The unit tests pin the rules; this one answers the question the owner actually
 * asked, in the terms he asked it: he pulled an episode, the file is in the folder,
 * and the screen said `missing`. So every assertion here is a read of the same HTTP
 * routes the interface reads, before the landing, after it, and after a scan.
 */
describe('A media whose file has landed but which nothing has indexed', () => {
	let context: TestApp;
	let reader: TestIdentity;
	let admin: TestIdentity;
	let handler: FakeHandler;
	let directory = '';
	let landedPath = '';

	const id: Record<string, string> = {};

	/** The service path of the landed file, which is not the path the gateway sees. */
	const REPORTED_PATH = '/media/shows/The Expanse - S01E02.mkv';

	const get = (path: string): request.Test =>
		request(context.app.getHttpServer())
			.get(path)
			.set('Authorization', `Bearer ${reader.token}`);

	const groups = async (): Promise<MediaGroup[]> =>
		((await get('/api/media/groups?limit=50').expect(200)).body as ResultList<MediaGroup>).items;

	const inState = async (state: SyncState): Promise<MediaItem[]> =>
		((await get(`/api/media?states=${state}&limit=50`).expect(200)).body as ResultList<MediaItem>)
			.items;

	/**
	 * Wait for the detached indexing pass the route only answers `202` for.
	 *
	 * Polled through the API rather than by reaching into the manager: the question is
	 * when the interface stops being told the old answer, which is the same thing a
	 * browser would be waiting for.
	 */
	const untilLanded = async (expected: number): Promise<MediaItem[]> => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const items = await inState(SyncState.AWAITING_INDEX);

			if (items.length === expected) {
				return items;
			}

			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		return inState(SyncState.AWAITING_INDEX);
	};

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-landing-api-'));
		landedPath = join(directory, 'The Expanse - S01E02.mkv');

		await writeFile(landedPath, 'a few bytes standing in for an episode');

		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);
		admin = await signInAs(context, UserRole.ADMIN);

		handler = new FakeHandler();
		context.app.get(HandlerRegistry).register(handler);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);
		const transfers = context.app.get(TransferRepository);

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:8096',
				status: MediaServiceStatus.ONLINE,
				priority: 100,
			}),
		);

		const theirs = await services.save(
			services.create({
				name: 'Cabin',
				type: MediaServiceType.PLEX,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:32400',
				status: MediaServiceStatus.ONLINE,
				priority: 200,
			}),
		);

		const ourShelf = await libraries.save(
			libraries.create({
				serviceId: ours.id,
				externalId: 'jf-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
				localPath: directory,
				writable: true,
			}),
		);

		const theirShelf = await libraries.save(
			libraries.create({
				serviceId: theirs.id,
				externalId: 'plex-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/data/shows'],
			}),
		);

		const episode = await items.save(
			items.create({
				serviceId: theirs.id,
				libraryId: theirShelf.id,
				externalId: 'plex-45231',
				kind: MediaKind.EPISODE,
				title: 'Back to the Butcher',
				normalizedTitle: 'expanse back to the butcher',
				seasonNumber: 1,
				episodeNumber: 2,
				syncState: SyncState.MISSING,
				file: {
					path: '/data/shows/The Expanse/S01E02.mkv',
					size: 37,
					container: 'mkv',
					videoCodec: 'hevc',
					audioCodec: 'eac3',
					width: 1920,
					height: 1080,
					durationMs: 2_700_000,
					bitrate: 6_000_000,
					quickHash: null,
					contentId: null,
					checksum: null,
				},
			}),
		);

		const transfer = await transfers.save(
			transfers.create({
				itemId: episode.id,
				title: 'The Expanse S01E02',
				state: TransferState.DONE,
				targetPath: landedPath,
				targetLibraryId: ourShelf.id,
				workPath: join(directory, 'work.part'),
				bytesTotal: 37,
				bytesDone: 37,
				contentId: null,
				finishedAt: new Date(),
			}),
		);

		id.ours = ours.id;
		id.theirs = theirs.id;
		id.library = ourShelf.id;
		id.episode = episode.id;
		id.transfer = transfer.id;
	});

	afterAll(async () => {
		await context.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('reads as missing before anything has been downloaded', async () => {
		const [group] = await groups();

		expect(group.sync).toBe(SyncState.MISSING);
		expect(await inState(SyncState.MISSING)).toHaveLength(1);
	});

	it('stops reading as missing the moment the move reports success', async () => {
		// The engine calls exactly this, from its state listener, when a transfer
		// reaches `done` — which is only after `FileMoveService` has reported the file
		// at its final path.
		const transfer = await context.app
			.get(TransferRepository)
			.findOneOrFail({ where: { id: id.transfer } });

		await context.app.get(LandingManager).record(transfer);

		expect(await inState(SyncState.MISSING)).toHaveLength(0);
	});

	it('reads as downloaded and waiting for the library instead', async () => {
		const [group] = await groups();

		expect(group.sync).toBe(SyncState.AWAITING_INDEX);
		expect((await inState(SyncState.AWAITING_INDEX)).map((item) => item.id)).toEqual([
			id.episode,
		]);
	});

	it('asked the destination library to re-read itself', async () => {
		expect(handler.rescans).toEqual(['jf-shows']);
	});

	it('survives a restart, because it is a row and not a memory', async () => {
		const landings = await context.app.get(MediaLandingRepository).findOpen();

		expect(landings).toHaveLength(1);
		expect(landings[0]).toMatchObject({
			itemId: id.episode,
			libraryId: id.library,
			path: landedPath,
			state: MediaLandingState.WAITING,
		});
	});

	it('stops once our own scan finds a real item for the file', async () => {
		handler.items = [
			{
				externalId: 'jf-99',
				parentExternalId: null,
				kind: MediaKind.EPISODE,
				title: 'Back to the Butcher',
				normalizedTitle: 'expanse back to the butcher',
				year: 2015,
				seasonNumber: 1,
				episodeNumber: 2,
				externalIds: {},
				overview: null,
				artworkUrl: null,
				file: {
					path: REPORTED_PATH,
					size: 37,
					container: 'mkv',
					videoCodec: 'hevc',
					audioCodec: 'eac3',
					width: 1920,
					height: 1080,
					durationMs: 2_700_000,
					bitrate: 6_000_000,
					quickHash: null,
					contentId: null,
					checksum: null,
				},
				addedAt: null,
			},
		];

		await request(context.app.getHttpServer())
			.post(`/api/services/${id.ours}/scan`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(202);

		expect(await untilLanded(0)).toHaveLength(0);
		expect(await context.app.get(MediaLandingRepository).findOpen()).toHaveLength(0);

		/*
		 * And the metadata is asked for, on that item and on nothing else.
		 *
		 * A scan looks at the disk, not at the providers: the row it writes for a file
		 * that has just landed carries a name and nothing else — no overview, no poster —
		 * and nothing ever went back for the rest, because the moment anybody would have
		 * asked had gone by.
		 *
		 * On the item and never on the library: the same question asked of a shelf of
		 * thirty thousand rows is hours of provider traffic, restarted by every file that
		 * lands. `rescans` above is the library call, and it stays the cheap one.
		 */
		// Nobody asked for the metadata of what just landed, before this.
		expect(handler.refreshed).toEqual(['jf-99']);
	});

	it('does not fall back to missing once the file is genuinely held', async () => {
		const [group] = await groups();

		expect(group.sync).not.toBe(SyncState.MISSING);
		expect(group.sync).not.toBe(SyncState.AWAITING_INDEX);
		expect(await inState(SyncState.MISSING)).toHaveLength(0);
	});

	describe('a file no media server ever takes', () => {
		beforeAll(async () => {
			// A second media, landed and then abandoned by every server: the file stays
			// on the disk and the index never grows a row for it.
			const items = context.app.get(MediaItemRepository);
			const libraries = context.app.get(LibraryRepository);
			const transfers = context.app.get(TransferRepository);
			const theirShelf = (await libraries.findByService(id.theirs))[0];
			const orphanPath = join(directory, 'Unwatched - S01E03.mkv');

			await writeFile(orphanPath, 'bytes nobody indexes');

			const episode = await items.save(
				items.create({
					serviceId: id.theirs,
					libraryId: theirShelf.id,
					externalId: 'plex-45232',
					kind: MediaKind.EPISODE,
					title: 'Rock Bottom',
					normalizedTitle: 'expanse rock bottom',
					seasonNumber: 1,
					episodeNumber: 3,
					syncState: SyncState.MISSING,
					file: null,
				}),
			);

			const transfer = await transfers.save(
				transfers.create({
					itemId: episode.id,
					title: 'The Expanse S01E03',
					state: TransferState.DONE,
					targetPath: orphanPath,
					targetLibraryId: id.library,
					workPath: join(directory, 'work-2.part'),
					bytesTotal: 20,
					bytesDone: 20,
					contentId: null,
					finishedAt: new Date(),
				}),
			);

			await context.app.get(LandingManager).record(transfer);

			id.orphan = episode.id;

			// The deadline is moved into the past rather than waited out: the grace
			// period is twelve hours, and a test that slept it would be a test nobody
			// runs.
			const landings = context.app.get(MediaLandingRepository);
			const landing = await landings.findForItem(episode.id);

			await landings.save({ ...landing!, expiresAt: new Date(Date.now() - 1000) });
		});

		it('says the server never indexed it, rather than going quiet', async () => {
			await request(context.app.getHttpServer())
				.post(`/api/services/${id.ours}/scan`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(202);

			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await inState(SyncState.NOT_INDEXED)).length === 1) {
					break;
				}

				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			expect((await inState(SyncState.NOT_INDEXED)).map((item) => item.id)).toEqual([
				id.orphan,
			]);
		});

		it('still does not call it missing, because downloading it again would change nothing', async () => {
			const group = (await groups()).find((one) => one.id === id.orphan);

			expect(group?.sync).toBe(SyncState.NOT_INDEXED);
			expect(await inState(SyncState.MISSING)).toHaveLength(0);
		});
	});
});
