import { seasonFolderNumber, withSeasonNumber } from './season-folder';

describe('seasonFolderNumber', () => {
	it('reads the spellings a library really uses', () => {
		expect(seasonFolderNumber('Season 4')).toBe(4);
		expect(seasonFolderNumber('Saison 01')).toBe(1);
		expect(seasonFolderNumber('S02')).toBe(2);
		expect(seasonFolderNumber('season.3')).toBe(3);
		expect(seasonFolderNumber(' Saison 12 ')).toBe(12);
	});

	it('refuses a segment that merely contains a season', () => {
		/*
		 * Anchored at both ends, and this is what the anchors are for. `Saison 01` is a
		 * season folder; `From - Saison 01 - VOSTFR` is a folder somebody named, and
		 * renumbering inside it would be editing a name rather than reading one.
		 */
		expect(seasonFolderNumber('From - Saison 01 - VOSTFR')).toBeNull();
		expect(seasonFolderNumber('Spartacus')).toBeNull();
		expect(seasonFolderNumber('Specials')).toBeNull();
		expect(seasonFolderNumber('')).toBeNull();
	});
});

describe('withSeasonNumber', () => {
	it('puts this season in the folder, keeping the library’s own spelling', () => {
		// The report this exists for: a pin written while correcting a season one
		// placement filed every later season into season one, silently and for ever.
		expect(withSeasonNumber('/share/SeriesTV/From/Saison 01', 4))
			.toBe('/share/SeriesTV/From/Saison 04');
		expect(withSeasonNumber('From/Season 1', 2)).toBe('From/Season 2');
		expect(withSeasonNumber('From/Season 01', 2)).toBe('From/Season 02');
		expect(withSeasonNumber('From/S1', 12)).toBe('From/S12');
	});

	it('keeps the padding even when the number grows past it', () => {
		// Nine to ten is where a naive pad drops a digit, and a library that writes
		// `Saison 09` writes `Saison 10` rather than `Saison 1`.
		expect(withSeasonNumber('From/Saison 09', 10)).toBe('From/Saison 10');
	});

	it('answers nothing for a path whose last segment is not a season', () => {
		// Null rather than the path unchanged, so a caller can tell "this is not about
		// seasons" from "this is already the right season" and say so in its own terms.
		expect(withSeasonNumber('/share/SeriesTV/From', 4)).toBeNull();
		expect(withSeasonNumber('/share/SeriesTV', 4)).toBeNull();
	});

	it('ignores a trailing slash rather than reading it as a segment', () => {
		expect(withSeasonNumber('/share/SeriesTV/From/Saison 01/', 4))
			.toBe('/share/SeriesTV/From/Saison 04');
	});
});
