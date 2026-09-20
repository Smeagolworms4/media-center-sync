import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
	type MediaItem,
	type MediaNode,
	type ResultList,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

describe('Browsing the index', () => {
	let context: TestApp;
	let reader: TestIdentity;
	let seriesId: string;

	beforeAll(async () => {
		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:21',
				status: MediaServiceStatus.ONLINE,
			}),
		);

		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
			}),
		);

		const series = await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'series-1',
				kind: MediaKind.SERIES,
				title: 'Big Buck Bunny',
				normalizedTitle: 'big buck bunny',
				year: 2008,
				syncState: SyncState.LOCAL_ONLY,
			}),
		);

		seriesId = series.id;

		for (let episode = 1; episode <= 12; episode += 1) {
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: library.id,
					externalId: `episode-${episode}`,
					parentId: series.id,
					kind: MediaKind.EPISODE,
					title: `Episode ${episode}`,
					normalizedTitle: `big buck bunny episode ${episode}`,
					seasonNumber: 1,
					episodeNumber: episode,
					syncState: episode % 2 === 0 ? SyncState.MISSING : SyncState.IN_SYNC,
				}),
			);
		}

		await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'film-1',
				kind: MediaKind.MOVIE,
				title: 'Tears of Steel',
				normalizedTitle: 'tears of steel',
				year: 2012,
				syncState: SyncState.LOCAL_ONLY,
			}),
		);
	});

	afterAll(async () => {
		await context.close();
	});

	const browse = (query: string): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/media${query}`)
			.set('Authorization', `Bearer ${reader.token}`);

	it('pages, and says how many pages there are', async () => {
		const response = await browse('?page=1&limit=5').expect(200);
		const page = response.body as ResultList<MediaItem>;

		expect(page.items).toHaveLength(5);
		expect(page.pagination).toMatchObject({ page: 1, limit: 5, total: 14, pages: 3 });
	});

	it('refuses a page size nobody could render rather than quietly shrinking it', async () => {
		// The manager clamps too, so answering 200 with two hundred rows would work —
		// and would read as the API ignoring what was asked for. A caller that wanted
		// a hundred thousand rows has a bug, and a 400 is where they find it.
		await browse('?limit=100000').expect(400);
	});

	it('serves the largest page it accepts', async () => {
		const response = await browse('?limit=200').expect(200);

		expect((response.body as ResultList<MediaItem>).pagination.limit).toBe(200);
	});

	it('filters by kind', async () => {
		const response = await browse(`?kind=${MediaKind.EPISODE}&limit=50`).expect(200);

		expect((response.body as ResultList<MediaItem>).pagination.total).toBe(12);
	});

	it('filters by state, which is the whole point of the icon vocabulary', async () => {
		const response = await browse(`?states=${SyncState.MISSING}&limit=50`).expect(200);
		const page = response.body as ResultList<MediaItem>;

		// One value, not a list: that is what a single state chip sends, and a query
		// string has no way of saying it meant a list of one.
		expect(page.pagination.total).toBe(6);
		expect(page.items.every((item) => item.sync === SyncState.MISSING)).toBe(true);
	});

	it('filters by several states at once', async () => {
		const response = await browse(
			`?states=${SyncState.MISSING}&states=${SyncState.LOCAL_ONLY}&limit=50`,
		).expect(200);

		expect((response.body as ResultList<MediaItem>).pagination.total).toBe(8);
	});

	it('searches the normalised title, so an accent typed or not finds the same rows', async () => {
		const response = await browse('?search=tears').expect(200);
		const page = response.body as ResultList<MediaItem>;

		expect(page.items).toHaveLength(1);
		expect(page.items[0].title).toBe('Tears of Steel');
	});

	it('sorts by the columns it allows, and by nothing else', async () => {
		const ascending = (await browse('?sort=title&direction=asc&limit=50').expect(200))
			.body as ResultList<MediaItem>;
		const descending = (await browse('?sort=title&direction=desc&limit=50').expect(200))
			.body as ResultList<MediaItem>;

		expect(ascending.items[0].title).not.toBe(descending.items[0].title);
		await browse('?sort=id; DROP TABLE media_items').expect(400);
	});

	it('answers a node with the children it has', async () => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${seriesId}`)
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(200);
		const node = response.body as MediaNode;

		expect(node.kind).toBe(MediaKind.SERIES);
		expect(node.children).toHaveLength(12);
	});

	it('pages a node’s children, and ignores a parent the caller tried to smuggle in', async () => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${seriesId}/children?limit=4&parentId=${seriesId}`)
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(200);
		const page = response.body as ResultList<MediaItem>;

		expect(page.items).toHaveLength(4);
		expect(page.pagination.total).toBe(12);
	});

	it('answers a key for an item nobody holds', async () => {
		const response = await request(context.app.getHttpServer())
			.get('/api/media/11111111-2222-4333-8444-555555555555')
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(404);

		expect(response.body).toMatchObject({ message: 'error.media.not_found' });
	});
});
