import type { Library, MediaService, SyncPlan } from '@mcs/shared';
import {
	LibraryKind,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	SyncTrigger } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import LibraryPathField from '@/components/library/LibraryPathField.vue';
import MatchesDialog from '@/components/media/MatchesDialog.vue';
import InviteDialog from '@/components/peer/InviteDialog.vue';
import ServiceForm from '@/components/service/ServiceForm.vue';
import JobRow from '@/components/sync/JobRow.vue';
import PlanForm from '@/components/sync/PlanForm.vue';
import SyncPreviewDialog from '@/components/sync/SyncPreviewDialog.vue';
import { useLibrariesStore } from '@/stores/libraries';
import { useServicesStore } from '@/stores/services';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

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
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		shared: true,
		filesMounted: true,
		mode: MediaServiceMode.LOCAL,
		baseUrl: 'http://10.0.0.2:8096',
		status: MediaServiceStatus.ONLINE,
		version: null,
		remoteRoot: null,
		localRoot: null,
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
	alias: null,
	position: 0,
	kind: LibraryKind.SHOWS,
	paths: ['/data/shows'],
	localPath: '/media/shows',
	writable: true,
	isDefaultTarget: false,
	itemCount: 10,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('components/service/ServiceForm', () => {
	const probeOk = {
		reachable: true,
		authenticated: true,
		type: MediaServiceType.JELLYFIN,
		version: '10.9',
		serverName: 'attic',
		libraries: [{ externalId: 'x', name: 'Shows', kind: LibraryKind.SHOWS, paths: ['/data/shows'] }],
		error: null,
	};

	it('shows what the probe found, so a wrong token is learned while typing', async () => {
		stubFetchRoutes({ '/api/services/probe': { body: probeOk } });
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		// Testing a connection validates the fields first: there is nothing to probe
		// without an address, and a call that answers "no host" explains nothing.
		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('[data-test="service-probe"]').trigger('click');
		await settle();

		const result = wrapper.find('[data-test="service-probe-result"]');
		expect(result.exists()).toBe(true);
		expect(result.text()).toContain('attic');
		expect(result.text()).toContain('Shows');
		// The kind is translated, not printed as the enum value it arrives as.
		expect(result.text()).toContain('Series');
	});

	it('reports a refused probe through the form error, not only in the panel', async () => {
		stubFetchRoutes({
			'/api/services/probe': {
				body: { ...probeOk, reachable: false, authenticated: false, error: 'error.service.unreachable' },
			},
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Nowhere');
		await wrapper.find('[data-test="service-url"] input').setValue('http://127.0.0.1:1');
		await wrapper.find('[data-test="service-probe"]').trigger('click');
		await settle();

		const error = wrapper.find('[data-test="form-main-error"]');
		expect(error.exists()).toBe(true);
		// A key nobody translated would reach the screen as a dotted identifier.
		expect(error.text()).not.toContain('error.service');
	});

	it('does not register anything when the connection is only being tested', async () => {
		const stub = stubFetchRoutes({
			'/api/services/probe': { body: probeOk },
			'/api/services': { body: service() },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('[data-test="service-probe"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'POST' && String(call[0]).endsWith('/api/services'))).toBe(false);
		expect(wrapper.emitted('saved')).toBeUndefined();
	});

	/** Saving a service nothing can reach registers a row that will never work. */
	it('probes before saving and refuses to save what did not answer', async () => {
		const stub = stubFetchRoutes({
			'/api/services/probe': {
				body: { ...probeOk, reachable: false, authenticated: false, error: 'error.service.unreachable' },
			},
			'/api/services': { body: service() },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(stub.mock.calls.some(call => String(call[0]).endsWith('/api/services'))).toBe(false);
		expect(wrapper.find('[data-test="form-main-error"]').text()).toContain('did not answer');
		expect(wrapper.emitted('saved')).toBeUndefined();
	});

	it('saves once the probe has answered, and reports the service it created', async () => {
		stubFetchRoutes({
			'/api/services/probe': { body: probeOk },
			'/api/services': { body: service({ id: 'new' }) },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ id: 'new' });
	});

	it('sends both roots, so a service states once where its files are for us', async () => {
		const stub = stubFetchRoutes({
			'/api/services/probe': { body: probeOk },
			'/api/services': { body: service({ id: 'new' }) },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('[data-test="service-remote-root"] input').setValue('/media');
		await wrapper.find('[data-test="service-local-root"] input').setValue('/mnt/nas');
		await wrapper.find('form').trigger('submit');
		await settle();

		const post = stub.mock.calls.find(
			call => call[1]?.method === 'POST' && String(call[0]).endsWith('/api/services'),
		);

		expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
			remoteRoot: '/media',
			localRoot: '/mnt/nas',
		});
	});

	it('spells an empty mapping as null, which is a mapping being withdrawn', async () => {
		const stub = stubFetchRoutes({
			'/api/services/probe': { body: probeOk },
			'/api/services': { body: service({ id: 'new' }) },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('form').trigger('submit');
		await settle();

		const post = stub.mock.calls.find(
			call => call[1]?.method === 'POST' && String(call[0]).endsWith('/api/services'),
		);

		expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
			remoteRoot: null,
			localRoot: null,
		});
	});

	/**
	 * The one decision about sharing somebody declares.
	 *
	 * It replaces a select labelled "Scope" whose values were `local` and `remote` —
	 * words that read as a position on a network, so the owner's own Jellyfin on their
	 * own LAN was registered `remote` and its libraries went private, with the
	 * consequence three screens away from the word that caused it.
	 */
	describe('the sharing switch', () => {
		it('starts on for a new registration, with the consequence stated', async () => {
			stubFetchRoutes({
				'/api/settings': { body: { defaultShareVisibility: 'friends_of_friends', pinned: [] } },
			});
			const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });
			await settle();

			expect(
				(wrapper.find('[data-test="service-shared"] input').element as HTMLInputElement).checked,
			).toBe(true);

			const hint = wrapper.find('[data-test="service-shared-hint"]');

			expect(hint.exists()).toBe(true);
			// The level is read from the gateway setting rather than spelled out, so
			// somebody reads what will actually apply before they agree to it.
			expect(hint.text()).toContain('My peers and theirs');
		});

		it('says the bytes come through this connection when the files are not here', async () => {
			stubFetchRoutes({
				'/api/settings': { body: { defaultShareVisibility: 'friends', pinned: [] } },
			});
			const { wrapper } = mountWithApp(ServiceForm, {
				props: { service: service({ mode: MediaServiceMode.REMOTE, filesMounted: false }) },
				global: { stubs: tooltipStub },
			});
			await settle();

			const hint = wrapper.find('[data-test="service-shared-hint"]');

			expect(hint.text()).toContain('My peers');
			expect(hint.text()).toContain('bandwidth');
		});

		it('drops the warning as soon as a local root is typed', async () => {
			const { wrapper } = mountWithApp(ServiceForm, {
				props: { service: service({ mode: MediaServiceMode.REMOTE, filesMounted: false }) },
				global: { stubs: tooltipStub },
			});
			await settle();

			expect(wrapper.find('[data-test="service-shared-hint"]').text()).toContain('bandwidth');

			await wrapper.find('[data-test="service-local-root"] input').setValue('/mnt/nas');
			await settle();

			expect(wrapper.find('[data-test="service-shared-hint"]').text()).not.toContain('bandwidth');
		});

		it('says nothing underneath while it is off', async () => {
			const { wrapper } = mountWithApp(ServiceForm, {
				props: { service: service({ shared: false }) },
				global: { stubs: tooltipStub },
			});
			await settle();

			expect(
				(wrapper.find('[data-test="service-shared"] input').element as HTMLInputElement).checked,
			).toBe(false);
			// A consequence of something somebody has not done is noise.
			expect(wrapper.find('[data-test="service-shared-hint"]').exists()).toBe(false);
		});

		it('keeps an edited service on whatever it already said', async () => {
			// The default is for registrations. An edit made to correct a port must not
			// switch sharing back on for something somebody deliberately turned off.
			const { wrapper } = mountWithApp(ServiceForm, {
				props: { service: service({ shared: false }) },
				global: { stubs: tooltipStub },
			});
			await settle();

			expect(
				(wrapper.find('[data-test="service-shared"] input').element as HTMLInputElement).checked,
			).toBe(false);
		});

		it('is absent for a peer, whose libraries this gateway never passes on', async () => {
			// Not off by default: absent. Reaching what a friend's friend holds will be
			// an introduction between the two ends, so a control offering to carry the
			// bytes would describe something the product does not do.
			const { wrapper } = mountWithApp(ServiceForm, {
				props: { service: service({ type: MediaServiceType.PEER, mode: MediaServiceMode.PEER }) },
				global: { stubs: tooltipStub },
			});
			await settle();

			expect(wrapper.find('[data-test="service-shared"]').exists()).toBe(false);
		});

		it('sends the switch with the registration', async () => {
			const stub = stubFetchRoutes({
				'/api/services/probe': { body: probeOk },
				'/api/services': { body: service({ id: 'new' }) },
			});
			const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

			await wrapper.find('[data-test="service-name"] input').setValue('Attic');
			await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
			await wrapper.find('[data-test="service-shared"] input').setValue(false);
			await wrapper.find('form').trigger('submit');
			await settle();

			const post = stub.mock.calls.find(
				call => call[1]?.method === 'POST' && String(call[0]).endsWith('/api/services'),
			);

			expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ shared: false });
		});
	});

	it('shows the roots a registered service already carries', () => {
		const { wrapper } = mountWithApp(ServiceForm, {
			props: { service: service({ remoteRoot: '/media', localRoot: '/mnt/nas' }) },
			global: { stubs: tooltipStub },
		});

		expect(
			(wrapper.find('[data-test="service-remote-root"] input').element as HTMLInputElement).value,
		).toBe('/media');
		expect(
			(wrapper.find('[data-test="service-local-root"] input').element as HTMLInputElement).value,
		).toBe('/mnt/nas');
	});

	it('refuses a relative root before the gateway has to', async () => {
		// A relative root resolves against whatever directory a process started in,
		// which is a different one in the container and in a development shell.
		const stub = stubFetchRoutes({
			'/api/services/probe': { body: probeOk },
			'/api/services': { body: service({ id: 'new' }) },
		});
		const { wrapper } = mountWithApp(ServiceForm, { global: { stubs: tooltipStub } });

		await wrapper.find('[data-test="service-name"] input').setValue('Attic');
		await wrapper.find('[data-test="service-url"] input').setValue('http://10.0.0.2:8096');
		await wrapper.find('[data-test="service-remote-root"] input').setValue('media');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false);
		expect(wrapper.text()).toContain('absolute path');
	});

	it('keeps the registered token when an edit leaves the field empty', async () => {
		const stub = stubFetchRoutes({
			'/api/services/s1/probe': { body: probeOk },
			'/api/services/s1': { body: service() },
		});
		const { wrapper } = mountWithApp(ServiceForm, {
			props: { service: service() },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('form').trigger('submit');
		await settle();

		const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');
		expect(patch).toBeDefined();
		expect(JSON.parse(String(patch?.[1]?.body))).not.toHaveProperty('token');
	});
});

describe('components/sync/PlanForm', () => {
	const plan: SyncPlan = {
		id: 'pl1',
		name: 'Nightly',
		enabled: true,
		trigger: SyncTrigger.SCHEDULE,
		schedule: '0 4 * * *',
		sourceServiceIds: ['s1', 's2'],
		preferredLibraryId: null,
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

	const services = [service({ id: 's1', name: 'First' }), service({ id: 's2', name: 'Second' })];

	it('says an empty source list means the configured priority', () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { services },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('follows the service priority');
		expect(wrapper.findAll('[data-test="plan-source"]')).toHaveLength(0);
	});

	it('keeps the sources in the order they will be consulted, and lets it change', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services },
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="plan-source"]').map(node => node.text());
		expect(rows[0]).toContain('First');
		expect(rows[1]).toContain('Second');

		(wrapper.vm as any).moveSource(0, 1);
		await nextTick();

		expect((wrapper.vm as any).model.sourceServiceIds).toEqual(['s2', 's1']);
	});

	it('turns the cron field into a sentence while it is being typed', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="cron-hint"]').text()).toContain('04:00');

		await wrapper.find('[data-test="plan-schedule"] input').setValue('*/30 * * * *');
		await nextTick();

		expect(wrapper.find('[data-test="cron-hint"]').text()).toContain('30 minutes');
	});

	/**
	 * The destination a plan keeps between runs, and the refusals it never offers.
	 *
	 * The list used to be every library the gateway knows, which put a friend's shelf
	 * in a menu the API would refuse — and, before the API refused it, stored a
	 * preference that was silently passed over on every run for ever. The libraries
	 * come from the same composable the queue uses, so the two screens cannot disagree
	 * about what a destination is.
	 */
	describe('the library a plan prefers', () => {
		function seedLibraries (): void {
			const libraries = useLibrariesStore();
			const servicesStore = useServicesStore();

			servicesStore.services = [
				service(),
				service({ id: 's2', name: 'A friend', filesMounted: false, mode: MediaServiceMode.PEER }),
			];
			libraries.libraries = [
				library,
				{ ...library, id: 'l2', name: 'Their shows', serviceId: 's2' },
			];
		}

		it('offers only the libraries a pull can land in, and names the others', async () => {
			const { wrapper } = mountWithApp(PlanForm, {
				props: { plan, services },
				global: { stubs: tooltipStub },
			});

			seedLibraries();
			await nextTick();

			expect((wrapper.vm as any).destinationItems.map((one: { value: string }) => one.value))
				.toEqual(['l1']);
			expect(wrapper.find('[data-test="plan-target-rejected"]').text())
				.toContain('Their shows');
		});

		it('sends it under its own name, as a preference rather than a target', async () => {
			const stub = stubFetchRoutes({ '/api/sync/plans/pl1': { body: plan } });
			const { wrapper } = mountWithApp(PlanForm, {
				props: { plan, services },
				global: { stubs: tooltipStub },
			});

			seedLibraries();
			(wrapper.vm as any).model.preferredLibraryId = 'l1';
			await nextTick();
			await (wrapper.vm as any).form.handle();
			await nextTick();

			const patch = stub.mock.calls.find(call => call[1]?.method === 'PATCH');

			expect(JSON.parse(String(patch?.[1]?.body)))
				.toMatchObject({ preferredLibraryId: 'l1' });
		});

		/**
		 * The preview has to be what a run would do, including where it would write.
		 *
		 * A preview that ignored the preference would promise one shelf and deliver
		 * another, which is the one thing this form must never do.
		 */
		it('previews with the preference the plan would run with', async () => {
			const { wrapper } = mountWithApp(PlanForm, {
				props: { plan, services },
				global: { stubs: tooltipStub },
			});

			seedLibraries();
			(wrapper.vm as any).model.preferredLibraryId = 'l1';
			await nextTick();
			await wrapper.find('[data-test="plan-preview"]').trigger('click');

			expect(wrapper.emitted('preview')?.[0]?.[0])
				.toMatchObject({ targetLibraryId: 'l1' });
		});
	});

	it('hands the preview the body a run would take', async () => {
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="plan-preview"]').trigger('click');

		expect(wrapper.emitted('preview')?.[0]?.[0]).toMatchObject({
			planId: 'pl1',
			sourceServiceIds: ['s1', 's2'],
		});
	});

	it('reads a size typed as 8G rather than asking for a byte count', async () => {
		stubFetchRoutes({ '/api/sync/plans/pl1': { body: plan } });
		const { wrapper } = mountWithApp(PlanForm, {
			props: { plan, services },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="plan-max-bytes"] input').setValue('8G');
		await nextTick();

		expect((wrapper.vm as any).runRequest().filter.maxBytes).toBe(8 * 1024 ** 3);
	});
});

describe('components/sync/SyncPreviewDialog', () => {
	it('lists what would be pulled, from where and to which path', async () => {
		stubFetchRoutes({
			'/api/sync/preview': {
				body: {
					itemsPlanned: 1,
					bytesPlanned: 900,
					items: [{
						itemId: 'm1',
						title: 'Pilot',
						kind: 'episode',
						sourceServiceId: 's1',
						sourceServiceName: 'Bob',
						targetPath: '/media/shows/pilot.mkv',
						bytes: 900,
						state: 'missing',
					}],
				},
			},
		});
		const { wrapper } = mountWithApp(SyncPreviewDialog, {
			props: { request: { planId: 'pl1' }, modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();

		const row = wrapper.find('[data-test="preview-row"]');
		expect(row.text()).toContain('Pilot');
		expect(row.text()).toContain('Bob');
		expect(row.text()).toContain('/media/shows/pilot.mkv');
	});

	it('says there is nothing to pull rather than offering to run nothing', async () => {
		stubFetchRoutes({ '/api/sync/preview': { body: { itemsPlanned: 0, bytesPlanned: 0, items: [] } } });
		const { wrapper } = mountWithApp(SyncPreviewDialog, {
			props: { request: { planId: 'pl1' }, modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="sync-run"]').attributes('disabled')).toBeDefined();
	});
});

describe('components/library/LibraryPathField', () => {
	it('says no path is set, because that is why nothing can land there', () => {
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library: { ...library, localPath: null, writable: false } },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-problem"]').text()).toContain('No local path');
	});

	it('saves a path and asks for the checks again, because the answer moved', async () => {
		const stub = stubFetchRoutes({
			'/api/libraries/l1': { body: { ...library, localPath: '/media/other' } },
			'/api/libraries/check': { body: [] },
		});
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="library-path"] input').setValue('/media/other');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(true);
		expect(stub.mock.calls.some(call => String(call[0]).includes('/libraries/check'))).toBe(true);
		expect(wrapper.emitted('saved')).toBeDefined();
	});

	it('says a path was worked out from the service rather than typed here', () => {
		// The two are corrected in different places: a typed path is wrong on its own,
		// a derived one is wrong for every library of the service at once.
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: {
				library,
				check: {
					libraryId: 'l1',
					name: 'Shows',
					localPath: '/media/shows',
					derived: true,
					exists: true,
					readable: true,
					writable: true,
					freeBytes: 1000,
					error: null,
				},
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-path"]').attributes('data-derived')).toBe('true');
		expect(wrapper.text()).toContain('Worked out from the root stated on the service');
	});

	it('refuses a relative path before the gateway has to', async () => {
		const stub = stubFetchRoutes({ '/api/libraries/l1': { body: library } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="library-path"] input').setValue('media/other');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(stub).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('absolute path');
	});
});

describe('components/peer/InviteDialog', () => {
	it('shows the invitation to copy, and when it stops working', async () => {
		stubFetchRoutes({
			'/api/peers/invites': {
				body: {
					code: 'CODE-1',
					fingerprint: 'AB',
					expiresAt: '2030-01-01T00:00:00.000Z',
					url: 'mcs://invite/CODE-1',
				},
			},
		});
		const { wrapper } = mountWithApp(InviteDialog, {
			props: { modelValue: true },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.find('[data-test="invite-create"]').trigger('click');
		await settle();

		expect(wrapper.text()).toContain('mcs://invite/CODE-1');
		expect(wrapper.text()).toContain('only be used once');
	});

	it('accepts one somebody pasted and reports the peer it linked', async () => {
		stubFetchRoutes({ '/api/peers/accept': { body: { id: 'p9', name: 'Carol' } } });
		const { wrapper } = mountWithApp(InviteDialog, {
			props: { modelValue: true },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		(wrapper.vm as any).tab = 'accept';
		await nextTick();
		await wrapper.find('[data-test="invite-code"] textarea').setValue('mcs://invite/CODE-1');
		await wrapper.find('form').trigger('submit');
		await settle();

		expect(wrapper.emitted('linked')?.[0]?.[0]).toMatchObject({ id: 'p9' });
	});

	/**
	 * The code is the convenience, not the rule: somebody holding their friend's
	 * fingerprint should not have to ask them for one.
	 */
	it('links by fingerprint alone, with no code and nothing secret in transit', async () => {
		const stub = stubFetchRoutes({ '/api/peers': { body: { id: 'p8', name: 'Dave' } } });
		const { wrapper } = mountWithApp(InviteDialog, {
			props: { modelValue: true },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		(wrapper.vm as any).tab = 'fingerprint';
		await nextTick();
		await wrapper.find('[data-test="peer-fingerprint"] input').setValue('AB:CD:EF');
		await wrapper.find('[data-test="peer-address"] input').setValue('203.0.113.9:4210');
		await wrapper.find('form').trigger('submit');
		await settle();

		const call = stub.mock.calls.find(one => String(one[1]?.method) === 'POST');
		expect(JSON.parse(String(call?.[1]?.body)))
			.toEqual({ fingerprint: 'AB:CD:EF', address: '203.0.113.9:4210' });
		expect(wrapper.emitted('linked')?.[0]?.[0]).toMatchObject({ id: 'p8' });
	});
});

describe('components/media/MatchesDialog', () => {
	const match = {
		id: 'match-1',
		localItemId: 'm1',
		remoteItemId: 'r1',
		remoteServiceId: 's1',
		remotePeerId: null,
		strategy: 'normalized_title',
		confidence: 0.72,
		state: 'outdated',
		reason: null,
		confirmedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
	};

	it('explains each correlation, and offers to overrule it', async () => {
		stubFetchRoutes({
			'/api/media/m1/matches': { body: [match] },
			'/api/services': { body: [service()] },
		});
		const { wrapper } = mountWithApp(MatchesDialog, {
			props: { itemId: 'm1', modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();

		const row = wrapper.find('[data-test="match-row"]');
		expect(row.text()).toContain('Similar title');
		expect(row.text()).toContain('72');
		expect(row.find('[data-test="match-confirm"]').exists()).toBe(true);
		expect(row.find('[data-test="match-remove"]').exists()).toBe(true);
	});

	it('drops a correlation somebody rejected', async () => {
		const stub = stubFetchRoutes({
			'/api/media/m1/matches/match-1': {},
			'/api/media/m1/matches': { body: [match] },
			'/api/services': { body: [service()] },
		});
		const { wrapper } = mountWithApp(MatchesDialog, {
			props: { itemId: 'm1', modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
		await wrapper.setProps({ modelValue: true });
		await settle();

		await wrapper.find('[data-test="match-remove"]').trigger('click');
		await settle();

		expect(stub.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true);
		expect(wrapper.findAll('[data-test="match-row"]')).toHaveLength(0);
	});

	it('says nothing has been correlated rather than showing an empty list', async () => {
		stubFetchRoutes({ '/api/media/m1/matches': { body: [] }, '/api/services': { body: [] } });
		const { wrapper } = mountWithApp(MatchesDialog, {
			props: { itemId: 'm1', modelValue: false },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		await wrapper.setProps({ modelValue: true });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
	});
});

describe('components/sync/JobRow', () => {
	const job = {
		id: 'j1',
		planId: 'pl1',
		planName: 'Nightly',
		state: 'running',
		trigger: 'schedule',
		startedAt: '2026-02-01T04:00:00.000Z',
		finishedAt: null,
		itemsPlanned: 10,
		itemsDone: 4,
		itemsFailed: 2,
		bytesPlanned: 1000,
		bytesDone: 400,
		scope: {},
		targets: [],
		stoppedBy: null,
		error: null,
		createdAt: '2026-02-01T04:00:00.000Z',
	} as never;

	it('offers to cancel a run that is still going', async () => {
		const { wrapper } = mountWithApp(JobRow, { props: { job }, global: { stubs: tooltipStub } });

		expect(wrapper.find('[data-test="job-cancel"]').exists()).toBe(true);
		await wrapper.find('[data-test="job-cancel"]').trigger('click');

		expect(wrapper.emitted('cancel')).toBeDefined();
	});

	it('counts the failures, because that is why something is still missing', () => {
		const { wrapper } = mountWithApp(JobRow, { props: { job }, global: { stubs: tooltipStub } });

		expect(wrapper.text()).toContain('2 failed');
		expect(wrapper.text()).toContain('4 of 10 items');
	});

	it('offers nothing to cancel on a finished run, and says what became of it', () => {
		const { wrapper } = mountWithApp(JobRow, {
			props: { job: { ...(job as object), state: 'failed', error: 'error.sync.no_source' } as never },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="job-cancel"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="job-error"]').text()).toContain('No source holds this media');
	});
});
