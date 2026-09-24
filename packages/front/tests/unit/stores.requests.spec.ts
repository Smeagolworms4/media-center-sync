import type { MediaRequestView } from '@mcs/shared';
import { MediaKind, MediaRequestState } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestsStore } from '@/stores/requests';
import { createStoreContext, stubFetch } from './helpers';

function view (overrides: Partial<MediaRequestView> = {}): MediaRequestView {
	return {
		id: '12',
		mediaId: '34',
		kind: MediaKind.MOVIE,
		title: 'Dune',
		tmdbId: '438631',
		tvdbId: null,
		state: MediaRequestState.APPROVED,
		seasons: [],
		requestedBy: 'ada',
		requestedAt: '2026-02-01T10:00:00.000Z',
		holdings: [],
		heldAlready: false,
		fulfillable: false,
		missingSeasons: [],
		suggestion: { term: 'Dune', kind: MediaKind.MOVIE, seasonNumbers: [] },
		details: null,
		...overrides,
	};
}

function urls (stub: ReturnType<typeof stubFetch>): string[] {
	return stub.mock.calls.map(call => String(call[0]));
}

describe('stores/requests', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('reads the open asks and asks for nothing it was not told to', async () => {
		const stub = stubFetch([{ body: [view(), view({ id: '13' })] }]);
		const store = useRequestsStore(pinia);

		await store.load();

		expect(store.requests).toHaveLength(2);
		expect(store.loaded).toBe(true);
		expect(store.notConfigured).toBe(false);
		// No parameters at all rather than an empty state: the API's own default is the
		// open asks, and `state=` is a filter on nothing.
		expect(urls(stub)[0]).toBe('/api/requests');
	});

	it('carries the state filter and the ceiling into the query', async () => {
		const stub = stubFetch([{ body: [] }]);
		const store = useRequestsStore(pinia);

		await store.load({ state: MediaRequestState.AVAILABLE, take: 5 });

		expect(urls(stub)[0]).toContain('state=available');
		expect(urls(stub)[0]).toContain('take=5');
	});

	it('asks the same question again when it is refreshed', async () => {
		const stub = stubFetch([{ body: [] }, { body: [] }]);
		const store = useRequestsStore(pinia);

		await store.load({ state: MediaRequestState.PENDING });
		await store.refresh();

		expect(urls(stub)[1]).toContain('state=pending');
	});

	it('leaves a list where a gateway answered nothing at all', async () => {
		stubFetch([{ body: null }]);
		const store = useRequestsStore(pinia);

		await store.load();

		expect(store.requests).toEqual([]);
	});

	/**
	 * The one refusal the listing has, and it is not a fault.
	 *
	 * A household that never configured Seerr must not be shown "the gateway could not
	 * answer" — the screen has its own words and points at the settings.
	 */
	it('reads a conflict as a gateway with no request source', async () => {
		stubFetch([{ status: 409, body: { message: 'error.request_source.not_configured' } }]);
		const store = useRequestsStore(pinia);

		await expect(store.load()).rejects.toBeDefined();

		expect(store.notConfigured).toBe(true);
		expect(store.requests).toEqual([]);
	});

	it('does not call a failure of its own a missing request source', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useRequestsStore(pinia);

		await expect(store.load()).rejects.toBeDefined();

		expect(store.notConfigured).toBe(false);
		expect(store.error).toBeDefined();
	});

	/**
	 * The answered row is kept, with the state the API returned.
	 *
	 * Seerr recomputes a request's status after the write, so reading the listing back
	 * would show the old one and look like the press had failed.
	 */
	it('keeps the answered ask, as the API answered it', async () => {
		const stub = stubFetch([
			{ body: [view({ id: '12', fulfillable: true, heldAlready: true })] },
			{ body: view({ id: '12', state: MediaRequestState.AVAILABLE, fulfillable: false }) },
		]);
		const store = useRequestsStore(pinia);

		await store.load();
		await store.markFulfilled('12');

		expect(urls(stub)[1]).toBe('/api/requests/12/fulfilled');
		expect(stub.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
		expect(store.requests).toHaveLength(1);
		expect(store.requests[0]?.state).toBe(MediaRequestState.AVAILABLE);
		expect(store.requests[0]?.fulfillable).toBe(false);
	});

	it('counts the asks it could honestly close', async () => {
		stubFetch([{
			body: [
				view({ id: '12', heldAlready: true, fulfillable: true }),
				view({ id: '13' }),
			],
		}]);
		const store = useRequestsStore(pinia);

		await store.load();

		expect(store.fulfillable.map(one => one.id)).toEqual(['12']);
	});

	it('pushes an ask the other way without inventing a row for it', async () => {
		const stub = stubFetch([{ body: [] }, { body: null }]);
		const store = useRequestsStore(pinia);

		await store.load();
		const created = await store.create({ itemId: 'm1', seasons: [2] });

		expect(urls(stub)[1]).toBe('/api/requests');
		expect(stub.mock.calls[1]?.[1]).toMatchObject({
			method: 'POST',
			body: JSON.stringify({ itemId: 'm1', seasons: [2] }),
		});
		// Nothing answers when the source already had the same ask open, which is a
		// success; and the held list is what the next read says it is.
		expect(created).toBeNull();
		expect(store.requests).toEqual([]);
	});

	/**
	 * Nothing here can move bytes, and that is the feature's one hard rule.
	 *
	 * Pinned as a property of the store rather than of a screen: an ask on somebody
	 * else's Seerr must not reach a transfer, a grab or a sync by any route.
	 */
	it('talks to nothing but the request routes', async () => {
		const stub = stubFetch([{ body: [view({ fulfillable: true })] }, { body: view() }, { body: null }]);
		const store = useRequestsStore(pinia);

		await store.load();
		await store.markFulfilled('12');
		await store.create({ tmdbId: '438631', kind: MediaKind.MOVIE });

		for (const url of urls(stub)) {
			expect(url.startsWith('/api/requests')).toBe(true);
		}
	});
});
