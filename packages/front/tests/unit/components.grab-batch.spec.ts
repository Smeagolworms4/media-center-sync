import type { ReleaseGrab } from '@mcs/shared';
import { GrabState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import GrabBatch from '@/components/transfer/GrabBatch.vue';
import { mountWithApp, tooltipStub } from './helpers';

function grab (overrides: Partial<ReleaseGrab> = {}): ReleaseGrab {
	return {
		id: 'g1',
		itemId: 'm1',
		title: 'Squid.Game.S01.PACK',
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
		lot: 'lot-1',
		partial: false,
		placements: [],
		error: null,
		createdAt: '2026-09-27T00:00:00.000Z',
		updatedAt: '2026-09-27T00:00:00.000Z',
		...overrides,
	} as ReleaseGrab;
}

function mount (rows: ReleaseGrab[]) {
	return mountWithApp(GrabBatch, {
		props: { grabs: rows },
		global: { stubs: { ...tooltipStub } },
	});
}

/**
 * One download, as somebody asked for it.
 *
 * Three seasons asked for in one act were three rows, each with its own progress bar and
 * its own three buttons — so "how far is Squid Game" was three numbers to add up and
 * stopping it was three presses.
 */
describe('components/transfer/GrabBatch', () => {
	const block = [
		grab({ id: 'g1', bytesDone: 1000, bytesTotal: 2000, rate: 10 }),
		grab({ id: 'g2', bytesDone: 500, bytesTotal: 2000, rate: 5 }),
		grab({ id: 'g3', state: GrabState.PLACED, bytesDone: 2000, bytesTotal: 2000, rate: 0 }),
	];

	it('adds the bytes and the rates of the whole download into one bar', () => {
		const { wrapper } = mount(block);

		// 3 500 of 6 000, which is what one progress bar over the lot has to say.
		const bar = wrapper.find('[data-test="grab-batch-progress"]');

		// 3 500 of 6 000, which is what one bar over the whole lot has to say.
		expect(Number(bar.attributes('aria-valuenow'))).toBeCloseTo(58.33, 1);
	});

	it('says how many of its downloads are filed', () => {
		const { wrapper } = mount(block);

		expect(wrapper.find('[data-test="grab-batch-count"]').text()).toContain('3');
	});

	it('acts on the whole block in one press, and only on the rows it means something for', async () => {
		const { wrapper } = mount(block);

		await wrapper.find('[data-test="grab-batch-pause"]').trigger('click');

		// The filed one is not stopped: pausing a lot that is half done means "stop the
		// rest", and refusing over the part that already landed answers nobody.
		expect(wrapper.emitted('pause')?.[0][0]).toHaveLength(2);
	});

	it('offers to start the whole block again when any of it is stopped', async () => {
		const { wrapper } = mount([grab({ state: GrabState.PAUSED }), grab({ id: 'g2', state: GrabState.PAUSED })]);

		expect(wrapper.find('[data-test="grab-batch-pause"]').exists()).toBe(false);

		await wrapper.find('[data-test="grab-batch-resume"]').trigger('click');

		expect(wrapper.emitted('resume')?.[0][0]).toHaveLength(2);
	});

	it('offers to start over only the ones that failed', async () => {
		const { wrapper } = mount([
			grab({ id: 'g1', state: GrabState.FAILED }),
			grab({ id: 'g2', state: GrabState.DOWNLOADING }),
		]);

		await wrapper.find('[data-test="grab-batch-retry"]').trigger('click');

		expect(wrapper.emitted('retry')?.[0][0]).toHaveLength(1);
		expect(wrapper.find('[data-test="grab-batch-failed"]').exists()).toBe(true);
	});

	it('archives and redirects the whole block, which is what those two are for', async () => {
		const { wrapper } = mount(block);

		await wrapper.find('[data-test="grab-batch-archive"]').trigger('click');
		await wrapper.find('[data-test="grab-batch-retarget"]').trigger('click');

		expect(wrapper.emitted('archive')?.[0][0]).toHaveLength(3);
		expect(wrapper.emitted('retarget')?.[0][0]).toHaveLength(3);
	});

	it('names the folder its downloads agree on, and says nothing when they do not', async () => {
		const together = mount([
			grab({ id: 'g1', plannedPath: '/share/SeriesTV2/Squid Game/Saison 1' }),
			grab({ id: 'g2', plannedPath: '/share/SeriesTV2/Squid Game/Saison 2' }),
		]);

		expect(together.wrapper.find('[data-test="grab-batch-destination"]').text())
			.toContain('/share/SeriesTV2/Squid Game');

		const apart = mount([
			grab({ id: 'g1', plannedPath: '/share/SeriesTV2/Squid Game' }),
			grab({ id: 'g2', plannedPath: '/share/Animes/Squid Game' }),
		]);

		// Saying one of the two would be saying the wrong thing about the other.
		expect(apart.wrapper.find('[data-test="grab-batch-destination"]').exists()).toBe(false);
	});

	it('keeps its files folded until somebody asks for them', async () => {
		const { wrapper } = mount(block);

		expect(wrapper.findAllComponents({ name: 'ReleaseGrabRow' })).toHaveLength(0);

		await wrapper.find('[data-test="grab-batch-toggle"]').trigger('click');

		expect(wrapper.findAllComponents({ name: 'ReleaseGrabRow' })).toHaveLength(3);
	});
});
