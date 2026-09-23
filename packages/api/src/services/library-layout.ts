import { LibraryLayoutSignal } from '@mcs/shared';

/**
 * Noticing that a library is organised in a way the media server misreads.
 *
 * The case this was written from: shows at
 * `/media/SeriesTV/Marvel Comics/Series TV/<show>/…` with the library root at
 * `/media/SeriesTV`. Jellyfin takes the first folder under the root for a series —
 * it identified `Marvel Comics/Series TV` as *Scream* — and every show beneath it for
 * one of its seasons, so the season list reads "Saison 1 … Saison 20, Agatha All
 * Along, Agent Carter, Agents of SHIELD, Cloak and Dagger". Two of the owner's series
 * were invisible for that reason and it cost him an evening to find out why.
 *
 * **The gateway cannot fix this and must not try.** It mirrors what the server
 * declares; rewriting the tree here would make the index disagree with the server
 * about what exists, and every pull would land in a folder the server does not read.
 * All it can do is notice and say so, with the series named and the repair spelled out
 * — add the deeper folder as a library root, or give the library a content type.
 *
 * **It is a suspicion, never a verdict.** Real shows do name their seasons: *American
 * Horror Story* is a season per title, anthologies are the normal case, and a
 * long-running soap genuinely passes thirty seasons. So the wording is something to
 * check, and a hint can be dismissed for good. What that buys is a low bar: it is
 * better to raise it on a handful of real shows somebody waves away once than to miss
 * the folder that made two series invisible.
 */

/**
 * What deciding whether a season looks odd needs to know about it.
 *
 * A name alone is not enough and the owner's library is where that showed: the same
 * three words can be a show somebody filed in the wrong place or a special the server
 * numbered and filed correctly, and only the number tells the two apart. Declared here
 * rather than imported from the repository so this stays a pure module with no opinion
 * about where the rows come from.
 */
export interface SeasonRow {
	title: string;
	/** What the server said this season is. Null when it could not say. */
	seasonNumber: number | null;
	/** How many episodes are under it, which is whether anybody can see it at all. */
	childCount: number;
}

/**
 * A name whose last word is a Roman numeral, which is a season number spelled out.
 *
 * `Livre I`, `Livre II`, `Season IV`, `Parte III`: a numbering convention rather than
 * a title, and the digit test alone cannot see it. Kaamelott is where it showed — its
 * six seasons are `Livre I` to `Livre VI`, and every one of them was read as the name
 * of a different show.
 *
 * Anchored at the end and required to be a whole word, so a show whose title merely
 * contains those letters is untouched: `Vikings` ends in `s`, `Mixi` is not matched
 * because the numeral has to stand alone, and `Rome` is a word rather than a numeral.
 * `I` alone counts — `Livre I` is the first book — and that is the one case worth
 * stating, because it also matches an English pronoun. A season called `I` is not a
 * sentence.
 */
const ROMAN_NUMERAL = /(?:^|\s)[ivxlcdm]+$/;

/** What a season is called when it is a season and not a show. */
const SPECIAL_SEASON_WORDS = [
	'special',
	'speciaux',
	'spécial',
	'spéciaux',
	'extra',
	'bonus',
	'oav',
	'ova',
	'film',
	'movie',
	'misc',
	'unknown',
];

/**
 * More seasons than a show plausibly runs for.
 *
 * Forty rather than a tidier twenty, and the gap is deliberate. *Doctor Who* is past
 * forty in some numberings, *The Simpsons* is at thirty-six, and a soap runs for
 * decades — so a threshold anywhere near twenty is a threshold that fires on real
 * shows every time somebody adds a long one. A folder of shows read as a series
 * passes forty as soon as the folder holds forty shows, which is what a collection
 * folder is for, and the named-seasons signal catches the smaller ones long before.
 */
const IMPLAUSIBLE_SEASON_COUNT = 40;

/**
 * How many title-named seasons it takes to be worth mentioning.
 *
 * Two, not one. One is an anthology's first season, a "Specials" the vocabulary below
 * did not know the word for in somebody's language, or a single folder somebody
 * dropped beside the seasons — all ordinary, and a hint on every one of them is a hint
 * people learn to close without reading. Two or more is a shape.
 */
const NAMED_SEASON_FLOOR = 2;

/** How many names are quoted as evidence. Enough to recognise, short enough to read. */
const EXAMPLE_LIMIT = 4;

/**
 * Whether this season name reads like a season rather than like a show.
 *
 * Tested by what a season name *has* rather than by matching the word "season" in
 * eight languages: every media server names an ordinary season with the season's
 * number in it — `Season 4`, `Saison 4`, `Staffel 4`, `第4季`, or bare `4` — so a name
 * carrying a digit is a season name whatever language it is in. A vocabulary check
 * would have to be complete to be safe, and an incomplete one puts a false hint on
 * every library in a language nobody thought of.
 *
 * The specials are the exception, because those genuinely have no number, and their
 * few names are worth listing: they appear on almost every well-scraped show and would
 * otherwise be the second title-named season that trips the floor.
 *
 * What is deliberately *not* excluded is a season named after the series itself. That
 * is exactly what the misread folder produces — the show's own name under the folder's
 * name — and excluding it would blind this to the case it exists for.
 */
export const looksLikeASeasonName = (title: string): boolean => {
	const folded = title
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.trim();

	if (folded === '') {
		// A season the server named nothing says nothing either way, and calling it a
		// show title would fire on every library whose scraper left the field empty.
		return true;
	}

	return (
		/\d/.test(folded)
		|| ROMAN_NUMERAL.test(folded)
		|| SPECIAL_SEASON_WORDS.some((word) => folded.includes(word))
	);
};

/**
 * What looks wrong about one series' seasons, or nothing.
 *
 * Returns the signals rather than a verdict so the interface can say which of the two
 * it is looking at: "its seasons are named like shows" and "it claims sixty seasons"
 * are checked differently by whoever reads them, and folding both into one sentence
 * would make the hint vaguer than the evidence.
 */
export const layoutSignals = (seasons: readonly SeasonRow[]): LibraryLayoutSignal[] => {
	const signals: LibraryLayoutSignal[] = [];

	if (namedSeasons(seasons).length >= NAMED_SEASON_FLOOR) {
		signals.push(LibraryLayoutSignal.NAMED_SEASONS);
	}

	if (seasons.length > IMPLAUSIBLE_SEASON_COUNT) {
		signals.push(LibraryLayoutSignal.TOO_MANY_SEASONS);
	}

	return signals;
};

/**
 * The season names that read like show titles, which is the evidence to quote.
 *
 * Counted once per *distinct* name, and that is the rule that keeps this honest. A
 * folder misread as a series shows the names of the shows it holds, and two shows do
 * not share a name; a name appearing twice is therefore not evidence of anything, it
 * is a placeholder. Jellyfin is the case that proved it: a season whose episodes carry
 * no season number is published as `Saison inconnue`, localised into the server's
 * language, so a perfectly ordinary Death Note — one series, correctly identified,
 * with its bonuses in two unnumbered seasons — arrived here as two title-looking names
 * and tripped the floor. Matching the placeholder by its words would need the same
 * eight-language vocabulary `looksLikeASeasonName` refuses to depend on; counting
 * distinct names needs none and covers every server's spelling of it.
 *
 * Insertion order is kept, so the evidence quoted is still the order the server
 * reports its seasons in.
 */
export const namedSeasons = (seasons: readonly SeasonRow[]): string[] => [
	...new Set(
		seasons
			/*
			 * A season the server gave a number to is a season, whatever it is called.
			 * `Tokyo Revelation` and `The Plan` are specials carrying `seasonNumber` 0 on
			 * the owner's Jellyfin — correctly filed, correctly shown — and reading their
			 * names as show titles put a suspicion on two series that had nothing wrong
			 * with them. The number is the server stating what the row is; the name is
			 * only what it happens to be called.
			 */
			.filter((season) => season.seasonNumber === null)
			/*
			 * A season holding nothing is not evidence, because nothing is what anybody
			 * can see of it.
			 *
			 * This went back and forth twice and the owner settled it: warning about a
			 * folder the interface does not draw is asking somebody to check the
			 * invisible. Filing episodes under the season their numbers name empties the
			 * folders a server invented — that is the fix working — and once a folder is
			 * empty the shape it described is gone from every screen.
			 *
			 * The cost is stated rather than hidden: it also silences a folder that is
			 * genuinely several shows, because those folders are empty for the same
			 * reason. Catching that case needs a different signal — a series claiming
			 * thirty-five seasons while its own identifier names a show that ran for
			 * three — and that one needs a metadata service this gateway does not call.
			 */
			.filter((season) => season.childCount > 0)
			.filter((season) => !looksLikeASeasonName(season.title))
			.map((season) => season.title),
	),
];

/** The few names a hint shows, so a person recognises the folder without scrolling. */
export const layoutExamples = (seasons: readonly SeasonRow[]): string[] =>
	namedSeasons(seasons).slice(0, EXAMPLE_LIMIT);
