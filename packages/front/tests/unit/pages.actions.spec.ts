import {
	LibraryKind,
	MediaServiceStatus,
	MediaServiceType,
	NamingScheme,
	PeerStatus,
	PeerTrust,
	PlacementStrategy,
	Right,
	SyncState,
	SyncTrigger,
	TransferErrorKind,
	TransferState,
	UserRole,
} from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import App from '@/App.vue';
import { useByteSize } from '@/composables/useByteSize';
import { useCatalogue } from '@/composables/useCatalogue';
import { useChunkMap } from '@/composables/useChunkMap';
import { useCron } from '@/composables/useCron';
import { useTransferError } from '@/composables/useTransferError';
import Library from '@/pages/Library.vue';
import Peers from '@/pages/Peers.vue';
import Services from '@/pages/Services.vue';
import Settings from '@/pages/Settings.vue';
import SettingsUsers from '@/pages/SettingsUsers.vue';
import Sync from '@/pages/Sync.vue';
import Transfers from '@/pages/Transfers.vue';
import { loadLocaleMessages } from '@/plugins/i18n';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function called (stub: ReturnType<typeof stubFetchRoutes>, fragment: string): boolean {
	return stub.mock.calls.some(call => String(call[0]).includes(fragment));
}

const service = {
	id: 's1',
	name: 'Living room',
	type: MediaServiceType.JELLYFIN,
	shared: true,
	filesMounted: true,
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
};

const library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Shows',
	kind: LibraryKind.SHOWS,
	paths: [],
	localPath: '/media/shows',
	writable: true,
	isDefaultTarget: false,
	itemCount: 10,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const peer = {
	id: 'p1',
	name: 'Bob',
	fingerprint: 'AB:CD',
	status: PeerStatus.LINKED,
	direction: null,
	trust: PeerTrust.FRIEND,
	readingForbidden: false,
	linkMode: null,
	address: null,
	viaPeerId: null,
	viaPeerName: null,
	serviceCount: 1,
	sharedItemCount: 3,
	lastSeenAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('pages/Services actions', () => {
	const routes = {
		'/api/services/s1/probe': { body: { reachable: true, authenticated: true, libraries: [] } },
		'/api/services/s1/refresh': {},
		'/api/services/s1/scan': {},
		'/api/services/s1': { body: service },
		'/api/services': { body: [service] },
	};

	it('checks, scans and refreshes the service a row belongs to', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Services, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="service-row-probe"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="service-scan"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="service-refresh"]').trigger('click');
		await settle();

		expect(called(stub, '/services/s1/probe')).toBe(true);
		expect(called(stub, '/services/s1/scan')).toBe(true);
		expect(called(stub, '/services/s1/refresh')).toBe(true);
	});

	/** Removing a service takes everything indexed from it with it, so it is asked. */
	it('asks before removing a service, then removes it', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Services, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="service-remove"]').trigger('click');
		await settle(2);
		expect(called(stub, 'DELETE')).toBe(false);

		(wrapper.vm as any).confirmRemove();
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true);
		expect(wrapper.findAll('[data-test="service-row"]')).toHaveLength(0);
	});

	it('opens the form to register a service, and closes it once one is saved', async () => {
		stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Services, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="service-add"]').trigger('click');
		await settle(2);
		expect((wrapper.vm as any).dialogOpen).toBe(true);

		await (wrapper.vm as any).onSaved();
		await settle();
		expect((wrapper.vm as any).dialogOpen).toBe(false);
	});

	it('shows the progress of a scan somebody else started', async () => {
		stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Services, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect((wrapper.vm as any).scanProgress('s1')).toBeNull();
	});
});

describe('pages/Peers actions', () => {
	const routes = {
		'/api/peers/identity': {
			body: { fingerprint: 'AB', name: 'me', rendezvous: 'wss://r', directAddress: '1.2.3.4:4210', directReachable: true },
		},
		'/api/peers/p1/connect': { body: peer },
		'/api/peers/p1/reading': { body: { ...peer, readingForbidden: true } },
		'/api/peers/p1': { body: { ...peer, name: 'Robert' } },
		'/api/peers': { body: [peer] },
	};

	it('tries the link again for the peer a card belongs to', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="peer-connect"]').trigger('click');
		await settle();

		expect(called(stub, '/peers/p1/connect')).toBe(true);
	});

	it('asks before forbidding a peer to read, then sends the flag', async () => {
		// Confirmed rather than done on the click, because the consequence is
		// counter-intuitive: the link is kept and the peer keeps talking to us.
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="peer-forbid-reading"]').trigger('click');
		await settle(2);

		expect((wrapper.vm as any).reading).toMatchObject({ forbid: true });
		expect(called(stub, '/peers/p1/reading')).toBe(false);

		await (wrapper.vm as any).confirmReading();
		await settle();

		const patch = stub.mock.calls.find(call => String(call[0]).includes('/peers/p1/reading'));

		expect(patch?.[1]?.method).toBe('PATCH');
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ forbidden: true });
	});

	it('offers the way back on a peer that is already forbidden', async () => {
		const stub = stubFetchRoutes({
			...routes,
			'/api/peers/p1/reading': { body: { ...peer, readingForbidden: false } },
			'/api/peers': { body: [{ ...peer, readingForbidden: true }] },
		});
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		// The card says so as well as offering the way out: the trade is what somebody
		// forgets a week later.
		expect(wrapper.find('[data-test="peer-reading-forbidden"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="peer-forbid-reading"]').exists()).toBe(false);

		await wrapper.find('[data-test="peer-allow-reading"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).confirmReading();
		await settle();

		const patch = stub.mock.calls.find(call => String(call[0]).includes('/peers/p1/reading'));

		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ forbidden: false });
	});

	it('renames a peer to whatever the viewer calls them', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="peer-rename"]').trigger('click');
		await settle(2);
		(wrapper.vm as any).renameValue = 'Robert';
		await (wrapper.vm as any).confirmRename();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: 'Robert' });
	});

	it('asks before dropping a link, then drops it without refusing the key', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="peer-remove"]').trigger('click');
		await settle(2);

		// The checkbox that used to offer a ban here is gone: the standalone action
		// made it a second way to reach the same outcome.
		expect(wrapper.find('[data-test="peer-remove-ban"]').exists()).toBe(false);

		await (wrapper.vm as any).confirmRemove();
		await settle();

		const removal = stub.mock.calls.find(call => call[1]?.method === 'DELETE');

		expect(removal).toBeDefined();
		expect(removal?.[1]?.body ?? null).toBeNull();
	});

	it('reloads once an invitation has linked somebody', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Peers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();
		const before = stub.mock.calls.length;

		await (wrapper.vm as any).onLinked();
		await settle();

		expect(stub.mock.calls.length).toBeGreaterThan(before);
	});
});

describe('pages/Sync actions', () => {
	const plan = {
		id: 'pl1',
		name: 'Nightly',
		enabled: true,
		trigger: SyncTrigger.SCHEDULE,
		schedule: '0 4 * * *',
		sourceServiceIds: ['s1'],
		targetLibraryId: 'l1',
		scope: {},
		maxItemsPerRun: null,
		maxBytesPerRun: null,
		estimate: null,
		filter: {},
		lastRunAt: null,
		nextRunAt: null,
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
		itemsFailed: 0,
		bytesPlanned: 100,
		bytesDone: 10,
		error: null,
		createdAt: '2026-02-01T00:00:00.000Z',
	};

	const routes = {
		'/api/sync/plans/pl1': { body: { ...plan, enabled: false } },
		'/api/sync/plans': { body: [plan] },
		'/api/sync/jobs/j1/cancel': { body: { ...job, state: 'cancelled' } },
		'/api/sync/jobs': { body: { items: [job], pagination: null } },
		'/api/sync/run': { body: job },
		'/api/services': { body: [service] },
		'/api/libraries': { body: [library] },
	};

	it('runs a plan now, and names the plan rather than repeating its body', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Sync, { global: { stubs: { ...tooltipStub, ...dialogStub } } });
		await settle();

		await wrapper.find('[data-test="plan-run"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(JSON.parse(String(run?.[1]?.body))).toEqual({ planId: 'pl1' });
	});

	it('disables a plan without deleting it', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Sync, { global: { stubs: { ...tooltipStub, ...dialogStub } } });
		await settle();

		await wrapper.find('[data-test="plan-toggle"]').trigger('click');
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: false });
	});

	it('cancels a run that is still going', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Sync, { global: { stubs: { ...tooltipStub, ...dialogStub } } });
		await settle();

		await wrapper.find('[data-test="job-cancel"]').trigger('click');
		await settle();

		expect(called(stub, '/sync/jobs/j1/cancel')).toBe(true);
	});

	it('asks before removing a plan, then removes it', async () => {
		const stub = stubFetchRoutes(routes);
		const { wrapper } = mountWithApp(Sync, { global: { stubs: { ...tooltipStub, ...dialogStub } } });
		await settle();

		await wrapper.find('[data-test="plan-remove"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).confirmRemove();
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true);
		expect(wrapper.findAll('[data-test="plan-row"]')).toHaveLength(0);
	});

	it('names the services a plan pins, in the order it will consult them', async () => {
		stubFetchRoutes({
			...routes,
			'/api/sync/plans': { body: [{ ...plan, sourceServiceIds: ['s1'] }] },
		});
		const { wrapper } = mountWithApp(Sync, { global: { stubs: { ...tooltipStub, ...dialogStub } } });
		await settle();

		expect(wrapper.find('[data-test="plan-row"]').text()).toContain('Living room');
		expect(wrapper.find('[data-test="plan-row"]').text()).toContain('Shows');
	});
});

describe('pages/SettingsUsers actions', () => {
	const user = {
		id: 'u1',
		username: 'ada',
		displayName: 'Ada',
		email: null,
		role: UserRole.USER,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		lastSeenAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};

	it('changes a role, which is the one thing the gateway owns', async () => {
		const stub = stubFetchRoutes({
			'/api/users/u1': { body: { ...user, role: UserRole.ADMIN } },
			'/api/users': { body: [user] },
		});
		const { wrapper } = mountWithApp(SettingsUsers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await (wrapper.vm as any).changeRole(user, UserRole.ADMIN);
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ role: 'admin' });
	});

	it('does nothing when the role picked is the one already held', async () => {
		const stub = stubFetchRoutes({ '/api/users': { body: [user] } });
		const { wrapper } = mountWithApp(SettingsUsers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();
		const before = stub.mock.calls.length;

		await (wrapper.vm as any).changeRole(user, UserRole.USER);
		await settle();

		expect(stub.mock.calls.length).toBe(before);
	});

	it('asks before removing an account, then removes it', async () => {
		const stub = stubFetchRoutes({ '/api/users/u1': {}, '/api/users': { body: [user] } });
		const { wrapper } = mountWithApp(SettingsUsers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="user-remove"]').trigger('click');
		await settle(2);
		await (wrapper.vm as any).confirmRemove();
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true);
		expect(wrapper.findAll('[data-test="user-row"]')).toHaveLength(0);
	});
});

describe('pages/Settings saving', () => {
	const settings = {
		placement: PlacementStrategy.BESIDE_EXISTING,
		fixedPath: null,
		namingOrder: [NamingScheme.SOURCE, NamingScheme.STANDARD],
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
		transferHistoryDays: 30,
		refreshIntervalMinutes: 15,
		fullScanCron: '0 4 * * *',
		cacheTtlSeconds: 60,
	};

	/**
	 * One library that can receive files and one on a friend's gateway that cannot.
	 *
	 * The section is only worth testing against something it must refuse: a library
	 * the gateway cannot write into accepts transfers the media server never sees.
	 */
	const placementRoutes = {
		'/api/libraries/categories': {
			body: [
				{
					key: 'movies',
					name: 'Movies',
					kind: LibraryKind.MOVIES,
					position: 0,
					libraryIds: ['l1'],
					serviceIds: ['s1'],
					itemCount: 2,
					local: true,
				},
				{
					key: 'shows',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					position: 1,
					libraryIds: ['l2'],
					serviceIds: ['s1'],
					itemCount: 4,
					local: true,
				},
			],
		},
		'/api/libraries': {
			body: [
				{
					id: 'l1',
					serviceId: 's1',
					externalId: 'x1',
					name: 'Movies',
					alias: null,
					position: 0,
					kind: LibraryKind.MOVIES,
					paths: ['/data/movies'],
					localPath: '/media/movies',
					writable: true,
					isDefaultTarget: false,
					itemCount: 2,
					lastScanAt: null,
					lastRefreshAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					id: 'l2',
					serviceId: 's1',
					externalId: 'x2',
					name: 'Shows',
					alias: null,
					position: 1,
					kind: LibraryKind.SHOWS,
					paths: ['/data/shows'],
					localPath: '/media/shows',
					writable: true,
					isDefaultTarget: false,
					itemCount: 4,
					lastScanAt: null,
					lastRefreshAt: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		},
		'/api/services': {
			body: [{
				id: 's1',
				name: 'Jellyfin (mine)',
				type: MediaServiceType.JELLYFIN,
				shared: true,
				filesMounted: true,
				baseUrl: 'https://jellyfin.local',
				status: MediaServiceStatus.ONLINE,
			}],
		},
	};

	it('sends where each category goes, chosen from the table, with everything else', async () => {
		// The whole point of the section: a choice made in the table has to reach the
		// gateway, or the screen is a picture of a setting rather than the setting.
		const stub = stubFetchRoutes({ '/api/settings': { body: settings }, ...placementRoutes });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const table = wrapper.findComponent({ name: 'CategoryTargetsTable' });
		table.findAllComponents({ name: 'VSelect' })[1].vm.$emit('update:modelValue', 'l2');
		await settle();

		(wrapper.vm as any).model.defaultTargetLibraryId = 'l1';
		await (wrapper.vm as any).form.handle();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		const body = JSON.parse(String(patch?.[1]?.body));

		expect(body.categoryTargets).toEqual({ shows: 'l2' });
		expect(body.defaultTargetLibraryId).toBe('l1');
		// Alongside, not instead of: one form saves the whole page.
		expect(body.namingOrder).toEqual([NamingScheme.SOURCE, NamingScheme.STANDARD]);
		expect(body.cacheTtlSeconds).toBe(60);
	});

	/**
	 * The naming order, which is a chain on screen and has to be one in the request.
	 *
	 * The control replaced a select of three exclusive values, so the thing worth
	 * pinning is that an order survives the round trip in the order it was read in:
	 * a screen that showed a chain and saved a single step would be exactly the lie
	 * the select was.
	 */
	it('reads the naming chain as a numbered list, steps and convention', async () => {
		stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const rows = wrapper.findAll('[data-test="settings-naming-order"] > li');

		// Two stored steps plus the convention's own line, in the stored order.
		expect(rows).toHaveLength(2);
		expect(wrapper.find('[data-test="settings-naming-step-source"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="settings-naming-convention"]').exists()).toBe(true);
		// The step nobody chose is offered rather than hidden, or somebody concludes
		// that imitating their own library is not something this gateway can do.
		expect(wrapper.find('[data-test="settings-naming-add-local"]').exists()).toBe(true);
	});

	it('saves the order somebody moved a step in', async () => {
		const stub = stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="settings-naming-add-local"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="settings-naming-up-local"]').trigger('click');
		await settle();

		await (wrapper.vm as any).form.handle();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		const body = JSON.parse(String(patch?.[1]?.body));

		expect(body.namingOrder).toEqual([
			NamingScheme.LOCAL,
			NamingScheme.SOURCE,
			NamingScheme.STANDARD,
		]);
	});

	it('keeps the convention last when another one is chosen', async () => {
		// Nothing may follow it: every step behind a convention is a step that can
		// never run, and the API refuses such an order.
		const stub = stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		const select = wrapper.findComponent({ name: 'NamingOrderField' })
			.findComponent({ name: 'VSelect' });
		select.vm.$emit('update:modelValue', NamingScheme.DOTTED);
		await settle();

		await (wrapper.vm as any).form.handle();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		const body = JSON.parse(String(patch?.[1]?.body));

		expect(body.namingOrder).toEqual([NamingScheme.SOURCE, NamingScheme.DOTTED]);
	});

	it('sends the sizes as byte counts and an empty cap as no cap', async () => {
		const stub = stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		(wrapper.vm as any).model.chunkSize = '8M';
		(wrapper.vm as any).model.downloadRateLimit = '';
		await (wrapper.vm as any).form.handle();
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		const body = JSON.parse(String(patch?.[1]?.body));
		expect(body.chunkSize).toBe(8 * 1024 ** 2);
		expect(body.downloadRateLimit).toBe(0);
		expect(body.fullScanCron).toBe('0 4 * * *');
	});

	it('switches pane when a tab is clicked', async () => {
		stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect((wrapper.vm as any).tab).toBe('placement');

		await wrapper.find('[data-test="settings-tab-transfers"]').trigger('click');
		await settle();

		expect((wrapper.vm as any).tab).toBe('transfers');
	});

	it('opens the tab holding a refused field, and marks it', async () => {
		// One form saves every setting at once, so a refusal can land on a tab nobody
		// is looking at: the screen would say the settings were refused, show nothing
		// visible, and leave somebody pressing save again.
		stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('[data-test="settings-tab-error"]').exists()).toBe(false);

		stubFetchRoutes({
			'/api/settings': {
				status: 400,
				body: { key: 'error.settings.invalid', field: 'peerMaxDepth' },
			},
		});
		await (wrapper.vm as any).form.handle();
		await settle();

		expect(wrapper.find('[data-test="settings-tab-error"]').exists()).toBe(true);
		expect((wrapper.vm as any).tab).toBe('peers');
	});

	it('puts a refusal under the field it names, wherever it sits on the page', async () => {
		// One form saves every setting at once. A refusal that only reached the top of
		// the screen would leave somebody with twenty boxes and no idea which to change.
		stubFetchRoutes({ '/api/settings': { body: settings } });
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		stubFetchRoutes({
			'/api/settings': {
				status: 400,
				body: { key: 'error.settings.invalid', field: 'peerMaxDepth' },
			},
		});
		await (wrapper.vm as any).form.handle();
		await settle();

		expect((wrapper.vm as any).form.fieldErrors.peerMaxDepth).toBeTruthy();
		expect(wrapper.find('[data-test="settings-peer-depth"]').text())
			.toContain('These settings were refused');
	});

	it('offers a retry when the settings cannot be read', async () => {
		stubFetchRoutes({});
		const { wrapper } = mountWithApp(Settings, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
	});
});

describe('pages/Library syncing a selection', () => {
	const group = {
		id: 'm1',
		kind: 'series',
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2019,
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
	};

	it('sends the selected identifiers, and clears the selection afterwards', async () => {
		const stub = stubFetchRoutes({
			'/api/services': { body: [service] },
			'/api/libraries': { body: [library] },
			'/api/media/groups': { body: { items: [group], pagination: { page: 1, limit: 24, total: 1, pages: 1 } } },
			'/api/sync/run': { body: { id: 'j1' } },
		});
		const { wrapper } = mountWithApp(Library, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		// Picking one tile is what opens the selection bar, and the bar is where
		// "everything on this page" and the action live on a poster wall.
		await wrapper.find('[data-test="media-select"] input').setValue(true);
		await settle(2);
		await wrapper.find('[data-test="media-select-all"] input').setValue(true);
		await settle(2);
		await wrapper.find('[data-test="library-sync-selected"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(JSON.parse(String(run?.[1]?.body))).toEqual({ scope: { itemIds: ['m1'] } });
		expect(wrapper.find('[data-test="library-selection-bar"]').exists()).toBe(false);
	});
});

describe('pages/Transfers repairing', () => {
	function transferRow (overrides: Record<string, unknown> = {}) {
		return {
			id: 't1',
			jobId: null,
			itemId: 'm1',
			contentId: null,
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
				peerId: null,
				peerName: null,
				transport: 'http_range',
				rate: 0,
				bytesDone: 100,
				connections: 0,
				healthy: false,
			}],
			chunkSize: 100,
			chunksTotal: 10,
			chunksDone: 1,
			error: 'error.transfer.no_space',
			errorKind: TransferErrorKind.DISK_FULL,
			chunksRepaired: 0,
			lastVerifiedAt: null,
			startedAt: null,
			finishedAt: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			...overrides,
		};
	}

	const base = {
		'/api/libraries/check': {
			body: [{ libraryId: 'l1', name: 'Shows', localPath: '/media/shows', exists: true, readable: true, writable: true, freeBytes: 10, error: null }],
		},
		'/api/libraries': { body: [library] },
		'/api/services': { body: [service] },
		'/api/transfers/stats': {
			body: { active: 0, queued: 0, paused: 0, failed: 1, rate: 0, bytesRemaining: 900 },
		},
		'/api/sync/run': { body: { id: 'j1' } },
	};

	/** The full-disk case: the fitting action asks where to put it instead. */
	it('asks which library to pull into, then plans the item again there', async () => {
		const stub = stubFetchRoutes({
			...base,
			'/api/transfers': {
				body: { items: [transferRow()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
			},
		});
		const { wrapper } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="transfer-another_target"]').trigger('click');
		await settle(2);
		expect((wrapper.vm as any).retargeting).not.toBeNull();

		(wrapper.vm as any).targetLibraryId = 'l1';
		await (wrapper.vm as any).confirmRetarget();
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		expect(JSON.parse(String(run?.[1]?.body)))
			.toEqual({ scope: { itemIds: ['m1'] }, targetLibraryId: 'l1' });
	});

	it('sends somebody to the service whose credentials were refused', async () => {
		stubFetchRoutes({
			...base,
			'/api/transfers': {
				body: {
					items: [transferRow({ errorKind: TransferErrorKind.SOURCE_UNAUTHORIZED })],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper, router } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();
		// The guard would send an unauthenticated test to the sign-in page, so what
		// is asserted is where the row asked to go.
		const push = vi.spyOn(router, 'push');

		await wrapper.find('[data-test="transfer-fix_service"]').trigger('click');
		await settle();

		expect(push).toHaveBeenCalledWith({ name: 'service', params: { id: 's1' } });
	});

	it('verifies what is on disk without committing to a repair', async () => {
		const stub = stubFetchRoutes({
			...base,
			'/api/transfers/t1/verify': {
				body: { transferId: 't1', ok: true, chunksChecked: 10, chunksCorrupt: 0, bytesToRepair: 0, checkedAt: '2026-02-02T00:00:00.000Z' },
			},
			'/api/transfers': {
				body: {
					items: [transferRow({ state: TransferState.DONE, errorKind: null, error: null })],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="transfer-verify"]').trigger('click');
		await settle();

		expect(called(stub, '/transfers/t1/verify')).toBe(true);
		expect(called(stub, '/transfers/t1/repair')).toBe(false);
		expect(wrapper.find('[data-test="transfer-verification"]').text()).toContain('intact');
	});

	it('resumes a whole queue that is holding', async () => {
		const stub = stubFetchRoutes({
			...base,
			'/api/transfers/stats': {
				body: { active: 0, queued: 0, paused: 1, failed: 0, rate: 0, bytesRemaining: 900 },
			},
			'/api/transfers/t1/resume': { body: transferRow({ state: TransferState.DOWNLOADING, errorKind: null }) },
			'/api/transfers': {
				body: {
					items: [transferRow({ state: TransferState.PAUSED, errorKind: null, error: null })],
					pagination: { page: 1, limit: 20, total: 1, pages: 1 },
				},
			},
		});
		const { wrapper } = mountWithApp(Transfers, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await settle();

		await wrapper.find('[data-test="transfer-resume-all"]').trigger('click');
		await settle();

		expect(called(stub, '/transfers/t1/resume')).toBe(true);
	});
});

describe('App shell actions', () => {
	async function signedIn () {
		vi.stubGlobal('WebSocket', class {
			addEventListener () {} close () {}
		} as unknown as typeof WebSocket);
		const stub = stubFetchRoutes({
			'/api/auth/logout': {},
			'/api/settings': { body: {} },
			'/api/services': { body: [] },
			'/api/libraries/check': { body: [] },
			'/api/libraries': { body: [] },
			'/api/peers': { body: [] },
			'/api/transfers/stats': {
				body: { active: 0, queued: 0, paused: 0, failed: 0, rate: 0, bytesRemaining: 0 },
			},
			'/api/transfers': { body: { items: [], pagination: null } },
			'/api/sync/jobs': { body: { items: [], pagination: null } },
			'/api/media': { body: { items: [], pagination: null } },
		});
		const mounted = mountWithApp(App, { global: { stubs: tooltipStub } });
		await mounted.router.push({ name: 'dashboard' });
		useTokenStore(mounted.pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', role: UserRole.ADMIN },
			rights: Object.values(Right),
		} as never);
		useAuthStore(mounted.pinia).ready = true;
		await settle();
		return { ...mounted, stub };
	}

	it('switches the theme and remembers the choice', async () => {
		const { wrapper } = await signedIn();

		const before = (wrapper.vm as any).currentTheme;
		(wrapper.vm as any).toggleTheme();
		await settle(2);

		expect((wrapper.vm as any).currentTheme).not.toBe(before);
		expect(window.localStorage.getItem('mcs.theme')).toBe((wrapper.vm as any).currentTheme);
	});

	it('changes the language of the whole interface', async () => {
		const { wrapper } = await signedIn();

		(wrapper.vm as any).changeLocale('fr');
		// Only English is bundled, so the switch is immediate and the French strings
		// arrive with the chunk. Waiting on the load is what the interface does too —
		// it simply does it in the background rather than in an assertion.
		await loadLocaleMessages('fr');
		await settle(2);

		expect(wrapper.find('.app_nav').text()).toContain('Médiathèque');
	});

	it('signs out, which revokes the session server-side first', async () => {
		const { wrapper, pinia, router, stub } = await signedIn();

		await (wrapper.vm as any).signOut();
		await settle();

		expect(called(stub, '/api/auth/logout')).toBe(true);
		expect(useTokenStore(pinia).session).toBeNull();
		expect(router.currentRoute.value.name).toBe('login');
	});
});

/**
 * The composables are used through their named exports everywhere; the `useX`
 * factories exist for the screens that would rather take them as a bundle, and
 * they have to keep handing back the same functions.
 */
describe('composable factories', () => {
	it('hand back the functions the components import directly', () => {
		expect(typeof useByteSize().parseByteSize).toBe('function');
		expect(typeof useCatalogue().toCatalogueEntry).toBe('function');
		expect(typeof useChunkMap().buildChunkMap).toBe('function');
		expect(typeof useCron().describeCron).toBe('function');
		expect(typeof useTransferError().describeTransferError).toBe('function');
	});
});
