import type { MediaItem } from '@mcs/shared';
import { EventName, MediaKind, SyncState, TransferState } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMediaQuery, useMediaStore } from '@/stores/media';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

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
		artworkUrl: null,
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

	it('marks an item as syncing while a transfer for it is running', async () => {
		stubFetch([{ body: { items: [item({ id: 'm1' })], pagination: null } }]);
		const store = useMediaStore();
		await store.search();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't1', itemId: 'm1', state: TransferState.DOWNLOADING,
		});
		expect(store.items[0].sync).toBe(SyncState.SYNCING);

		emitServerEvent(EventName.TRANSFER_STATE, {
			id: 't1', itemId: 'm1', state: TransferState.DONE,
		});
		expect(store.items[0].sync).toBe(SyncState.IN_SYNC);
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

	it('confirms and drops a correlation through the routes that record it', async () => {
		const stub = stubFetch([{ body: { id: 'match-1' } }, {}]);
		const store = useMediaStore();

		await store.confirmMatch('m1', 'match-1');
		await store.removeMatch('m1', 'match-1');

		expect(String(stub.mock.calls[0][0])).toContain('/api/media/m1/matches/match-1/confirm');
		expect(stub.mock.calls[1][1]?.method).toBe('DELETE');
	});
});
