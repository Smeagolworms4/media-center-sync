import type { DataSource } from 'typeorm';
import {
	LibraryKind,
	MediaKind,
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
				filesMounted: true,
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

	describe('reconciling parents', () => {
		it('links every child that names a parent the index already holds', async () => {
			const series = await anItem({ kind: MediaKind.SERIES, externalId: 'series-1' });
			const season = await anItem({
				kind: MediaKind.SEASON,
				externalId: 'season-1',
				parentExternalId: 'series-1',
			});
			const film = await anItem({ kind: MediaKind.MOVIE, externalId: 'film-1' });

			await expect(items.linkKnownParents(service.id)).resolves.toBe(1);
			await expect(items.findOne({ where: { id: season.id } })).resolves.toMatchObject({
				parentId: series.id,
			});
			// A film names no parent and must not acquire one.
			await expect(items.findOne({ where: { id: film.id } })).resolves.toMatchObject({
				parentId: null,
			});
		});

		it('writes nothing for a child whose parent is still unknown', async () => {
			// The count is the signal a scan logs, so a statement that rewrote every
			// candidate row with the null it already held would report a repair that
			// never happened.
			await anItem({ externalId: 'episode-1', parentExternalId: 'season-nobody-sent' });

			await expect(items.linkKnownParents(service.id)).resolves.toBe(0);
		});

		it('never links across services, whatever the identifiers look like', async () => {
			// Two media servers number their items from one, so `series-1` exists on
			// both — and filing our season under a friend's show would be silent.
			const services = new MediaServiceRepository(dataSource);
			const other = await services.save(
				services.create({
					name: 'friend',
					type: MediaServiceType.PLEX,
					filesMounted: false,
					baseUrl: 'http://friend.test',
				}),
			);

			await anItem({ serviceId: other.id, kind: MediaKind.SERIES, externalId: 'series-1' });

			const season = await anItem({ externalId: 'season-1', parentExternalId: 'series-1' });

			await expect(items.linkKnownParents(service.id)).resolves.toBe(0);
			await expect(items.findOne({ where: { id: season.id } })).resolves.toMatchObject({
				parentId: null,
			});
		});

		it('names each missing parent once, however many children point at it', async () => {
			await anItem({ externalId: 'episode-1', parentExternalId: 'season-1' });
			await anItem({ externalId: 'episode-2', parentExternalId: 'season-1' });
			await anItem({ externalId: 'episode-3', parentExternalId: 'season-2' });
			await anItem({ kind: MediaKind.SERIES, externalId: 'series-1' });

			const missing = await items.findUnresolvedParents(service.id);

			expect(missing.map((entry) => entry.parentExternalId).sort()).toEqual([
				'season-1',
				'season-2',
			]);
			expect(missing.every((entry) => entry.libraryId === library.id)).toBe(true);
		});

		it('says nothing is missing once the parents are there', async () => {
			await anItem({ kind: MediaKind.SERIES, externalId: 'series-1' });
			await anItem({ externalId: 'season-1', parentExternalId: 'series-1' });

			await items.linkKnownParents(service.id);

			await expect(items.findUnresolvedParents(service.id)).resolves.toEqual([]);
		});
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
		// And it still comes back ordered. An unknown sort used to clear the ordering
		// altogether, which on a paginated list means a row on two pages and a row on
		// none — a worse failure than the wrong column, and a silent one.
		expect(unknownSort.map((item) => item.title)).toEqual(['A', 'B']);
	});

	it('puts a season’s episodes in broadcast order, not alphabetical order', async () => {
		// Numbered out of order on purpose: inserting them in sequence would pass on
		// the insertion order alone and prove nothing.
		await anItem({ title: 'The Gathering', seasonNumber: 1, episodeNumber: 10 });
		await anItem({ title: 'Absolution', seasonNumber: 1, episodeNumber: 2 });
		await anItem({ title: 'Pilot', seasonNumber: 1, episodeNumber: 1 });
		await anItem({ title: 'Aftermath', seasonNumber: 2, episodeNumber: 1 });

		const [ordered] = await items.search({});

		expect(ordered.map((item) => [item.seasonNumber, item.episodeNumber])).toEqual([
			[1, 1],
			[1, 2],
			[1, 10],
			[2, 1],
		]);
	});

	it('sends an episode the service numbered nothing to the end, on either engine', async () => {
		// SQLite sorts a NULL first ascending and PostgreSQL sorts it last, so without
		// the sentinel this row lands at opposite ends of the season depending on which
		// database somebody picked — the same screen, two orders.
		await anItem({ title: 'Special', seasonNumber: 1, episodeNumber: null });
		await anItem({ title: 'Pilot', seasonNumber: 1, episodeNumber: 1 });

		const [ordered] = await items.search({});

		expect(ordered.map((item) => item.title)).toEqual(['Pilot', 'Special']);
	});

	it('leaves a film list ordered by what was asked for', async () => {
		// Every row collapses to the same episode key, so the coordinates cost nothing
		// where they mean nothing.
		await anItem({ title: 'Z', year: 1969 });
		await anItem({ title: 'A', year: 2001 });

		const [byTitle] = await items.search({});

		expect(byTitle.map((item) => item.title)).toEqual(['A', 'Z']);
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

	it('lists the top of a library, which is what has no parent', async () => {
		const series = await anItem({ kind: MediaKind.SERIES, title: 'B series' });

		await anItem({ parentId: series.id, title: 'An episode' });
		await anItem({ kind: MediaKind.MOVIE, title: 'A film' });

		const roots = await items.findRoots(library.id);

		expect(roots.map((item) => item.title)).toEqual(['A film', 'B series']);
	});

	it('reads several identifiers at once, and asks nothing for none', async () => {
		await anItem({ externalId: 'one' });
		await anItem({ externalId: 'two' });

		await expect(items.findByExternalIds(service.id, ['one', 'two'])).resolves.toHaveLength(2);
		// An empty list is a query nobody needs to run, and `IN ()` is not valid SQL on
		// either engine.
		await expect(items.findByExternalIds(service.id, [])).resolves.toEqual([]);
	});

	it('narrows a search to one service, and one parent', async () => {
		const parent = await anItem({ kind: MediaKind.SERIES, externalId: 'parent' });

		await anItem({ parentId: parent.id, externalId: 'child' });

		const [mine] = await items.search({ serviceId: service.id });
		const [nobodys] = await items.search({ serviceId: 'another-service' });
		const [children] = await items.search({ parentId: parent.id });

		expect(mine).toHaveLength(2);
		expect(nobodys).toHaveLength(0);
		expect(children.map((item) => item.externalId)).toEqual(['child']);
	});

	it('counts the rows of one library and of one service', async () => {
		await anItem();
		await anItem();

		await expect(items.countByLibrary(library.id)).resolves.toBe(2);
		await expect(items.countByLibrary('another-library')).resolves.toBe(0);
		await expect(items.countByService(service.id)).resolves.toBe(2);
	});

	it('counts the states of one service rather than of everything', async () => {
		await anItem({ syncState: SyncState.MISSING });

		const mine = await items.countByState(service.id);
		const nobodys = await items.countByState('another-service');

		expect(mine[SyncState.MISSING]).toBe(1);
		expect(nobodys[SyncState.MISSING]).toBe(0);
	});

	it('writes a state onto the rows named, and runs nothing for an empty list', async () => {
		const item = await anItem({ syncState: SyncState.UNKNOWN });

		await items.setSyncState([], SyncState.IN_SYNC);
		await expect(items.findOneBy({ id: item.id })).resolves.toMatchObject({
			syncState: SyncState.UNKNOWN,
		});

		await items.setSyncState([item.id], SyncState.IN_SYNC);
		await expect(items.findOneBy({ id: item.id })).resolves.toMatchObject({
			syncState: SyncState.IN_SYNC,
		});
	});

	it('offers for fingerprinting only the files that have no identity yet', async () => {
		// The filter cannot be pushed into SQL: the file lives in a `simple-json`
		// column that neither engine can look inside.
		const file = {
			path: '/media/shows/a.mkv',
			size: 1,
			container: null,
			videoCodec: null,
			audioCodec: null,
			width: null,
			height: null,
			durationMs: null,
			bitrate: null,
			quickHash: null,
			contentId: null,
			checksum: null,
		};

		await anItem({ externalId: 'no-hash', file });
		await anItem({ externalId: 'hashed', file: { ...file, quickHash: 'q1-abc' } });
		await anItem({ externalId: 'empty-path', file: { ...file, path: '' } });
		await anItem({ externalId: 'no-file', file: null });

		const fingerprintable = await items.findFingerprintable(library.id);

		expect(fingerprintable.map((item) => item.externalId)).toEqual(['no-hash']);
	});

	describe('grouped listings', () => {
		it('answers nothing for a filter nothing can satisfy', async () => {
			// An empty list is a filter nobody satisfies, not the absence of one —
			// asking for a friend nobody has linked must answer nothing, and answering
			// the whole library instead looks exactly like the filter being ignored.
			await anItem();

			await expect(items.findGroupSeeds({ serviceIds: [] })).resolves.toEqual([]);
			await expect(items.findGroupSeeds({ libraryIds: [] })).resolves.toEqual([]);
		});

		it('narrows to the libraries and the kind asked for', async () => {
			await anItem({ kind: MediaKind.MOVIE });
			await anItem({ kind: MediaKind.EPISODE });

			const films = await items.findGroupSeeds({
				libraryIds: [library.id],
				kind: MediaKind.MOVIE,
			});

			expect(films).toHaveLength(1);
			await expect(items.findGroupSeeds({ libraryIds: ['elsewhere'] })).resolves.toEqual([]);
		});

		it('takes the top of each tree whatever the library holds', async () => {
			// A library of concerts or audiobooks has no kind this model names, so a
			// filter derived from the kind would show parents and children together.
			const series = await anItem({ kind: MediaKind.SERIES });

			await anItem({ parentId: series.id });

			const roots = await items.findGroupSeeds({ rootsOnly: true });

			expect(roots.map((row) => row.id)).toEqual([series.id]);
		});

		it('searches the normalised title here too', async () => {
			await anItem({ title: 'Amélie', normalizedTitle: 'amelie' });
			await anItem({ title: 'Arrival', normalizedTitle: 'arrival' });

			await expect(items.findGroupSeeds({ search: 'amelie' })).resolves.toHaveLength(1);
			// An empty search is not a search, or every listing would filter on nothing.
			await expect(items.findGroupSeeds({ search: '' })).resolves.toHaveLength(2);
		});

		it('reads the engine’s idea of a boolean back as one', async () => {
			// `getRawMany` skips the entity layer that would have converted it, and the
			// engines disagree: SQLite hands back 0 and 1, PostgreSQL false and true. A
			// `=== true` would be silently false for every ignored item on the engine
			// that ships by default, and the filter would simply appear not to work.
			await anItem({ ignored: true });
			await anItem({ ignored: false });

			const seeds = await items.findGroupSeeds({});

			expect(seeds.map((row) => row.ignored).sort()).toEqual([false, true]);
		});

		it('reads the same projection for identifiers pulled in from outside the filter', async () => {
			const parent = await anItem({ kind: MediaKind.SERIES });
			const child = await anItem({ parentId: parent.id });

			await expect(items.findDigests([parent.id, parent.id])).resolves.toHaveLength(1);
			await expect(items.findChildDigests([parent.id])).resolves.toMatchObject([
				{ id: child.id },
			]);
			await expect(items.findByIds([child.id])).resolves.toHaveLength(1);
			await expect(items.findDigests([])).resolves.toEqual([]);
		});
	});
});
