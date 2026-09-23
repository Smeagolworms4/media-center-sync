import { LibraryLayoutSignal } from '@mcs/shared';
import { layoutExamples, layoutSignals, looksLikeASeasonName, namedSeasons } from './library-layout';

const seasons = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => `Season ${index + 1}`);

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
			...seasons(20),
			'Agatha All Along',
			'Agent Carter',
			'Agents of SHIELD',
			'Cloak and Dagger',
		]);

		expect(signals).toEqual([LibraryLayoutSignal.NAMED_SEASONS]);
	});

	it('says nothing about a show with ordinary seasons and specials', () => {
		expect(layoutSignals([...seasons(9), 'Specials'])).toEqual([]);
	});

	it('says nothing about one oddly named season', () => {
		// An anthology's first year, or a word the vocabulary does not know. One is not
		// a shape, and a hint on every such show is a hint people learn to close unread.
		expect(layoutSignals([...seasons(4), 'Murder House'])).toEqual([]);
	});

	it('reports a series with more seasons than a show plausibly runs for', () => {
		expect(layoutSignals(seasons(41))).toEqual([LibraryLayoutSignal.TOO_MANY_SEASONS]);
	});

	it('leaves a long-running show alone', () => {
		// The Simpsons is at thirty-six, and a soap goes further. Anything near twenty
		// would fire on a real library every year.
		expect(layoutSignals(seasons(36))).toEqual([]);
	});

	it('reports both signals when both are true', () => {
		expect(layoutSignals([...seasons(40), 'Agent Carter', 'Cloak and Dagger'])).toEqual([
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
		expect(layoutSignals(['Saison inconnue', 'Saison inconnue', 'Specials', 'Saison 1'])).toEqual(
			[],
		);
		expect(layoutSignals(['Unknown Season', 'Unknown Season', 'Unbekannte Staffel'])).toEqual([]);
	});

	it('still reports a folder holding several shows', () => {
		// The counterpart of the case above, on the owner's Albator folder: four
		// distinct titles, so the floor is cleared on distinct names alone.
		expect(
			layoutSignals([
				'Albator - Endless Odyssey',
				"Albator Corsaire de l'Espace",
				'Gun Frontier',
				'Harlock Saga',
				'Specials',
				'Saison 1',
			]),
		).toEqual([LibraryLayoutSignal.NAMED_SEASONS]);
	});
});

describe('namedSeasons', () => {
	it('quotes the names that read like show titles, and only those', () => {
		expect(namedSeasons([...seasons(2), 'Agent Carter', 'Specials'])).toEqual(['Agent Carter']);
	});

	it('quotes a repeated name once, in the order the server reported it', () => {
		expect(namedSeasons(['Gun Frontier', 'Harlock Saga', 'Gun Frontier'])).toEqual([
			'Gun Frontier',
			'Harlock Saga',
		]);
	});
});

describe('layoutExamples', () => {
	it('shows enough names to recognise the folder and no more', () => {
		const examples = layoutExamples([
			'Agatha All Along',
			'Agent Carter',
			'Agents of SHIELD',
			'Cloak and Dagger',
			'Daredevil',
			'Jessica Jones',
		]);

		expect(examples).toEqual([
			'Agatha All Along',
			'Agent Carter',
			'Agents of SHIELD',
			'Cloak and Dagger',
		]);
	});
});
