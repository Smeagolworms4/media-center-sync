import { ReleaseKind, type ReleaseCoverage } from '@mcs/shared';

/**
 * What a release name says about itself.
 *
 * Read off the name and never from the indexer's own fields, which is a decision worth
 * stating: a tracker's category says `TV/HD` for a season pack and for one episode
 * alike, and its quality field is filled in by whoever uploaded it. The name is the one
 * thing every tracker agrees on, because it is the thing the release *is*.
 *
 * Everything here is a guess and is treated as one. A name nothing can be read off
 * stays `UNKNOWN` and is shown rather than hidden — somebody looking at a list of
 * releases can tell what they are looking at far better than this can — and nothing
 * here decides anything on its own: it orders a list and labels its rows.
 */

export interface ParsedRelease {
	kind: ReleaseKind;
	seasonNumber: number | null;
	/** The first episode it names, kept because most of the product asks for one. */
	episodeNumber: number | null;
	quality: string | null;
	source: string | null;
	languages: string[];
	/** Everything it names, which is what decides whether it fills a gap. */
	coverage: ReleaseCoverage;
}

/**
 * `S02E09`, `2x09`, `S02 E09`. The separators are the point: every tracker spells this
 * differently and all of them are common enough to be worth a branch.
 */
// `(?!\d)` and not `\b`, and the difference is a real release: a trailing word
// boundary refuses `S01E01E02` outright, because `1` followed by `E` is not a
// boundary — so a name listing two episodes was read as naming none, and fell
// through to being taken for a season pack.
const EPISODE = /\bs(\d{1,2})[\s._-]*e(\d{1,3})(?!\d)/i;
const EPISODE_X = /\b(\d{1,2})x(\d{1,3})\b/i;

/**
 * A run of episodes in one release: `S01E01-E03`, `S01E01E02E03`, `S01E01-03`.
 *
 * Worth its own reading because the difference is four files or one: a release named
 * `S01E01-E12` read as episode one is eleven gaps somebody thinks are still open, and
 * a plan built on that grabs eleven things it already has coming.
 */
const EPISODE_RANGE = /\bs(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._-]*(?:-\s*e?|e)(\d{1,3}))+/i;
const EPISODE_TAIL = /(?:[\s._-]*(?:-\s*e?|e)(\d{1,3}))/gi;

/**
 * A whole show in one release: `Complete Series`, `Intégrale`, `Seasons 1-5`.
 *
 * `COMPLETE` on its own is deliberately not enough — `S02.COMPLETE` is a season pack
 * and says so — so the word has to sit beside something that means the show.
 */
// `intégrale` with its accent as well as without: it is how the word is actually
// spelled, and a French library is full of releases that spell it properly.
const WHOLE_SERIES = /\b(?:complete[\s._-]*(?:series|serie|collection)|int[ée]grale?|seasons?[\s._-]*\d{1,2}[\s._-]*-[\s._-]*\d{1,2})\b/i;

/**
 * A season with no episode after it, which is what makes a pack a pack.
 *
 * `Complete` is matched separately because a great many packs say `S02.COMPLETE` and a
 * great many others say only `Season 2` — and a pack mistaken for one episode is ten
 * files somebody did not ask for.
 */
const SEASON = /\b(?:s(?:eason)?[\s._-]*(\d{1,2}))\b/i;

const QUALITY: [RegExp, string][] = [
	[/\b(2160p|4k|uhd)\b/i, '2160p'],
	[/\b1080p\b/i, '1080p'],
	[/\b720p\b/i, '720p'],
	[/\b576p\b/i, '576p'],
	[/\b480p\b/i, '480p'],
];

const SOURCE: [RegExp, string][] = [
	[/\b(blu[\s._-]?ray|bdrip|brrip|bdremux|remux)\b/i, 'BluRay'],
	[/\b(web[\s._-]?dl|webdl)\b/i, 'WEB-DL'],
	[/\b(web[\s._-]?rip|webrip)\b/i, 'WEBRip'],
	[/\bhdtv\b/i, 'HDTV'],
	[/\b(dvdrip|dvd)\b/i, 'DVD'],
];

/**
 * Language tags, and the French ones are the reason this list is not the obvious one.
 *
 * `VOSTFR` is subtitled and `MULTI` is not a language at all but a promise of several;
 * both are what a French library is full of, and a list that only knew `FRENCH` would
 * label half of it as nothing. The tag is kept as the release spells it, because that
 * is what somebody recognises.
 */
const LANGUAGES: [RegExp, string][] = [
	[/\bmulti\b/i, 'MULTI'],
	[/\bvostfr\b/i, 'VOSTFR'],
	[/\bvff?\b/i, 'VF'],
	[/\b(french|truefrench)\b/i, 'FRENCH'],
	[/\b(vo|english|eng)\b/i, 'VO'],
	[/\bjap(anese)?\b/i, 'JP'],
];

const numberOf = (value: string | undefined): number | null => {
	if (value === undefined) {
		return null;
	}

	const parsed = Number.parseInt(value, 10);

	return Number.isNaN(parsed) ? null : parsed;
};

const firstMatch = (name: string, table: [RegExp, string][]): string | null => {
	for (const [pattern, label] of table) {
		if (pattern.test(name)) {
			return label;
		}
	}

	return null;
};

/**
 * Read a release name.
 *
 * `hasSeason` says whether the media this was searched for is a show at all, and it is
 * what keeps `Blade Runner 2049` from being read as season 20: a film's name is full of
 * numbers and none of them are coordinates. Without that context the safe answer is to
 * trust only an explicit `SxxExx`.
 */
export const parseReleaseName = (name: string, hasSeason = true): ParsedRelease => {
	const episode = EPISODE.exec(name) ?? EPISODE_X.exec(name);
	const seasonNumber = episode ? numberOf(episode[1]) : null;
	const episodeNumber = episode ? numberOf(episode[2]) : null;
	const pack = episode === null && hasSeason ? SEASON.exec(name) : null;
	const packSeason = pack ? numberOf(pack[1]) : null;
	const wholeSeries = hasSeason && WHOLE_SERIES.test(name);
	const episodeNumbers = episodeNumber === null ? [] : runOf(name, episodeNumber);

	const languages: string[] = [];

	for (const [pattern, label] of LANGUAGES) {
		if (pattern.test(name) && !languages.includes(label)) {
			languages.push(label);
		}
	}

	return {
		kind:
			episodeNumber !== null
				? ReleaseKind.EPISODE
				: packSeason !== null
					? ReleaseKind.SEASON_PACK
					: hasSeason
						? ReleaseKind.UNKNOWN
						: ReleaseKind.MOVIE,
		seasonNumber: seasonNumber ?? packSeason,
		episodeNumber,
		quality: firstMatch(name, QUALITY),
		source: firstMatch(name, SOURCE),
		languages,
		coverage: {
			seasonNumber: seasonNumber ?? packSeason,
			episodeNumbers,
			// A season pack, or a complete run that also names one season. Never both a
			// pack and an enumeration: a name that spells its episodes has told us
			// exactly what it holds, and claiming the season on top would make it fill
			// gaps it does not cover.
			wholeSeason: episodeNumbers.length === 0 && packSeason !== null,
			wholeSeries,
		},
	};
};

/**
 * Every episode a name spells out, from the first one found.
 *
 * `S01E01-E03` is one, two and three; `S01E01E02` is one and two. The tail is read
 * rather than assumed contiguous for the second form, and filled in for the first,
 * because `E01-E12` names twelve files and lists two of them.
 */
const runOf = (name: string, first: number): number[] => {
	const range = EPISODE_RANGE.exec(name);

	if (range === null) {
		return [first];
	}

	const found = [...range[0].matchAll(EPISODE_TAIL)]
		.map((match) => numberOf(match[1]))
		.filter((one): one is number => one !== null);
	const last = found.at(-1);

	if (last === undefined || last <= first) {
		return [first];
	}

	// A dash means a run and a repeated `E` means a list, but a list of one number after
	// the first is also a run of two — so the safe reading of both is everything from
	// the first to the last. Capped, because `E01-E999` is a name, not a season.
	return last - first > 200 ? [first] : Array.from({ length: last - first + 1 }, (_, index) => first + index);
};
