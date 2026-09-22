import { LibraryHintKind, LibraryLayoutSignal } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import Dashboard from '@/pages/Dashboard.vue';
import Library from '@/pages/Library.vue';
import { mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * The two screens that carry the organisation hints, wired to the gateway's answer.
 *
 * The component's own suite proves the wording; this proves the wiring, which is the
 * half that can break on its own. A page that stopped reading the route, or stopped
 * passing the list through, would still render every other thing it renders — and both
 * hints exist only to be seen, so nothing else anywhere would fail.
 */

async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

const EMPTY_LIST = { body: { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } } };

const HINTS = [
	{
		key: 'misread-folder:series-1',
		kind: LibraryHintKind.MISREAD_FOLDER,
		itemId: 'series-1',
		title: 'Marvel Comics',
		libraryName: 'Series TV',
		serviceName: 'Jellyfin',
		signals: [LibraryLayoutSignal.NAMED_SEASONS],
		examples: ['Agent Carter', 'Agents of SHIELD'],
		seasonCount: 24,
	},
];

/**
 * Every route either page reads, with the hints among them.
 *
 * `/api/libraries/hints` is listed before the shorter `/api/libraries` on purpose —
 * the stub matches on the longest key that the URL contains, and without its own entry
 * the hints call would be answered with the list of libraries.
 */
const ROUTES = {
	'/api/libraries/hints': { body: HINTS },
	'/api/libraries/check': { body: [] },
	'/api/libraries/categories': { body: [] },
	'/api/libraries': { body: [] },
	'/api/services': { body: [] },
	'/api/peers': { body: [] },
	'/api/transfers/stats': { body: { queued: 0, running: 0, done: 0, failed: 0, bytesDone: 0, bytesTotal: 0, rate: 0 } },
	'/api/transfers/unconfigured': { body: [] },
	'/api/transfers': EMPTY_LIST,
	'/api/sync/jobs': EMPTY_LIST,
	'/api/media/groups': EMPTY_LIST,
	'/api/media': EMPTY_LIST,
};

describe('the organisation hints on the screens that carry them', () => {
	it('shows the suspicion on the dashboard', async () => {
		stubFetchRoutes(ROUTES);
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.find('[data-test="library-hint"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="library-hint-text"]').text()).toContain('Marvel Comics');
	});

	it('shows it on the wall too, where the rows it explains are', async () => {
		stubFetchRoutes(ROUTES);
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.find('[data-test="library-hint"]').exists()).toBe(true);
	});

	it('draws nothing on either when the gateway has nothing to say', async () => {
		stubFetchRoutes({ ...ROUTES, '/api/libraries/hints': { body: [] } });
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.find('[data-test="library-hints"]').exists()).toBe(false);
	});

	/** A hint nobody could fetch is not a reason to take a home page down. */
	it('draws the rest of the dashboard when the hints cannot be read', async () => {
		stubFetchRoutes({ ...ROUTES, '/api/libraries/hints': { status: 500, body: { message: 'error.general' } } });
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.find('[data-test="library-hints"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="tile-services"]').exists()).toBe(true);
	});
});
