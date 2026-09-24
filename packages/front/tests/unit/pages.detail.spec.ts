import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
	SyncState,
	SyncTrigger,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import LibraryItem from '@/pages/LibraryItem.vue';
import Peer from '@/pages/Peer.vue';
import Service from '@/pages/Service.vue';
import SettingsShares from '@/pages/SettingsShares.vue';
import SyncPlan from '@/pages/SyncPlan.vue';
import Transfers from '@/pages/Transfers.vue';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

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
	name: 'Bob’s Jellyfin',
	type: MediaServiceType.JELLYFIN,
	shared: true,
	filesMounted: false,
	baseUrl: 'http://10.0.0.9:8096',
	status: MediaServiceStatus.ONLINE,
	version: '10.9',
	authProvider: false,
	priority: 5,
	peerId: 'p1',
	lastProbeAt: null,
	lastScanAt: null,
	libraryCount: 1,
	itemCount: 10,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Shows',
	kind: LibraryKind.SHOWS,
	paths: ['/data/shows'],
	localPath: '/media/shows',
	writable: false,
	isDefaultTarget: false,
	itemCount: 12,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function mediaItem (overrides: Record<string, unknown> = {}) {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.SERIES,
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: 'Belters.',
		artworkUrl: null,
		companions: null,
		file: null,
		quality: null,
		addedAt: null,
		sync: SyncState.OUTDATED,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function mediaGroup (overrides: Record<string, unknown> = {}) {
	return {
		id: 'm1',
		kind: MediaKind.SERIES,
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: 'Belters.',
		artworkItemId: null,
		sync: SyncState.OUTDATED,
		quality: null,
		sources: [{
			itemId: 'm1',
			serviceId: 's1',
			serviceName: 'Bob\u2019s Jellyfin',
			serviceType: MediaServiceType.JELLYFIN,
			shared: true,
			filesMounted: false,
			peerId: 'p1',
			peerName: 'Bob',
			quality: null,
			companions: null,
			bytes: 1024,
			local: false,
			sync: SyncState.IN_SYNC,
		}],
		childCount: 2,
		missingCount: 1,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

describe('pages/LibraryItem', () => {
	const routes = {
		'/api/media/groups/m1/children': {
			body: {
				items: [
					mediaGroup({ id: 'm2', kind: MediaKind.EPISODE, title: 'Dulcinea', seasonNumber: 1, episodeNumber: 1, sync: SyncState.IN_SYNC, missingCount: 0 }),
					mediaGroup({ id: 'm3', kind: MediaKind.EPISODE, title: 'The Big Empty', seasonNumber: 1, episodeNumber: 2, sync: SyncState.MISSING, missingCount: 0 }),
				],
				pagination: { page: 1, limit: 200, total: 2, pages: 1 },
			},
		},
		'/api/media/groups/m1': { body: mediaGroup() },
		// The representative's own index row, which is where the corrections live: a group
		// is the merged view and carries none of them.
		'/api/media/m1': { body: mediaItem() },
		'/api/media/m1/matches': { body: [] },
		'/api/libraries': { body: [library] },
		'/api/services': { body: [service] },
		'/api/peers': { body: [] },
		'/api/sync/run': { body: { id: 'j1' } },
		'/api/sync/plans/for-item/m1': {
			body: { suggestedName: 'The Expanse', covering: [], extendable: [] },
		},
		'/api/sync/plans/for-item': { body: { id: 'plan-1', name: 'The Expanse' } },
		'/api/sync/estimate': {
			body: {
				itemCount: 2,
				bytes: 3_000_000_000,
				unbounded: false,
				truncated: false,
				computedAt: '2026-02-01T00:00:00.000Z',
			},
		},
	};

	/** The whole point of the page: what is missing is listed, not hidden. */
	it('lists the missing children beside the ones we hold, and marks them as missing', async () => {
		stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const rows = wrapper.findAll('[data-test="media-row"]');
		expect(rows).toHaveLength(2);
		const missing = rows.find(row => row.attributes('data-state') === SyncState.MISSING);
		expect(missing?.classes()).toContain('media-row--missing');
	});

	it('offers to pull everything missing below the item', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('[data-test="item-sync-missing"]').exists()).toBe(true);
		await wrapper.find('[data-test="item-sync-missing"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(run).toBeDefined();
		expect(JSON.parse(String(run?.[1]?.body))).toMatchObject({
			scope: { rootItemIds: ['m1'] },
			filter: { missingOnly: true },
		});
	});

	/** Every copy, ours marked, is the difference between this page and a list row. */
	it('lists every server that holds the media, and lets one be chosen for the run', async () => {
		stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('[data-test="source-picker"]').exists()).toBe(true);
		expect(wrapper.findAll('[data-test="group-source"]')).toHaveLength(1);
		expect(wrapper.text()).toContain('Bob\u2019s Jellyfin');
		expect(wrapper.text()).toContain('Follow the configured priority');
	});

	/**
	 * The requirement, end to end: several versions kept, and several pulled.
	 *
	 * One version could be chosen and one only, so a household that wanted the extended
	 * cut *and* the theatrical one had to run two syncs and hope the second did not land
	 * on the first.
	 */
	it('fetches the exact copy a row names, and leaves the button above it alone', async () => {
		const twoVersions = mediaGroup({
			// A film, because a container has no file of its own and its fetch button
			// means something else entirely — see the show case below.
			kind: MediaKind.MOVIE,
			sources: [
				{
					itemId: 'copy-theatrical',
					serviceId: 's1',
					serviceName: 'Bob\u2019s Jellyfin',
					serviceType: MediaServiceType.JELLYFIN,
					shared: true,
					filesMounted: false,
					peerId: 'p1',
					peerName: 'Bob',
					quality: null,
					companions: null,
					bytes: 1024,
					versionId: 'q1-theatrical',
					edition: null,
					local: false,
					sync: SyncState.MISSING,
				},
				{
					itemId: 'copy-extended',
					serviceId: 's1',
					serviceName: 'Bob\u2019s Jellyfin',
					serviceType: MediaServiceType.JELLYFIN,
					shared: true,
					filesMounted: false,
					peerId: 'p1',
					peerName: 'Bob',
					quality: null,
					companions: null,
					bytes: 4096,
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					local: false,
					sync: SyncState.MISSING,
				},
			],
			versions: [
				{
					versionId: 'q1-theatrical',
					edition: null,
					quality: null,
					bytes: 1024,
					heldLocally: false,
					sourceItemIds: ['copy-theatrical'],
				},
				{
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					quality: null,
					bytes: 4096,
					heldLocally: false,
					sourceItemIds: ['copy-extended'],
				},
			],
		});

		const stub = stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: twoVersions } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const buttons = wrapper.findAll('[data-test="group-source-download"]');
		expect(buttons).toHaveLength(2);

		// Both cuts are on the same server, so the choice cannot be said in service
		// identifiers — it is said by which row was pressed.
		await buttons[1].trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(JSON.parse(String(run?.[1]?.body))).toMatchObject({
			scope: { itemIds: ['copy-extended'] },
		});

		// And nothing above the list offers a second way to say it: a transfer is about a
		// copy, the header never knew which one, and two controls answering the same
		// question is how the two answers end up disagreeing.
		expect(wrapper.find('[data-test="item-sync"]').exists()).toBe(false);
	});

	it('offers no fetch above the list at all, whatever the media', async () => {
		// The header button planned a run with no work in it on a media only we hold and
		// answered with "a sync has started", which teaches people that a button can
		// report success for having done nothing. Fetching now lives on the row that
		// knows which copy it is about.
		const ours = mediaGroup({
			sources: [
				{
					itemId: 'copy-ours',
					serviceId: 's1',
					serviceName: 'MisaMisa',
					serviceType: MediaServiceType.JELLYFIN,
					shared: false,
					filesMounted: true,
					peerId: null,
					peerName: null,
					quality: null,
					companions: null,
					bytes: 4096,
					versionId: 'q1-ours',
					edition: null,
					local: true,
					path: '/media/animes/Pompoko.mkv',
					sync: SyncState.LOCAL_ONLY,
				},
			],
			versions: [
				{
					versionId: 'q1-ours',
					edition: null,
					quality: null,
					bytes: 4096,
					heldLocally: true,
					sourceItemIds: ['copy-ours'],
				},
			],
		});

		stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: ours } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('[data-test="item-sync"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="group-source-download"]').exists()).toBe(false);
	});

	it('fetches the gaps of a whole show from the server the row names', async () => {
		/*
		 * A series is a folder and the planner refuses anything carrying no file, so
		 * pressing fetch on a show answered "a sync has started" and planned nothing —
		 * the owner watched it happen on Spartacus. Expanding the container into its
		 * episodes is what makes the button do anything at all.
		 *
		 * Only the episodes no copy is held of. This asked for the whole show for a
		 * while, on the reasoning that naming a server names it for everything under the
		 * folder, and it was wrong in the only way that matters: a show of six seasons
		 * with one missing planned all six, so the queue filled with episodes already on
		 * the disk and the gap somebody wanted came last. What arrived overnight was
		 * season one, again.
		 */
		const show = mediaGroup({
			kind: MediaKind.SERIES,
			sources: [
				{
					itemId: 'copy-theirs',
					serviceId: 's2',
					serviceName: 'plex',
					serviceType: MediaServiceType.PLEX,
					shared: false,
					filesMounted: false,
					peerId: null,
					peerName: null,
					quality: null,
					companions: null,
					bytes: null,
					versionId: null,
					edition: null,
					local: false,
					path: null,
					sync: SyncState.MISSING,
				},
			],
			versions: [],
		});

		const stub = stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: show } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="group-source-download"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));

		expect(JSON.parse(String(run?.[1]?.body))).toMatchObject({
			scope: { rootItemIds: ['m1'] },
			filter: { missingOnly: true },
			sourceServiceIds: ['s2'],
		});
	});

	it('names the file before erasing it, and only erases once somebody agrees', async () => {
		/*
		 * The one action in this product that destroys something no scan can bring back,
		 * so the test is about the asking as much as the erasing: the path has to be on
		 * screen, and nothing may be called until the second button is pressed.
		 */
		const ours = mediaGroup({
			sources: [
				{
					itemId: 'copy-ours',
					serviceId: 's1',
					serviceName: 'MisaMisa',
					serviceType: MediaServiceType.JELLYFIN,
					shared: false,
					filesMounted: true,
					peerId: null,
					peerName: null,
					quality: null,
					companions: null,
					bytes: 4096,
					versionId: 'q1-ours',
					edition: null,
					local: true,
					path: '/media/animes/Death Note/Saison 1/S01E01.mkv',
					sync: SyncState.IN_SYNC,
				},
			],
			versions: [
				{
					versionId: 'q1-ours',
					edition: null,
					quality: null,
					bytes: 4096,
					heldLocally: true,
					sourceItemIds: ['copy-ours'],
				},
			],
		});

		const stub = stubFetchRoutes({
			...routes,
			'/api/media/groups/m1': { body: ours },
			'/api/media/copy-ours/file': { body: { path: '/mnt/media/animes/Death Note/Saison 1/S01E01.mkv' } },
		});
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="group-source-delete"]').trigger('click');
		await settle();

		// The server's own spelling, because that is the one somebody recognises from
		// their Jellyfin.
		expect(wrapper.find('[data-test="delete-path"]').text())
			.toBe('/media/animes/Death Note/Saison 1/S01E01.mkv');
		expect(stub.mock.calls.some(call => String(call[0]).includes('/file'))).toBe(false);

		await wrapper.find('[data-test="delete-accept"]').trigger('click');
		await settle();

		const erased = stub.mock.calls.find(call => String(call[0]).includes('/api/media/copy-ours/file'));

		expect(erased).toBeDefined();
		expect(erased?.[1]?.method).toBe('DELETE');
	});

	it('erases nothing when somebody backs out of the confirmation', async () => {
		const ours = mediaGroup({
			sources: [
				{
					itemId: 'copy-ours',
					serviceId: 's1',
					serviceName: 'MisaMisa',
					serviceType: MediaServiceType.JELLYFIN,
					shared: false,
					filesMounted: true,
					peerId: null,
					peerName: null,
					quality: null,
					companions: null,
					bytes: 4096,
					versionId: 'q1-ours',
					edition: null,
					local: true,
					path: '/media/animes/Death Note/Saison 1/S01E01.mkv',
					sync: SyncState.IN_SYNC,
				},
			],
			versions: [
				{
					versionId: 'q1-ours',
					edition: null,
					quality: null,
					bytes: 4096,
					heldLocally: true,
					sourceItemIds: ['copy-ours'],
				},
			],
		});

		const stub = stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: ours } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="group-source-delete"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="delete-cancel"]').trigger('click');
		await settle();

		expect(wrapper.find('[data-test="delete-confirm"]').exists()).toBe(false);
		expect(stub.mock.calls.some(call => String(call[0]).includes('/file'))).toBe(false);
	});

	it('shows the seasons of a series as cards, each with what is missing under it', async () => {
		stubFetchRoutes({
			...routes,
			'/api/media/groups/m1/children': {
				body: {
					items: [mediaGroup({ id: 'm2', kind: MediaKind.SEASON, title: 'Season 1', seasonNumber: 1, missingCount: 3 })],
					pagination: { page: 1, limit: 200, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const cards = wrapper.findAll('[data-test="media-card"]');
		expect(cards).toHaveLength(1);
		expect(cards[0].find('[data-test="media-missing-count"]').text()).toContain('3 missing');
	});

	/**
	 * Never inspected and inspected-and-empty are different answers with different
	 * remedies, and the page has to offer the right one.
	 */
	it('offers a scan when what sits beside the file has never been read', async () => {
		const stub = stubFetchRoutes({ ...routes, '/api/services/s1/scan': {} });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const block = wrapper.find('[data-test="item-companions"]');
		expect(block.find('[data-test="companion-marks"]').attributes('data-state')).toBe('unknown');

		await block.find('[data-test="item-companions-scan"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).includes('/api/services/s1/scan'))).toBe(true);
	});

	it('shows what sits beside the file once it has been read, and offers no scan', async () => {
		stubFetchRoutes({
			...routes,
			'/api/media/groups/m1': {
				body: mediaGroup({
					sources: [{
						itemId: 'm1',
						serviceId: 's1',
						serviceName: 'Bob\u2019s Jellyfin',
						serviceType: MediaServiceType.JELLYFIN,
						shared: true,
						filesMounted: false,
						peerId: null,
						peerName: null,
						quality: null,
						companions: {
							nfo: true,
							poster: false,
							fanart: false,
							subtitles: 0,
							missing: ['poster.jpg'],
							checkedAt: '2026-02-01T00:00:00.000Z',
						},
						bytes: 1024,
						local: true,
						sync: SyncState.IN_SYNC,
					}],
				}),
			},
		});
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const block = wrapper.find('[data-test="item-companions"]');
		expect(block.find('[data-test="companion-marks"]').attributes('data-state')).toBe('incomplete');
		expect(block.text()).toContain('poster.jpg');
		expect(block.find('[data-test="item-companions-scan"]').exists()).toBe(false);
	});

	/**
	 * Four levels down, the way back out has to be on the screen: the category a media
	 * belongs to is nowhere on the item itself, and the browser's own button walks the
	 * history rather than the tree.
	 */
	it('says where the media sits, from the category down, with every step clickable', async () => {
		stubFetchRoutes({
			...routes,
			'/api/libraries/categories': {
				body: [{
					key: 'shows',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					position: 0,
					libraryIds: ['l1'],
					serviceIds: ['s1'],
					itemCount: 12,
					local: true,
				}],
			},
			'/api/media/groups/series-1': {
				body: mediaGroup({ id: 'series-1', title: 'The Expanse', parentId: null }),
			},
			'/api/media/groups/m1': {
				body: mediaGroup({
					id: 'm1',
					kind: MediaKind.SEASON,
					title: 'Season 1',
					parentId: 'series-1',
				}),
			},
		});
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const trail = wrapper.find('[data-test="media-breadcrumb"]');
		expect(trail.exists()).toBe(true);
		expect(trail.findAll('[data-test="media-breadcrumb-step"]').map(one => one.text()))
			.toEqual(['Library', 'Shows', 'The Expanse']);
		// The step somebody is on is not a link that goes nowhere.
		expect(trail.find('[data-test="media-breadcrumb-current"]').text()).toBe('Season 1');
		expect(trail.findAll('[data-test="media-breadcrumb-step"]')[1].attributes('href'))
			.toContain('category=shows');
	});

	/**
	 * A copy on a friend's server and one on somebody their friend introduced are not
	 * the same offer, and this list is where a pull is chosen from.
	 */
	it('says how far away each copy is, friends of friends included', async () => {
		stubFetchRoutes({
			...routes,
			'/api/peers': {
				body: [{
					id: 'p1',
					name: 'Bob',
					nodeId: null,
					fingerprint: 'AB',
					status: PeerStatus.LINKED,
					direction: null,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					readingForbidden: false,
					linkMode: null,
					address: null,
					viaPeerId: 'p0',
					viaPeerName: 'Alice',
					serviceCount: 1,
					sharedItemCount: 3,
					lastSeenAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
			},
		});
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const origin = wrapper.find('[data-test="group-source-origin"]');
		expect(origin.attributes('data-origin')).toBe('friend_of_friend');
		expect(origin.text()).toContain('Friends of friends');
	});

	/**
	 * The owner's complaint, answered: a plan is made from the thing on screen.
	 *
	 * Everything below is about the two ways that goes wrong. A screen that offers one
	 * button and silently picks which of the two intents it meant sends somebody home
	 * with a nightly schedule they did not ask for, or with nothing at all; and a plan
	 * nobody can navigate back to is a plan nobody edits.
	 */
	describe('keeping it in sync from the card', () => {
		async function openKeep (group: Record<string, unknown> = mediaGroup()) {
			const stub = stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: group } });
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();
			await wrapper.find('[data-test="item-keep"]').trigger('click');
			await settle();
			return { wrapper, stub };
		}

		it('offers the control on the series card and on the season card', async () => {
			for (const kind of [MediaKind.SERIES, MediaKind.SEASON]) {
				stubFetchRoutes({ ...routes, '/api/media/groups/m1': { body: mediaGroup({ kind }) } });
				const { wrapper } = mountWithApp(LibraryItem, {
					props: { itemId: 'm1' },
					global: { stubs: { ...tooltipStub, ...dialogStub } },
				});
				await settle();

				expect(wrapper.find('[data-test="item-keep"]').exists(), kind).toBe(true);
			}
		});

		/**
		 * A film is finished. "Keep this film in step for ever" is a schedule that finds
		 * nothing every night, and offering it teaches people that plans do nothing.
		 */
		it('does not offer it on a film, which has nothing to keep up with', async () => {
			stubFetchRoutes({
				...routes,
				'/api/media/groups/m1': { body: mediaGroup({ kind: MediaKind.MOVIE }) },
			});
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();

			expect(wrapper.find('[data-test="item-keep"]').exists()).toBe(false);
		});

		it('says what the plan would cover before anything is created', async () => {
			const { wrapper } = await openKeep();

			const estimate = wrapper.find('[data-test="keep-estimate"]');
			expect(estimate.text()).toContain('2 items to pull');
			expect(estimate.text()).toContain('2.8 GB');
		});

		/**
		 * No figure is never a shrug.
		 *
		 * A gateway with no library it can write into used to be answered "Nobody has
		 * worked out what this comes to", while the refusal behind it named the reason
		 * exactly. The sentence now says what is missing and where to add it.
		 */
		it('says there is nowhere to land, and where to add somewhere, when that is why', async () => {
			stubFetchRoutes({
				...routes,
				'/api/sync/estimate': {
					status: 409,
					body: { statusCode: 409, message: 'error.library.path_not_writable', error: 'Conflict' },
				},
			});
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();
			await wrapper.find('[data-test="item-keep"]').trigger('click');
			await settle();

			const estimate = wrapper.find('[data-test="keep-estimate"]');

			expect(estimate.text()).toContain('no library this gateway can write into');
			expect(estimate.text()).toContain('Media services');
			expect(estimate.text()).not.toContain('Nobody has worked out');
			expect(wrapper.find('[data-test="keep-estimate-open-services"]').exists()).toBe(true);
		});

		it('names any other reason in the catalogue’s own words', async () => {
			stubFetchRoutes({
				...routes,
				'/api/sync/estimate': {
					status: 404,
					body: { statusCode: 404, message: 'error.media.not_found', error: 'Not Found' },
				},
			});
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();
			await wrapper.find('[data-test="item-keep"]').trigger('click');
			await settle();

			const failed = wrapper.find('[data-test="keep-estimate-failed"]');

			expect(failed.text()).toContain('could not work out what this comes to');
			expect(failed.text()).toContain('This media item no longer exists.');
			expect(wrapper.find('[data-test="keep-estimate-open-services"]').exists()).toBe(false);
		});

		it('creates a plan on the subtree, named after the show, with the trigger chosen', async () => {
			const { wrapper, stub } = await openKeep();

			await wrapper.find('[data-test="keep-create"]').trigger('click');
			await settle();

			const call = stub.mock.calls.find(one =>
				String(one[0]).includes('/api/sync/plans/for-item') && one[1]?.method === 'POST');

			expect(call).toBeDefined();
			expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
				itemId: 'm1',
				name: 'The Expanse',
				// Manual is what the field opens on: a schedule nobody picked is a
				// gateway downloading at four in the morning.
				trigger: SyncTrigger.MANUAL,
				schedule: null,
			});
		});

		/**
		 * The two intents, told apart by the screen rather than by the person.
		 *
		 * "Get the missing episodes of this season" is a run and nothing is remembered;
		 * "keep this series in step" is a plan. The one-off must never create a plan.
		 */
		it('runs once without creating anything when that is the button pressed', async () => {
			const stub = stubFetchRoutes(routes);
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();
			await wrapper.find('[data-test="item-keep"]').trigger('click');
			await settle();

			await wrapper.find('[data-test="keep-run-once"]').trigger('click');
			await settle();

			const run = stub.mock.calls.find(one => String(one[0]).includes('/api/sync/run'));
			expect(JSON.parse(String(run?.[1]?.body))).toMatchObject({
				scope: { rootItemIds: ['m1'] },
				filter: { missingOnly: true },
			});
			expect(stub.mock.calls.some(one =>
				String(one[0]).includes('/api/sync/plans/for-item') && one[1]?.method === 'POST',
			)).toBe(false);
		});

		/**
		 * The way back. Somebody who kept a show in sync in March and wants to change it
		 * in September arrives here, not on the sync screen.
		 */
		it('names the plan that already covers it, and links to it from the media', async () => {
			const covered = {
				suggestedName: 'The Expanse',
				covering: [{
					plan: { id: 'plan-1', name: 'The Expanse', scope: { rootItemIds: ['m1'] } },
					coveredItemId: 'm1',
					exact: true,
				}],
				extendable: [],
			};
			stubFetchRoutes({ ...routes, '/api/sync/plans/for-item/m1': { body: covered } });
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();

			const link = wrapper.find('[data-test="item-plan-link"]');
			expect(link.text()).toContain('The Expanse');
			expect(link.attributes('href')).toBe('/sync/plans/plan-1');

			await wrapper.find('[data-test="item-keep"]').trigger('click');
			await settle();

			// And the dialog offers that plan rather than a second one to fight it.
			expect(wrapper.find('[data-test="keep-covered"]').text()).toContain('The Expanse');
			expect(wrapper.find('[data-test="keep-open-plan"]').attributes('href'))
				.toBe('/sync/plans/plan-1');
			expect(wrapper.find('[data-test="keep-create"]').exists()).toBe(false);
		});
	});

	it('offers a retry when the item cannot be read', async () => {
		stubFetchRoutes({ '/api/services': { body: [] }, '/api/peers': { body: [] } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
	});

	/**
	 * A search order that applies to one media, said on the media.
	 *
	 * It is deliberately not on the settings screen: somebody wondering why a search on
	 * this one series answers differently from every other is looking at this page, and a
	 * setting nothing here mentioned would be one nobody could find, let alone undo.
	 */
	describe('a search order of the media’s own', () => {
		const ordered = {
			...routes,
			'/api/media/m1': {
				body: mediaItem({
					title: 'The Expanse',
					overrides: {
						title: 'The Expanse',
						releasePreference: { ranks: [{ dimension: 'resolution', values: ['1080p'] }] },
					},
					reported: {
						libraryId: 'l1',
						title: 'the.expanse.2015',
						seriesTitle: null,
						year: 2015,
						seasonNumber: null,
						episodeNumber: null,
						overview: 'Belters.',
						externalIds: {},
					},
				}),
			},
		};

		it('says nothing at all on a media that has none', async () => {
			stubFetchRoutes(routes);
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();

			expect(wrapper.find('[data-test="release-preference-note"]').exists()).toBe(false);
		});

		it('states it, and cancels it in one press without withdrawing the rest', async () => {
			// The press re-sends every other correction: a `PUT` replaces the instruction
			// outright, so sending the null alone would quietly undo the corrected title
			// along with the order.
			const stub = stubFetchRoutes({
				...ordered,
				'/api/media/m1/override': { body: mediaItem() },
			});
			const { wrapper } = mountWithApp(LibraryItem, {
				props: { itemId: 'm1' },
				global: { stubs: { ...tooltipStub, ...dialogStub } },
			});
			await settle();

			expect(wrapper.find('[data-test="release-preference-note"]').exists()).toBe(true);

			await wrapper.find('[data-test="release-preference-note-cancel"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(put?.[0]).toBe('/api/media/m1/override');
			expect(JSON.parse(String(put?.[1]?.body)))
				.toEqual({ title: 'The Expanse', releasePreference: null });
		});
	});

	/**
	 * Correcting a child without opening it, which is the same need as on the wall.
	 *
	 * The shelf a season belongs on, or an episode a scraper numbered wrongly, is obvious
	 * from the list and invisible from the child's own page — and one mis-scraped folder
	 * produces a dozen of them.
	 */
	it('offers the correction on every child row, and aims the dialog at that child', async () => {
		const stub = stubFetchRoutes({ ...routes, '/api/media/m2': { body: mediaItem({ id: 'm2' }) } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const actions = wrapper.findAll('[data-test="media-row-override"]');

		expect(actions).toHaveLength(2);

		await actions[0].trigger('click');
		await settle();

		// The child's own row, not the page's media: the dialog corrects one index row and
		// the one it was pointed at is the one that was pressed.
		expect(stub.mock.calls.some(call => String(call[0]).endsWith('/api/media/m2'))).toBe(true);
	});
});

describe('pages/Service', () => {
	it('says a library cannot receive transfers, rather than leaving it to be discovered', async () => {
		stubFetchRoutes({
			'/api/services/s1': { body: service },
			'/api/libraries/check': {
				body: [{
					libraryId: 'l1',
					name: 'Shows',
					localPath: '/media/shows',
					exists: true,
					readable: true,
					writable: false,
					freeBytes: 12,
					error: null,
				}],
			},
			'/api/libraries': { body: [library] },
		});
		const { wrapper } = mountWithApp(Service, {
			props: { id: 's1' },
			global: { stubs: tooltipStub },
		});
		await settle();

		expect(wrapper.find('[data-test="service-unwritable"]').exists()).toBe(true);
		const row = wrapper.find('[data-test="library-row"]');
		expect(row.attributes('data-writable')).toBe('false');
		expect(row.find('[data-test="library-problem"]').text()).toContain('cannot write');
	});

	it('shows the local path as an editable field, with what it has to match', async () => {
		stubFetchRoutes({
			'/api/services/s1': { body: service },
			'/api/libraries/check': { body: [] },
			'/api/libraries': { body: [{ ...library, writable: true }] },
		});
		const { wrapper } = mountWithApp(Service, {
			props: { id: 's1' },
			global: { stubs: tooltipStub },
		});
		await settle();

		expect(wrapper.find('[data-test="library-path"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('/data/shows');
	});
});

describe('pages/Peer', () => {
	const peer = {
		id: 'p1',
		name: 'Bob',
		fingerprint: 'AB:CD',
		status: PeerStatus.LINKED,
		direction: null,
		trust: PeerTrust.FRIEND,
		linkMode: null,
		address: null,
		viaPeerId: null,
		viaPeerName: null,
		serviceCount: 1,
		sharedItemCount: 12,
		lastSeenAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};

	const routes = {
		'/api/peers/p1/services': { body: [service] },
		'/api/peers/p1': { body: peer },
		'/api/services/s1/libraries': { body: [library] },
		'/api/media': { body: { items: [mediaItem({ id: 'm9', kind: MediaKind.MOVIE, title: 'Arrival' })], pagination: null } },
		'/api/sync/run': { body: { id: 'j1' } },
	};

	it('browses what the peer shares as a catalogue', async () => {
		stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peer, {
			props: { id: 'p1' },
			global: { stubs: tooltipStub },
		});
		await settle();

		await wrapper.find('[data-test="peer-browse"]').trigger('click');
		await settle();

		expect(wrapper.find('[data-test="catalogue-list"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="catalogue-row"]').text()).toContain('Arrival');
	});

	it('pulls everything this peer has that we do not', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peer, {
			props: { id: 'p1' },
			global: { stubs: tooltipStub },
		});
		await settle();

		await wrapper.find('[data-test="peer-pull-all"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(JSON.parse(String(run?.[1]?.body))).toMatchObject({
			sourceServiceIds: ['s1'],
			filter: { missingOnly: true },
		});
	});
});

describe('pages/SyncPlan', () => {
	const plan = {
		id: 'pl1',
		name: 'Nightly',
		enabled: true,
		trigger: SyncTrigger.SCHEDULE,
		schedule: '0 4 * * *',
		sourceServiceIds: ['s1'],
		preferredLibraryId: 'l1',
		scope: {},
		maxItemsPerRun: null,
		maxBytesPerRun: null,
		estimate: null,
		filter: { missingOnly: true },
		lastRunAt: null,
		nextRunAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};

	it('previews with exactly the body a run would take', async () => {
		const stub = stubFetchRoutes({
			'/api/sync/plans/pl1': { body: plan },
			'/api/sync/preview': { body: { itemsPlanned: 1, bytesPlanned: 10, items: [] } },
			'/api/services': { body: [service] },
			'/api/libraries': { body: [library] },
		});
		const { wrapper } = mountWithApp(SyncPlan, {
			props: { id: 'pl1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="plan-preview"]').trigger('click');
		await settle();

		const preview = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/preview'));
		// The preference goes in as the run's destination: a preview that ignored it
		// would promise one shelf and the run would deliver another.
		expect(JSON.parse(String(preview?.[1]?.body))).toMatchObject({
			planId: 'pl1',
			sourceServiceIds: ['s1'],
			targetLibraryId: 'l1',
		});
	});

	it('opens on an empty form for a plan that does not exist yet', async () => {
		const stub = stubFetchRoutes({
			'/api/services': { body: [service] },
			'/api/libraries': { body: [library] },
		});
		const { wrapper } = mountWithApp(SyncPlan, {
			props: { id: 'new' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('[data-test="plan-form"]').exists()).toBe(true);
		// Nothing is read for a plan that has no identifier yet.
		expect(stub.mock.calls.every(call => !String(call[0]).includes('/api/sync/plans/'))).toBe(true);
	});
});

describe('pages/SettingsShares', () => {
	const sharePolicy = (overrides: Record<string, unknown> = {}) => ({
		id: 'sp1',
		libraryId: 'l1',
		libraryName: 'Shows',
		serviceId: 's1',
		visibility: 'friends',
		overridden: true,
		allowedPeerIds: [],
		deniedPeerIds: [],
		rateLimit: 0,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	});

	const screen = (policies: Record<string, unknown>[], libraries = [library]) => {
		stubFetchRoutes({
			'/api/shares': { body: policies },
			'/api/libraries': { body: libraries },
			'/api/services': { body: [service] },
			'/api/peers': { body: [] },
		});

		return mountWithApp(SettingsShares, { global: { stubs: tooltipStub } });
	};

	it('shows each library with what it currently exposes', async () => {
		const { wrapper } = screen([sharePolicy()]);
		await settle();

		expect(wrapper.find('[data-test="share-library"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="share-visibility-chip"]').text()).toContain('My peers');
		expect(wrapper.find('[data-test="share-audit"]').exists()).toBe(true);
	});

	/**
	 * The distinction the screen exists to show: "my peers" because somebody chose it
	 * reads differently from "my peers" because that is what the gateway does by
	 * default, and only one of the two changes when the default changes.
	 */
	it('says whether a library was set here or is following the gateway default', async () => {
		const { wrapper } = screen([
			sharePolicy(),
			sharePolicy({
				id: '',
				libraryId: 'l2',
				libraryName: 'Films',
				visibility: 'friends_of_friends',
				overridden: false,
				updatedAt: '',
			}),
		], [library, { ...library, id: 'l2', name: 'Films' }]);
		await settle();

		const chips = wrapper.findAll('[data-test="share-origin-chip"]');

		expect(chips).toHaveLength(2);
		expect(chips[0].attributes('data-origin')).toBe('set');
		expect(chips[0].text()).toContain('Set here');
		expect(chips[1].attributes('data-origin')).toBe('default');
		expect(chips[1].text()).toContain('Gateway default');
	});

	/**
	 * A library reading "nobody" with no row behind it is following its server, not
	 * refused. The screen used to carry a third state, "not ours to share", for a
	 * library whose files this gateway does not hold — that is one switch on the server
	 * now, and no library is out of the default's reach any more.
	 */
	it('says a private library nobody set is following the default', async () => {
		const { wrapper } = screen([
			sharePolicy({ id: '', visibility: 'private', overridden: false, updatedAt: '' }),
		]);
		await settle();

		const chip = wrapper.find('[data-test="share-origin-chip"]');

		expect(chip.attributes('data-origin')).toBe('default');
		expect(chip.text()).toContain('Gateway default');
	});

	it('lists a library nobody has configured, which is most of them on a new gateway', async () => {
		// Listed only the stored rows, this screen showed nothing at all on a gateway
		// that was in fact sharing every library it had.
		const { wrapper } = screen([
			sharePolicy({ id: '', visibility: 'friends_of_friends', overridden: false, updatedAt: '' }),
		]);
		await settle();

		expect(wrapper.findAll('[data-test="share-library"]')).toHaveLength(1);
		expect(wrapper.find('[data-test="share-visibility-chip"]').text()).toContain('My peers and theirs');
	});
});

describe('pages/Transfers actions', () => {
	const base = {
		'/api/libraries/check': { body: [] },
		'/api/libraries': { body: [{ ...library, writable: true }] },
		'/api/services': { body: [service] },
		'/api/transfers/stats': {
			body: { active: 1, queued: 0, paused: 0, failed: 0, rate: 10, bytesRemaining: 900 },
		},
		'/api/transfers/t1/pause': { body: { id: 't1', state: 'paused' } },
		'/api/transfers': {
			body: {
				items: [{
					id: 't1',
					jobId: null,
					itemId: 'm1',
					contentId: null,
					title: 'Pilot',
					kind: 'episode',
					state: 'downloading',
					targetPath: '/media/shows/pilot.mkv',
					bytesTotal: 1000,
					bytesDone: 100,
					rate: 10,
					etaSeconds: 30,
					sources: [],
					chunkSize: 100,
					chunksTotal: 10,
					chunksDone: 1,
					error: null,
					errorKind: null,
					chunksRepaired: 0,
					lastVerifiedAt: null,
					startedAt: null,
					finishedAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
				pagination: { page: 1, limit: 20, total: 1, pages: 1 },
			},
		},
	};

	it('pauses the transfer somebody pressed pause on', async () => {
		const stub = stubFetchRoutes(base);
		const { wrapper } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="transfer-pause"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).includes('/api/transfers/t1/pause'))).toBe(true);
	});

	it('fetches the chunk map and the history only once a row is expanded', async () => {
		const stub = stubFetchRoutes({
			...base,
			'/api/transfers/t1/chunks': { body: [{ index: 0, start: 0, end: 99, state: 'done', bytesDone: 100, sourceServiceId: 's1', attempts: 1, checksum: null }] },
			'/api/transfers/t1/revalidations': { body: [] },
		});
		const { wrapper } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).includes('/chunks'))).toBe(false);

		await wrapper.find('[data-test="transfer-expand"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).includes('/chunks'))).toBe(true);
		expect(wrapper.find('[data-test="chunk-map"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="revalidation-list"]').exists()).toBe(true);
	});
});
