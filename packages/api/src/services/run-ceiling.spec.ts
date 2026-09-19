import { SyncStopReason } from '@mcs/shared';
import { applyCeilings } from './run-ceiling';

/** Five items of a thousand bytes each, so the arithmetic is readable. */
const items = [1, 2, 3, 4, 5].map((index) => ({ id: `item-${index}`, bytes: 1000 }));

describe('applyCeilings', () => {
	const cases: [string, number | null, number | null, number, SyncStopReason | null][] = [
		['no ceiling at all', null, null, 5, null],
		['a count above the run', 10, null, 5, null],
		['a count exactly the run', 5, null, 5, null],
		['a count below the run', 3, null, 3, SyncStopReason.MAX_ITEMS],
		['a count of one', 1, null, 1, SyncStopReason.MAX_ITEMS],
		['a count of nothing', 0, null, 0, SyncStopReason.MAX_ITEMS],
		['a size above the run', null, 10_000, 5, null],
		['a size exactly the run', null, 5000, 5, null],
		['a size one byte short', null, 4999, 4, SyncStopReason.MAX_BYTES],
		['a size that takes three', null, 3500, 3, SyncStopReason.MAX_BYTES],
		['a size smaller than the first item', null, 999, 0, SyncStopReason.MAX_BYTES],
		['a size of nothing', null, 0, 0, SyncStopReason.MAX_BYTES],
		['both, the count biting first', 2, 4000, 2, SyncStopReason.MAX_ITEMS],
		['both, the size biting first', 4, 2000, 2, SyncStopReason.MAX_BYTES],
	];

	it.each(cases)('%s', (_name, maxItems, maxBytes, kept, stoppedBy) => {
		const result = applyCeilings(items, { maxItems, maxBytes });

		expect(result.kept).toHaveLength(kept);
		expect(result.stoppedBy).toBe(stoppedBy);
	});

	it('accounts for every item it was given', () => {
		const result = applyCeilings(items, { maxItems: 2, maxBytes: null });

		// Nothing is allowed to disappear: what a ceiling drops becomes a skipped line
		// on the job, which is the only thing that makes `stoppedBy` legible afterwards.
		expect(result.kept.length + result.dropped.length).toBe(items.length);
		expect(result.dropped.map((item) => item.id)).toEqual(['item-3', 'item-4', 'item-5']);
	});

	it('keeps the order the plan chose, so tomorrow continues where today stopped', () => {
		const result = applyCeilings(items, { maxItems: 2, maxBytes: null });

		expect(result.kept.map((item) => item.id)).toEqual(['item-1', 'item-2']);
	});

	it('stops rather than packing what is left with smaller files', () => {
		const mixed = [
			{ id: 'huge', bytes: 4000 },
			{ id: 'small', bytes: 10 },
		];
		const result = applyCeilings(mixed, { maxItems: null, maxBytes: 100 });

		// Packing would make the contents of a run depend on the sizes of the files in
		// it: two runs of the same plan on the same day would pull different episodes.
		expect(result.kept).toHaveLength(0);
		expect(result.stoppedBy).toBe(SyncStopReason.MAX_BYTES);
	});

	it('says nothing stopped it when nothing did', () => {
		expect(applyCeilings([], { maxItems: 0, maxBytes: 0 }).stoppedBy).toBeNull();
	});
});
