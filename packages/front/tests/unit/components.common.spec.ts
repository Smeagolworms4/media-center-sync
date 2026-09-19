import { TransferState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import ByteSize from '@/components/common/ByteSize.vue';
import Duration from '@/components/common/Duration.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import Rate from '@/components/common/Rate.vue';
import RelativeDate from '@/components/common/RelativeDate.vue';
import TransferProgress from '@/components/transfer/TransferProgress.vue';
import { useI18nStore } from '@/stores/i18n';
import { mountWithApp, tooltipStub } from './helpers';

function progress (overrides: Record<string, unknown> = {}) {
	return {
		id: 't1',
		state: TransferState.DOWNLOADING,
		bytesDone: 512 * 1024 ** 2,
		bytesTotal: 1024 ** 3,
		rate: 4 * 1024 ** 2,
		etaSeconds: 128,
		chunksDone: 12,
		chunksTotal: 24,
		sourceCount: 2,
		...overrides,
	};
}

describe('ByteSize', () => {
	it('renders a human size', () => {
		const { wrapper } = mountWithApp(ByteSize, { props: { bytes: 1024 ** 3 } });
		expect(wrapper.text()).toBe('1.0 GB');
	});

	it('follows the chosen locale', async () => {
		const { wrapper, pinia } = mountWithApp(ByteSize, { props: { bytes: 1536 } });
		useI18nStore(pinia).setLocale('fr');
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toBe('1,5 KB');
		useI18nStore(pinia).setLocale('en');
	});

	it('says nothing rather than zero when there is no size', () => {
		const { wrapper } = mountWithApp(ByteSize, { props: { bytes: null } });
		expect(wrapper.text()).toBe('—');
	});
});

describe('Rate and Duration', () => {
	it('renders a rate per second', () => {
		const { wrapper } = mountWithApp(Rate, { props: { rate: 2 * 1024 ** 2 } });
		expect(wrapper.text()).toBe('2.0 MB/s');
	});

	it('renders a duration', () => {
		const { wrapper } = mountWithApp(Duration, { props: { seconds: 125 } });
		expect(wrapper.text()).toBe('2m 05s');
	});
});

describe('RelativeDate', () => {
	it('shows how long ago something happened', () => {
		const date = new Date(Date.now() - 120_000).toISOString();
		const { wrapper } = mountWithApp(RelativeDate, {
			props: { date },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('2 minutes ago');
	});

	it('falls back to "never" when nothing ever happened', () => {
		const { wrapper } = mountWithApp(RelativeDate, { props: { date: null } });
		expect(wrapper.text()).toBe('never');
	});

	it('accepts a caller-supplied empty text', () => {
		const { wrapper } = mountWithApp(RelativeDate, {
			props: { date: null, emptyText: 'not scanned yet' },
		});
		expect(wrapper.text()).toBe('not scanned yet');
	});
});

describe('EmptyState and ErrorState', () => {
	it('EmptyState falls back to the generic wording', () => {
		const { wrapper } = mountWithApp(EmptyState);
		expect(wrapper.text()).toContain('Nothing here');
	});

	it('EmptyState takes its own wording and extra actions', () => {
		const { wrapper } = mountWithApp(EmptyState, {
			props: { title: 'No peer yet', text: 'Invite a friend.' },
			slots: { default: '<button class="invite">Invite</button>' },
		});

		expect(wrapper.text()).toContain('No peer yet');
		expect(wrapper.find('.invite').exists()).toBe(true);
	});

	it('ErrorState always offers a retry', async () => {
		const { wrapper } = mountWithApp(ErrorState);

		expect(wrapper.text()).toContain('Try again');
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});

describe('PageHeader', () => {
	it('renders the title, the subtitle and the actions slot', () => {
		const { wrapper } = mountWithApp(PageHeader, {
			props: { title: 'Transfers', subtitle: '3 running', icon: 'mdi-transfer-down' },
			slots: { actions: '<button class="pause">Pause</button>' },
		});

		expect(wrapper.find('.page-header_title').text()).toBe('Transfers');
		expect(wrapper.find('.page-header_subtitle').text()).toBe('3 running');
		expect(wrapper.find('.pause').exists()).toBe(true);
		expect(wrapper.find('.page-header_progress').exists()).toBe(false);
	});

	it('shows a progress bar while the page loads', () => {
		const { wrapper } = mountWithApp(PageHeader, { props: { title: 'Transfers', loading: true } });
		expect(wrapper.find('.page-header_progress').exists()).toBe(true);
	});
});

describe('TransferProgress', () => {
	it('shows the position, the rate and the time left while downloading', () => {
		const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress() } });

		expect(wrapper.text()).toContain('Downloading');
		expect(wrapper.text()).toContain('512.0 MB');
		expect(wrapper.text()).toContain('1.0 GB');
		expect(wrapper.text()).toContain('4.0 MB/s');
		expect(wrapper.text()).toContain('2m 08s');
		expect(wrapper.text()).toContain('2 sources');
	});

	it('positions the bar on the bytes actually written', () => {
		const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress() } });
		const bar = wrapper.findComponent({ name: 'VProgressLinear' });

		expect(bar.props('modelValue')).toBe(50);
		expect(bar.props('indeterminate')).toBe(false);
	});

	it('goes indeterminate where a byte position would be a lie', () => {
		for (const state of [TransferState.CONNECTING, TransferState.VERIFYING, TransferState.REPAIRING]) {
			const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress({ state }) } });
			expect(wrapper.findComponent({ name: 'VProgressLinear' }).props('indeterminate')).toBe(true);
		}
	});

	it('colours a failure as an error and a finished transfer as in sync', () => {
		const failed = mountWithApp(TransferProgress, { props: { progress: progress({ state: TransferState.FAILED }) } });
		expect(failed.wrapper.findComponent({ name: 'VProgressLinear' }).props('color')).toBe('error');

		const done = mountWithApp(TransferProgress, { props: { progress: progress({ state: TransferState.DONE }) } });
		expect(done.wrapper.findComponent({ name: 'VProgressLinear' }).props('color')).toBe('state-in-sync');
	});

	it('hides the rate and the estimate for a transfer that is not moving', () => {
		const { wrapper } = mountWithApp(TransferProgress, {
			props: { progress: progress({ state: TransferState.PAUSED, rate: 0 }) },
		});

		expect(wrapper.text()).toContain('Paused');
		expect(wrapper.find('.transfer-progress_rate').exists()).toBe(false);
		expect(wrapper.find('.transfer-progress_eta').exists()).toBe(false);
	});

	it('says so when the time left cannot be estimated', () => {
		const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress({ etaSeconds: null }) } });
		expect(wrapper.text()).toContain('time left unknown');
	});

	it('shows no percentage at all when the total size is unknown', () => {
		const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress({ bytesTotal: 0 }) } });
		expect(wrapper.findComponent({ name: 'VProgressLinear' }).props('modelValue')).toBe(0);
	});

	it('drops the byte counters in compact mode', () => {
		const { wrapper } = mountWithApp(TransferProgress, { props: { progress: progress(), compact: true } });
		expect(wrapper.find('.transfer-progress_bytes').exists()).toBe(false);
	});
});
