import type { DataSource } from 'typeorm';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	SyncState,
} from '@mcs/shared';
import type { Library, MediaService } from '@/entities';
import { createTestDataSource } from '../../test/utils/database';
import { LibraryRepository } from './library.repository';
import { MediaItemRepository } from './media-item.repository';
import { MediaServiceRepository } from './media-service.repository';

describe('MediaItemRepository', () => {
	let dataSource: DataSource;
	let items: MediaItemRepository;
	let service: MediaService;
	let library: Library;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		items = new MediaItemRepository(dataSource);

		const services = new MediaServiceRepository(dataSource);
		const libraries = new LibraryRepository(dataSource);

		service = await services.save(
			services.create({
				name: 'home',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://home.test',
			}),
		);
		library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
			}),
		);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	const anItem = (overrides: Partial<Parameters<MediaItemRepository['create']>[0]> = {}) =>
		items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: `ext-${Math.random()}`,
				kind: MediaKind.EPISODE,
				title: 'The Expanse',
				normalizedTitle: 'expanse',
				syncState: SyncState.UNKNOWN,
				...overrides,
			}),
		);

	it('lists the children of a node in season and episode order', async () => {
		const parent = await anItem({ kind: MediaKind.SERIES, externalId: 'series-1' });

		await anItem({ parentId: parent.id, seasonNumber: 1, episodeNumber: 2 });
		await anItem({ parentId: parent.id, seasonNumber: 1, episodeNumber: 1 });

		const children = await items.findChildren(parent.id);

		expect(children.map((child) => child.episodeNumber)).toEqual([1, 2]);
	});

	it('finds an item by the identifier its own service uses', async () => {
		await anItem({ externalId: 'jellyfin-42' });

		await expect(items.findByExternalId(service.id, 'jellyfin-42')).resolves.not.toBeNull();
		await expect(items.findByExternalId('another-service', 'jellyfin-42')).resolves.toBeNull();
	});

	it('paginates a search and reports the total, not the page size', async () => {
		for (let index = 0; index < 5; index += 1) {
			await anItem({ title: `Title ${index}`, normalizedTitle: `title ${index}` });
		}

		const [page, total] = await items.search({ libraryId: library.id, page: 2, limit: 2 });

		expect(page).toHaveLength(2);
		expect(total).toBe(5);
	});

	it('searches on the normalised title rather than the displayed one', async () => {
		await anItem({ title: 'Amélie', normalizedTitle: 'amelie' });

		const [found] = await items.search({ search: 'amelie' });

		expect(found).toHaveLength(1);
	});

	it('keeps only the requested states', async () => {
		await anItem({ syncState: SyncState.MISSING });
		await anItem({ syncState: SyncState.IN_SYNC });

		const [found] = await items.search({ states: [SyncState.MISSING] });

		expect(found).toHaveLength(1);
		expect(found[0].syncState).toBe(SyncState.MISSING);
	});

	it('orders on a column of its own choosing, never on the one in the request', async () => {
		await anItem({ title: 'B', year: 2001 });
		await anItem({ title: 'A', year: 2010 });

		const [byYear] = await items.search({ sort: 'year', direction: 'desc' });

		expect(byYear.map((item) => item.year)).toEqual([2010, 2001]);

		const [unknownSort] = await items.search({
			sort: 'id; DROP TABLE media_items' as unknown as 'title',
		});

		expect(unknownSort).toHaveLength(2);
	});

	it('narrows correlation candidates to the same title and episode coordinates', async () => {
		await anItem({ normalizedTitle: 'expanse', seasonNumber: 1, episodeNumber: 1 });
		await anItem({ normalizedTitle: 'expanse', seasonNumber: 1, episodeNumber: 2 });
		await anItem({ normalizedTitle: 'severance', seasonNumber: 1, episodeNumber: 1 });

		const candidates = await items.findCandidatesForMatch('expanse', 1, 1);

		expect(candidates).toHaveLength(1);
	});

	it('matches a film, which has no season and no episode', async () => {
		await anItem({ kind: MediaKind.MOVIE, normalizedTitle: 'arrival' });

		await expect(items.findCandidatesForMatch('arrival', null, null)).resolves.toHaveLength(1);
	});

	it('leaves out the service the item being correlated came from', async () => {
		await anItem({ normalizedTitle: 'expanse', seasonNumber: 1, episodeNumber: 1 });

		await expect(
			items.findCandidatesForMatch('expanse', 1, 1, service.id),
		).resolves.toHaveLength(0);
	});

	it('counts every state, including the ones no row uses', async () => {
		await anItem({ syncState: SyncState.MISSING });
		await anItem({ syncState: SyncState.MISSING });

		const counts = await items.countByState();

		expect(counts[SyncState.MISSING]).toBe(2);
		expect(counts[SyncState.CONFLICT]).toBe(0);
	});

	it('reports what a scan no longer saw', async () => {
		const kept = await anItem({ externalId: 'kept' });

		await anItem({ externalId: 'gone' });

		const stale = await items.findStale(library.id, [kept.externalId]);

		expect(stale.map((item) => item.externalId)).toEqual(['gone']);
	});

	it('treats a scan that saw nothing as a library that is now empty', async () => {
		await anItem();

		await expect(items.findStale(library.id, [])).resolves.toHaveLength(1);
	});
});
