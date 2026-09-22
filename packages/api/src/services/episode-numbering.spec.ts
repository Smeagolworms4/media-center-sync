import { alignAbsoluteNumbering, episodeIdentifierKeys, type NumberedEpisode } from './episode-numbering';

/** A show cut into seasons, complete: `[13, 12]` is season 1 of 13 and season 2 of 12. */
const split = (prefix: string, lengths: number[]): NumberedEpisode[] =>
	lengths.flatMap((length, index) =>
		Array.from({ length }, (_, position) => ({
			id: `${prefix}-s${index + 1}e${position + 1}`,
			seasonNumber: index + 1,
			episodeNumber: position + 1,
		})),
	);

/** The same show published straight through, optionally under a season number. */
const flat = (prefix: string, count: number, seasonNumber: number | null = 1): NumberedEpisode[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-e${index + 1}`,
		seasonNumber,
		episodeNumber: index + 1,
	}));

const paired = (pairs: ReturnType<typeof alignAbsoluteNumbering>): Record<string, string> =>
	Object.fromEntries(pairs.map((pair) => [pair.absoluteId, pair.splitId]));

describe('alignAbsoluteNumbering', () => {
	it('relates an absolute number to the season and episode it falls in', () => {
		// Two seasons of 13 and 12, against one run of 25. Episode 14 is the first of
		// season 2, which is the arithmetic the whole feature rests on.
		const pairs = paired(alignAbsoluteNumbering(flat('run', 25), split('cut', [13, 12])));

		expect(pairs['run-e1']).toBe('cut-s1e1');
		expect(pairs['run-e13']).toBe('cut-s1e13');
		expect(pairs['run-e14']).toBe('cut-s2e1');
		expect(pairs['run-e25']).toBe('cut-s2e12');
		expect(Object.keys(pairs)).toHaveLength(25);
	});

	it('answers the same pairs whichever side is given first', () => {
		const forwards = paired(alignAbsoluteNumbering(flat('run', 25), split('cut', [13, 12])));
		const backwards = paired(alignAbsoluteNumbering(split('cut', [13, 12]), flat('run', 25)));

		expect(backwards).toEqual(forwards);
	});

	it('relates a long anime run to the seasons it was cut into', () => {
		// The case in hand: one continuous run against nine seasons of unequal length.
		const lengths = [39, 28, 26, 24, 24, 39, 38, 37, 36];
		const total = lengths.reduce((sum, length) => sum + length, 0);
		const pairs = paired(alignAbsoluteNumbering(flat('db', total), split('cut', lengths)));

		expect(total).toBe(291);
		expect(pairs['db-e153']).toBe('cut-s6e12');
		expect(pairs['db-e291']).toBe('cut-s9e36');
	});

	it('pairs nothing when both sides number by season and disagree', () => {
		// The negative that matters. Two split sides whose seasons differ are two
		// servers saying different things about the same show, and the honest answer is
		// that one of the episodes is missing — not a conversion that makes it agree.
		const pairs = alignAbsoluteNumbering(split('left', [13, 13]), split('right', [12, 14]));

		expect(pairs).toEqual([]);
	});

	it('pairs nothing when both sides number by season and agree', () => {
		// Nothing to convert: the ordinary season and episode rule already relates
		// these, and firing here would put a computed coordinate over two declared ones.
		expect(alignAbsoluteNumbering(split('left', [13, 12]), split('right', [13, 12]))).toEqual([]);
	});

	it('pairs nothing when both sides are one continuous run', () => {
		expect(alignAbsoluteNumbering(flat('left', 25), flat('right', 25))).toEqual([]);
	});

	it('refuses a flat side whose numbers never leave a plausible season', () => {
		// Ten episodes in one season against two seasons of five. The totals agree, and
		// the flat side's highest number still sits inside a season the other side has —
		// so these two are arguing about where season 1 ends, not using two conventions.
		expect(alignAbsoluteNumbering(flat('left', 10), split('right', [5, 5]))).toHaveLength(10);
		expect(alignAbsoluteNumbering(flat('left', 5), split('right', [5, 5]))).toEqual([]);
	});

	it('refuses the whole show when a season on the split side has a hole', () => {
		const holed = split('cut', [13, 12]).filter((episode) => episode.id !== 'cut-s1e7');

		// Season 1 is now twelve rows and the gateway cannot tell whether the show ran
		// twelve or thirteen. Every season after it would be offset by one.
		expect(alignAbsoluteNumbering(flat('run', 25), holed)).toEqual([]);
	});

	it('refuses the whole show when a season is missing entirely', () => {
		const gapped = [
			...split('cut', [13]),
			...Array.from({ length: 12 }, (_, index) => ({
				id: `cut-s3e${index + 1}`,
				seasonNumber: 3,
				episodeNumber: index + 1,
			})),
		];

		expect(alignAbsoluteNumbering(flat('run', 25), gapped)).toEqual([]);
	});

	it('refuses two sides that do not account for the same number of episodes', () => {
		// The split side stops at season 2 while the run goes to 40. The lengths in hand
		// may belong to a neighbouring cut of the show, and a prefix that lines up is
		// exactly what that looks like from here.
		expect(alignAbsoluteNumbering(flat('run', 40), split('cut', [13, 12]))).toEqual([]);
	});

	it('refuses a split side that does not start at season 1', () => {
		const later = split('cut', [13, 12]).map((episode) => ({
			...episode,
			seasonNumber: (episode.seasonNumber as number) + 1,
		}));

		expect(alignAbsoluteNumbering(flat('run', 25), later)).toEqual([]);
	});

	it('refuses either side that numbers two rows the same', () => {
		const duplicated = [...flat('run', 25), { id: 'run-extra', seasonNumber: 1, episodeNumber: 7 }];

		expect(alignAbsoluteNumbering(duplicated, split('cut', [13, 12]))).toEqual([]);

		const twice = [...split('cut', [13, 12]), { id: 'cut-extra', seasonNumber: 2, episodeNumber: 3 }];

		expect(alignAbsoluteNumbering(flat('run', 25), twice)).toEqual([]);
	});

	it('tolerates holes on the side numbered straight through', () => {
		// A run missing episodes still measures the same axis: the conversion is a
		// function of the other side's season lengths, and its highest number is what
		// says how long the show is.
		const holed = flat('run', 25).filter((episode) => episode.episodeNumber !== 7);
		const pairs = paired(alignAbsoluteNumbering(holed, split('cut', [13, 12])));

		expect(Object.keys(pairs)).toHaveLength(24);
		expect(pairs['run-e14']).toBe('cut-s2e1');
		expect(pairs['run-e7']).toBeUndefined();
	});

	it('reads a run with no season number at all as one continuous run', () => {
		const pairs = paired(alignAbsoluteNumbering(flat('run', 25, null), split('cut', [13, 12])));

		expect(pairs['run-e14']).toBe('cut-s2e1');
	});

	it('leaves specials out of the run and out of the season lengths', () => {
		// Season 0 shifts nothing, on either side, and is never paired.
		const withSpecials = [
			...flat('run', 25),
			{ id: 'run-sp1', seasonNumber: 0, episodeNumber: 1 },
		];
		const cutWithSpecials = [
			...split('cut', [13, 12]),
			{ id: 'cut-sp1', seasonNumber: 0, episodeNumber: 1 },
			{ id: 'cut-sp2', seasonNumber: 0, episodeNumber: 2 },
		];
		const pairs = paired(alignAbsoluteNumbering(withSpecials, cutWithSpecials));

		expect(pairs['run-e14']).toBe('cut-s2e1');
		expect(Object.keys(pairs)).toHaveLength(25);
		expect(pairs['run-sp1']).toBeUndefined();
	});

	it('ignores rows a service left unnumbered rather than reading them as a hole', () => {
		const partial = [
			...split('cut', [13, 12]),
			{ id: 'cut-unknown', seasonNumber: 2, episodeNumber: null },
		];

		expect(paired(alignAbsoluteNumbering(flat('run', 25), partial))['run-e14']).toBe('cut-s2e1');
	});

	it('pairs nothing when a side holds no numbered episode at all', () => {
		expect(alignAbsoluteNumbering([], split('cut', [13, 12]))).toEqual([]);
	});
});

describe('episodeIdentifierKeys', () => {
	it('keeps an identifier only one episode of the show carries', () => {
		const keys = episodeIdentifierKeys([
			{ id: 'one', keys: ['tvdb:111'] },
			{ id: 'two', keys: ['tvdb:222'] },
		]);

		expect(keys.get('one')).toEqual(new Set(['tvdb:111']));
		expect(keys.get('two')).toEqual(new Set(['tvdb:222']));
	});

	it('drops the show identifier every episode was stamped with', () => {
		// The trap: a library that writes the series number onto all four hundred rows.
		// Believing it would merge episode 3 with episode 47 at full confidence.
		const keys = episodeIdentifierKeys([
			{ id: 'one', keys: ['tvdb:81472'] },
			{ id: 'two', keys: ['tvdb:81472'] },
			{ id: 'three', keys: ['tvdb:81472'] },
		]);

		expect(keys.size).toBe(0);
	});

	it('keeps the episode identifier and drops the show one on the same row', () => {
		const keys = episodeIdentifierKeys([
			{ id: 'one', keys: ['tvdb:81472', 'imdb:tt001'] },
			{ id: 'two', keys: ['tvdb:81472', 'imdb:tt002'] },
		]);

		expect(keys.get('one')).toEqual(new Set(['imdb:tt001']));
		expect(keys.get('two')).toEqual(new Set(['imdb:tt002']));
	});

	it('counts a value repeated on one row once', () => {
		const keys = episodeIdentifierKeys([{ id: 'one', keys: ['tvdb:111', 'tvdb:111'] }]);

		expect(keys.get('one')).toEqual(new Set(['tvdb:111']));
	});
});
