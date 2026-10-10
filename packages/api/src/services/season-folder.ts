/**
 * Reading and rewriting the folder a library keeps one season in.
 *
 * One rule in one place because two parts of the gateway ask it and they must not
 * disagree: the naming service imitates the folders a library already uses, and a
 * placement pinned on a show has to put a season-four file in that show's season-four
 * folder. The second was the bug — a pin reading `/share/SeriesTV/From/Saison 01`,
 * written once while correcting a season-one placement, filed every later season into
 * season one, silently, for ever.
 */

/**
 * A segment that names a season and nothing else: `Season 4`, `Saison 01`, `S02`.
 *
 * Anchored at both ends on purpose. `Saison 01` is a season folder; `From - Saison 01 -
 * VOSTFR` is a folder somebody named, and rewriting a number inside it would be editing
 * a name rather than reading one. The vocabulary is short and deliberately not an
 * eight-language list: what is being asked here is "may I change this number", and the
 * safe answer for a segment nothing recognises is no.
 */
const SEASON_FOLDER = /^(?:season|saison|series|s)\s*\.?\s*(\d{1,3})$/i;

/** The season a folder segment names, or null when it does not name one. */
export const seasonFolderNumber = (segment: string): number | null => {
	const found = SEASON_FOLDER.exec(segment.trim());

	return found === null ? null : Number.parseInt(found[1], 10);
};

/**
 * The same path with its season folder renumbered, or null when it has none.
 *
 * Null rather than the path unchanged, so a caller can tell "this is not about seasons"
 * from "this is already the right season" and say so in its own terms.
 *
 * The library's own padding is kept: one writing `Season 1` gets `Season 2`, one writing
 * `Season 01` gets `Season 02`. Imitating the spelling is the whole point — a second
 * `Season 04` beside an existing `Saison 04` is two folders no media server shows as one
 * season.
 */
export const withSeasonNumber = (path: string, seasonNumber: number): string | null => {
	const segments = path.replace(/\/+$/, '').split('/');
	const last = segments[segments.length - 1] ?? '';
	const found = SEASON_FOLDER.exec(last.trim());

	if (found === null) {
		return null;
	}

	const padded = found[1].length > 1
		? String(seasonNumber).padStart(found[1].length, '0')
		: String(seasonNumber);

	segments[segments.length - 1] = last.replace(/\d{1,3}\s*$/, padded);

	return segments.join('/');
};
