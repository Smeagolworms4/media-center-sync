import type { Library, MediaService, SyncPlan } from '@mcs/shared';
import {
	LibraryKind,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	ShareVisibility,
	SyncTrigger,
	TransferErrorKind,
	TransferState,
} from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import CopyField from '@/components/common/CopyField.vue';
import Pagination from '@/components/paginate/Pagination.vue';
import ServiceForm from '@/components/service/ServiceForm.vue';
import SharePolicyForm from '@/components/share/SharePolicyForm.vue';
import PlanForm from '@/components/sync/PlanForm.vue';
import SyncPreviewDialog from '@/components/sync/SyncPreviewDialog.vue';
import TransferActions from '@/components/transfer/TransferActions.vue';
import Window from '@/components/Window.vue';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

function stubClipboard (writeText: (value: string) => Promise<void>): void {
	Object.defineProperty(globalThis.navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	});
}

async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'First',
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
		itemCount: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

const library: Library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Shows',
	kind: LibraryKind.SHOWS,
	paths: [],
	localPath: '/media/shows',
	writable: true,
	isDefaultTarget: false,
	itemCount: 4,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('components/Window', () => {
	it('closes from its own button, and hands a close to what it wraps', async () => {
		const { wrapper } = mountWithApp(Window, {
			props: { modelValue: true, title: 'Linking two gateways' },
			slots: { default: '<p class="body">body</p>' },
			global: { stubs: dialogStub },
		});

		expect(wrapper.find('.body').exists()).toBe(true);

		await wrapper.find('.v-toolbar button').trigger('click');

		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
	});
});

describe('components/common/CopyField', () => {
	it('copies the value and says so for a moment', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		// Only the clipboard is replaced: swapping the whole navigator takes away the
		// user agent string Vuetify reads, and every later mount fails on it.
		stubClipboard(writeText);
		const { wrapper } = mountWithApp(CopyField, {
			props: { value: 'mcs://invite/CODE-1', label: 'Invitation' },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="copy-button"]').trigger('click');
		await settle();

		expect(writeText).toHaveBeenCalledWith('mcs://invite/CODE-1');
	});

	/** The clipboard API is refused over plain HTTP, which is how most of these run. */
	it('keeps the value selectable when the clipboard refuses', async () => {
		stubClipboard(() => Promise.reject(new Error('denied')));
		const { wrapper } = mountWithApp(CopyField, {
			props: { value: 'AB:CD' },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="copy-button"]').trigger('click');
		await settle();

		expect(wrapper.find('.copy-field_value').text()).toBe('AB:CD');
	});
});

describe('components/paginate/Pagination', () => {
	it('walks the pages and goes back to the first one when the size changes', async () => {
		const { wrapper } = mountWithApp(Pagination, {
			props: { page: 1, limit: 20, total: 100, label: 'Rows' },
		});

		// First, previous, next, last — in the order the control lays them out.
		const buttons = wrapper.findAll('.paginate-pagination-action button');
		await buttons[2].trigger('click');
		expect(wrapper.emitted('update:page')?.at(-1)).toEqual([2]);

		await buttons[1].trigger('click');
		expect(wrapper.emitted('update:page')?.at(-1)).toEqual([1]);

		await buttons[0].trigger('click');
		expect(wrapper.emitted('update:page')?.at(-1)).toEqual([0]);

		await buttons[3].trigger('click');
		expect(wrapper.emitted('update:page')?.at(-1)).toEqual([4]);
	});
});

describe('components/sync/PlanForm interactions', () => {
	const plan: SyncPlan = {
		id: 'pl1',
		name: 'Nightly',
		enabled: true,
		trigger: SyncTrigger.SCHEDULE,
		schedule: '0 4 * * *',
		sourceServiceIds: ['s1', 's2'],
		targetLibraryId: null,
		rootItemId: null,
		filter: {},
		lastRunAt: null,
		nextRunAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};

	const services = [service(), service({ id: 's2', name: 'Second' }), service({ id: 's3', name: 'Third' })];

	it('moves a source down the order from the row itself', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		const first = wrapper.findAll('[data-test="plan-source"]')[0];
		const buttons = first.findAll('button');
		await buttons[1].trigger('click');

		expect((wrapper.vm as any).model.sourceServiceIds).toEqual(['s2', 's1']);
	});

	it('takes a source out of the order', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		const buttons = wrapper.findAll('[data-test="plan-source"]')[0].findAll('button');
		await buttons[2].trigger('click');

		expect((wrapper.vm as any).model.sourceServiceIds).toEqual(['s2']);
	});

	it('adds a source that is not pinned yet, and offers only those', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		expect((wrapper.vm as any).availableSources.map((one: MediaService) => one.id)).toEqual(['s3']);

		(wrapper.vm as any).addSource = 's3';
		await nextTick();
		(wrapper.vm as any).pushSource();

		expect((wrapper.vm as any).model.sourceServiceIds).toEqual(['s1', 's2', 's3']);
	});

	it('saves the plan, filters included', async () => {
		const stub = stubFetchRoutes({ '/api/sync/plans/pl1': { body: plan } });
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('form').trigger('submit');
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		const body = JSON.parse(String(patch?.[1]?.body));
		expect(body.name).toBe('Nightly');
		expect(body.sourceServiceIds).toEqual(['s1', 's2']);
		expect(body.filter.missingOnly).toBe(true);
		expect(wrapper.emitted('saved')).toBeDefined();
	});

	it('lets the editor be left alone', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		const cancel = wrapper.findAll('button').find(node => node.text() === 'Cancel');
		await cancel?.trigger('click');

		expect(wrapper.emitted('cancel')).toBeDefined();
	});

	it('drops the cron field when the trigger is not a schedule', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services, libraries: [library] },
			global: { stubs: tooltipStub },
		});

		(wrapper.vm as any).model.trigger = SyncTrigger.MANUAL;
		await nextTick();

		expect(wrapper.find('[data-test="plan-schedule"]').exists()).toBe(false);
	});
});

describe('components/sync/SyncPreviewDialog running', () => {
	it('runs exactly what it previewed, then closes', async () => {
		const stub = stubFetchRoutes({
			'/api/sync/preview': {
				body: {
					itemsPlanned: 1,
					bytesPlanned: 10,
					items: [{
						itemId: 'm1',
						title: 'Pilot',
						kind: 'episode',
						sourceServiceId: 's1',
						sourceServiceName: 'First',
						targetPath: '/media/shows/pilot.mkv',
						bytes: 10,
						state: 'missing',
					}],
				},
			},
			'/api/sync/run': { body: { id: 'j1' } },
		});
		const request = { planId: 'pl1', sourceServiceIds: ['s1'] };
		const { wrapper } = mountWithApp(SyncPreviewDialog, {
			props: { request, modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();
		await wrapper.find('[data-test="sync-run"]').trigger('click');
		await settle();

		const run = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/run'));
		const preview = stub.mock.calls.find(call => String(call[0]).includes('/api/sync/preview'));
		expect(run?.[1]?.body).toBe(preview?.[1]?.body);
		expect(wrapper.emitted('run')).toBeDefined();
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
	});

	it('offers a retry when the preview itself failed', async () => {
		stubFetchRoutes({});
		const { wrapper } = mountWithApp(SyncPreviewDialog, {
			props: { request: { planId: 'pl1' }, modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
	});
});

describe('components/share/SharePolicyForm interactions', () => {
	it('sends the visibility somebody chose, with the peers it applies to', async () => {
		const stub = stubFetchRoutes({
			'/api/shares/l1': {
				body: {
					id: 'sp1',
					libraryId: 'l1',
					libraryName: 'Shows',
					serviceId: 's1',
					visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
					allowedPeerIds: ['p1'],
					deniedPeerIds: [],
					rateLimit: 0,
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			},
		});
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers: [], policy: null },
			global: { stubs: tooltipStub },
		});

		(wrapper.vm as any).model.visibility = ShareVisibility.FRIENDS_OF_FRIENDS;
		(wrapper.vm as any).model.allowedPeerIds = ['p1'];
		await nextTick();
		await wrapper.find('form').trigger('submit');
		await settle();

		const body = JSON.parse(String(stub.mock.calls[0][1]?.body));
		expect(body.visibility).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
		expect(body.allowedPeerIds).toEqual(['p1']);
		expect(wrapper.emitted('saved')).toBeDefined();
	});

	it('explains the rule that is currently chosen', async () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers: [], policy: null },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('A library with no policy is private');

		(wrapper.vm as any).model.visibility = ShareVisibility.FRIENDS;
		await nextTick();

		expect(wrapper.text()).toContain('gateways you linked to yourself');
	});
});

describe('components/service/ServiceForm interactions', () => {
	it('can be left without saving anything', async () => {
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		const cancel = wrapper.findAll('button').find(node => node.text() === 'Cancel');
		await cancel?.trigger('click');

		expect(wrapper.emitted('cancel')).toBeDefined();
	});

	it('reveals the token while it is being typed, because it is typed once', async () => {
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		const field = wrapper.find('[data-test="service-token"]');
		expect(field.find('input').attributes('type')).toBe('password');

		await field.find('.v-field__append-inner .v-icon').trigger('click');
		await nextTick();

		expect(field.find('input').attributes('type')).toBe('text');
	});

	it('forgets a probe answer as soon as the address changes', async () => {
		stubFetchRoutes({
			'/api/services/probe': { body: { reachable: true, authenticated: true, libraries: [], serverName: 'attic', version: '1' } },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('[data-test="service-probe"]').trigger('click');
		await settle();
		expect(wrapper.find('[data-test="service-probe-result"]').exists()).toBe(true);

		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.5:8096');
		await settle(2);

		expect(wrapper.find('[data-test="service-probe-result"]').exists()).toBe(false);
	});
});

describe('components/transfer/TransferActions in a narrow row', () => {
	const transfer = {
		id: 't1',
		jobId: null,
		itemId: 'm1',
		contentId: null,
		title: 'Pilot',
		kind: 'episode',
		state: TransferState.DOWNLOADING,
		targetPath: '/media/shows/pilot.mkv',
		bytesTotal: 1000,
		bytesDone: 1,
		rate: 0,
		etaSeconds: null,
		sources: [],
		chunkSize: 100,
		chunksTotal: 10,
		chunksDone: 0,
		error: null,
		errorKind: null,
		chunksRepaired: 0,
		lastVerifiedAt: null,
		startedAt: null,
		finishedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	} as never;

	it('keeps the actions as icons where there is no room for words', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: { transfer, compact: true },
		});

		expect(wrapper.find('[data-test="transfer-pause"]').text()).toBe('');
		expect(wrapper.find('[data-test="transfer-cancel"]').exists()).toBe(true);
	});

	it('offers nothing while an action is already running', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: {
				transfer: { ...(transfer as object), state: TransferState.FAILED, errorKind: TransferErrorKind.NETWORK } as never,
				busy: true,
			},
		});

		expect(wrapper.find('[data-test="transfer-retry"]').attributes('disabled')).toBeDefined();
	});
});
