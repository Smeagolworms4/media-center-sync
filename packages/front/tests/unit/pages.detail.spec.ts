import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
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
	scope: MediaServiceScope.REMOTE,
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
			scope: MediaServiceScope.REMOTE,
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
		'/api/media/m1/matches': { body: [] },
		'/api/services': { body: [service] },
		'/api/peers': { body: [] },
		'/api/sync/run': { body: { id: 'j1' } },
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
			rootItemId: 'm1',
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

	it('offers a retry when the item cannot be read', async () => {
		stubFetchRoutes({ '/api/services': { body: [] }, '/api/peers': { body: [] } });
		const { wrapper } = mountWithApp(LibraryItem, {
			props: { itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
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
		targetLibraryId: 'l1',
		rootItemId: null,
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
	it('shows each library with what it currently exposes', async () => {
		stubFetchRoutes({
			'/api/shares': {
				body: [{
					id: 'sp1',
					libraryId: 'l1',
					libraryName: 'Shows',
					serviceId: 's1',
					visibility: 'friends',
					allowedPeerIds: [],
					deniedPeerIds: [],
					rateLimit: 0,
					updatedAt: '2026-01-01T00:00:00.000Z',
				}],
			},
			'/api/libraries': { body: [library] },
			'/api/services': { body: [service] },
			'/api/peers': { body: [] },
		});
		const { wrapper } = mountWithApp(SettingsShares, { global: { stubs: tooltipStub } });
		await settle();

		expect(wrapper.find('[data-test="share-library"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="share-visibility-chip"]').text()).toContain('My peers');
		expect(wrapper.find('[data-test="share-audit"]').exists()).toBe(true);
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
