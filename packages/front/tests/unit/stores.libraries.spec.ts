import type { Library, LibraryCheck, MediaCategory } from '@mcs/shared';
import { LibraryKind, PathMatch } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLibrariesStore } from '@/stores/libraries';
import { createStoreContext, stubFetch } from './helpers';

function library (overrides: Partial<Library> = {}): Library {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'jf-1',
		name: 'Shows',
		alias: null,
		position: 0,
		kind: LibraryKind.SHOWS,
		paths: ['/data/shows'],
		localPath: '/media/shows',
		writable: true,
		isDefaultTarget: false,
		itemCount: 400,
		lastScanAt: null,
		lastRefreshAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function check (overrides: Partial<LibraryCheck> = {}): LibraryCheck {
	return {
		libraryId: 'l1',
		name: 'Shows',
		localPath: '/media/shows',
		derived: false,
		exists: true,
		readable: true,
		writable: true,
		freeBytes: 1024,
		serverPaths: ['/data/shows'],
		match: PathMatch.MATCHED,
		error: null,
		...overrides,
	};
}

function category (overrides: Partial<MediaCategory> = {}): MediaCategory {
	return {
		key: 'shows',
		name: 'Shows',
		kind: LibraryKind.SHOWS,
		position: 0,
		libraryIds: ['l1'],
		serviceIds: ['s1'],
		itemCount: 400,
		local: true,
		...overrides,
	};
}

describe('stores/libraries', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('loads the libraries and indexes them by identifier', async () => {
		stubFetch([{ body: [library(), library({ id: 'l2', serviceId: 's2' })] }]);
		const store = useLibrariesStore();

		await store.load();

		expect(store.byId.l2.serviceId).toBe('s2');
		expect(store.ofService('s1').map(one => one.id)).toEqual(['l1']);
	});

	it('keeps the failure rather than an empty list', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useLibrariesStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
		expect(store.libraries).toHaveLength(0);
	});

	/**
	 * The failure this whole screen exists for: a path that does not designate the
	 * directory the media server reads accepts transfers nobody will ever see.
	 */
	it('names the libraries nothing can be pulled into', async () => {
		stubFetch([
			{ body: [library({ id: 'l1' }), library({ id: 'l2', name: 'Films' })] },
			{ body: [check({ libraryId: 'l1' }), check({ libraryId: 'l2', name: 'Films', writable: false })] },
		]);
		const store = useLibrariesStore();
		await store.load();

		await store.loadChecks();

		expect(store.unwritableChecks.map(one => one.libraryId)).toEqual(['l2']);
		expect(store.writableLibraries.map(one => one.id)).toEqual(['l1']);
	});

	/**
	 * The order the wall draws them in, and the answer to which category a media
	 * belongs to when it is filed in two: lowest position, and ours before a friend's
	 * when nobody ever ordered the two against each other.
	 */
	it('orders the categories, ours first on a tie', async () => {
		stubFetch([{
			body: [
				category({ key: 'films', name: 'Films', position: 10, libraryIds: ['l2'] }),
				category({ key: 'concerts', name: 'Concerts', position: 0, local: false, libraryIds: ['l3'] }),
				category(),
			],
		}]);
		const store = useLibrariesStore();

		await store.loadCategories();

		expect(store.orderedCategories.map(one => one.key)).toEqual(['shows', 'concerts', 'films']);
		expect(store.categoryByKey.films.name).toBe('Films');
		expect(store.categoriesLoaded).toBe(true);
	});

	/** What a breadcrumb walks: a media knows its library and nothing above it. */
	it('says which category a library belongs to', async () => {
		stubFetch([{
			body: [
				category({ libraryIds: ['l1', 'l3'] }),
				category({ key: 'films', name: 'Films', position: 10, libraryIds: ['l2'] }),
			],
		}]);
		const store = useLibrariesStore();

		await store.loadCategories();

		expect(store.categoryOfLibrary.l3.name).toBe('Shows');
		expect(store.categoryOfLibrary.l2.name).toBe('Films');
		expect(store.categoryOfLibrary.l9).toBeUndefined();
	});

	/** An empty body parses to null, and the wall reads this as a list. */
	it('answers a list even when the gateway answers nothing', async () => {
		stubFetch([{ body: null }]);
		const store = useLibrariesStore();

		await store.loadCategories();

		expect(store.categories).toEqual([]);
	});

	it('re-checks the paths after one has been changed, because the answer moved', async () => {
		const stub = stubFetch([
			{ body: library({ localPath: '/media/other' }) },
			{ body: [check({ writable: false, localPath: '/media/other' })] },
		]);
		const store = useLibrariesStore();

		await store.update('l1', { localPath: '/media/other' });

		expect(stub).toHaveBeenCalledTimes(2);
		expect(String(stub.mock.calls[1][0])).toContain('/api/libraries/check');
		expect(store.checkById.l1.writable).toBe(false);
	});
});
