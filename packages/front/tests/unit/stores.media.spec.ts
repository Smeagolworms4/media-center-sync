import type { MediaGroup, MediaItem } from '@mcs/shared';
import { EventName, MediaKind, MediaServiceType, SyncState, TransferState } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMediaQuery, useMediaStore } from '@/stores/media';
import { useTokenStore } from '@/stores/token';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

function group (overrides: Partial<MediaGroup> = {}): MediaGroup {
	return {
		id: 'g1',
		kind: MediaKind.SERIES,
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkItemId: 'a1',
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		versions: [],
		childCount: 0,
		missingCount: 0,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

function item (overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2019,
		seasonNumber: 1,
		episodeNumber: 1,
		externalIds: {},
		overview: null,
		overrides: null,
		reported: null,
		artworkUrl: null,
		companions: null,
		file: null,
		quality: null,
		addedAt: null,
		sync: SyncState.MISSING,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('buildMediaQuery', () => {
	it('repeats the key for a list of states rather than joining them', () => {
		const query = buildMediaQuery({ states: [SyncState.MISSING, SyncState.OUTDATED] });

		expect(query).toBe('?states=missing&states=outdated');
	});

	it('leaves out what was not asked for', () => {
		expect(buildMediaQuery({ search: '', serviceId: undefined, page: 2 })).toBe('?page=2');
	});

	it('is empty when nothing is filtered', () => {
		expect(buildMediaQuery({})).toBe('');
	});
});

describe('stores/media', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('searches the index and keeps the pagination the list needs', async () => {
		const stub = stubFetch([{
			body: { items: [item()], pagination: { page: 1, limit: 50, total: 138, pages: 3 } },
		}]);
		const store = useMediaStore();

		await store.search({ search: 'expanse', states: [SyncState.MISSING], page: 1 });

		expect(String(stub.mock.calls[0][0])).toContain('search=expanse');
		expect(String(stub.mock.calls[0][0])).toContain('states=missing');
		expect(store.items).toHaveLength(1);
		expect(store.pagination.total).toBe(138);
	});

	it('keeps the failure so the page can show an error rather than "nothing here"', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useMediaStore();

		await expect(store.search()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
		expect(store.loading).toBe(false);
	});

	it('builds the artwork URL itself, because a component never builds one', () => {
		const store = useMediaStore();

		expect(store.artworkUrl('m1')).toBe('/api/media/m1/artwork');
	});

	/**
	 * An `<img>` carries no header, so the poster route takes the access token as a
	 * query parameter — and getting that wrong is a wall of broken images.
	 */
	it('carries the access token in the artwork URL, since an image cannot send a header', () => {
		useTokenStore().store({
			accessToken: 'tok en/1',
			refreshToken: 'r',
			expiresIn: 900,
			user: null,
			rights: [],
		} as never);
		const store = useMediaStore();

		expect(store.artworkUrl('m1')).toBe('/api/media/m1/artwork?token=tok%20en%2F1');
	});

	it('has no artwork URL for a group whose sources carry no artwork at all', () => {
		const store = useMediaStore();

		expect(store.artworkUrl(null)).toBeNull();
	});

	it('reads one band of the grouped view per key, so two can be in flight at once', async () => {
		const stub = stubFetch([
			{ body: { items: [group({ id: 'series-1' })], pagination: { page: 1, limit: 24, total: 7, pages: 1 } } },
			{ body: { items: [group({ id: 'movie-1', kind: MediaKind.MOVIE })], pagination: { page: 1, limit: 24, total: 3, pages: 1 } } },
		]);
		const store = useMediaStore();

		await Promise.all([
			store.searchGroups('series', { kind: MediaKind.SERIES, limit: 24 }),
			store.searchGroups('movie', { kind: MediaKind.MOVIE, limit: 24 }),
		]);

		expect(String(stub.mock.calls[0][0])).toContain('/media/groups?kind=series');
		expect(store.groups.series.map(one => one.id)).toEqual(['series-1']);
		expect(store.groups.movie.map(one => one.id)).toEqual(['movie-1']);
		expect(store.groupPagination.series.total).toBe(7);
		expect(store.groupPagination.movie.total).toBe(3);
		expect(store.groupsLoading).toBe(false);
	});

	it('reads one group and its children through the grouped routes', async () => {
		const stub = stubFetch([{ body: group() }, { body: { items: [], pagination: null } }]);
		const store = useMediaStore();

		await store.group('g1');
		await store.groupChildren('g1', { limit: 200 });

		expect(String(stub.mock.calls[0][0])).toContain('/api/media/groups/g1');
		expect(String(stub.mock.calls[1][0])).toContain('/api/media/groups/g1/children?limit=200');
	});

	/** A poster has to change state while somebody is looking at it. */
	it('marks a poster as syncing when a transfer runs for any copy underneath it', async () => {
		stubFetch([{
			body: {
				items: [group({
					id: 'g1',
					sources: [{
						itemId: 'copy-1',
						serviceId: 's1',
						serviceName: 'Living room',
						serviceType: MediaServiceType.JELLYFIN,
						peerId: null,
						peerName: null,
						quality: null,
						companions: null,
						bytes: null,
						versionId: null,
						edition: null,
						local: true,
						path: null,
						localPath: null,
						sync: SyncState.IN_SYNC,
					}],
				})],
				pagination: null,
			},
		}]);
		const store = useMediaStore();
		await store.searchGroups('series', {});
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't1', itemId: 'copy-1', state: TransferState.DOWNLOADING,
		});

		expect(store.groups.series[0].sync).toBe(SyncState.SYNCING);
	});

	it('marks an item as syncing while a transfer for it is running', async () => {
		stubFetch([{ body: { items: [item({ id: 'm1' })], pagination: null } }]);
		const store = useMediaStore();
		await store.search();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't1', itemId: 'm1', state: TransferState.DOWNLOADING,
		});
		expect(store.items[0].sync).toBe(SyncState.SYNCING);

		/*
		 * A finished transfer means the file is on the disk, and nothing more.
		 *
		 * `in_sync` here would claim the media server holds it, which it does not
		 * until it has scanned — and the next reload from the API would contradict
		 * this row. `awaiting_index` is what the gateway has recorded, so the
		 * optimistic patch and the reload say the same thing.
		 */
		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't1', itemId: 'm1', state: TransferState.DONE,
		});
		expect(store.items[0].sync).toBe(SyncState.AWAITING_INDEX);
	});

	it('ignores a transfer for an item this list does not hold', async () => {
		stubFetch([{ body: { items: [item({ id: 'm1' })], pagination: null } }]);
		const store = useMediaStore();
		await store.search();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't9', itemId: 'elsewhere', state: TransferState.DONE,
		});

		expect(store.items[0].sync).toBe(SyncState.MISSING);
	});

	it('sends a correction exactly as it was built, nulls included', async () => {
		// The store is the last place the body passes through, and dropping a null
		// here — or turning an empty string into one — would silently take away the
		// only way to remove a value a scraper invented.
		const stub = stubFetch([{ body: item({ title: 'Cosmos', year: null }) }]);
		const store = useMediaStore();

		const saved = await store.setOverride('m1', { title: 'Cosmos', year: null });

		expect(stub.mock.calls[0][0]).toBe('/api/media/m1/override');
		expect(stub.mock.calls[0][1]?.method).toBe('PUT');
		expect(JSON.parse(stub.mock.calls[0][1]?.body as string)).toEqual({ title: 'Cosmos', year: null });
		expect(saved.title).toBe('Cosmos');
	});

	it('puts every corrected field back with one call', async () => {
		const stub = stubFetch([{ body: item() }]);
		const store = useMediaStore();

		await store.clearOverride('m1');

		expect(stub.mock.calls[0][0]).toBe('/api/media/m1/override');
		expect(stub.mock.calls[0][1]?.method).toBe('DELETE');
	});

	it('confirms and drops a correlation through the routes that record it', async () => {
		const stub = stubFetch([{ body: { id: 'match-1' } }, {}]);
		const store = useMediaStore();

		await store.confirmMatch('m1', 'match-1');
		await store.removeMatch('m1', 'match-1');

		expect(String(stub.mock.calls[0][0])).toContain('/api/media/m1/matches/match-1/confirm');
		expect(stub.mock.calls[1][1]?.method).toBe('DELETE');
	});
});
