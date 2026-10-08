import { episodesCovered, spanOf } from './episode-coverage';

const row = (episodeNumber: number | null, episodeNumberEnd: number | null = null) => ({
	episodeNumber,
	episodeNumberEnd,
});

describe('episode coverage', () => {
	describe('spanOf', () => {
		it('reads one episode off an ordinary file', () => {
			expect(spanOf(row(4))).toEqual([4]);
		});

		it('fills in the episodes between the two ends of a two-part file', () => {
			// The whole reason the column exists: `S01E01-E02` is one row and two
			// episodes, and the second was being offered for download.
			expect(spanOf(row(1, 2))).toEqual([1, 2]);
			expect(spanOf(row(4, 6))).toEqual([4, 5, 6]);
		});

		it('reads an absent end as one episode, however it is spelled', () => {
			/*
			 * `undefined` reaches this from a partial `select` and from any fixture
			 * written before the column existed, and it used to answer *nothing*:
			 * `undefined <= 1` is false rather than an error, so the length came out
			 * NaN and the row covered no episodes at all. An episode on the disk then
			 * read as a hole — this file's own bug, from the other side.
			 */
			expect(spanOf({ episodeNumber: 9, episodeNumberEnd: undefined } as never)).toEqual([9]);
			expect(spanOf({ episodeNumber: 9 } as never)).toEqual([9]);
		});

		it('covers nothing when nobody could work out a number', () => {
			// A season, a series, or an episode the server never numbered. Guessing one
			// would mark a real gap held, which is worse than the gap.
			expect(spanOf(row(null))).toEqual([]);
			expect(spanOf(row(null, 3))).toEqual([]);
		});

		it('refuses a range that does not climb rather than reversing it', () => {
			// `E05-E02` is a typo or a parse that went wrong. Run backwards it would
			// claim four episodes are held on the strength of a mistake.
			expect(spanOf(row(5, 2))).toEqual([5]);
			expect(spanOf(row(5, 5))).toEqual([5]);
		});
	});

	describe('episodesCovered', () => {
		it('gathers what a season actually holds, two-part files expanded', () => {
			const held = episodesCovered([row(1), row(2, 3), row(4)]);

			expect([...held].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
		});

		it('is empty for a season of rows nobody numbered', () => {
			expect(episodesCovered([row(null), row(null)]).size).toBe(0);
		});

		it('counts an episode once however many rows report it', () => {
			// Two servers holding the same episode is the normal case, not a conflict.
			expect(episodesCovered([row(2), row(2), row(1, 2)]).size).toBe(2);
		});
	});
});
