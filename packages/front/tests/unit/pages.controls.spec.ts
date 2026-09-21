import type { Component } from 'vue';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	NamingScheme,
	PeerStatus,
	PeerTrust,
	PlacementStrategy,
	ShareVisibility,
	SyncState,
	SyncTrigger,
	TransferErrorKind,
	TransferState,
	UserRole,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import Dashboard from '@/pages/Dashboard.vue';
import Library from '@/pages/Library.vue';
import LibraryItem from '@/pages/LibraryItem.vue';
import Peer from '@/pages/Peer.vue';
import Peers from '@/pages/Peers.vue';
import Service from '@/pages/Service.vue';
import Services from '@/pages/Services.vue';
import Settings from '@/pages/Settings.vue';
import SettingsShares from '@/pages/SettingsShares.vue';
import SettingsUsers from '@/pages/SettingsUsers.vue';
import Sync from '@/pages/Sync.vue';
import SyncPlan from '@/pages/SyncPlan.vue';
import Transfers from '@/pages/Transfers.vue';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * Every control on every page is pressed once.
 *
 * Cheap, and it catches the failure that is most expensive to find by hand: a
 * button whose handler throws — a missing identifier, a store method renamed —
 * which in a browser leaves a control that simply does nothing and says nothing.
 */
async function settle (times = 6): Promise<void> {
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
	version: '10.9',
	authProvider: false,
	priority: 10,
	peerId: null,
	lastProbeAt: '2026-02-01T00:00:00.000Z',
	lastScanAt: '2026-02-01T00:00:00.000Z',
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
	alias: null,
	position: 0,
	kind: LibraryKind.SHOWS,
	paths: ['/data/shows'],
	localPath: '/media/shows',
	writable: true,
	isDefaultTarget: true,
	itemCount: 10,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const category = {
	key: 'shows',
	name: 'Shows',
	kind: LibraryKind.SHOWS,
	position: 0,
	libraryIds: ['l1'],
	serviceIds: ['s1'],
	itemCount: 10,
	local: true,
};

const check = {
	libraryId: 'l1',
	name: 'Shows',
	localPath: '/media/shows',
	exists: true,
	readable: true,
	writable: true,
	freeBytes: 1024,
	error: null,
};

const peer = {
	id: 'p1',
	name: 'Bob',
	nodeId: 'node-bob-1',
	fingerprint: 'AB:CD',
	status: PeerStatus.LINKED,
	direction: null,
	trust: PeerTrust.FRIEND_OF_FRIEND,
	readingForbidden: false,
	linkMode: 'relay',
	address: '203.0.113.9:4210',
	viaPeerId: 'p0',
	viaPeerName: 'Alice',
	serviceCount: 1,
	sharedItemCount: 12,
	lastSeenAt: '2026-02-01T00:00:00.000Z',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const mediaItem = {
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
	externalIds: { tvdb: '1' },
	overview: 'Belters.',
	artworkUrl: null,
	companions: null,
	file: null,
	quality: {
		label: 'x265 · 1080p',
		mixed: true,
		dominant: null,
		variants: [{ label: 'x265 · 1080p', videoCodec: 'h265', resolution: '1080p', hdr: null, audioCodec: 'eac3', audioChannels: '5.1', container: 'mkv', count: 2, bytes: 100 }],
		fileCount: 2,
		totalBytes: 100,
	},
	addedAt: null,
	sync: SyncState.OUTDATED,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const mediaGroup = {
	id: 'm1',
	kind: MediaKind.SERIES,
	title: 'The Expanse',
	normalizedTitle: 'expanse',
	year: 2015,
	seasonNumber: null,
	episodeNumber: null,
	externalIds: { tvdb: '1' },
	overview: 'Belters.',
	artworkItemId: 'm1',
	sync: SyncState.OUTDATED,
	quality: mediaItem.quality,
	sources: [{
		itemId: 'm1',
		serviceId: 's1',
		serviceName: 'Living room',
		serviceType: MediaServiceType.JELLYFIN,
		shared: true,
		filesMounted: true,
		peerId: null,
		peerName: null,
		quality: mediaItem.quality,
		companions: null,
		bytes: 100,
		local: true,
		sync: SyncState.OUTDATED,
	}],
	childCount: 1,
	missingCount: 1,
	libraryId: 'l1',
	parentId: null,
	addedAt: null,
};

const transfer = {
	id: 't1',
	jobId: null,
	itemId: 'm1',
	contentId: 'v1:cid',
	title: 'Pilot',
	kind: 'episode',
	state: TransferState.FAILED,
	targetPath: '/media/shows/pilot.mkv',
	bytesTotal: 1000,
	bytesDone: 100,
	rate: 0,
	etaSeconds: null,
	sources: [{
		serviceId: 's1',
		serviceName: 'Living room',
		peerId: 'p1',
		peerName: 'Bob',
		transport: 'swarm',
		rate: 0,
		bytesDone: 100,
		connections: 1,
		healthy: false,
	}],
	chunkSize: 100,
	chunksTotal: 10,
	chunksDone: 1,
	error: 'error.transfer.no_space',
	errorKind: TransferErrorKind.CHECKSUM_MISMATCH,
	chunksRepaired: 1,
	lastVerifiedAt: null,
	startedAt: null,
	finishedAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const job = {
	id: 'j1',
	planId: 'pl1',
	planName: 'Nightly',
	state: 'running',
	trigger: SyncTrigger.SCHEDULE,
	startedAt: '2026-02-01T00:00:00.000Z',
	finishedAt: null,
	itemsPlanned: 4,
	itemsDone: 1,
	itemsFailed: 1,
	bytesPlanned: 100,
	bytesDone: 10,
	error: null,
	createdAt: '2026-02-01T00:00:00.000Z',
};

const plan = {
	id: 'pl1',
	name: 'Nightly',
	enabled: true,
	trigger: SyncTrigger.SCHEDULE,
	schedule: '0 4 * * *',
	sourceServiceIds: ['s1'],
	targetLibraryId: 'l1',
	rootItemId: 'm1',
	filter: { missingOnly: true, kinds: [MediaKind.EPISODE], minYear: 2000, maxBytes: 1024, titleMatches: 'the' },
	lastRunAt: '2026-02-01T00:00:00.000Z',
	nextRunAt: '2026-02-02T04:00:00.000Z',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const settings = {
	placement: PlacementStrategy.FIXED_PATH,
	fixedPath: '/media/incoming',
	namingOrder: [NamingScheme.STANDARD],
	pullMetadata: true,
	preferSourceMetadata: true,
	maxParallelTransfers: 2,
	maxConnectionsPerSource: 4,
	chunkSize: 4_194_304,
	downloadRateLimit: 1024,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	peerMaxDepth: 3,
	allowSwarm: true,
	transferHistoryDays: 30,
	failedHistoryDays: 180,
	refreshIntervalMinutes: 15,
	fullScanCron: '0 4 * * 1',
	cacheTtlSeconds: 60,
};

const user = {
	id: 'u1',
	username: 'ada',
	displayName: 'Ada',
	email: null,
	role: UserRole.ADMIN,
	provider: 'service:1',
	providerUserId: 'jf-1',
	avatarUrl: null,
	lastSeenAt: '2026-02-01T00:00:00.000Z',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const policy = {
	id: 'sp1',
	libraryId: 'l1',
	libraryName: 'Shows',
	serviceId: 's1',
	visibility: ShareVisibility.FRIENDS,
	allowedPeerIds: [],
	deniedPeerIds: [],
	rateLimit: 0,
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const ROUTES: Record<string, { status?: number; body?: unknown }> = {
	'/api/services/s1/libraries': { body: [library] },
	'/api/services/s1/probe': { body: { reachable: true, authenticated: true, type: MediaServiceType.JELLYFIN, version: '10.9', serverName: 'attic', libraries: [], error: null } },
	'/api/services/s1/refresh': {},
	'/api/services/s1/scan': {},
	'/api/services/probe': { body: { reachable: true, authenticated: true, type: MediaServiceType.JELLYFIN, version: '10.9', serverName: 'attic', libraries: [], error: null } },
	'/api/services/s1': { body: service },
	'/api/services': { body: [service] },
	'/api/libraries/categories': { body: [category] },
	'/api/libraries/check': { body: [check] },
	'/api/libraries/l1': { body: library },
	'/api/libraries': { body: [library] },
	'/api/media/groups/m1/children': { body: { items: [{ ...mediaGroup, id: 'm2', kind: MediaKind.SEASON, seasonNumber: 1, sync: SyncState.MISSING, childCount: 0, missingCount: 2 }], pagination: { page: 1, limit: 200, total: 1, pages: 1 } } },
	'/api/media/groups/m1': { body: mediaGroup },
	'/api/media/groups': { body: { items: [mediaGroup], pagination: { page: 1, limit: 24, total: 1, pages: 1 } } },
	'/api/media/m1/children': { body: { items: [{ ...mediaItem, id: 'm2', kind: MediaKind.EPISODE, sync: SyncState.MISSING }], pagination: null } },
	'/api/media/m1/matches': { body: [] },
	'/api/media/m1': { body: { ...mediaItem, childCount: 1 } },
	'/api/media': { body: { items: [mediaItem], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } },
	'/api/peers/identity': { body: { nodeId: 'node-7f3a', fingerprint: 'FF:EE', name: 'me', directAddress: '1.2.3.4:4210', directReachable: false } },
	'/api/peers/invites': { body: { code: 'C', fingerprint: 'AB', address: 'https://ours.example.org', expiresAt: '2030-01-01T00:00:00.000Z', url: 'mcs://invite/C' } },
	'/api/peers/p1/services': { body: [service] },
	'/api/peers/p1/connect': { body: peer },
	'/api/peers/p1/reading': { body: peer },
	'/api/peers/p1': { body: peer },
	'/api/peers': { body: [peer] },
	'/api/sync/plans/for-item/m1': { body: { suggestedName: 'Pilot', covering: [], extendable: [] } },
	'/api/sync/plans/for-item': { body: plan },
	'/api/sync/estimate': { body: { itemCount: 1, bytes: 10, unbounded: false, truncated: false, computedAt: '2026-02-02T00:00:00.000Z' } },
	'/api/sync/plans/pl1': { body: plan },
	'/api/sync/plans': { body: [plan] },
	'/api/sync/jobs/j1/cancel': { body: { ...job, state: 'cancelled' } },
	'/api/sync/jobs': { body: { items: [job], pagination: { page: 1, limit: 20, total: 1, pages: 1 } } },
	'/api/sync/preview': { body: { itemsPlanned: 1, bytesPlanned: 10, items: [{ itemId: 'm1', title: 'Pilot', kind: 'episode', sourceServiceId: 's1', sourceServiceName: 'Living room', targetPath: '/media/shows/pilot.mkv', bytes: 10, state: 'missing' }] } },
	'/api/sync/run': { body: job },
	'/api/transfers/stats': { body: { active: 1, queued: 2, paused: 1, failed: 1, rate: 500, bytesRemaining: 900 } },
	'/api/transfers/unconfigured': { body: [] },
	'/api/transfers/t1/chunks': { body: [{ index: 0, start: 0, end: 99, state: 'corrupt', bytesDone: 0, sourceServiceId: 's1', attempts: 2, checksum: null }] },
	'/api/transfers/t1/revalidations': { body: [] },
	'/api/transfers/t1/verify': { body: { transferId: 't1', ok: false, chunksChecked: 10, chunksCorrupt: 1, bytesToRepair: 100, checkedAt: '2026-02-02T00:00:00.000Z' } },
	'/api/transfers/t1/repair': { body: transfer },
	'/api/transfers/t1/pause': { body: transfer },
	'/api/transfers/t1/resume': { body: transfer },
	'/api/transfers/t1/cancel': { body: transfer },
	'/api/transfers/t1/retry': { body: transfer },
	'/api/transfers': { body: { items: [transfer], pagination: { page: 1, limit: 20, total: 1, pages: 1 } } },
	'/api/shares/audit/p1': { body: { peerId: 'p1', peerName: 'Bob', trust: 'friend', libraries: [{ libraryId: 'l1', name: 'Shows', itemCount: 10 }] } },
	'/api/shares/l1': { body: policy },
	'/api/shares': { body: [policy] },
	'/api/settings': { body: settings },
	'/api/users/u1': { body: user },
	'/api/users': { body: [user] },
};

const PAGES: [string, Component, Record<string, unknown>][] = [
	['Dashboard', Dashboard, {}],
	['Library', Library, {}],
	['LibraryItem', LibraryItem, { itemId: 'm1' }],
	['Services', Services, {}],
	['Service', Service, { id: 's1' }],
	['Peers', Peers, {}],
	['Peer', Peer, { id: 'p1' }],
	['Sync', Sync, {}],
	['SyncPlan', SyncPlan, { id: 'pl1' }],
	['Transfers', Transfers, {}],
	['Settings', Settings, {}],
	['SettingsShares', SettingsShares, {}],
	['SettingsUsers', SettingsUsers, {}],
];

describe('every control on every page', () => {
	it.each(PAGES)('%s presses without anything throwing', async (_name, page, props) => {
		stubFetchRoutes(ROUTES);
		const errors: unknown[] = [];
		const { wrapper } = mountWithApp(page, {
			props,
			global: {
				stubs: { ...tooltipStub, ...dialogStub },
				config: { errorHandler: (error: unknown) => errors.push(error) },
			},
		});
		await settle();

		for (const button of wrapper.findAll('button')) {
			if (button.attributes('disabled') !== undefined) {
				continue;
			}
			await button.trigger('click');
			await settle(2);
		}

		expect(errors).toEqual([]);
		expect(wrapper.html().length).toBeGreaterThan(0);
	});
});
