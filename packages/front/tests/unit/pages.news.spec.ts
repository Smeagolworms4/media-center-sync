import { LibraryKind, MediaKind, SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NewReleases from '@/pages/NewReleases.vue';
import { useServicesStore } from '@/stores/services';
import { mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/** Let the mounted page finish its own fetches, as the other page suites do. */
async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

/**
 * What has come out for the shows this household follows.
 *
 * The screen asks for **series**, and that is the correction these tests exist to hold.
 * It used to ask for episodes and got exactly that: a flat wall of sixty tiles with no
 * posters, belonging to no series and sorted into no category — "pourquoi c'est pas rangé
 * en série saison, comme le reste". The request source hands us series and the episodes
 * are found inside them, so the wall is series and opening one is how its seasons are
 * reached.
 *
 * Both halves of the rule still hold: a show nobody here follows is not news, and a
 * followed show with nothing to fetch beneath it is not either — which is `actionable`.
 */

function series (overrides: Record<string, unknown> = {}) {
	return {
		id: 's1',
		kind: MediaKind.SERIES,
		title: 'The Expanse',
		seriesTitle: null,
		normalizedTitle: 'the expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		// The poster the request source named. A season and an episode carry none, which
		// is the other half of why the wall is series.
		artworkItemId: 's1',
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		childCount: 10,
		missingCount: 3,
		versions: [],
		libraryId: 'l1',
		parentId: null,
		addedAt: '2026-09-28T00:00:00.000Z',
		...overrides,
	};
}

const CATEGORIES = [
	{
		key: 'series',
		name: 'Séries',
		kind: LibraryKind.SHOWS,
		position: 100,
		libraryIds: ['l1'],
		serviceIds: ['sv1'],
		itemCount: 10,
		local: true,
	},
	{
		key: 'films',
		name: 'Films',
		kind: LibraryKind.MOVIES,
		position: 200,
		libraryIds: ['l2'],
		serviceIds: ['sv1'],
		itemCount: 4,
		local: true,
	},
];

/** The wall, with each category answering whatever `byCategory` says it holds. */
async function open (
	byCategory: Record<string, Record<string, unknown>[]>,
	scans: { serviceId: string; libraryId: string | null; itemsSeen: number; itemsTotal: number | null; done: boolean }[] = [],
) {
	const stub = stubFetchRoutes({
		'/api/libraries/categories': { body: CATEGORIES },
		'/api/libraries': { body: [] },
		// Keyed on the query string, because each band asks for its own category and the
		// helper matches a route by substring.
		...Object.fromEntries(
			CATEGORIES.map(one => {
				const items = byCategory[one.key] ?? [];

				return [
					`categoryKey=${one.key}`,
					{ body: { items, pagination: { page: 1, limit: 60, total: items.length, pages: 1 } } },
				];
			}),
		),
		'/api/media/groups': {
			body: { items: [], pagination: { page: 1, limit: 60, total: 0, pages: 0 } },
		},
	});
	const { wrapper } = mountWithApp(NewReleases, { global: { stubs: tooltipStub } });

	// Written straight onto the store, because a scan reaches this screen through the
	// event stream and not through a route it could be stubbed on.
	const services = useServicesStore();

	for (const one of scans) {
		services.scans[one.serviceId] = one;
	}

	await settle();

	return { wrapper, stub };
}

describe('pages/NewReleases', () => {
	it('asks for series with something to fetch, not for episodes', async () => {
		const { stub } = await open({});
		const url = String(stub.mock.calls.find(one => String(one[0]).includes('/media/groups'))?.[0]);

		// Roots rather than a kind: a film is as much news as a series, and both are what
		// a category sorts.
		expect(url).toContain('rootsOnly=true');
		expect(url).not.toContain('kind=episode');
		// Either way of saying the household cares: a plan, or the watchlist on the
		// request source. Reading plans alone would leave this screen empty.
		expect(url).toContain('watched=true');
		// What makes it news rather than a catalogue: something left to fetch or replace.
		expect(url).toContain('actionable=true');
		expect(url).toContain('sort=addedAt');
		expect(url).toContain('direction=desc');
	});

	it('draws one band per category, like the library it belongs to', async () => {
		const { wrapper } = await open({
			series: [series()],
			films: [series({ id: 'm1', kind: MediaKind.MOVIE, title: 'Dune' })],
		});

		expect(wrapper.find('[data-test="news-band-series"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-band-films"]').exists()).toBe(true);
		expect(wrapper.findComponent({ name: 'LibrarySection' }).exists()).toBe(true);
	});

	it('leaves out a category with nothing in it, rather than heading an empty shelf', async () => {
		const { wrapper } = await open({ series: [series()] });

		expect(wrapper.find('[data-test="news-band-series"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-band-films"]').exists()).toBe(false);
	});

	it('keeps the library’s own grid-or-list preference', async () => {
		// Shared on purpose: somebody who browses in rows browses in rows everywhere.
		const { wrapper } = await open({ series: [series()] });

		expect(wrapper.find('[data-test="news-view-toggle"]').exists()).toBe(true);
	});

	it('says nothing is new rather than drawing an empty frame', async () => {
		const { wrapper } = await open({});

		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-scanning"]').exists()).toBe(false);
	});

	it('says it is still reading rather than saying nothing is new', async () => {
		/*
		 * The two empties look identical and mean opposite things. "Nothing new for the
		 * shows you follow" is an answer; "nobody has finished reading your watchlist yet"
		 * is a wait. Said as an answer, somebody reads it off a screen that has not
		 * finished and concludes the feature does not work — which is what happened.
		 */
		const { wrapper } = await open({}, [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 120, itemsTotal: null, done: false },
		]);

		expect(wrapper.find('[data-test="news-scanning"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(false);
	});

	it('goes back to saying nothing is new once the scan is over', async () => {
		const { wrapper } = await open({}, [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 120, itemsTotal: 120, done: true },
		]);

		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-scanning"]').exists()).toBe(false);
	});
});
