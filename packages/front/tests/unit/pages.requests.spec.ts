import type { MediaRequestView, RequestHolding } from '@mcs/shared';
import type { Pinia } from 'pinia';
import {
	MediaKind,
	MediaRequestState,
	MediaServiceStatus,
	MediaServiceType,
	Right,
	UserRole,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import Requests from '@/pages/Requests.vue';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { dialogStub, mountWithApp, mountWithAppAt, stubFetchRoutes, tooltipStub } from './helpers';

async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

const service = {
	id: 's1',
	name: 'Living room',
	type: MediaServiceType.JELLYFIN,
	shared: true,
	filesMounted: true,
	baseUrl: 'http://10.0.0.2:8096',
	status: MediaServiceStatus.ONLINE,
	version: null,
	authProvider: false,
	priority: 10,
	peerId: null,
	lastProbeAt: null,
	lastScanAt: null,
	libraryCount: 1,
	itemCount: 10,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function holding (overrides: Partial<RequestHolding> = {}): RequestHolding {
	return {
		itemId: 'm1',
		title: 'Dune',
		serviceId: 's1',
		seasonNumbers: [],
		...overrides,
	};
}

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

function signIn (pinia: Pinia, rights: Right[]): void {
	useTokenStore(pinia).store({
		accessToken: 'a',
		refreshToken: 'r',
		expiresIn: 900,
		user: { id: 'u1', username: 'ada', role: UserRole.ADMIN },
		rights,
	} as never);
	useAuthStore(pinia).ready = true;
}

function routes (requests: MediaRequestView[]): Record<string, { status?: number; body?: unknown }> {
	return {
		'/api/services': { body: [service] },
		'/api/requests/12/fulfilled': {
			body: view({ state: MediaRequestState.AVAILABLE, fulfillable: false }),
		},
		'/api/releases/search': { body: { query: 'dune', suggestions: [], missing: [], failed: [] } },
		'/api/requests': { body: requests },
	};
}

async function open (
	requests: MediaRequestView[],
	rights: Right[] = Object.values(Right),
) {
	const stub = stubFetchRoutes(routes(requests));
	const mounted = mountWithApp(Requests, {
		global: { stubs: { ...tooltipStub, ...dialogStub } },
	});

	signIn(mounted.pinia, rights);
	await settle();

	return { ...mounted, stub };
}

function urls (stub: ReturnType<typeof stubFetchRoutes>): string[] {
	return stub.mock.calls.map(call => String(call[0]));
}

function posts (stub: ReturnType<typeof stubFetchRoutes>): string[] {
	return stub.mock.calls
		.filter(call => (call[1] as { method?: string } | undefined)?.method === 'POST')
		.map(call => String(call[0]));
}

describe('pages/Requests', () => {
	it('offers to close an ask a copy of ours answers, and names the machine it is on', async () => {
		const { wrapper } = await open([view({
			heldAlready: true,
			fulfillable: true,
			holdings: [holding()],
			suggestion: null,
		})]);

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.attributes('data-held')).toBe('true');
		expect(row.find('[data-test="request-fulfil"]').exists()).toBe(true);
		// "We hold it" has to be checkable, so the copy names the service it sits on.
		expect(row.find('[data-test="request-holding"]').attributes('data-service')).toBe('s1');
	});

	it('offers nothing to close on an ask nothing of ours answers', async () => {
		const { wrapper } = await open([view({ heldAlready: false, fulfillable: false })]);

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.find('[data-test="request-fulfil"]').exists()).toBe(false);
		expect(row.find('[data-test="request-held-none"]').exists()).toBe(true);
	});

	/**
	 * The API decides, and the screen does not second-guess it.
	 *
	 * A request the source already considers available has nothing to say back to it,
	 * and a screen that offered the press anyway would look like it had failed.
	 */
	it('offers nothing to close on an ask the source already considers answered', async () => {
		const { wrapper } = await open([view({
			state: MediaRequestState.AVAILABLE,
			heldAlready: true,
			fulfillable: false,
			holdings: [holding()],
		})]);

		expect(wrapper.find('[data-test="request-fulfil"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="request-state"]').attributes('data-state'))
			.toBe(MediaRequestState.AVAILABLE);
	});

	it('keeps the press away from somebody who may look but not act', async () => {
		const { wrapper } = await open(
			[view({ heldAlready: true, fulfillable: true, holdings: [holding()] })],
			[Right.MEDIA_READ],
		);

		expect(wrapper.find('[data-test="request-row"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="request-fulfil"]').exists()).toBe(false);
	});

	/** The row somebody is actually looking at: something no library of ours holds. */
	it('names a request from what the source says the work is', async () => {
		const { wrapper } = await open([view({
			title: null,
			details: {
				title: 'Arrival',
				year: 2016,
				overview: 'A linguist is recruited by the army.',
				artworkUrl: 'https://image.example/poster.jpg',
				seasonNumbers: [],
			},
		})]);

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.find('[data-test="request-title"]').attributes('data-named')).toBe('true');
		expect(row.find('[data-test="request-title"]').text()).toContain('Arrival');
		expect(row.find('[data-test="request-from-source"]').exists()).toBe(true);
		expect(row.find('[data-test="request-overview"]').exists()).toBe(true);
		expect(row.find('[data-test="request-artwork-image"]').attributes('src'))
			.toBe('https://image.example/poster.jpg');
	});

	it('renders a request nothing can name as itself rather than as a blank row', async () => {
		const { wrapper } = await open([view({ title: null, details: null, suggestion: null })]);

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.exists()).toBe(true);
		expect(row.find('[data-test="request-title"]').attributes('data-named')).toBe('false');
		// The identifiers are all a source is certain to carry, and they are what
		// somebody pastes into a metadata site to find out what they are looking at.
		expect(row.find('[data-test="request-identifiers"]').exists()).toBe(true);
		expect(row.find('[data-test="request-search"]').exists()).toBe(false);
		expect(row.find('[data-test="request-no-search"]').exists()).toBe(true);
		expect(row.find('[data-test="request-artwork-placeholder"]').exists()).toBe(true);
	});

	it('says which seasons of a show nothing here holds', async () => {
		const { wrapper } = await open([view({
			kind: MediaKind.SERIES,
			seasons: [
				{ seasonNumber: 2, state: MediaRequestState.APPROVED },
				{ seasonNumber: 3, state: MediaRequestState.APPROVED },
			],
			holdings: [holding({ seasonNumbers: [2] })],
			heldAlready: true,
			fulfillable: false,
			missingSeasons: [3],
		})]);

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.find('[data-test="request-missing-seasons"]').exists()).toBe(true);
		// Held for two and asked for three, so there is nothing honest to close.
		expect(row.find('[data-test="request-fulfil"]').exists()).toBe(false);
	});

	/**
	 * The suggestion is the one thing on the view worked out for this purpose, and it
	 * reaches the indexer as it was handed over.
	 */
	it('hands the suggested term to the search unchanged, and only on a press', async () => {
		const { wrapper, stub } = await open([view({
			kind: MediaKind.SERIES,
			title: 'The Expanse',
			suggestion: { term: 'The Expanse', kind: MediaKind.SERIES, seasonNumbers: [2, 3] },
		})]);

		// Nothing was searched by the page merely opening.
		expect(urls(stub).some(url => url.includes('/api/releases'))).toBe(false);

		await wrapper.find('[data-test="request-search"]').trigger('click');
		await settle();

		const term = wrapper.find('[data-test="request-search-term"] input');

		expect((term.element as HTMLInputElement).value).toBe('The Expanse');

		await wrapper.find('[data-test="request-search-run"]').trigger('click');
		await settle();

		const search = urls(stub).find(url => url.includes('/api/releases/search')) ?? '';
		const asked = new URLSearchParams(search.slice(search.indexOf('?')));

		expect(asked.get('term')).toBe('The Expanse');
		// The first missing season, because an indexer is asked for one at a time.
		expect(asked.get('seasonNumber')).toBe('2');
		expect(asked.get('seasonPack')).toBe('true');
		// And which categories to ask for. Left out, a free-text search asks the television
		// ones, so a film would be looked for among the shows — an empty answer with no
		// error anywhere, which reads as "the tracker has nothing".
		expect(asked.get('kind')).toBe('show');
	});

	/**
	 * The rule the whole feature is drawn along.
	 *
	 * An ask on somebody else's Seerr must not be able to spend this gateway's disk, so
	 * no press on this screen may reach a grab, a transfer or a sync — the two writes it
	 * has are the request routes, which move nothing.
	 */
	it('moves no bytes, whatever is pressed on it', async () => {
		const { wrapper, stub } = await open([view({
			heldAlready: true,
			fulfillable: true,
			holdings: [holding()],
		})]);

		await wrapper.find('[data-test="request-fulfil"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="request-search"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="request-search-run"]').trigger('click');
		await settle();

		expect(posts(stub)).toEqual(['/api/requests/12/fulfilled']);

		for (const url of urls(stub)) {
			expect(url.includes('/api/releases/grab')).toBe(false);
			expect(url.includes('/api/releases/plan')).toBe(false);
			expect(url.includes('/api/transfers')).toBe(false);
			expect(url.includes('/api/sync')).toBe(false);
		}
	});

	it('keeps the answered ask on the screen, in the state the API answered', async () => {
		const { wrapper } = await open([view({
			heldAlready: true,
			fulfillable: true,
			holdings: [holding()],
		})]);

		await wrapper.find('[data-test="request-fulfil"]').trigger('click');
		await settle();

		const row = wrapper.find('[data-test="request-row"]');

		expect(row.exists()).toBe(true);
		expect(row.find('[data-test="request-state"]').attributes('data-state'))
			.toBe(MediaRequestState.AVAILABLE);
		expect(row.find('[data-test="request-fulfil"]').exists()).toBe(false);
	});

	it('shows an empty screen where nothing has been asked for', async () => {
		const { wrapper } = await open([]);

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
	});

	/**
	 * A gateway with no request source is not broken, and the generic failure would send
	 * somebody hunting for a fault in a feature they never turned on.
	 */
	it('says nothing is configured, and points at the screen that fixes it', async () => {
		stubFetchRoutes({
			'/api/services': { body: [service] },
			'/api/requests': { status: 409, body: { message: 'error.request_source.not_configured' } },
		});
		const mounted = mountWithApp(Requests, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		signIn(mounted.pinia, Object.values(Right));
		await settle();

		expect(mounted.wrapper.find('[data-test="request-not-configured"]').exists()).toBe(true);
		expect(mounted.wrapper.find('[data-test="request-configure"]').attributes('href'))
			.toBe('/settings');
		expect(mounted.wrapper.find('[data-test="request-list"]').exists()).toBe(false);
	});

	it('opens on the state a link carried, rather than on everything', async () => {
		const stub = stubFetchRoutes(routes([]));
		const mounted = await mountWithAppAt(
			Requests,
			'/requests?state=available',
			{ global: { stubs: { ...tooltipStub, ...dialogStub } } },
		);

		signIn(mounted.pinia, Object.values(Right));
		await settle();

		expect(urls(stub).some(url => url.includes('state=available'))).toBe(true);
	});
});
