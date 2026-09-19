/**
 * Turning what a library calls a file into something two libraries can agree on.
 *
 * Everything the correlation does rests on these functions. Two gateways never see
 * the same string for the same episode — one has `The.Expanse.S01E02.1080p.WEB-DL.
 * x265-GRP.mkv`, the other `The Expanse (2015) - s01e02 - Episode Title.mkv` — and
 * the only way a title-based match means anything is if both reduce to `expanse`.
 * They are pure and exported so they can be tested against a table of real names,
 * because every wrong reduction here shows up as either a missed match or, worse, a
 * confident wrong one.
 */

/**
 * Release noise: everything a scene name carries that is not the title.
 *
 * Deliberately a token list rather than one enormous expression, because the rule
 * is "drop this word", and a token that is also a word in a title — `ts`, `dv`,
 * `multi` — only ever appears surrounded by separators in a release name. Matching
 * on whole tokens is what keeps `Multiplicity` and `The Duke of Burgundy` intact.
 */
const NOISE_TOKENS = new Set([
	// Resolution and scan.
	'480p', '576p', '720p', '1080p', '1080i', '1440p', '2160p', '4320p', '4k', '8k', 'uhd', 'hd', 'sd',
	// Source.
	'bluray', 'blueray', 'bdrip', 'brrip', 'bdremux', 'bd', 'webrip', 'webdl', 'web', 'hdtv',
	'pdtv', 'dvdrip', 'dvdscr', 'dvd', 'hdrip', 'remux', 'cam', 'camrip', 'telesync', 'telecine',
	'ts', 'tc', 'r5', 'vod', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'hulu', 'itunes',
	// Video codec.
	'x264', 'x265', 'h264', 'h265', 'avc', 'hevc', 'xvid', 'divx', 'av1', 'vp9', 'mpeg2',
	'10bit', '8bit', '12bit', 'hi10p', 'hi10',
	// Dynamic range.
	'hdr', 'hdr10', 'hdr10plus', 'dv', 'dovi', 'sdr', 'hlg',
	// Audio.
	'aac', 'aac2', 'ac3', 'eac3', 'ddp', 'ddp5', 'dd5', 'dd', 'dts', 'dtshd', 'dtsma', 'truehd',
	'atmos', 'flac', 'mp3', 'opus', 'lpcm', 'pcm', '2ch', '6ch', '8ch',
	// Edition and language markers.
	'proper', 'repack', 'rerip', 'internal', 'limited', 'extended', 'uncut', 'unrated', 'remastered',
	'imax', 'theatrical', 'directors', 'director', 'criterion', 'anniversary', 'complete',
	'multi', 'dual', 'vostfr', 'vost', 'vff', 'vfq', 'vf', 'vo', 'subbed', 'subs', 'sub', 'dubbed',
	'hardcoded', 'hc', 'retail',
]);

/**
 * Channel layouts and the like, which are tokens but not words.
 *
 * Kept apart because they need a pattern rather than a list, and because a title
 * genuinely containing `5.1` does not exist while a release name without one is
 * rare.
 */
const NOISE_PATTERNS: RegExp[] = [
	/^\d\.\d$/, // 5.1, 7.1, 2.0
	/^\d{3,4}mb$/,
	/^\d+(\.\d+)?gb$/,
	/^[a-z]{2,3}\d\.\d$/, // dd5.1, ddp7.1
];

/**
 * Leading articles dropped before comparing.
 *
 * Libraries disagree constantly on this — one sorts `The Expanse` under E and
 * stores it as `Expanse, The`, another leaves it alone — so the article has to go
 * from both sides. The list covers the languages a European library mixes without
 * thinking about it.
 */
const LEADING_ARTICLES = [
	'the', 'a', 'an',
	'le', 'la', 'les', 'un', 'une', 'des',
	'der', 'die', 'das', 'ein', 'eine',
	'el', 'los', 'las', 'una',
	'il', 'lo', 'gli', 'i',
	'de', 'het', 'een',
];

/** A year we are willing to believe belongs to a film, not to a title. */
const YEAR_PATTERN = /^(19|20)\d{2}$/;

export interface ParsedTitle {
	/** The human title, cleaned of release noise but still readable and cased. */
	title: string;
	/** What gets stored in `MediaItem.normalizedTitle` and compared. */
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
}

export interface EpisodeNumbers {
	seasonNumber: number;
	episodeNumber: number;
}

/**
 * Fold accents, so `Amélie` and `Amelie` are the same film.
 *
 * NFD splits a letter from its diacritic and the range strips the diacritic; it is
 * the only approach that does not need a table per language.
 */
export function foldAccents(value: string): string {
	return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Strips one trailing media extension, and only one that looks like an extension. */
export function stripExtension(value: string): string {
	return value.replace(/\.[a-z0-9]{1,4}$/i, '');
}

/** Everything after the last separator, tolerating both kinds of slash. */
export function basename(value: string): string {
	const cut = value.replace(/\\/g, '/');
	const index = cut.lastIndexOf('/');

	return index === -1 ? cut : cut.slice(index + 1);
}

function isNoiseToken(token: string): boolean {
	if (NOISE_TOKENS.has(token)) {
		return true;
	}

	return NOISE_PATTERNS.some((pattern) => pattern.test(token));
}

/**
 * Reduce a title to its comparable form.
 *
 * Order matters and is not obvious: bracketed blocks go before tokenisation
 * (otherwise `[SubsPlease]` leaves `subsplease` behind as a plausible word), the
 * article goes after noise removal (otherwise `The 1080p Cut` loses the wrong
 * word), and the fallback at the end exists because a title that is nothing but
 * digits — `2012`, `1917` — would otherwise reduce to the empty string and match
 * every other empty string in the library.
 */
export function normalizeTitle(raw: string): string {
	if (!raw) {
		return '';
	}

	let value = foldAccents(raw).toLowerCase();

	// Bracketed blocks are release group tags, checksums and language markers. None
	// of them is ever part of a title, and `[1B2C3D4E]` would survive tokenisation.
	value = value.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');

	// An ampersand is a spelling choice, not a difference: one library writes
	// `Rick & Morty`, the next `Rick and Morty`.
	value = value.replace(/&/g, ' and ');

	// Separators used as spaces in release names. Apostrophes close up instead, so
	// `don't` becomes `dont` rather than `don t`.
	value = value.replace(/['’`]/g, '');
	value = value.replace(/[._\-:;,/\\+()\[\]{}!?"@#$%^*=|<>~]/g, ' ');

	const tokens = value.split(/\s+/).filter((token) => token !== '');
	const kept: string[] = [];

	for (const token of tokens) {
		if (isNoiseToken(token)) {
			continue;
		}

		// A parenthesised or trailing year is metadata, and it is carried separately
		// by `extractYear` so a match can weigh it instead of relying on the string.
		if (YEAR_PATTERN.test(token) && kept.length > 0) {
			continue;
		}

		kept.push(token);
	}

	// A release group glued to the last token (`...x265-GRP`) already lost its dash
	// above, so the group survives as a token. Dropping a trailing token of three or
	// four capitals would also drop `NCIS` or `CSI`, so it is left in: a spurious
	// token costs a little similarity, a dropped acronym costs the whole match.
	if (kept.length > 1 && LEADING_ARTICLES.includes(kept[0])) {
		kept.shift();
	}

	const normalized = kept.join(' ').replace(/\s+/g, ' ').trim();

	if (normalized !== '') {
		return normalized;
	}

	// Everything was noise or a year: the title was probably `2012` or `1080`. Fall
	// back to the raw string reduced as little as possible rather than to nothing.
	return foldAccents(raw)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The production year, when the name carries one.
 *
 * A parenthesised year wins over a bare one, because `Blade Runner 2049 (2017)`
 * has two candidates and only one of them is the year. A bare year is only
 * accepted when it is not the first token, which is what keeps `1917` and `2012`
 * as titles.
 */
export function extractYear(raw: string): number | null {
	const parenthesised = /[(\[](19|20)\d{2}[)\]]/.exec(raw);

	if (parenthesised) {
		return Number(parenthesised[0].slice(1, -1));
	}

	const tokens = foldAccents(raw)
		.replace(/[._\-]/g, ' ')
		.split(/\s+/)
		.filter((token) => token !== '');

	for (let index = tokens.length - 1; index >= 1; index -= 1) {
		if (YEAR_PATTERN.test(tokens[index])) {
			return Number(tokens[index]);
		}
	}

	return null;
}

/**
 * Season and episode out of a name.
 *
 * The four forms are tried in order of how much they prove. `S01E02` is
 * unambiguous, `1x02` nearly so, `Season 1 Episode 2` is spelled out, and a bare
 * `102` is a guess — which is why it comes last and is only accepted as a whole
 * token of three or four digits that is not a year. Anime absolute numbering
 * (`Show - 137`) deliberately does not match: guessing season 1 episode 37 from it
 * would be wrong far more often than right.
 */
export function parseEpisodeNumbers(raw: string): EpisodeNumbers | null {
	if (!raw) {
		return null;
	}

	const value = foldAccents(raw).replace(/[._]/g, ' ');

	const sxxexx = /\bs(?:eason)?\s*(\d{1,3})\s*[\s._-]*\s*e(?:p(?:isode)?)?\s*(\d{1,4})\b/i.exec(
		value,
	);

	if (sxxexx) {
		return { seasonNumber: Number(sxxexx[1]), episodeNumber: Number(sxxexx[2]) };
	}

	const cross = /\b(\d{1,2})x(\d{1,3})\b/i.exec(value);

	if (cross) {
		return { seasonNumber: Number(cross[1]), episodeNumber: Number(cross[2]) };
	}

	// `Season 1/Episode 2`, the form a folder tree produces rather than a file name.
	const spelled = /\bseason\s*(\d{1,3})\b[^\d]{0,12}\bepisode\s*(\d{1,4})\b/i.exec(value);

	if (spelled) {
		return { seasonNumber: Number(spelled[1]), episodeNumber: Number(spelled[2]) };
	}

	// Last resort: a bare `102` or `1102`. A four-digit token that parses as a year
	// is refused, because `Show 1984 720p` is not season 19 episode 84.
	const bare = /(?:^|[\s\-])(\d{3,4})(?=$|[\s\-.])/.exec(value);

	if (bare && !YEAR_PATTERN.test(bare[1])) {
		const digits = bare[1];
		const season = Number(digits.slice(0, digits.length - 2));
		const episode = Number(digits.slice(-2));

		if (season >= 1 && season <= 99) {
			return { seasonNumber: season, episodeNumber: episode };
		}
	}

	return null;
}

/**
 * Cut a release name down to the part that is the title.
 *
 * Everything from the first strong marker onwards — the episode tag, the year, the
 * first noise token — belongs to the release, not to the work. Cutting there is
 * what turns `The.Expanse.S01E02.1080p.WEB-DL.x265-GRP` into `The Expanse` rather
 * than into `The Expanse Episode Title 1080p GRP`.
 */
function titlePart(raw: string): string {
	const spaced = raw.replace(/[._]/g, ' ');
	const markers: number[] = [];

	const episodeTag =
		/\bs(?:eason)?\s*\d{1,3}\s*[\s._-]*\s*e(?:p(?:isode)?)?\s*\d{1,4}\b/i.exec(spaced) ??
		/\b\d{1,2}x\d{1,3}\b/i.exec(spaced) ??
		/\bseason\s*\d{1,3}\b/i.exec(spaced);

	if (episodeTag?.index !== undefined && episodeTag.index > 0) {
		markers.push(episodeTag.index);
	}

	const year = /[(\[]?(19|20)\d{2}[)\]]?/.exec(spaced);

	if (year?.index !== undefined && year.index > 0) {
		markers.push(year.index);
	}

	let offset = 0;

	for (const token of spaced.split(' ')) {
		const cleaned = foldAccents(token)
			.toLowerCase()
			.replace(/[^a-z0-9.]/g, '');

		if (cleaned !== '' && isNoiseToken(cleaned) && offset > 0) {
			markers.push(offset);
			break;
		}

		offset += token.length + 1;
	}

	const cut = markers.length > 0 ? Math.min(...markers) : spaced.length;

	return spaced.slice(0, cut).trim() || spaced.trim();
}

/**
 * Everything the name can tell us, in one pass.
 *
 * Handlers call this on the metadata the service reports, and on the file path when
 * the service reports nothing useful — a lot of Plex libraries carry a title of
 * `Episode 4` and a path that says far more.
 */
export function parseTitle(raw: string): ParsedTitle {
	const name = stripExtension(basename(raw ?? ''));
	const numbers = parseEpisodeNumbers(name);
	const readable = titlePart(name)
		.replace(/[\[\]{}()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	return {
		title: readable,
		normalizedTitle: normalizeTitle(readable),
		year: extractYear(name),
		seasonNumber: numbers?.seasonNumber ?? null,
		episodeNumber: numbers?.episodeNumber ?? null,
	};
}

/**
 * How alike two normalised titles are, between 0 and 1.
 *
 * Dice over character bigrams rather than an edit distance: it is insensitive to
 * word order, which matters because `Star Wars Episode V The Empire Strikes Back`
 * and `The Empire Strikes Back` are the same film on two libraries, and it does not
 * collapse to nothing on long strings the way a length-normalised edit distance
 * does. A containment bonus covers the case above, where one title is a strict
 * subset of the other.
 */
export function similarity(left: string, right: string): number {
	if (left === right) {
		return left === '' ? 0 : 1;
	}

	if (left === '' || right === '') {
		return 0;
	}

	const dice = diceCoefficient(left, right);
	const longer = left.length >= right.length ? left : right;
	const shorter = left.length >= right.length ? right : left;

	// A short title fully contained in a longer one is usually the same work under a
	// fuller name, but only when the short one is substantial: `Up` inside
	// `Growing Up` is a coincidence, and the length floor is what excludes it.
	if (shorter.length >= 6 && longer.includes(shorter)) {
		return Math.max(dice, 0.85);
	}

	return dice;
}

function diceCoefficient(left: string, right: string): number {
	const leftBigrams = bigrams(left);
	const rightBigrams = bigrams(right);

	if (leftBigrams.size === 0 || rightBigrams.size === 0) {
		return 0;
	}

	let shared = 0;

	for (const [bigram, count] of leftBigrams) {
		shared += Math.min(count, rightBigrams.get(bigram) ?? 0);
	}

	const total = countBigrams(leftBigrams) + countBigrams(rightBigrams);

	return (2 * shared) / total;
}

function bigrams(value: string): Map<string, number> {
	const compact = value.replace(/\s+/g, '');
	const result = new Map<string, number>();

	for (let index = 0; index < compact.length - 1; index += 1) {
		const bigram = compact.slice(index, index + 2);

		result.set(bigram, (result.get(bigram) ?? 0) + 1);
	}

	return result;
}

function countBigrams(source: Map<string, number>): number {
	let total = 0;

	for (const count of source.values()) {
		total += count;
	}

	return total;
}
