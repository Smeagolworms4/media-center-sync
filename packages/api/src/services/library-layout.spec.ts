import { LibraryLayoutSignal } from '@mcs/shared';
import {
	layoutExamples,
	layoutSignals,
	looksLikeASeasonName,
	namedSeasons,
	type SeasonRow,
} from './library-layout';

/** A season the server numbered, which is the ordinary case. */
const numbered = (count: number): SeasonRow[] =>
	Array.from({ length: count }, (_, index) => ({
		title: `Season ${index + 1}`,
		seasonNumber: index + 1,
	}));

/** A season the server could not number, which is the only kind judged on its name. */
const unnumbered = (...titles: string[]): SeasonRow[] =>
	titles.map((title) => ({ title, seasonNumber: null }));

describe('looksLikeASeasonName', () => {
	it.each([
		'Season 1',
		'Saison 12',
		'Staffel 3',
		'Temporada 2',
		'Stagione 4',
		'Сезон 5',
		'第4季',
		'4',
	])('reads %s as a season, whatever the language', (title) => {
		expect(looksLikeASeasonName(title)).toBe(true);
	});

	it.each(['Specials', 'Spéciaux', 'Bonus', 'OVA'])('reads %s as a season', (title) => {
		expect(looksLikeASeasonName(title)).toBe(true);
	});

	it.each(['Agatha All Along', 'Agent Carter', 'Agents of SHIELD', 'Cloak and Dagger'])(
		'reads %s as a show title',
		(title) => {
			expect(looksLikeASeasonName(title)).toBe(false);
		},
	);

	it('says nothing about a season the server named nothing', () => {
		// Called a season, so that a scraper that left the field empty does not put a
		// hint on every series in the library.
		expect(looksLikeASeasonName('   ')).toBe(true);
	});
});

describe('layoutSignals', () => {
	it('reports a series whose seasons are named like shows', () => {
		// The owner's Marvel folder as Jellyfin reported it.
		const signals = layoutSignals([
			...numbered(20),
			...unnumbered('Agatha All Along', 'Agent Carter', 'Agents of SHIELD', 'Cloak and Dagger'),
		]);

		expect(signals).toEqual([LibraryLayoutSignal.NAMED_SEASONS]);
	});

	it('says nothing about a show with ordinary seasons and specials', () => {
		expect(layoutSignals([...numbered(9), ...unnumbered('Specials')])).toEqual([]);
	});

	it('says nothing about one oddly named season', () => {
		// An anthology's first year, or a word the vocabulary does not know. One is not
		// a shape, and a hint on every such show is a hint people learn to close unread.
		expect(layoutSignals([...numbered(4), ...unnumbered('Murder House')])).toEqual([]);
	});

	it('reports a series with more seasons than a show plausibly runs for', () => {
		expect(layoutSignals(numbered(41))).toEqual([LibraryLayoutSignal.TOO_MANY_SEASONS]);
	});

	it('leaves a long-running show alone', () => {
		// The Simpsons is at thirty-six, and a soap goes further. Anything near twenty
		// would fire on a real library every year.
		expect(layoutSignals(numbered(36))).toEqual([]);
	});

	it('reports both signals when both are true', () => {
		expect(layoutSignals([...numbered(40), ...unnumbered('Agent Carter', 'Cloak and Dagger')])).toEqual([
			LibraryLayoutSignal.NAMED_SEASONS,
			LibraryLayoutSignal.TOO_MANY_SEASONS,
		]);
	});

	it('says nothing about a series with no season at all', () => {
		expect(layoutSignals([])).toEqual([]);
	});

	it('says nothing about a season placeholder the server repeated', () => {
		// The owner's Death Note, as Jellyfin reported it: one series, correctly
		// identified, whose bonuses sit in two seasons with no number. Jellyfin
		// publishes those as `Saison inconnue`, localised into the server's language,
		// and the first version of this counted the same placeholder twice and called
		// the folder misread. Two shows do not share a name, so a name that appears
		// twice is evidence of nothing.
		expect(
			layoutSignals([
				...unnumbered('Saison inconnue', 'Saison inconnue'),
				...numbered(1),
			]),
		).toEqual([]);
		expect(
			layoutSignals(unnumbered('Unknown Season', 'Unknown Season', 'Unbekannte Staffel')),
		).toEqual([]);
	});

	it('says nothing about seasons numbered in Roman numerals', () => {
		// Kaamelott's six seasons are `Livre I` to `Livre VI`. A numbering convention,
		// not six different shows — and the digit test alone cannot see it.
		expect(layoutSignals(unnumbered('Livre I', 'Livre II', 'Livre III', 'Livre IV'))).toEqual([]);
		expect(layoutSignals(unnumbered('Season IV', 'Season V', 'Specials'))).toEqual([]);
	});

	it('does not take a title that merely looks like one for a numeral', () => {
		// The numeral has to stand alone at the end, or half the library reads as
		// numbered: `Vikings`, `Rome` and `Echo` are words.
		expect(layoutSignals(unnumbered('Vikings', 'Rome'))).toEqual([
			LibraryLayoutSignal.NAMED_SEASONS,
		]);
		expect(layoutSignals(unnumbered('Echo', 'Helstrom'))).toEqual([
			LibraryLayoutSignal.NAMED_SEASONS,
		]);
	});

	it('still reports a folder whose shows have been emptied by the filing', () => {
		/*
		 * The owner's Marvel folder after a scan, and the trap an earlier version fell
		 * into. Filing episodes under the season their numbers name moves them out of the
		 * folders the server invented — which is the fix working — and leaves those
		 * folders empty. Excluding an empty season made the suspicion vanish on the one
		 * library that still had every bit of the problem: `Scream` with thirty-five
		 * seasons and Daredevil nowhere to be found.
		 *
		 * The names are quoted in the hint itself, so the evidence is on screen whether
		 * or not the row is drawn.
		 */
		expect(
			layoutSignals(unnumbered('Agatha All Along', 'Echo', 'The Falcon and the Winter Soldier')),
		).toEqual([LibraryLayoutSignal.NAMED_SEASONS]);
	});

	it('still reports a folder holding several shows', () => {
		// The counterpart of the case above, on the owner's Albator folder: four
		// distinct titles, so the floor is cleared on distinct names alone.
		expect(
			layoutSignals([
				...unnumbered(
					'Albator - Endless Odyssey',
					"Albator Corsaire de l'Espace",
					'Gun Frontier',
					'Harlock Saga',
					'Specials',
				),
				...numbered(1),
			]),
		).toEqual([LibraryLayoutSignal.NAMED_SEASONS]);
	});
});

describe('namedSeasons', () => {
	it('quotes the names that read like show titles, and only those', () => {
		expect(namedSeasons([...numbered(2), ...unnumbered('Agent Carter', 'Specials')])).toEqual([
			'Agent Carter',
		]);
	});

	it('quotes a repeated name once, in the order the server reported it', () => {
		expect(namedSeasons(unnumbered('Gun Frontier', 'Harlock Saga', 'Gun Frontier'))).toEqual([
			'Gun Frontier',
			'Harlock Saga',
		]);
	});
});

describe('layoutExamples', () => {
	it('shows enough names to recognise the folder and no more', () => {
		const examples = layoutExamples(
			unnumbered(
				'Agatha All Along',
				'Agent Carter',
				'Agents of SHIELD',
				'Cloak and Dagger',
				'Daredevil',
				'Jessica Jones',
			),
		);

		expect(examples).toEqual([
			'Agatha All Along',
			'Agent Carter',
			'Agents of SHIELD',
			'Cloak and Dagger',
		]);
	});
});
