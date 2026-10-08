import {
	LibraryKind,
	MediaKind,
	NewsSignal,
	ScanPhase,
	type ScanProgress,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ErrorState from '@/components/common/ErrorState.vue';
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
		// Nothing seen, which is what most of a watchlist says: the watch looks at a
		// batch of followed shows per pass, so a default of "seen" would make every
		// fixture here fetchable and prove nothing about the marks.
		fetchable: [],
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
	everything: Record<string, unknown>[],
	scans: ScanProgress[] = [],
) {
	const stub = stubFetchRoutes({
		'/api/libraries/categories': { body: CATEGORIES },
		'/api/libraries': { body: [] },
		/*
		 * One route, because the wall is one request now. It used to be one per category,
		 * which on eight categories was eight of the most expensive query this product has
		 * — and ten seconds of a reload.
		 */
		'/api/media/groups': {
			body: { items: everything, pagination: { page: 1, limit: 120, total: everything.length, pages: 1 } },
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
		const { stub } = await open([]);
		const asked = stub.mock.calls.filter(one => String(one[0]).includes('/media/groups'));
		const url = String(asked[0]?.[0]);

		// One request for the whole wall. It was one per category, and `rootsOnly` with
		// `actionable` makes the gateway re-read every descendant and build a skeleton for
		// each — eight times over, which is where ten seconds of a reload went.
		expect(asked).toHaveLength(1);
		expect(url).not.toContain('categoryKey');

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

	/*
	 * The two halves of the news, told apart.
	 *
	 * A new episode is tonight; a better encoding of a film already on the disk is a
	 * weekend job, and on a metered connection it may be never. Both are `actionable`
	 * and they are not the same news.
	 */
	it('sends no reason when both halves are wanted, exactly as it always did', async () => {
		const { stub } = await open([]);
		const url = String(
			stub.mock.calls.find(one => String(one[0]).includes('/media/groups'))?.[0],
		);

		// The default has to be byte-for-byte the old request, or every household that
		// never touches the filter gets a different screen for no reason.
		expect(url).not.toContain('reasons');
	});

	it('asks only for the gaps once the upgrades are unticked', async () => {
		const { wrapper, stub } = await open([]);

		await wrapper.find('[data-test="news-reason-upgrade"]').trigger('click');
		await settle();

		const asked = stub.mock.calls.filter(one => String(one[0]).includes('/media/groups'));
		const url = String(asked.at(-1)?.[0]);

		// Narrowed by the gateway, not here: the page never receives the rows it is not
		// showing, which is the difference between a filter and a fold.
		expect(url).toContain('reasons=gap');
		expect(url).not.toContain('reasons=upgrade');
	});

	/**
	 * What can actually be had, which `actionable` never said.
	 *
	 * The wall showed twelve followed shows with holes, of which perhaps two were
	 * obtainable tonight, and the other ten were shows nobody is seeding and nobody
	 * reachable holds — told apart only by opening each one and searching the trackers by
	 * hand. That is the whole of "pas juste notifier sur overseer".
	 */
	describe('only what can be fetched', () => {
		it('asks for everything until somebody says otherwise', async () => {
			/*
			 * Off by default, and that is not timidity. A show the episode watch has not
			 * come round to carries no signal at all, so switching this on by default
			 * would hide most of a fresh watchlist from the one screen built to show it.
			 */
			const { stub } = await open([]);
			const url = String(
				stub.mock.calls.find(one => String(one[0]).includes('/media/groups'))?.[0],
			);

			expect(url).not.toContain('signals');
		});

		it('asks the gateway for the fetchable ones once it is switched on', async () => {
			const { wrapper, stub } = await open([]);

			await wrapper.find('[data-test="news-only-fetchable"]').trigger('click');
			await settle();

			const asked = stub.mock.calls.filter(one => String(one[0]).includes('/media/groups'));
			const url = String(asked.at(-1)?.[0]);

			// Both signals, which is a real filter here rather than the absence of one —
			// the asymmetry with `reasons` that the page comments on.
			expect(url).toContain('signals=copy');
			expect(url).toContain('signals=release');
		});

		it('narrows to one kind of source without turning the filter off', async () => {
			const { wrapper, stub } = await open([]);

			await wrapper.find('[data-test="news-only-fetchable"]').trigger('click');
			await settle();
			await wrapper.find('[data-test="news-signal-release"]').trigger('click');
			await settle();

			const asked = stub.mock.calls.filter(one => String(one[0]).includes('/media/groups'));
			const url = String(asked.at(-1)?.[0]);

			expect(url).toContain('signals=copy');
			expect(url).not.toContain('signals=release');
		});

		it('offers no kinds to choose between while the filter is off', async () => {
			// Three pills in a row read as one filter with three boxes, and unticking the
			// wrong one empties the screen. The choice appears with the thing it narrows.
			const { wrapper } = await open([]);

			expect(wrapper.find('[data-test="news-signals"]').exists()).toBe(false);
		});

		it('says nothing can be fetched rather than saying nothing is new', async () => {
			/*
			 * The third empty, and a lie somebody would act on. There may be ten new
			 * episodes with nothing seeding them; "nothing new" said over that is the same
			 * mistake as saying it during a scan, which somebody already read off a screen
			 * and concluded the feature was broken.
			 */
			const { wrapper } = await open([]);

			await wrapper.find('[data-test="news-only-fetchable"]').trigger('click');
			await settle();

			expect(wrapper.find('[data-test="news-empty-fetchable"]').exists()).toBe(true);
			expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(false);
		});

		it('offers the way back out of the filter it is showing an empty screen for', async () => {
			const { wrapper, stub } = await open([]);

			await wrapper.find('[data-test="news-only-fetchable"]').trigger('click');
			await settle();
			await wrapper.find('[data-test="news-show-everything"]').trigger('click');
			await settle();

			const asked = stub.mock.calls.filter(one => String(one[0]).includes('/media/groups'));

			expect(String(asked.at(-1)?.[0])).not.toContain('signals');
			expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(true);
		});
	});

	/**
	 * A read somebody cancelled is not a read that failed.
	 *
	 * Every call here carries a `keepLastKey`, so starting a newer one aborts the one in
	 * flight — and this screen shares `libraries|categories` with the library and
	 * `media|groups|…` with every other wall. Leaving the page quickly, or toggling a
	 * filter, therefore kills a request *on purpose*; the dead one then lit up
	 * "something went wrong" over the live one's results, and it is the slowest read in
	 * the product so it lost that race most often. "J'ai toujours des erreurs de
	 * chargement, surtout quand je change de page assez vite."
	 */
	it('shows no error when the read was cancelled by a newer one', async () => {
		stubFetchRoutes({
			'/api/libraries/categories': { body: CATEGORIES },
			'/api/libraries': { body: [] },
		});
		// What the caller raises for an aborted fetch, which is what it turns into an
		// `AbortCallerException`: a `DOMException` named `AbortError`, and nothing else.
		const stub = vi.fn((input: unknown) => (String(input).includes('/media/groups')
			? Promise.reject(new DOMException('aborted', 'AbortError'))
			: Promise.resolve(Response.json(CATEGORIES))));

		globalThis.fetch = stub as unknown as typeof fetch;

		const { wrapper } = mountWithApp(NewReleases, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.findComponent(ErrorState).exists()).toBe(false);
	});

	it('still shows the error when the gateway really refuses', async () => {
		// The other half, or the guard above would hide every real failure: a screen that
		// never says anything went wrong is worse than one that says it too often.
		const stub = vi.fn((input: unknown) => (String(input).includes('/media/groups')
			? Promise.reject(new TypeError('Failed to fetch'))
			: Promise.resolve(Response.json(CATEGORIES))));

		globalThis.fetch = stub as unknown as typeof fetch;

		const { wrapper } = mountWithApp(NewReleases, { global: { stubs: tooltipStub } });

		await settle();

		expect(wrapper.findComponent(ErrorState).exists()).toBe(true);
	});

	it('draws one band per category, like the library it belongs to', async () => {
		const { wrapper } = await open([
			series(),
			series({ id: 'm1', kind: MediaKind.MOVIE, title: 'Dune', libraryId: 'l2' }),
		]);

		expect(wrapper.find('[data-test="news-band-series"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-band-films"]').exists()).toBe(true);
		expect(wrapper.findComponent({ name: 'LibrarySection' }).exists()).toBe(true);
	});

	it('leaves out a category with nothing in it, rather than heading an empty shelf', async () => {
		const { wrapper } = await open([series()]);

		expect(wrapper.find('[data-test="news-band-series"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-band-films"]').exists()).toBe(false);
	});

	it('marks a card with what was seen for it, so the wall reads without opening one', async () => {
		const { wrapper } = await open([
			series({ fetchable: [NewsSignal.COPY, NewsSignal.RELEASE] }),
			series({ id: 's2', title: 'Severance', fetchable: [] }),
		]);
		const marks = wrapper.findAll('[data-test="fetchable-marks"]');

		// One card marked, one not: nothing is drawn where nothing is known, because a
		// card saying "unavailable" about a show nobody has searched for states as fact
		// something nobody has looked into.
		expect(marks).toHaveLength(1);
		expect(marks[0].attributes('data-signals')).toBe('copy release');
	});

	it('keeps the library’s own grid-or-list preference', async () => {
		// Shared on purpose: somebody who browses in rows browses in rows everywhere.
		const { wrapper } = await open([series()]);

		expect(wrapper.find('[data-test="news-view-toggle"]').exists()).toBe(true);
	});

	it('says nothing is new rather than drawing an empty frame', async () => {
		const { wrapper } = await open([]);

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
		const { wrapper } = await open([], [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 120, itemsTotal: null, done: false, phase: ScanPhase.WALKING },
		]);

		expect(wrapper.find('[data-test="news-scanning"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(false);
	});

	it('counts against what the last scan found, with a bar that moves', async () => {
		// A bar moving against a number is the difference between "it is working" and "it
		// is nearly done". The gateway reports the previous scan's count as the estimate,
		// since counting first would mean reading the library twice.
		const { wrapper } = await open([], [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 300, itemsTotal: 1200, done: false, phase: ScanPhase.WALKING },
		]);
		const bar = wrapper.find('[data-test="news-scanning-progress"]');

		expect(bar.attributes('aria-valuenow')).toBe('25');
		expect(wrapper.find('[data-test="news-scanning"]').text()).toContain('1200');
	});

	it('draws no figure when one of the scans cannot give one', async () => {
		/*
		 * Summing the totals that exist against the rows of the ones that do not would draw
		 * a bar past its own end — the rows of a scan with no estimate would count towards
		 * a total that does not include them.
		 */
		const { wrapper } = await open([], [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 300, itemsTotal: 1200, done: false, phase: ScanPhase.WALKING },
			{ serviceId: 'sv2', libraryId: null, itemsSeen: 900, itemsTotal: null, done: false, phase: ScanPhase.WALKING },
		]);

		expect(wrapper.find('[data-test="news-scanning-progress"]').attributes('aria-valuenow'))
			.toBeUndefined();
	});

	it('goes back to saying nothing is new once the scan is over', async () => {
		const { wrapper } = await open([], [
			{ serviceId: 'sv1', libraryId: null, itemsSeen: 120, itemsTotal: 120, done: true, phase: ScanPhase.WALKING },
		]);

		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-scanning"]').exists()).toBe(false);
	});
});
