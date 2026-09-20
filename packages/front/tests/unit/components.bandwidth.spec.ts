import { NamingScheme, PlacementStrategy } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import BandwidthControl from '@/components/transfer/BandwidthControl.vue';
import { useSettingsStore } from '@/stores/settings';
import { mountWithApp, stubFetchRoutes } from './helpers';

async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function settings (overrides: Record<string, unknown> = {}) {
	return {
		placement: PlacementStrategy.BESIDE_EXISTING,
		fixedPath: null,
		namingOrder: [NamingScheme.STANDARD],
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
		transferHistoryDays: 30,
		failedHistoryDays: 180,
		refreshIntervalMinutes: 15,
		fullScanCron: null,
		cacheTtlSeconds: 60,
		...overrides,
	};
}

const STATS = { active: 1, queued: 0, paused: 0, failed: 0, rate: 2_097_152, bytesRemaining: 10 };

function mountControl (current = settings()) {
	const stub = stubFetchRoutes({
		'/api/transfers/stats': { body: STATS },
		'/api/settings': { body: current },
	});
	const result = mountWithApp(BandwidthControl, {
		global: { stubs: { VMenu: { template: '<div><slot name="activator" :props="{}" /><slot /></div>' } } },
	});
	useSettingsStore(result.pinia).settings = current as never;
	return { ...result, stub };
}

describe('components/transfer/BandwidthControl', () => {
	it('shows what is moving right now, from the queue the socket keeps current', async () => {
		const { wrapper } = mountControl();
		await settle();

		expect(wrapper.find('[data-test="bandwidth-control"]').text()).toContain('2.0 MB/s');
	});

	/** A throttled gateway that looks unthrottled is a support question waiting. */
	it('shows the caps on the bar itself as soon as one is set', async () => {
		const { wrapper } = mountControl(settings({ downloadRateLimit: 10 * 1024 ** 2 }));
		await settle();

		const caps = wrapper.find('[data-test="bandwidth-caps"]');
		expect(caps.exists()).toBe(true);
		expect(caps.text()).toContain('10.0 MB/s');
	});

	it('says nothing about caps when there are none', async () => {
		const { wrapper } = mountControl();
		await settle();

		expect(wrapper.find('[data-test="bandwidth-caps"]').exists()).toBe(false);
	});

	/**
	 * The point of the control: one click caps the gateway, in bytes per second,
	 * from whatever screen somebody happened to be on.
	 */
	it('applies a preset in one click, converted to bytes per second', async () => {
		const { wrapper, stub } = mountControl();
		await settle();

		const presets = wrapper.findAll('[data-test="bandwidth-download-preset"]');
		// Zero first, then 512 KB/s, then 1 MB/s: the third chip is one megabyte.
		await presets[2].trigger('click');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method) === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body)))
			.toEqual({ downloadRateLimit: 1024 ** 2, uploadRateLimit: 0 });
	});

	it('keeps the other direction untouched when one cap is chosen', async () => {
		const { wrapper, stub } = mountControl(settings({ downloadRateLimit: 5 * 1024 ** 2 }));
		await settle();

		const presets = wrapper.findAll('[data-test="bandwidth-upload-preset"]');
		await presets[1].trigger('click');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method) === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body)))
			.toEqual({ downloadRateLimit: 5 * 1024 ** 2, uploadRateLimit: 512 * 1024 });
	});

	/**
	 * Filled on open rather than once: the settings page, or another tab, may have
	 * moved the cap since, and a stale field would write the old number back.
	 */
	it('fills the fields from the caps in force each time it opens', async () => {
		const { wrapper } = mountControl(settings({ downloadRateLimit: 512 * 1024, uploadRateLimit: 2 * 1024 ** 2 }));
		await settle();

		(wrapper.vm as any).open = true;
		await settle(2);

		expect((wrapper.vm as any).model).toMatchObject({
			download: 512,
			downloadUnit: 'kb',
			upload: 2,
			uploadUnit: 'mb',
		});
	});

	it('sends what was typed in the free field, in the unit beside it', async () => {
		const { wrapper, stub } = mountControl();
		await settle();

		await wrapper.find('[data-test="bandwidth-download"] input').setValue('750');
		(wrapper.vm as any).model.downloadUnit = 'kb';
		await settle(2);
		await wrapper.find('[data-test="bandwidth-apply"]').trigger('click');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method) === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body)))
			.toEqual({ downloadRateLimit: 750 * 1024, uploadRateLimit: 0 });
	});

	it('reads an empty field as no cap rather than as nothing to do', async () => {
		const { wrapper, stub } = mountControl(settings({ downloadRateLimit: 10 * 1024 ** 2 }));
		await settle();

		await wrapper.find('[data-test="bandwidth-download"] input').setValue('');
		await settle(2);
		await wrapper.find('[data-test="bandwidth-apply"]').trigger('click');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method) === 'PATCH');
		expect(JSON.parse(String(patch?.[1]?.body)))
			.toEqual({ downloadRateLimit: 0, uploadRateLimit: 0 });
	});
});
