import type {
	CoveragePlan,
	MediaGroup,
	PeerCopy,
	ReleaseGroup,
	ReleaseSearchResult,
} from '@mcs/shared';
import {
	MediaKind,
	MediaOrigin,
	MediaServiceType,
	PEER_SUGGESTION_PREFIX,
	ReleaseKind,
	SuggestionSource,
	SyncState,
} from '@mcs/shared';
import { flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ReleasePlan from '@/components/media/ReleasePlan.vue';
import ReleaseSearch from '@/components/media/ReleaseSearch.vue';
import { useReleasesStore } from '@/stores/releases';
import { mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * A copy that exists and a name on a tracker, on one screen, told apart.
 *
 * The screen has one job beyond listing: to make the two legible as two different kinds
 * of thing, and to put the right action on each. A peer copy has a holder and a path and
 * no seeders; a release has seeders and no holder. Showing "0 seeders" beside a file
 * sitting on a friend's disk would be the one statement about it that is false, and a
 * single "fetch" button over both would send half the rows to the wrong machine — silently
 * at both ends.
 *
 * Asserted on `data-test` and `data-source`, never on wording: the labels are translated
 * and a test reading them would be pinning English.
 */

function group (overrides: Partial<ReleaseGroup> = {}): ReleaseGroup {
	return {
		key: 'grp-1',
		title: 'Spartacus.S01E01.1080p.WEB-DL-GRP',
		kind: ReleaseKind.EPISODE,
		seasonNumber: 1,
		episodeNumber: 1,
		quality: '1080p',
		source: 'WEB-DL',
		languages: ['VO'],
		size: 3000,
		seeders: 40,
		releases: [
			{
				id: 'release-1',
				title: 'Spartacus.S01E01.1080p.WEB-DL-GRP',
				indexer: 'prowlarr',
				size: 3000,
				seeders: 40,
				leechers: 1,
				publishedAt: null,
				magnetUrl: 'magnet:?xt=urn:btih:one',
				downloadUrl: null,
				kind: ReleaseKind.EPISODE,
				seasonNumber: 1,
				episodeNumber: 1,
				quality: '1080p',
				source: 'WEB-DL',
				languages: ['VO'],
				coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
				heldAlready: false,
				flags: [],
			},
		],
		flags: [],
		indexers: ['prowlarr'],
		coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
		fills: [],
		brings: [],
		heldAlready: false,
		...overrides,
	};
}

function copy (overrides: Partial<PeerCopy> = {}): PeerCopy {
	return {
		id: `${PEER_SUGGESTION_PREFIX}svc-alice:1`,
		itemIds: ['their-ep-1', 'their-ep-2'],
		title: 'Spartacus',
		serviceId: 'svc-alice',
		serviceName: 'Alice Jellyfin',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: 'peer-alice',
		peerName: 'Alice',
		origin: MediaOrigin.FRIEND,
		seasonNumber: 1,
		episodeNumber: null,
		size: 4000,
		quality: null,
		path: null,
		fills: [
			{ itemId: 'our-ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' },
			{ itemId: 'our-ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' },
		],
		...overrides,
	};
}

function mediaGroup (overrides: Partial<MediaGroup> = {}): MediaGroup {
	return {
		id: 'season-1',
		kind: MediaKind.SEASON,
		title: 'Season 1',
		normalizedTitle: 'season 1',
		year: null,
		seasonNumber: 1,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkItemId: null,
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		childCount: 2,
		missingCount: 2,
		versions: [],
		libraryId: 'lib-shows',
		parentId: 'series-1',
		addedAt: null,
		...overrides,
	} as MediaGroup;
}

function searchResult (overrides: Partial<ReleaseSearchResult> = {}): ReleaseSearchResult {
	return {
		query: 'Spartacus S01',
		suggestions: [
			{ source: SuggestionSource.PEER, key: copy().id, copy: copy() },
			{ source: SuggestionSource.INDEXER, key: 'grp-1', release: group() },
		],
		missing: [{ itemId: 'our-ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' }],
		failed: [],
		...overrides,
	};
}

/** Mounts the search tab with an answer already in the store, as a search leaves it. */
async function mountWithResult (result = searchResult(), media = mediaGroup()) {
	const mounted = mountWithApp(ReleaseSearch, {
		props: { group: media, seasonNumber: media.seasonNumber, episodeNumber: media.episodeNumber },
		global: { stubs: { ...tooltipStub } },
	});

	const store = useReleasesStore(mounted.pinia);

	store.result = result;
	store.searchedFor = media.id;
	await nextTick();

	return { ...mounted, store };
}

describe('components/media/ReleaseSearch', () => {
	beforeEach(() => {
		// Mounting loads what has already been grabbed for this media; nothing under test
		// here cares what that answers, and an unstubbed call would reach the network.
		stubFetchRoutes({ '/releases/downloads': { body: [] } });
	});

	it('draws a peer copy and a tracker release as two kinds of row', async () => {
		const { wrapper } = await mountWithResult();
		const rows = wrapper.findAll('[data-test="release-row"]');

		expect(rows).toHaveLength(2);
		// The gateway put the copy that exists first, and the screen does not re-sort.
		expect(rows[0].attributes('data-source')).toBe(SuggestionSource.PEER);
		expect(rows[1].attributes('data-source')).toBe(SuggestionSource.INDEXER);
	});

	/**
	 * A peer copy has no seeders, and a row claiming it has none would be saying the one
	 * thing about it that is not true. It has a holder and how far away they are instead.
	 */
	it('says who holds a peer copy and never how well it is seeded', async () => {
		const { wrapper } = await mountWithResult();
		const row = wrapper.findAll('[data-test="release-row"]')[0];

		expect(row.find('[data-test="release-peer-holder"]').text()).toContain('Alice Jellyfin');
		expect(row.find('[data-test="release-peer-name"]').exists()).toBe(true);
		expect(row.find('[data-test="release-peer-origin"]').attributes('data-origin'))
			.toBe(MediaOrigin.FRIEND);
		expect(row.find('[data-test="release-seeders"]').exists()).toBe(false);
	});

	it('says how well a tracker release is seeded and never who holds it', async () => {
		const { wrapper } = await mountWithResult();
		const row = wrapper.findAll('[data-test="release-row"]')[1];

		expect(row.find('[data-test="release-seeders"]').exists()).toBe(true);
		expect(row.find('[data-test="release-peer-holder"]').exists()).toBe(false);
	});

	it('shows the holder own path on a single-file copy, which a release cannot have', async () => {
		const { wrapper } = await mountWithResult(searchResult({
			suggestions: [
				{
					source: SuggestionSource.PEER,
					key: 'peer:one',
					copy: copy({ id: 'peer:one', path: '/media/Shows/S01E01.mkv', fills: [copy().fills[0]] }),
				},
			],
		}));

		expect(wrapper.find('[data-test="release-peer-path"]').text())
			.toBe('/media/Shows/S01E01.mkv');
	});

	describe('the action on each row', () => {
		it('offers a peer copy a pull and never a grab', async () => {
			const { wrapper } = await mountWithResult();
			const row = wrapper.findAll('[data-test="release-row"]')[0];

			expect(row.find('[data-test="release-pull-button"]').exists()).toBe(true);
			expect(row.find('[data-test="release-grab-button"]').exists()).toBe(false);
		});

		it('offers a tracker release a grab and never a pull', async () => {
			const { wrapper } = await mountWithResult();
			const row = wrapper.findAll('[data-test="release-row"]')[1];

			expect(row.find('[data-test="release-grab-button"]').exists()).toBe(true);
			expect(row.find('[data-test="release-pull-button"]').exists()).toBe(false);
		});

		/**
		 * The failure mode the whole shape is designed against. A peer copy reaching
		 * qBittorrent is a magnetless add: nothing is fetched, no error is answered, and
		 * every screen says it was handed over.
		 */
		it('never sends a peer copy to the download client', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/sync/run': { body: { id: 'job-1' } },
			});
			const { wrapper } = await mountWithResult();

			await wrapper.find('[data-test="release-pull-button"]').trigger('click');
			await flushPromises();

			const urls = fetched.mock.calls.map(call => String(call[0]));

			expect(urls.some(url => url.includes('/sync/run'))).toBe(true);
			expect(urls.some(url => url.includes('/releases/grab'))).toBe(false);
		});

		/** And the mirror of it: a magnet names no file the transfer engine could read. */
		it('never sends a tracker release to the transfer machinery', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/releases/grab': { body: { id: 'grab-1', placements: [] } },
			});
			const { wrapper } = await mountWithResult();

			await wrapper.find('[data-test="release-grab-button"]').trigger('click');
			await flushPromises();

			const urls = fetched.mock.calls.map(call => String(call[0]));

			expect(urls.some(url => url.includes('/releases/grab'))).toBe(true);
			expect(urls.some(url => url.includes('/sync/run'))).toBe(false);
		});
	});

	/*
	 * Which tracker a grab comes from.
	 *
	 * The same release usually sits on several, and the row already said so — "on 2
	 * trackers" — while never saying which of the two it would take, nor what it costs
	 * there. On a private tracker that is the difference between a release somebody can
	 * take and one they cannot afford.
	 */
	describe('choosing the tracker', () => {
		const onTwo = () => searchResult({
			suggestions: [
				{
					source: SuggestionSource.INDEXER,
					key: 'grp-1',
					release: group({
						releases: [
							{ ...group().releases[0], id: 'release-1', indexer: 'YGG', seeders: 40, flags: [] },
							{
								...group().releases[0],
								id: 'release-2',
								indexer: 'Sharewood',
								seeders: 12,
								flags: ['freeleech'],
							},
						],
					}),
				},
			],
		});

		it('names the tracker a grab would take, before anybody presses', async () => {
			const { wrapper } = await mountWithResult(onTwo());
			const select = wrapper.findComponent({ name: 'VSelect' });

			// The control's own value is the answer: no opening, no hover, no second line.
			expect(select.props('modelValue')).toBe('release-1');
			expect((select.props('items') as { id: string; indexer: string }[])
				.find(one => one.id === select.props('modelValue'))
				?.indexer).toBe('YGG');
		});

		it('offers every tracker holding it, the chosen one on its face', async () => {
			const { wrapper } = await mountWithResult(onTwo());
			const select = wrapper.findComponent({ name: 'VSelect' });

			expect(select.exists()).toBe(true);
			expect(select.props('modelValue')).toBe('release-1');
			expect((select.props('items') as { id: string }[]).map(one => one.id))
				.toEqual(['release-1', 'release-2']);
		});

		it('grabs the one that was chosen and not the best seeded', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/releases/grab': { body: { id: 'grab-1', placements: [] } },
			});
			const { wrapper } = await mountWithResult(onTwo());

			await wrapper.findComponent({ name: 'VSelect' }).setValue('release-2');
			await wrapper.find('[data-test="release-grab-button"]').trigger('click');
			await flushPromises();

			const [, options] = fetched.mock.calls
				.find(call => String(call[0]).includes('/releases/grab')) ?? [];

			expect(JSON.parse(String((options as RequestInit).body))).toMatchObject({
				releaseId: 'release-2',
			});
		});

		/** And the default is what it always was: the copy the gateway put first. */
		it('takes the best seeded when nobody chose', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/releases/grab': { body: { id: 'grab-1', placements: [] } },
			});
			const { wrapper } = await mountWithResult(onTwo());

			await wrapper.find('[data-test="release-grab-button"]').trigger('click');
			await flushPromises();

			const [, options] = fetched.mock.calls
				.find(call => String(call[0]).includes('/releases/grab')) ?? [];

			expect(JSON.parse(String((options as RequestInit).body))).toMatchObject({
				releaseId: 'release-1',
			});
		});

		it('says what the chosen copy costs on the row itself', async () => {
			const { wrapper } = await mountWithResult(onTwo());

			// Nothing said about the best-seeded one, which carries no flag.
			expect(wrapper.find('[data-test="release-cost"]').exists()).toBe(false);

			await wrapper.findComponent({ name: 'VSelect' }).setValue('release-2');

			expect(wrapper.find('[data-test="release-cost"]').attributes('data-cost')).toBe('free');
		});

		it('says the tracker plainly when there is only one of them', async () => {
			const { wrapper } = await mountWithResult();

			// A select over one option is a control that cannot do anything, on a row that
			// already carries five chips.
			expect(wrapper.findComponent({ name: 'VSelect' }).exists()).toBe(false);
			expect(wrapper.find('[data-test="release-from"]').text()).toContain('prowlarr');
		});
	});

	describe('what it asks for', () => {
		it('says it is looking for a film when the media is one', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/releases/search': { body: searchResult() },
			});
			const { wrapper } = await mountWithResult(
				searchResult(),
				mediaGroup({ id: 'movie-1', kind: MediaKind.MOVIE, seasonNumber: null }),
			);

			await wrapper.find('[data-test="release-search-run"]').trigger('click');
			await flushPromises();

			const search = fetched.mock.calls
				.map(call => String(call[0]))
				.find(url => url.includes('/releases/search'));

			// Without this the search is made of the television categories, answers nothing
			// for every film anybody looks for, and reports no fault at all.
			expect(search).toContain('kind=movie');
		});

		it('says it is looking for a show when the media is one', async () => {
			const fetched = stubFetchRoutes({
				'/releases/downloads': { body: [] },
				'/releases/search': { body: searchResult() },
			});
			const { wrapper } = await mountWithResult();

			await wrapper.find('[data-test="release-search-run"]').trigger('click');
			await flushPromises();

			const search = fetched.mock.calls
				.map(call => String(call[0]))
				.find(url => url.includes('/releases/search'));

			expect(search).toContain('kind=show');
		});

		/** A plan of nothing is a button that answers an empty panel. */
		it('offers to cover the gaps only once a search has found some', async () => {
			const withGaps = await mountWithResult();

			expect(withGaps.wrapper.find('[data-test="release-plan-open"]').exists()).toBe(true);

			const withNone = await mountWithResult(searchResult({ missing: [] }));

			expect(withNone.wrapper.find('[data-test="release-plan-open"]').exists()).toBe(false);
		});
	});
});

function plan (overrides: Partial<CoveragePlan> = {}): CoveragePlan {
	return {
		steps: [
			{
				releaseId: 'release-1',
				title: 'Spartacus.S01.1080p.WEB-DL-GRP',
				kind: ReleaseKind.SEASON_PACK,
				size: 9000,
				seeders: 12,
				covers: [{ itemId: 'our-ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' }],
				partial: true,
			},
		],
		uncovered: [
			{ itemId: 'our-ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' },
			{ itemId: 'our-ep-9', seasonNumber: 1, episodeNumber: 9, title: 'Episode 9' },
		],
		...overrides,
	};
}

describe('components/media/ReleasePlan', () => {
	it('names every episode nothing on offer covers', () => {
		const { wrapper } = mountWithApp(ReleasePlan, { props: { plan: plan() } });

		expect(wrapper.findAll('[data-test="release-plan-uncovered-episode"]')).toHaveLength(2);
	});

	/**
	 * "Two of these are unobtainable" and "two of these are one press away on the list
	 * above" are different sentences, and only the second one is true when a friend has
	 * them. The plan cannot take them — a download client has no use for a peer copy — so
	 * it points at them instead.
	 */
	it('marks an uncovered episode a peer is holding', () => {
		const { wrapper } = mountWithApp(ReleasePlan, {
			props: {
				plan: plan(),
				peers: [copy({ fills: [{ itemId: 'our-ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' }] })],
			},
		});

		const chips = wrapper.findAll('[data-test="release-plan-uncovered-episode"]');

		expect(chips[0].attributes('data-on-peer')).toBe('true');
		// Episode nine is on nobody: marking it too would be the panel lying about a press
		// that would do nothing.
		expect(chips[1].attributes('data-on-peer')).toBe('false');
		expect(wrapper.find('[data-test="release-plan-uncovered-peer"]').exists()).toBe(true);
	});

	it('says nothing about peers when none of the uncovered is on one', () => {
		const { wrapper } = mountWithApp(ReleasePlan, {
			props: { plan: plan(), peers: [copy({ fills: [] })] },
		});

		expect(wrapper.find('[data-test="release-plan-uncovered-peer"]').exists()).toBe(false);
	});
});
