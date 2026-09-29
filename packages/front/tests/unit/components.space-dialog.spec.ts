import { SpaceVerdict } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import SpaceDialog from '@/components/sync/SpaceDialog.vue';
import { useSyncStore } from '@/stores/sync';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/** Vuetify settles a dialog over several ticks; six is what the other suites use. */
async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function target (overrides: Record<string, unknown> = {}) {
	return {
		libraryId: 'lib-1',
		libraryName: 'Séries TV',
		localPath: '/share/SeriesTV',
		freeBytes: 4_000_000_000,
		requiredBytes: 3_000_000_000,
		remainingBytes: 1_000_000_000,
		reserveBytes: 2_000_000_000,
		verdict: SpaceVerdict.TIGHT,
		...overrides,
	};
}

/**
 * The question the gateway asked and nobody could answer.
 *
 * A run whose destination is tight is refused until somebody says to go ahead, and the
 * refusal carries every destination with what is free, what is needed and what would be
 * left. The interface dropped all of it and showed one sentence saying "confirm to run it
 * anyway" — with nothing anywhere to confirm with. The only way through was to call the
 * API by hand, which is what the owner did.
 */
describe('components/sync/SpaceDialog', () => {
	function mount () {
		return mountWithApp(SpaceDialog, {
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});
	}

	it('stays out of the way until the gateway asks', async () => {
		const { wrapper } = mount();
		await settle();

		expect(wrapper.find('[data-test="space-target"]').exists()).toBe(false);
	});

	it('shows every destination the refusal named, with its numbers', async () => {
		const { wrapper } = mount();
		const store = useSyncStore();

		store.pendingSpace = {
			request: { scope: { itemIds: ['m1'] } },
			targets: [target(), target({ libraryId: 'lib-2', libraryName: 'Animés' })],
		};
		await settle();

		expect(wrapper.findAll('[data-test="space-target"]')).toHaveLength(2);
		expect(wrapper.find('[data-test="space-target"]').text()).toContain('Séries TV');
	});

	/*
	 * The more serious of the two things this dialog is about: a folder no library
	 * covers is scanned by no media server, so the files land where nothing will ever
	 * see them — however much room there is.
	 */
	it('flags a destination that belongs to no library at all', async () => {
		const { wrapper } = mount();
		const store = useSyncStore();

		store.pendingSpace = {
			request: { scope: { itemIds: ['m1'] } },
			targets: [target({ libraryId: '', libraryName: '/share/Animes2/Series' })],
		};
		await settle();

		expect(wrapper.find('[data-test="space-stray"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="space-stray-hint"]').exists()).toBe(true);
	});

	it('says nothing of the sort when every destination is a library', async () => {
		const { wrapper } = mount();
		const store = useSyncStore();

		store.pendingSpace = { request: { scope: { itemIds: ['m1'] } }, targets: [target()] };
		await settle();

		expect(wrapper.find('[data-test="space-stray"]').exists()).toBe(false);
	});

	it('runs it anyway, which is the one thing the refusal was asking for', async () => {
		/*
		 * Asserted on what leaves for the gateway, because that is the whole of the fix:
		 * the same run, carrying the acknowledgement the refusal asked for. The interface
		 * had never sent that field at all.
		 */
		const stub = stubFetchRoutes({ '/api/sync/run': { body: { id: 'job-1' } } });
		const { wrapper } = mount();
		const store = useSyncStore();

		store.pendingSpace = { request: { scope: { itemIds: ['m1'] } }, targets: [target()] };
		await settle();

		await wrapper.find('[data-test="space-confirm"]').trigger('click');
		await settle();

		const call = stub.mock.calls.find(one => String(one[0]).includes('/api/sync/run'));

		expect(JSON.parse(String((call?.[1] as RequestInit)?.body))).toMatchObject({
			acknowledgeSpace: true,
			scope: { itemIds: ['m1'] },
		});
		expect(store.pendingSpace).toBeNull();
	});

	it('lets somebody walk away, which starts nothing', async () => {
		const { wrapper } = mount();
		const store = useSyncStore();

		store.pendingSpace = { request: { scope: { itemIds: ['m1'] } }, targets: [target()] };
		await settle();

		await wrapper.find('[data-test="space-cancel"]').trigger('click');
		await settle();

		expect(store.pendingSpace).toBeNull();
	});
});
