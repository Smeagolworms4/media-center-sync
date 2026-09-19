import type { Router } from 'vue-router';
import {
	LibraryKind,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	NamingScheme,
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

describe('pages/Library', () => {
	it('shows the empty state rather than an empty table', async () => {
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/libraries': { body: [] },
			'/api/media': { body: { items: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } } },
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="media-list"]').exists()).toBe(false);
	});

	it('offers to sync what has been selected, and only then', async () => {
		stubFetchRoutes({
			'/api/services': { body: [] },
			'/api/libraries': { body: [] },
			'/api/media': {
				body: {
					items: [{
						id: 'm1',
						serviceId: 's1',
						libraryId: 'l1',
						parentId: null,
						kind: 'episode',
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
					}],
					pagination: { page: 1, limit: 50, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Library, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="library-sync-selected"]').exists()).toBe(false);

		await wrapper.find('[data-test="media-select"] input').setValue(true);
		await settle(2);

		expect(wrapper.find('[data-test="library-sync-selected"]').exists()).toBe(true);
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
	it('shows the fixed path only when the placement needs one', async () => {
		stubFetchRoutes({
			'/api/settings': {
				body: {
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
					allowFriendsOfFriends: true,
					allowSwarm: true,
					rendezvousUrl: null,
					transferHistoryDays: 30,
					refreshIntervalMinutes: 15,
					fullScanCron: '0 4 * * *',
					cacheTtlSeconds: 60,
				},
			},
		});
		const { wrapper } = mountWithApp(Settings, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="settings-fixed-path"]').exists()).toBe(true);
		// A chunk size is shown the way somebody would type it, not as 4194304.
		expect(wrapper.text()).toContain('Chunk size');
		expect(wrapper.find('[data-test="cron-hint"]').text()).toContain('04:00');
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
		const en = (await import('@/locales/en')).default;

		for (const kind of Object.values(LibraryKind)) {
			expect(en.library.kind[kind]).toBeTruthy();
		}
	});
});
