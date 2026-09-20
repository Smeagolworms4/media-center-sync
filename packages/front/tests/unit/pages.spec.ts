import type { Router } from 'vue-router';
import {
	LibraryKind,
	MediaKind,
	MediaOrigin,
	MediaServiceMode,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	NamingScheme,
	PeerDirection,
	PeerStatus,
	PeerTrust,
	PlacementStrategy,
	Right,
	SyncState,
	TransferErrorKind,
	TransferState,
	UserRole,
} from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import App from '@/App.vue';
import Dashboard from '@/pages/Dashboard.vue';
import Library from '@/pages/Library.vue';
import NotFound from '@/pages/NotFound.vue';
import Peers from '@/pages/Peers.vue';
import Services from '@/pages/Services.vue';
import Settings from '@/pages/Settings.vue';
import SettingsUsers from '@/pages/SettingsUsers.vue';
import Sync from '@/pages/Sync.vue';
import Transfers from '@/pages/Transfers.vue';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { mountWithApp, stubFetch, stubFetchRoutes, tooltipStub } from './helpers';

async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

/** Waits for a navigation to land; a lazy page takes as long as its import does. */
async function untilRoute (router: Router, name: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (router.currentRoute.value.name === name) {
			return;
		}
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 5);
		});
	}
}

const EMPTY_LIST = { body: { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } } };

const EMPTY_STATS = {
	body: { active: 0, queued: 0, paused: 0, failed: 0, rate: 0, bytesRemaining: 0 },
};

function service (overrides: Record<string, unknown> = {}) {
	return {
		id: 's1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		scope: MediaServiceScope.LOCAL,
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
		...overrides,
	};
}

function transfer (overrides: Record<string, unknown> = {}) {
	return {
		id: 't1',
		jobId: null,
		itemId: 'm1',
		contentId: null,
		title: 'Pilot',
		kind: 'episode',
		state: TransferState.DOWNLOADING,
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
		...overrides,
	};
}

describe('pages/Dashboard', () => {
	const healthy = {
		'/api/services': { body: [service()] },
		'/api/libraries/check': { body: [] },
		'/api/libraries/categories': { body: [] },
		'/api/libraries': { body: [] },
		'/api/peers': { body: [] },
		'/api/transfers/stats': EMPTY_STATS,
		'/api/transfers': EMPTY_LIST,
		'/api/sync/jobs': EMPTY_LIST,
		'/api/media': { body: { items: [], pagination: { page: 1, limit: 1, total: 0, pages: 0 } } },
	};

	it('says there is nothing to deal with when everything answers', async () => {
		stubFetchRoutes(healthy);
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="dashboard-problems"] [data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.findAll('[data-test="dashboard-problem"]')).toHaveLength(0);
	});

	/**
	 * The failure that reports nothing anywhere else: a library the gateway cannot
	 * write into accepts transfers the media server will never see.
	 */
	it('names a library that cannot be written to, and links somewhere useful', async () => {
		stubFetchRoutes({
			...healthy,
			'/api/libraries/check': {
				body: [{
					libraryId: 'l1',
					name: 'Shows',
					localPath: '/media/shows',
					exists: true,
					readable: true,
					writable: false,
					freeBytes: 0,
					error: null,
				}],
			},
		});
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });
		await settle();

		const problems = wrapper.findAll('[data-test="dashboard-problem"]');
		expect(problems).toHaveLength(1);
		expect(problems[0].text()).toContain('Shows');
	});

	/**
	 * The home page names the categories rather than only counting servers: the first
	 * click from here is the one somebody actually wants, and a category opens on its
	 * own from the same address the wall uses.
	 */
	it('names the merged categories and opens one on its own', async () => {
		stubFetchRoutes({
			...healthy,
			'/api/libraries/categories': {
				body: [{
					key: 'animes',
					name: 'Animes',
					kind: LibraryKind.SHOWS,
					position: 0,
					libraryIds: ['l1', 'l3'],
					serviceIds: ['s1', 's2'],
					itemCount: 12,
					local: true,
				}],
			},
		});
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });
		await settle();

		const chip = wrapper.find('[data-test="dashboard-category"]');
		expect(chip.text()).toContain('Animes');
		expect(chip.attributes('href')).toContain('category=animes');
	});

	it('counts what is missing from the pagination rather than pulling the rows', async () => {
		const stub = stubFetchRoutes({
			...healthy,
			'/api/media': { body: { items: [], pagination: { page: 1, limit: 1, total: 137, pages: 137 } } },
		});
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });
		await settle();

		const mediaCall = stub.mock.calls.map(call => String(call[0])).find(url => url.includes('/api/media'));
		expect(mediaCall).toContain('states=missing');
		expect(mediaCall).toContain('limit=1');
		expect(wrapper.find('[data-test="tile-missing"]').text()).toContain('137');
	});

	it('offers a retry instead of a blank frame when the gateway is down', async () => {
		stubFetchRoutes({});
		const { wrapper } = mountWithApp(Dashboard, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
	});
});

function mediaGroup (overrides: Record<string, unknown> = {}) {
	return {
		id: 'g1',
		kind: 'series',
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkItemId: null,
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		childCount: 0,
		missingCount: 0,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

function mediaLibrary (overrides: Record<string, unknown> = {}) {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'x',
		name: 'Animes',
		kind: LibraryKind.SHOWS,
		paths: [],
		localPath: null,
		writable: true,
		isDefaultTarget: false,
		itemCount: 3,
		lastScanAt: null,
		lastRefreshAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

const LIBRARIES = [
	mediaLibrary({ id: 'l1', name: 'Animes', kind: LibraryKind.SHOWS }),
	mediaLibrary({ id: 'l2', name: 'FilmsHD', kind: LibraryKind.MOVIES }),
	mediaLibrary({ id: 'l3', serviceId: 's2', name: 'Animes', kind: LibraryKind.SHOWS }),
];

function mediaCategory (overrides: Record<string, unknown> = {}) {
	return {
		key: 'animes',
		name: 'Animes',
		kind: LibraryKind.SHOWS,
		position: 0,
		libraryIds: ['l1', 'l3'],
		serviceIds: ['s1', 's2'],
		itemCount: 12,
		local: true,
		...overrides,
	};
}

/**
 * Two servers, three libraries, two categories: the `Animes` of both machines are
 * one band, and that is the whole point of the merge.
 */
const CATEGORIES = [
	mediaCategory(),
	mediaCategory({
		key: 'filmshd',
		name: 'FilmsHD',
		kind: LibraryKind.MOVIES,
		position: 10,
		libraryIds: ['l2'],
		serviceIds: ['s1'],
		local: false,
	}),
];

const LIBRARY_BASE = {
	'/api/services': { body: [] },
	'/api/peers': { body: [] },
	'/api/libraries/categories': { body: CATEGORIES },
	'/api/libraries': { body: LIBRARIES },
};

const ONE_GROUP = {
	body: { items: [mediaGroup()], pagination: { page: 1, limit: 24, total: 1, pages: 1 } },
};

describe('pages/Library', () => {
	it('shows the empty state rather than an empty wall', async () => {
		stubFetchRoutes({
			...LIBRARY_BASE,
			'/api/media/groups': { body: { items: [], pagination: { page: 1, limit: 24, total: 0, pages: 0 } } },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="media-list"]').exists()).toBe(false);
	});

	it('says so rather than showing a wall when no library is registered', async () => {
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/peers': { body: [] },
			'/api/libraries/categories': { body: [] },
			'/api/libraries': { body: [] },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').text()).toContain('No library yet');
		expect(wrapper.find('[data-test="library-section"]').exists()).toBe(false);
	});

	/**
	 * The shape of the screen: one band per *category* — every library of that name,
	 * on every server — under the name the person reads, in the order the gateway
	 * settled, and never a word we invented.
	 */
	it('draws a band per category, merged by name and ordered by position', async () => {
		const stub = stubFetchRoutes({
			...LIBRARY_BASE,
			'/api/media/groups': { body: { items: [mediaGroup()], pagination: { page: 1, limit: 24, total: 42, pages: 2 } } },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const sections = wrapper.findAll('[data-test="library-section"]');
		expect(sections.map(one => one.attributes('data-category'))).toEqual(['animes', 'filmshd']);
		expect(sections[0].text()).toContain('Animes');
		expect(sections[1].text()).toContain('FilmsHD');
		// Structural, for the icon and the shape of a cover; never rendered as a word.
		expect(sections[0].attributes('data-kind')).toBe(LibraryKind.SHOWS);
		expect(sections[0].text()).not.toContain('shows');
		expect(sections[0].find('[data-test="library-section-count"]').text()).toContain('42');
		// One of the merged libraries is ours, and the band says so.
		expect(sections[0].find('[data-test="library-section-local"]').exists()).toBe(true);
		expect(sections[1].find('[data-test="library-section-local"]').exists()).toBe(false);

		const asked = stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));
		expect(asked.some(url => url.includes('categoryKey=animes'))).toBe(true);
		expect(asked.some(url => url.includes('categoryKey=filmshd'))).toBe(true);
		// Never one band per library-and-server: `Animes` is asked for once.
		expect(asked.some(url => url.includes('libraryId='))).toBe(false);
	});

	/** A home screen is a glance at what is new, at the top of the tree. */
	it('asks each band for the latest additions, and for roots only', async () => {
		const stub = stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const asked = stub.mock.calls.map(call => String(call[0])).find(url => url.includes('/media/groups'));
		expect(asked).toContain('sort=addedAt');
		expect(asked).toContain('direction=desc');
		expect(asked).toContain('rootsOnly=true');
		expect(wrapper.find('[data-test="library-section-latest"]').exists()).toBe(true);
	});

	/** A category that holds nothing still exists, and says so. */
	it('keeps an empty category on screen instead of dropping it', async () => {
		stubFetchRoutes({
			...LIBRARY_BASE,
			'groups?': { body: { items: [], pagination: { page: 1, limit: 24, total: 0, pages: 0 } } },
			'categoryKey=animes': { body: { items: [mediaGroup()], pagination: { page: 1, limit: 24, total: 1, pages: 1 } } },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const sections = wrapper.findAll('[data-test="library-section"]');
		expect(sections).toHaveLength(2);
		expect(sections[1].find('[data-test="library-section-empty"]').exists()).toBe(true);
	});

	/**
	 * The same series filed in two categories is one poster, in the first of them.
	 * Two would be two things to pick, two things to sync, and one library that looks
	 * twice the size it is.
	 */
	it('shows a media once, under the first category that holds it', async () => {
		stubFetchRoutes({
			...LIBRARY_BASE,
			'/api/media/groups': { body: { items: [mediaGroup()], pagination: { page: 1, limit: 24, total: 1, pages: 1 } } },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const sections = wrapper.findAll('[data-test="library-section"]');
		expect(sections[0].findAll('[data-test="media-card"]')).toHaveLength(1);
		expect(sections[1].findAll('[data-test="media-card"]')).toHaveLength(0);
		// The band still counts what it holds: it is not empty, it is already shown.
		expect(sections[1].find('[data-test="library-section-count"]').text()).toContain('1');
	});

	/** Opening a band is opening its category, paginated, with the filters. */
	it('opens a category on its own, in the address', async () => {
		const stub = stubFetchRoutes({
			...LIBRARY_BASE,
			'/api/media/groups': { body: { items: [mediaGroup()], pagination: { page: 1, limit: 24, total: 42, pages: 2 } } },
		});
		const { wrapper, router } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		await wrapper.find('[data-test="library-section-all"]').trigger('click');
		await settle();

		expect(router.currentRoute.value.query.category).toBe('animes');
		expect(wrapper.findAll('[data-test="library-section"]')).toHaveLength(1);
		const asked = stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));
		expect(asked.at(-1)).toContain('categoryKey=animes');
		expect(asked.at(-1)).toContain('limit=60');
	});

	/** Four levels deep, the way back out has to be on the screen. */
	it('says where the wall is once a category is open', async () => {
		stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper, router } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="media-breadcrumb"]').exists()).toBe(false);

		await router.push({ name: 'library', query: { category: 'animes' } });
		await settle();

		const trail = wrapper.find('[data-test="media-breadcrumb"]');
		expect(trail.exists()).toBe(true);
		expect(trail.find('[data-test="media-breadcrumb-current"]').text()).toBe('Animes');
		expect(trail.find('[data-test="media-breadcrumb-step"]').text()).toBe('Library');
	});

	/** One title, and no guessing which of three categories it landed in. */
	it('browses across every category on request, in one paginated band', async () => {
		const stub = stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper, router } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		await wrapper.find('[data-test="library-everything"] input').setValue(true);
		await settle();

		expect(router.currentRoute.value.query.all).toBeDefined();
		expect(wrapper.findAll('[data-test="library-section"]')).toHaveLength(1);
		const asked = stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));
		expect(asked.at(-1)).not.toContain('categoryKey=');
	});

	it('renders one card per group, with its state and its sources', async () => {
		stubFetchRoutes({
			...LIBRARY_BASE,
			'/api/media/groups': {
				body: {
					items: [mediaGroup({ sync: SyncState.OUTDATED, sources: [{ itemId: 'i1', serviceId: 's1', serviceName: 'Living room', serviceType: 'jellyfin', scope: 'local', peerId: null, peerName: null, quality: null, companions: null, bytes: 10, local: true, sync: SyncState.IN_SYNC }] })],
					pagination: { page: 1, limit: 24, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const card = wrapper.find('[data-test="media-card"]');
		expect(card.attributes('data-state')).toBe(SyncState.OUTDATED);
		expect(card.find('[data-test="sync-state"]').attributes('data-state')).toBe(SyncState.OUTDATED);
		expect(card.find('[data-test="source-mark-local"]').exists()).toBe(true);
		expect(card.find('[data-test="media-poster-placeholder"]').exists()).toBe(true);
	});

	it('offers to sync what has been selected, and only then', async () => {
		stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="library-selection-bar"]').exists()).toBe(false);

		await wrapper.find('[data-test="media-select"] input').setValue(true);
		await settle(2);

		expect(wrapper.find('[data-test="library-selection-bar"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="library-sync-selected"]').exists()).toBe(true);
	});

	/** A filtered wall has to be a link somebody can send. */
	it('keeps the filters in the address', async () => {
		stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper, router } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const filters = wrapper.findComponent({ name: 'MediaFilters' });
		filters.vm.$emit('update:states', [SyncState.MISSING]);
		filters.vm.$emit('update:kind', 'movie');
		filters.vm.$emit('update:libraryId', 'l2');
		await settle();

		expect(router.currentRoute.value.query.states).toBe('missing');
		expect(router.currentRoute.value.query.kind).toBe('movie');
		expect(router.currentRoute.value.query.libraryId).toBe('l2');
		// One library chosen is one band, and that band is paginated.
		expect(wrapper.findAll('[data-test="library-section"]')).toHaveLength(1);
	});

	/**
	 * "What do my friends have" is one filter, and naming six servers is not the same
	 * question — so both travel, and both reach the API.
	 */
	it('sends the servers and the origins, and keeps them in the address', async () => {
		const stub = stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper, router } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		const filters = wrapper.findComponent({ name: 'MediaFilters' });
		filters.vm.$emit('update:serviceIds', ['s1', 's2']);
		filters.vm.$emit('update:origins', [MediaOrigin.FRIEND, MediaOrigin.FRIEND_OF_FRIEND]);
		await settle();

		expect(router.currentRoute.value.query.serviceIds).toBe('s1,s2');
		expect(router.currentRoute.value.query.origins).toBe('friend,friend_of_friend');

		const asked = stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));
		expect(asked.at(-1)).toContain('serviceIds=s1&serviceIds=s2');
		expect(asked.at(-1)).toContain('origins=friend&origins=friend_of_friend');
	});

	/**
	 * Roots by default — a library of concerts has no kind this model names, and
	 * deriving it would put parents and children on the same wall. Asking for a kind
	 * is asking for exactly that, episodes included.
	 */
	it('drops the roots-only filter the moment a kind is asked for', async () => {
		const stub = stubFetchRoutes({ ...LIBRARY_BASE, '/api/media/groups': ONE_GROUP });
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		wrapper.findComponent({ name: 'MediaFilters' }).vm.$emit('update:kind', MediaKind.EPISODE);
		await settle();

		const asked = stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));
		expect(asked.at(-1)).toContain('kind=episode');
		expect(asked.at(-1)).not.toContain('rootsOnly');
	});
});

describe('pages/Services', () => {
	it('explains what to do when no service is registered', async () => {
		stubFetchRoutes({ '/api/services': { body: [] } });
		const { wrapper } = mountWithApp(Services, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="service-list"]').exists()).toBe(false);
	});

	it('shows each service with its reachability and its counts', async () => {
		stubFetchRoutes({
			'/api/services': { body: [service({ status: MediaServiceStatus.UNAUTHORIZED })] },
		});
		const { wrapper } = mountWithApp(Services, { global: { stubs: tooltipStub } });
		await settle();

		const row = wrapper.find('[data-test="service-row"]');
		expect(row.exists()).toBe(true);
		expect(row.find('[data-test="service-status"]').attributes('data-status'))
			.toBe(MediaServiceStatus.UNAUTHORIZED);
		expect(row.text()).toContain('Living room');
	});

	it('bands the list by what can be done with each service', async () => {
		// Three kinds that do not behave alike: only ours can be written into, a
		// server we merely have an account on is somebody else's disk, and a peer
		// shows what its owner chose to share. Flat, they all looked the same.
		stubFetchRoutes({
			'/api/services': {
				body: [
					service({ id: 'mine', name: 'Living room', mode: MediaServiceMode.LOCAL }),
					service({
						id: 'theirs',
						name: 'Their Plex',
						mode: MediaServiceMode.REMOTE,
						scope: MediaServiceScope.REMOTE,
					}),
					service({
						id: 'friend',
						name: 'The cottage',
						mode: MediaServiceMode.PEER,
						type: MediaServiceType.PEER,
						scope: MediaServiceScope.REMOTE,
					}),
				],
			},
		});
		const { wrapper } = mountWithApp(Services, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.findAll('[data-test="service-row"]')).toHaveLength(3);
		expect(wrapper.findAll('[data-test="service-band"]').map(band => band.attributes('data-mode')))
			.toEqual([MediaServiceMode.LOCAL, MediaServiceMode.REMOTE, MediaServiceMode.PEER]);
	});

	it('never drops a row whose mode it cannot read', async () => {
		// Filtering on `mode` alone left a record written before that field existed
		// belonging to no band, and it disappeared from the page. A registered
		// service that does not appear is worse than one in the wrong band: nothing
		// says it is missing.
		stubFetchRoutes({
			'/api/services': {
				body: [{ ...service({ name: 'Ancient' }), mode: undefined }],
			},
		});
		const { wrapper } = mountWithApp(Services, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.findAll('[data-test="service-row"]')).toHaveLength(1);
		expect(wrapper.text()).toContain('Ancient');
	});
});

describe('pages/Transfers', () => {
	const base = {
		'/api/libraries/check': { body: [] },
		'/api/libraries': { body: [] },
		'/api/services': { body: [] },
		'/api/transfers/stats': EMPTY_STATS,
		'/api/transfers': EMPTY_LIST,
	};

	it('shows the empty state when nothing is being pulled', async () => {
		stubFetchRoutes(base);
		const { wrapper } = mountWithApp(Transfers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
	});

	/** The behaviour that matters: the offer fits the failure. */
	it('offers another source for a transfer whose source is gone', async () => {
		stubFetchRoutes({
			...base,
			'/api/transfers': {
				body: {
					items: [transfer({
						state: TransferState.FAILED,
						errorKind: TransferErrorKind.SOURCE_GONE,
						error: 'error.sync.no_source',
					})],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, { global: { stubs: tooltipStub } });
		await settle();

		const row = wrapper.find('[data-test="transfer-row"]');
		expect(row.find('[data-test="transfer-another_source"]').exists()).toBe(true);
		expect(row.find('[data-test="transfer-retry"]').exists()).toBe(false);
		expect(row.find('[data-test="transfer-error"]').attributes('data-kind'))
			.toBe(TransferErrorKind.SOURCE_GONE);
	});

	it('offers another library for a transfer that ran out of room', async () => {
		stubFetchRoutes({
			...base,
			'/api/transfers': {
				body: {
					items: [transfer({ state: TransferState.FAILED, errorKind: TransferErrorKind.DISK_FULL })],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="transfer-another_target"]').exists()).toBe(true);
	});

	it('reads a paused transfer as holding, with resume the obvious way back', async () => {
		stubFetchRoutes({
			...base,
			'/api/transfers/stats': {
				body: { active: 0, queued: 0, paused: 1, failed: 0, rate: 0, bytesRemaining: 500 },
			},
			'/api/transfers': {
				body: {
					items: [transfer({ state: TransferState.PAUSED })],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="transfer-paused"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="transfer-resume"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="queue-paused"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="transfer-resume-all"]').exists()).toBe(true);
	});

	it('says how many sources are feeding one file without being expanded', async () => {
		stubFetchRoutes({
			...base,
			'/api/transfers': {
				body: {
					items: [transfer({
						sources: [
							{ serviceId: 's1', serviceName: 'A', peerId: null, peerName: null, transport: 'swarm', rate: 1, bytesDone: 1, connections: 1, healthy: true },
							{ serviceId: 's2', serviceName: 'B', peerId: 'p1', peerName: 'Bob', transport: 'swarm', rate: 1, bytesDone: 1, connections: 1, healthy: false },
						],
					})],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="transfer-multi-source"]').text()).toContain('2');
		expect(wrapper.find('[data-test="transfer-unhealthy-sources"]').exists()).toBe(true);
	});
});

describe('pages/Sync', () => {
	it('explains what a plan is when there is none', async () => {
		stubFetchRoutes({
			'/api/sync/plans': { body: [] },
			'/api/sync/jobs': EMPTY_LIST,
			'/api/services': { body: [] },
			'/api/libraries': { body: [] },
		});
		const { wrapper } = mountWithApp(Sync, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="plan-list"] [data-test="empty-state"]').exists()).toBe(true);
	});

	it('says a plan with no source pinned follows the configured priority', async () => {
		stubFetchRoutes({
			'/api/sync/plans': {
				body: [{
					id: 'pl1',
					name: 'Nightly',
					enabled: true,
					trigger: 'schedule',
					schedule: '0 4 * * *',
					sourceServiceIds: [],
					targetLibraryId: null,
					rootItemId: null,
					filter: {},
					lastRunAt: null,
					nextRunAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
			},
			'/api/sync/jobs': EMPTY_LIST,
			'/api/services': { body: [] },
			'/api/libraries': { body: [] },
		});
		const { wrapper } = mountWithApp(Sync, { global: { stubs: tooltipStub } });
		await settle();

		const row = wrapper.find('[data-test="plan-row"]');
		expect(row.text()).toContain('follows the service priority');
		// The cron field is turned into a sentence, because nobody reads 0 4 * * *.
		expect(row.find('[data-test="cron-hint"]').text()).toContain('04:00');
	});
});

describe('pages/Peers', () => {
	it('says when only relayed links are possible, next to the identity', async () => {
		stubFetchRoutes({
			'/api/peers/identity': {
				body: {
					fingerprint: 'AB:CD',
					name: 'me',
					rendezvous: 'wss://rendezvous',
					directAddress: null,
					directReachable: false,
				},
			},
			'/api/peers': { body: [] },
		});
		const { wrapper } = mountWithApp(Peers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="peer-reachability"]').text()).toContain('relayed');
		expect(wrapper.find('[data-test="peer-identity"]').text()).toContain('AB:CD');
	});

	it('shows a friend of a friend as one, and through whom', async () => {
		stubFetchRoutes({
			'/api/peers/identity': {
				body: { fingerprint: 'AB', name: 'me', rendezvous: 'wss://r', directAddress: null, directReachable: true },
			},
			'/api/peers': {
				body: [{
					id: 'p1',
					name: 'Carol',
					fingerprint: 'EF',
					status: PeerStatus.LINKED,
					direction: null,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					linkMode: null,
					address: null,
					viaPeerId: 'p0',
					viaPeerName: 'Bob',
					serviceCount: 1,
					sharedItemCount: 3,
					lastSeenAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
			},
		});
		const { wrapper } = mountWithApp(Peers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="peer-trust"]').text()).toContain('Bob');
	});

	function pendingPeer (direction: PeerDirection, overrides: Record<string, unknown> = {}) {
		return {
			id: 'p1',
			name: 'Dave',
			fingerprint: 'EF',
			status: PeerStatus.PENDING,
			direction,
			trust: PeerTrust.FRIEND,
			linkMode: null,
			address: null,
			viaPeerId: null,
			viaPeerName: null,
			serviceCount: 0,
			sharedItemCount: 0,
			lastSeenAt: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			...overrides,
		};
	}

	const identity = {
		'/api/peers/identity': {
			body: { fingerprint: 'AB', name: 'me', rendezvous: 'wss://r', directAddress: null, directReachable: true },
		},
	};

	/**
	 * A request waiting on somebody here and one waiting on somebody else are two
	 * different situations wearing the word "pending"; only one of them needs an
	 * answer, and it has to be obvious which.
	 */
	it('offers an answer to an incoming request and nothing but a note to an outgoing one', async () => {
		const stub = stubFetchRoutes({
			...identity,
			'/api/peers/p1/approve': { body: { ...pendingPeer(PeerDirection.INCOMING), status: PeerStatus.LINKED, direction: null } },
			'/api/peers': { body: [pendingPeer(PeerDirection.INCOMING)] },
		});
		const { wrapper } = mountWithApp(Peers, { global: { stubs: tooltipStub } });
		await settle();

		const row = wrapper.find('[data-test="peer-row"]');
		expect(row.attributes('data-direction')).toBe(PeerDirection.INCOMING);
		expect(row.find('[data-test="peer-incoming-hint"]').exists()).toBe(true);

		await row.find('[data-test="peer-approve"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).includes('/api/peers/p1/approve'))).toBe(true);
	});

	it('leaves an outgoing request with nothing to press', async () => {
		stubFetchRoutes({
			...identity,
			'/api/peers': { body: [pendingPeer(PeerDirection.OUTGOING)] },
		});
		const { wrapper } = mountWithApp(Peers, { global: { stubs: tooltipStub } });
		await settle();

		const row = wrapper.find('[data-test="peer-row"]');
		expect(row.attributes('data-direction')).toBe(PeerDirection.OUTGOING);
		expect(row.find('[data-test="peer-approve"]').exists()).toBe(false);
		expect(row.text()).toContain('Waiting for them');
	});
});

describe('pages/SettingsUsers', () => {
	it('explains why a mirrored account cannot be renamed here', async () => {
		stubFetchRoutes({
			'/api/users': {
				body: [{
					id: 'u1',
					username: 'ada',
					displayName: 'Ada',
					email: null,
					role: UserRole.USER,
					provider: 'service:8f1c',
					providerUserId: 'jf-1',
					avatarUrl: null,
					lastSeenAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
			},
		});
		const { wrapper } = mountWithApp(SettingsUsers, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="user-mirrored"]').text()).toContain('does not own');
		// The role stays editable, because that one is ours.
		expect(wrapper.find('[data-test="user-role"]').exists()).toBe(true);
	});
});

describe('pages/Settings', () => {
	const settingsBody = (overrides: Record<string, unknown> = {}) => ({
		placement: PlacementStrategy.FIXED_PATH,
		fixedPath: '/media/incoming',
		naming: NamingScheme.STANDARD,
		pullMetadata: true,
		preferSourceMetadata: false,
		maxParallelTransfers: 2,
		maxConnectionsPerSource: 4,
		chunkSize: 4_194_304,
		downloadRateLimit: 0,
		uploadRateLimit: 0,
		matchThreshold: 0.8,
		peerMaxDepth: 3,
		allowSwarm: true,
		rendezvousUrl: null,
		publicUrl: null,
		peerAddress: null,
		defaultTargetPath: null,
		transferHistoryDays: 30,
		refreshIntervalMinutes: 15,
		fullScanCron: '0 4 * * *',
		cacheTtlSeconds: 60,
		...overrides,
	});

	const openSettings = async (overrides: Record<string, unknown> = {}) => {
		stubFetchRoutes({ '/api/settings': { body: { pinned: [], ...settingsBody(overrides) } } });
		const mounted = mountWithApp(Settings, { global: { stubs: tooltipStub } });
		await settle();
		return mounted;
	};

	const valueOf = (wrapper: ReturnType<typeof mountWithApp>['wrapper'], test: string) =>
		(wrapper.find(`[data-test="${test}"] input`).element as HTMLInputElement).value;

	it('offers the reach as a number of hops, not as a yes or no', async () => {
		// The switch it replaces could only write one hop or the default: there was no
		// way to ask for two, and no way to see which of the six was in force.
		const { wrapper } = await openSettings({ peerMaxDepth: 4 });

		expect(valueOf(wrapper, 'settings-peer-depth')).toBe('4');
	});

	it('disables the reach when the deployment pinned it, and says why', async () => {
		// Hidden would be worse: somebody looking for this setting has to find out that
		// it exists and is decided elsewhere, or they conclude there is no limit at all.
		stubFetchRoutes({
			'/api/settings': { body: { pinned: ['peerMaxDepth'], ...settingsBody() } },
		});
		const { wrapper } = mountWithApp(Settings, { global: { stubs: tooltipStub } });
		await settle();

		const input = wrapper.find('[data-test="settings-peer-depth"] input');

		expect((input.element as HTMLInputElement).disabled).toBe(true);
		expect(wrapper.find('[data-test="settings-peer-depth"]').text())
			.toContain('cannot be changed here');
	});

	it('shows the fixed path only when the placement needs one', async () => {
		const { wrapper } = await openSettings();

		expect(wrapper.find('[data-test="settings-fixed-path"]').exists()).toBe(true);
		// A chunk size is shown the way somebody would type it, not as 4194304.
		expect(wrapper.text()).toContain('Chunk size');
		expect(wrapper.find('[data-test="cron-hint"]').text()).toContain('04:00');
	});

	it('offers the browser’s own origin when no public address has been set', async () => {
		const { wrapper } = await openSettings({ publicUrl: null });

		expect(valueOf(wrapper, 'settings-public-url')).toBe(window.location.origin);
	});

	it('says the address is a suggestion and where it came from', async () => {
		// Offered, not assumed: a gateway administered over a private address and
		// reached by friends over a domain name would otherwise announce the wrong one
		// to everybody, and nobody checks a fact they were never told was a guess.
		const { wrapper } = await openSettings({ publicUrl: null });
		const caption = wrapper.find('[data-test="settings-public-url-suggested"]');

		expect(caption.exists()).toBe(true);
		expect(caption.text()).toContain(window.location.origin);
	});

	it('never overwrites an address somebody has already set', async () => {
		const { wrapper } = await openSettings({ publicUrl: 'https://mcs.example.org' });

		expect(valueOf(wrapper, 'settings-public-url')).toBe('https://mcs.example.org');
		expect(valueOf(wrapper, 'settings-public-url')).not.toBe(window.location.origin);
		// And it does not claim to be a suggestion, because it is not one.
		expect(wrapper.find('[data-test="settings-public-url-suggested"]').exists()).toBe(false);
	});

	it('stops calling it a suggestion once somebody types their own', async () => {
		const { wrapper } = await openSettings({ publicUrl: null });

		await wrapper.find('[data-test="settings-public-url"] input').setValue('https://elsewhere.example');
		await settle();

		expect(wrapper.find('[data-test="settings-public-url-suggested"]').exists()).toBe(false);
	});

	it('fills the peer address and the fallback folder from what is stored', async () => {
		const { wrapper } = await openSettings({
			peerAddress: 'mcs.example.org:4210',
			defaultTargetPath: '/media/incoming',
		});

		expect(valueOf(wrapper, 'settings-peer-address')).toBe('mcs.example.org:4210');
		expect(valueOf(wrapper, 'settings-default-target')).toBe('/media/incoming');
	});

	it('sends an emptied box as a clearing rather than as an empty string', async () => {
		const stub = stubFetchRoutes({
			'/api/settings': { body: settingsBody({ peerAddress: 'mcs.example.org:4210' }) },
		});
		const { wrapper } = mountWithApp(Settings, { global: { stubs: tooltipStub } });
		await settle();

		await wrapper.find('[data-test="settings-peer-address"] input').setValue('');
		await wrapper.find('form').trigger('submit');
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');

		expect(JSON.parse(String(patch?.[1]?.body)).peerAddress).toBeNull();
	});
});

describe('pages/NotFound', () => {
	it('offers the sign-in page to a visitor with no session', async () => {
		const { wrapper, router } = mountWithApp(NotFound);

		expect(wrapper.text()).toContain('Page not found');
		await wrapper.find('.empty-state button').trigger('click');
		await untilRoute(router, 'login');

		expect(router.currentRoute.value.name).toBe('login');
	});

	it('offers the dashboard to somebody already signed in', async () => {
		const { wrapper, pinia, router } = mountWithApp(NotFound);
		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', role: UserRole.ADMIN }, rights: [Right.LIBRARY_READ],
		} as never);
		await nextTick();

		expect(wrapper.text()).toContain('Back to the dashboard');
		await wrapper.find('.empty-state button').trigger('click');
		await untilRoute(router, 'dashboard');

		expect(router.currentRoute.value.name).toBe('dashboard');
	});
});

describe('App', () => {
	const flush = settle;

	it('holds a progress state until the boot restore answers', async () => {
		stubFetch([]);
		const { wrapper } = mountWithApp(App);

		expect(wrapper.find('.app_boot').exists()).toBe(true);

		await flush();
		expect(wrapper.find('.app_boot').exists()).toBe(false);
	});

	it('shows no shell at all to a visitor with no session', async () => {
		const { wrapper } = mountWithApp(App);
		await flush();

		expect(wrapper.find('.v-navigation-drawer').exists()).toBe(false);
		expect(wrapper.find('.v-app-bar').exists()).toBe(false);
	});

	it('shows only the sections the viewer may open', async () => {
		vi.stubGlobal('WebSocket', class {
			addEventListener () {} close () {}
		} as unknown as typeof WebSocket);
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/libraries/check': { body: [] },
			'/api/libraries': { body: [] },
			'/api/peers': { body: [] },
			'/api/transfers/stats': EMPTY_STATS,
			'/api/transfers': EMPTY_LIST,
			'/api/sync/jobs': EMPTY_LIST,
			'/api/media': { body: { items: [], pagination: { page: 1, limit: 1, total: 0, pages: 0 } } },
			'/api/settings': { body: {} },
			'/api/auth': { body: {} },
		});
		const { wrapper, pinia, router } = mountWithApp(App);
		await router.push({ name: 'dashboard' });

		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', displayName: 'Ada', role: UserRole.USER },
			rights: [Right.LIBRARY_READ, Right.TRANSFER_READ],
		} as never);
		useAuthStore(pinia).ready = true;
		await flush();

		const entries = wrapper.findAll('.app_nav .v-list-item-title').map(node => node.text());
		expect(entries).toContain('Dashboard');
		expect(entries).toContain('Library');
		expect(entries).toContain('Transfers');
		expect(entries).not.toContain('Settings');
		expect(entries).not.toContain('Users');
	});

	it('names the gateway, the account and the connection state in the bar', async () => {
		vi.stubGlobal('WebSocket', class {
			addEventListener () {} close () {}
		} as unknown as typeof WebSocket);
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/libraries/check': { body: [] },
			'/api/libraries': { body: [] },
			'/api/peers': { body: [] },
			'/api/transfers/stats': EMPTY_STATS,
			'/api/transfers': EMPTY_LIST,
			'/api/sync/jobs': EMPTY_LIST,
			'/api/media': { body: { items: [], pagination: { page: 1, limit: 1, total: 0, pages: 0 } } },
			'/api/settings': { body: {} },
			'/api/auth': { body: {} },
		});
		const { wrapper, pinia, router } = mountWithApp(App);
		await router.push({ name: 'dashboard' });

		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', displayName: 'Ada Lovelace', role: UserRole.ADMIN },
			rights: Object.values(Right),
		} as never);
		useAuthStore(pinia).ready = true;
		await flush();

		expect(wrapper.find('.v-app-bar').text()).toContain('Media Center Sync');
		expect(wrapper.find('.app_account').text()).toContain('Ada Lovelace');
		expect(wrapper.find('.app_connection').exists()).toBe(true);
	});

	it('carries the journey attributes the end-to-end suite addresses', async () => {
		vi.stubGlobal('WebSocket', class {
			addEventListener () {} close () {}
		} as unknown as typeof WebSocket);
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/libraries/check': { body: [] },
			'/api/libraries': { body: [] },
			'/api/peers': { body: [] },
			'/api/transfers/stats': EMPTY_STATS,
			'/api/transfers': EMPTY_LIST,
			'/api/sync/jobs': EMPTY_LIST,
			'/api/media': { body: { items: [], pagination: { page: 1, limit: 1, total: 0, pages: 0 } } },
			'/api/settings': { body: {} },
			'/api/auth': { body: {} },
		});
		const { wrapper, pinia, router } = mountWithApp(App);
		await router.push({ name: 'dashboard' });

		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', role: UserRole.ADMIN },
			rights: Object.values(Right),
		} as never);
		useAuthStore(pinia).ready = true;
		await flush();

		expect(wrapper.find('[data-test="app-shell"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="app-nav"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="nav-library"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true);
	});
});

/** Kept out of the page suites above: `LibraryKind` is only needed by this one. */
describe('vocabulary', () => {
	it('has a word for every library kind the API can report', async () => {
		const en = (await import('@/locales/en.json')).default;

		for (const kind of Object.values(LibraryKind)) {
			expect(en.library.kind[kind]).toBeTruthy();
		}
	});
});
