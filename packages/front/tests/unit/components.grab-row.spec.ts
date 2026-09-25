import type { ReleaseGrab } from '@mcs/shared';
import { GrabState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import ReleaseGrabRow from '@/components/transfer/ReleaseGrabRow.vue';
import { mountWithApp, tooltipStub } from './helpers';

function grab (overrides: Partial<ReleaseGrab> = {}): ReleaseGrab {
	return {
		id: 'g1',
		itemId: 'm1',
		title: 'Show.S01E10.1080p-GRP',
		indexer: 'TR4KER',
		state: GrabState.DOWNLOADING,
		clientId: 'hash-1',
		bytesDone: 500,
		bytesTotal: 1000,
		rate: 10,
		savePath: '/downloads/complete',
		targetPath: null,
		targetLibraryId: null,
		targetFolder: null,
		plannedPath: null,
		partial: false,
		placements: [],
		error: null,
		createdAt: '2026-09-25T00:00:00.000Z',
		updatedAt: '2026-09-25T00:00:00.000Z',
		...overrides,
	} as ReleaseGrab;
}

function mount (row: ReleaseGrab) {
	return mountWithApp(ReleaseGrabRow, {
		props: { grab: row },
		global: { stubs: { ...tooltipStub } },
	});
}

/**
 * The controls a torrent has, which until now were one.
 *
 * A queue nobody can stop, restart or tidy is a queue people manage in the download
 * client's own interface instead — which is the errand this screen exists to spare them.
 */
describe('components/transfer/ReleaseGrabRow', () => {
	it('offers to stop a download that is running', async () => {
		const { wrapper } = mount(grab());

		expect(wrapper.find('[data-test="release-grab-row-pause"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="release-grab-row-resume"]').exists()).toBe(false);

		await wrapper.find('[data-test="release-grab-row-pause"]').trigger('click');

		expect(wrapper.emitted('pause')).toHaveLength(1);
	});

	it('offers to start a stopped one, and says so with the filled button', async () => {
		// Stopping is the first thing people try, so the way back has to be the obvious
		// one — the same shape a paused transfer wears.
		const { wrapper } = mount(grab({ state: GrabState.PAUSED }));

		expect(wrapper.find('[data-test="release-grab-row-pause"]').exists()).toBe(false);

		await wrapper.find('[data-test="release-grab-row-resume"]').trigger('click');

		expect(wrapper.emitted('resume')).toHaveLength(1);
	});

	it('offers neither once the file is filed', async () => {
		// It is a file at that point. Stopping it would mean nothing.
		const { wrapper } = mount(grab({ state: GrabState.PLACED }));

		expect(wrapper.find('[data-test="release-grab-row-pause"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="release-grab-row-resume"]').exists()).toBe(false);
	});

	it('offers neither for a row the client never took', async () => {
		const { wrapper } = mount(grab({ clientId: null, state: GrabState.SENT }));

		expect(wrapper.find('[data-test="release-grab-row-pause"]').exists()).toBe(false);
	});

	it.each([
		GrabState.SENT,
		GrabState.DOWNLOADING,
		GrabState.PAUSED,
		GrabState.FETCHED,
		GrabState.PLACED,
		GrabState.FAILED,
		GrabState.CANCELLED,
	])('offers to archive a row in every state, including %s', async state => {
		const { wrapper } = mount(grab({ state }));

		await wrapper.find('[data-test="release-grab-row-archive"]').trigger('click');

		expect(wrapper.emitted('archive')).toHaveLength(1);
	});

	it('offers to start a failed one over, and only where that means something', async () => {
		const { wrapper } = mount(grab({ state: GrabState.FAILED }));

		expect(wrapper.find('[data-test="release-grab-row-retry"]').exists()).toBe(true);
		expect(mount(grab()).wrapper.find('[data-test="release-grab-row-retry"]').exists()).toBe(false);
	});

	/**
	 * Where it will land, while it is still landing.
	 *
	 * `targetPath` is written when the file is filed and `targetFolder` only when somebody
	 * chose one, so a download running for six hours had nothing to say about where it was
	 * going — which is exactly when the question gets asked.
	 */
	it('names the destination worked out when the download was sent', () => {
		const { wrapper } = mount(grab({ plannedPath: '/share/SeriesTV5/Show/Saison 1' }));

		expect(wrapper.find('[data-test="release-grab-row-destination"]').text())
			.toContain('/share/SeriesTV5/Show/Saison 1');
	});

	it('prefers where it actually went once it has gone there', () => {
		const { wrapper } = mount(grab({
			state: GrabState.PLACED,
			plannedPath: '/share/planned',
			targetPath: '/share/real/Show - S01E10.mkv',
		}));

		expect(wrapper.find('[data-test="release-grab-row-destination"]').text())
			.toContain('/share/real/Show - S01E10.mkv');
	});
});
