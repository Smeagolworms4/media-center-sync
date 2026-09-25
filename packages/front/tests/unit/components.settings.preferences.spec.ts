import type { MediaCategory, ReleasePreferenceSettings } from '@mcs/shared';
import {
	LibraryKind,
	NamingScheme,
	PlacementStrategy,
	ReleasePreferenceDimension,
	RequestSourceType,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ReleasePreferences from '@/components/settings/ReleasePreferences.vue';
import Settings from '@/pages/Settings.vue';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * Saying once, on one screen, which of forty copies the household actually wants.
 *
 * Everything here is about a sentence being sayable and surviving the trip to the
 * gateway, because every way this feature fails is silent: a search still comes back
 * looking ordered when the order was dropped, an override that was cancelled still looks
 * cancelled when what was saved is "order by nothing", and a key cleared by somebody
 * editing an address beside it only surfaces as a request list that has gone empty.
 *
 * The assertions are on `data-test` attributes and on what is sent, never on displayed
 * text: the catalogues are merged by somebody else and these components legitimately
 * render raw keys here.
 */
async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function category (key: string, name: string, position: number): MediaCategory {
	return {
		key,
		name,
		kind: LibraryKind.MOVIES,
		position,
		libraryIds: [`l-${key}`],
		serviceIds: ['s1'],
		itemCount: 4,
		local: true,
	};
}

const CATEGORIES = [category('films', 'Films', 0), category('series', 'Séries', 1)];

/** Resolution first, then codec: the order between the two is half of the setting. */
const ORDERED: ReleasePreferenceSettings = {
	global: {
		ranks: [
			{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] },
			{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
		],
	},
	byCategory: {},
};

function mountPane (settings: ReleasePreferenceSettings = ORDERED, trackers: string[] = []) {
	return mountWithApp(ReleasePreferences, {
		props: { modelValue: settings, categories: CATEGORIES, trackers },
		global: { stubs: { ...tooltipStub, ...dialogStub } },
	});
}

/** What the add field under one dimension offers beside whatever somebody types. */
function suggestionsUnder (
	wrapper: ReturnType<typeof mountPane>['wrapper'],
	dimension: ReleasePreferenceDimension,
): string[] {
	const field = wrapper.findAllComponents({ name: 'VCombobox' }).find(
		one => one.attributes('data-test') === `release-preferences-add-value-global-${dimension}`,
	);

	return ((field?.props('items') ?? []) as string[]);
}

/** The last order the pane handed back, which is what the page would save. */
function written (wrapper: ReturnType<typeof mountPane>['wrapper']): ReleasePreferenceSettings {
	const emitted = wrapper.emitted('update:modelValue') ?? [];

	expect(emitted.length).toBeGreaterThan(0);

	return emitted.at(-1)?.[0] as ReleasePreferenceSettings;
}

describe('components/settings/ReleasePreferences', () => {
	it('moves a dimension and hands back the order that produced', async () => {
		// The ordering is between dimensions as much as inside one: codec above
		// resolution says a 720p x265 beats a 1080p x264, which is the opposite sentence
		// and has to be sayable.
		const { wrapper } = mountPane();

		await wrapper.find('[data-test="release-preferences-down-global-resolution"]').trigger('click');

		expect(written(wrapper).global.ranks.map(one => one.dimension)).toEqual([
			ReleasePreferenceDimension.CODEC,
			ReleasePreferenceDimension.RESOLUTION,
		]);
	});

	it('leaves the values inside a moved dimension exactly as they were', async () => {
		// A move that reshuffled the values would be a control that changes two things
		// and reports one.
		const { wrapper } = mountPane();

		await wrapper.find('[data-test="release-preferences-down-global-resolution"]').trigger('click');

		expect(written(wrapper).global.ranks.find(
			one => one.dimension === ReleasePreferenceDimension.RESOLUTION,
		)?.values).toEqual(['1080p', '2160p']);
	});

	it('promotes one value within a dimension without touching the others', async () => {
		const { wrapper } = mountPane();

		await wrapper.find('[data-test="release-preferences-promote-global-resolution-1"]').trigger('click');

		expect(written(wrapper).global.ranks[0].values).toEqual(['2160p', '1080p']);
	});

	it('gives a category an order of its own, started as a copy of the household one', async () => {
		// A copy and not a blank pane: overriding means "like that, but". Starting empty
		// would make the commonest edit a retyping of everything already said, and a
		// half-finished retyping is an order that silently differs from its model.
		const { wrapper } = mountPane();
		const select = wrapper
			.findAllComponents({ name: 'VSelect' })
			.find(one => one.attributes('data-test') === 'release-preferences-add-override');

		select?.vm.$emit('update:modelValue', 'films');
		await settle(2);

		const next = written(wrapper);

		expect(next.byCategory.films.ranks).toEqual(ORDERED.global.ranks);
		// Copied, not shared: changing the household order later must not reach into it,
		// which is what makes cancelling the override an exact undo.
		expect(next.byCategory.films.ranks[0].values).not.toBe(ORDERED.global.ranks[0].values);
	});

	it('shows a category’s own order beside the household one, said to be that category’s', async () => {
		// "La catégorie ça se configure au même endroit que le global": the override is
		// not a screen of its own, and its pane says which category it is for.
		const { wrapper } = mountPane({
			global: ORDERED.global,
			byCategory: { films: { ranks: [] } },
		});

		expect(wrapper.find('[data-test="release-preferences-pane-global"]').attributes('data-scope'))
			.toBe('global');
		expect(wrapper.find('[data-test="release-preferences-pane-films"]').attributes('data-scope'))
			.toBe('category');
	});

	it('cancels an override back to following the household order, not to ordering by nothing', async () => {
		/*
		 * The two sentences this pane exists to keep apart. A missing key says "I have no
		 * override, use the one above"; a preference with no values says "here, order by
		 * nothing", which is how one shelf opts out of a household order that is wrong for
		 * it. Cancelling that left `{ ranks: [] }` behind would silence the household
		 * order for that category for ever, and the screen would look identical.
		 */
		const { wrapper } = mountPane({
			global: ORDERED.global,
			byCategory: { films: { ranks: [{ dimension: ReleasePreferenceDimension.CODEC, values: ['x264'] }] } },
		});

		await wrapper.find('[data-test="release-preferences-cancel-films"]').trigger('click');

		expect(written(wrapper).byCategory).not.toHaveProperty('films');
	});

	it('keeps a category’s override whose category nothing is reporting right now', async () => {
		// A shelf disappears the moment a media server goes offline. An override hidden
		// because its category is briefly missing is one nobody can cancel on the day it
		// is in the way.
		const { wrapper } = mountPane({
			global: ORDERED.global,
			byCategory: { animes: { ranks: [] } },
		});

		expect(wrapper.find('[data-test="release-preferences-pane-animes"]').exists()).toBe(true);
	});

	it('adds a dimension with no values, which is a dimension deliberately silenced', async () => {
		const { wrapper } = mountPane({
			global: ORDERED.global,
			byCategory: { films: { ranks: [] } },
		});

		await wrapper.find('[data-test="release-preferences-add-films-resolution"]').trigger('click');

		expect(written(wrapper).byCategory.films.ranks).toEqual([
			{ dimension: ReleasePreferenceDimension.RESOLUTION, values: [] },
		]);
	});

	it('says so when an order separates nothing, rather than showing an empty list', async () => {
		const { wrapper } = mountPane({ global: { ranks: [] }, byCategory: {} });

		expect(wrapper.find('[data-test="release-preferences-none-global"]').exists()).toBe(true);
	});
});

/**
 * The stored settings, as the gateway answers them.
 *
 * Only the keys the page reads: the store fills the rest from the answer and the page
 * falls back to the shipped defaults for anything missing, which is also what a gateway
 * running an older image does.
 */
const STORED = {
	placement: PlacementStrategy.BESIDE_EXISTING,
	fixedPath: null,
	categoryTargets: {},
	defaultTargetLibraryId: null,
	namingOrder: [NamingScheme.SOURCE, NamingScheme.STANDARD],
	pullMetadata: true,
	writeNfo: false,
	preferSourceMetadata: false,
	maxParallelTransfers: 2,
	maxConnectionsPerSource: 4,
	chunkSize: 4_194_304,
	downloadRateLimit: 0,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	peerMaxDepth: 3,
	keepDiscoveredPeers: false,
	relayForPeers: false,
	allowSwarm: true,
	instanceName: null,
	publicUrl: null,
	defaultTargetPath: null,
	transferHistoryDays: 30,
	failedHistoryDays: 180,
	refreshIntervalMinutes: 15,
	fullScanCron: null,
	cacheTtlSeconds: 60,
	releasePreferences: ORDERED,
	indexer: null,
	downloadClient: null,
	requestSource: null,
};

async function mountPage (settings: Record<string, unknown> = STORED) {
	const stub = stubFetchRoutes({ '/api/settings': { body: settings } });
	const { wrapper } = mountWithApp(Settings, {
		global: { stubs: { ...tooltipStub, ...dialogStub } },
	});

	await settle();

	return { wrapper, stub };
}

/** The body of the save, which is the only thing the gateway ever sees of this screen. */
function saved (stub: Awaited<ReturnType<typeof mountPage>>['stub']): Record<string, any> {
	const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');

	expect(patch).toBeDefined();

	return JSON.parse(String(patch?.[1]?.body));
}

describe('pages/Settings: the search order', () => {
	it('has a tab of its own, which is where it was asked for', async () => {
		// "Un onglet dédié dans mes préférences". It is also the only workable place: an
		// order over five dimensions and one pane per category cannot hang below two
		// addresses and a list of path mappings.
		const { wrapper } = await mountPage();

		expect(wrapper.find('[data-test="settings-tab-preferences"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="release-preferences"]').exists()).toBe(true);
	});

	it('saves the order a move produced, and nothing else', async () => {
		const { wrapper, stub } = await mountPage();

		await wrapper.find('[data-test="release-preferences-down-global-resolution"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		const body = saved(stub);

		expect(body.releasePreferences.global.ranks.map((one: any) => one.dimension)).toEqual([
			ReleasePreferenceDimension.CODEC,
			ReleasePreferenceDimension.RESOLUTION,
		]);
		// The API writes a row for every key a PATCH carries, and a row for a value
		// nobody chose pins a default this gateway can never drop.
		expect(body).not.toHaveProperty('namingOrder');
	});

	it('saves a rank with no values rather than dropping it on the way out', async () => {
		// It is the sentence "no opinion here", and it only exists if it survives a
		// round trip: dropped at save time, the row would come back ranked by the
		// household order and nothing would say why.
		const { wrapper, stub } = await mountPage();

		await wrapper.find('[data-test="release-preferences-add-global-team"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		expect(saved(stub).releasePreferences.global.ranks).toContainEqual({
			dimension: ReleasePreferenceDimension.TEAM,
			values: [],
		});
	});

	it('sends both halves of the setting, because the row is replaced and not merged', async () => {
		// A patch carrying `global` alone is refused by the API: stored, it would come
		// back with no category table at all and the next search would throw on the first
		// category lookup.
		const { wrapper, stub } = await mountPage();

		await wrapper.find('[data-test="release-preferences-down-global-resolution"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		expect(saved(stub).releasePreferences).toHaveProperty('byCategory');
	});

	it('does not send the order when it was only looked at', async () => {
		/*
		 * The page sends what changed, and this setting is the one most likely to break
		 * that: it is a nested object, so a baseline holding the store's own would compare
		 * equal to the edit and report nothing changed — and a copy rebuilt on every read
		 * would compare unequal and write the row on every unrelated save, pinning an
		 * order nobody chose where a key with no row would have followed the default.
		 */
		const { wrapper, stub } = await mountPage();

		await (wrapper.vm as any).form.handle();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');

		// A patch may still be sent for the address this screen suggests — see
		// `publicUrlSuggested`, where saving is what accepts it — so the claim is about
		// this key and not about the request.
		expect(patch === undefined || !(JSON.parse(String(patch[1]?.body)) as Record<string, unknown>)
			.releasePreferences).toBe(true);
	});
});

describe('pages/Settings: the request source', () => {
	const stored = {
		...STORED,
		requestSource: {
			type: RequestSourceType.SEERR,
			baseUrl: 'http://jellyseerr:5055',
			// Exactly what the gateway answers: never the key, only the fact of one.
			apiKey: null,
			hasApiKey: true,
			enabled: true,
		},
	};

	it('is on the screen at all, beside the two sources that move bytes', async () => {
		const { wrapper } = await mountPage();

		expect(wrapper.find('[data-test="settings-request-source"]').exists()).toBe(true);
	});

	it('never shows the stored key back, and says one is held', async () => {
		const { wrapper } = await mountPage(stored);

		expect((wrapper.vm as any).model.requestApiKey).toBe('');
		expect((wrapper.vm as any).model.requestHasKey).toBe(true);
	});

	it('keeps the stored key when the box is left blank', async () => {
		// The commonest edit on this pane is correcting the address, and the box beside it
		// is blank because the gateway cannot show what it holds. Taking that literally
		// would unauthenticate a working Seerr, and the only symptom would be a request
		// list that has gone empty.
		const { wrapper, stub } = await mountPage(stored);

		(wrapper.vm as any).model.requestUrl = 'https://seerr.local:5055';
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		const body = saved(stub);

		expect(body.requestSource.baseUrl).toBe('https://seerr.local:5055');
		expect(body.requestSource).not.toHaveProperty('apiKey');
	});

	it('sends a key that was actually typed', async () => {
		const { wrapper, stub } = await mountPage(stored);

		(wrapper.vm as any).model.requestApiKey = 'typed';
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		expect(saved(stub).requestSource.apiKey).toBe('typed');
	});

	it('turns the source off without forgetting where it was', async () => {
		// The switch and the address are two different statements: one says "do not read
		// it for now", the other says "there is nowhere to read".
		const { wrapper, stub } = await mountPage(stored);

		(wrapper.vm as any).model.requestEnabled = false;
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		const body = saved(stub);

		expect(body.requestSource.enabled).toBe(false);
		expect(body.requestSource.baseUrl).toBe('http://jellyseerr:5055');
	});

	it('clears the source when the address is emptied, rather than saving half of one', async () => {
		// A half-filled object would be a source the gateway believes in and cannot read,
		// which fails when somebody opens the requests screen rather than when they saved.
		const { wrapper, stub } = await mountPage(stored);

		(wrapper.vm as any).model.requestUrl = '';
		await settle(2);
		await (wrapper.vm as any).form.handle();
		await settle();

		expect(saved(stub).requestSource).toBeNull();
	});

	/*
	 * The one dimension whose values cannot be shipped in a table.
	 *
	 * A tracker's name belongs to the household, and typing it is a guess: `Generation-Free`
	 * written for `Generation-Free (API)` matches nothing, orders nothing, and no screen
	 * says so. They are read from the indexer this gateway searches and offered.
	 */
	it('offers the trackers the gateway actually reaches', () => {
		const ranked: ReleasePreferenceSettings = {
			global: { ranks: [{ dimension: ReleasePreferenceDimension.INDEXER, values: [] }] },
			byCategory: {},
		};
		const { wrapper } = mountPane(ranked, ['C411', 'Generation-Free (API)']);

		expect(suggestionsUnder(wrapper, ReleasePreferenceDimension.INDEXER))
			.toEqual(['C411', 'Generation-Free (API)']);
	});

	it('offers none when no indexer is configured, and still takes a typed one', () => {
		const ranked: ReleasePreferenceSettings = {
			global: { ranks: [{ dimension: ReleasePreferenceDimension.INDEXER, values: [] }] },
			byCategory: {},
		};
		const { wrapper } = mountPane(ranked, []);

		expect(suggestionsUnder(wrapper, ReleasePreferenceDimension.INDEXER)).toEqual([]);
		// Still a combobox and not a select: a household with no indexer configured yet can
		// write the order it intends to use.
		const hook = `release-preferences-add-value-global-${ReleasePreferenceDimension.INDEXER}`;

		expect(wrapper.findAllComponents({ name: 'VCombobox' })
			.some(one => one.attributes('data-test') === hook)).toBe(true);
	});

	it('does not offer a tracker already in the order', () => {
		const ranked: ReleasePreferenceSettings = {
			global: {
				ranks: [{ dimension: ReleasePreferenceDimension.INDEXER, values: ['C411'] }],
			},
			byCategory: {},
		};
		const { wrapper } = mountPane(ranked, ['C411', 'Generation-Free (API)']);

		expect(suggestionsUnder(wrapper, ReleasePreferenceDimension.INDEXER))
			.toEqual(['Generation-Free (API)']);
	});
});
