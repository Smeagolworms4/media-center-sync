import type { QualitySummary, QualityVariant } from '@mcs/shared';
import { SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import QualityChip from '@/components/media/QualityChip.vue';
import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
import { describeSyncState, SYNC_STATE_ICON } from '@/composables/useSyncState';
import { SYNC_STATE_COLOR } from '@/plugins/vuetify';
import { mountWithApp, tooltipStub } from './helpers';

function variant (overrides: Partial<QualityVariant> = {}): QualityVariant {
	return {
		label: 'x265 · 1080p',
		videoCodec: 'hevc',
		resolution: '1080p',
		hdr: null,
		audioCodec: 'eac3',
		audioChannels: '5.1',
		container: 'mkv',
		count: 8,
		bytes: 8 * 1024 ** 3,
		...overrides,
	};
}

describe('useSyncState', () => {
	it('describes every state the vocabulary holds', () => {
		for (const state of Object.values(SyncState)) {
			const descriptor = describeSyncState(state);
			expect(descriptor.state).toBe(state);
			expect(descriptor.icon).toBe(SYNC_STATE_ICON[state]);
			expect(descriptor.color).toBe(SYNC_STATE_COLOR[state]);
			expect(descriptor.labelKey).toBe(`sync.state.${state}`);
		}
	});

	it('gives every state its own icon and its own colour', () => {
		expect(new Set(Object.values(SYNC_STATE_ICON)).size).toBe(Object.values(SyncState).length);
		expect(new Set(Object.values(SYNC_STATE_COLOR)).size).toBe(Object.values(SyncState).length);
	});

	/**
	 * The two states a file on our own disk can be in, drawn apart from the rest.
	 *
	 * They are not variations on `missing` and must not look like one: the bytes are
	 * here, and offering to download them again is the behaviour they were added to
	 * stop.
	 */
	it.each([SyncState.AWAITING_INDEX, SyncState.NOT_INDEXED])(
		'draws %s as something of its own, not as a shade of missing',
		state => {
			expect(SYNC_STATE_ICON[state]).not.toBe(SYNC_STATE_ICON[SyncState.MISSING]);
			expect(SYNC_STATE_COLOR[state]).not.toBe(SYNC_STATE_COLOR[SyncState.MISSING]);
			expect(describeSyncState(state).labelKey).toBe(`sync.state.${state}`);
			expect(describeSyncState(state).helpKey).toBe(`sync.state_help.${state}`);
		},
	);

	it('falls back to unknown for a state this build has never heard of', () => {
		expect(describeSyncState('teleported' as SyncState).state).toBe(SyncState.UNKNOWN);
		expect(describeSyncState(null).state).toBe(SyncState.UNKNOWN);
		expect(describeSyncState(undefined).state).toBe(SyncState.UNKNOWN);
	});
});

describe('SyncStateIcon', () => {
	it.each(Object.values(SyncState))('renders %s with its own icon', state => {
		const { wrapper } = mountWithApp(SyncStateIcon, { props: { state } });

		expect(wrapper.find('[data-state]').attributes('data-state')).toBe(state);
		expect(wrapper.find('.v-icon').classes().join(' ')).toContain(SYNC_STATE_ICON[state]);
	});

	it('shows the label beside the icon when asked', () => {
		const { wrapper } = mountWithApp(SyncStateIcon, {
			props: { state: SyncState.MISSING, withLabel: true },
		});

		expect(wrapper.text()).toContain('Missing here');
	});

	it('shows no label by default, so a dense list stays dense', () => {
		const { wrapper } = mountWithApp(SyncStateIcon, { props: { state: SyncState.MISSING } });

		expect(wrapper.text()).not.toContain('Missing here');
	});

	it('renders the unknown state when given nothing at all', () => {
		const { wrapper } = mountWithApp(SyncStateIcon, { props: { state: null } });

		expect(wrapper.find('[data-state]').attributes('data-state')).toBe(SyncState.UNKNOWN);
	});
});

describe('QualityChip', () => {
	it('shows the assembled label for a uniform node', () => {
		const quality: QualitySummary = {
			label: 'x265 · 1080p',
			mixed: false,
			dominant: variant(),
			variants: [variant()],
			fileCount: 8,
			totalBytes: 8 * 1024 ** 3,
		};

		const { wrapper } = mountWithApp(QualityChip, { props: { quality } });

		expect(wrapper.text()).toContain('x265 · 1080p');
		expect(wrapper.find('[data-mixed]').attributes('data-mixed')).toBe('false');
	});

	it('says mixed, in the viewer language, when the variants disagree', () => {
		const quality: QualitySummary = {
			label: 'mixed',
			mixed: true,
			dominant: variant(),
			variants: [variant(), variant({ label: 'x264 · 720p', count: 2, bytes: 2 * 1024 ** 3 })],
			fileCount: 10,
			totalBytes: 10 * 1024 ** 3,
		};

		const { wrapper } = mountWithApp(QualityChip, { props: { quality } });

		expect(wrapper.text()).toContain('mixed');
		expect(wrapper.find('[data-mixed]').attributes('data-mixed')).toBe('true');
	});

	it('lists every variant with its count and its size in the tooltip', () => {
		const quality: QualitySummary = {
			label: 'mixed',
			mixed: true,
			dominant: variant(),
			variants: [variant(), variant({ label: 'x264 · 720p', count: 1, bytes: 1024 ** 3 })],
			fileCount: 9,
			totalBytes: 9 * 1024 ** 3,
		};

		const { wrapper } = mountWithApp(QualityChip, {
			props: { quality },
			global: { stubs: tooltipStub },
		});
		const rows = wrapper.findAll('.quality-chip_variants tr');

		expect(rows).toHaveLength(2);
		expect(rows[0].text()).toContain('x265 · 1080p');
		expect(rows[0].text()).toContain('8 files');
		expect(rows[0].text()).toContain('8.0 GB');
		expect(rows[1].text()).toContain('1 file');
		expect(rows[1].text()).toContain('1.0 GB');
		expect(wrapper.find('.quality-chip_total').text()).toContain('9 files');
	});

	it('degrades to an unknown chip for a node nobody has scanned', () => {
		const { wrapper } = mountWithApp(QualityChip, { props: { quality: null } });

		expect(wrapper.find('.quality-chip--unknown').exists()).toBe(true);
		expect(wrapper.text()).toContain('unknown quality');
	});
});
