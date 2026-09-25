import {
	releaseCostOf,
	ReleasePreferenceDimension,
	ReleasePreferenceScope,
	type Release,
	type ReleaseGroup,
	type ReleasePreference,
	type ReleasePreferenceLevels,
	type ReleasePreferenceRank,
	type ResolvedReleasePreference,
} from '@mcs/shared';

/**
 * Putting the copy somebody actually wants at the top of the list.
 *
 * A search comes back ordered by seeders, which is the only order a gateway that knows
 * nothing about the household can produce and the wrong one for every household: the
 * best-seeded line is usually a 2160p remux, and a house that watches on a 1080p
 * television and keeps a fixed disk wants the third line down. `ReleasePreference` is
 * that sentence said once; this is the part that applies it.
 *
 * **It orders and never hides.** Every comparison here can only move a row, and nothing
 * in this file can drop one — which is deliberate and is the whole safety of the
 * feature. See `preference.model.ts`: the one case a preference cannot be trusted with
 * is the case it did not foresee, and last place is a survivable answer where absence is
 * not.
 *
 * Pure on purpose. Everything it needs is in its arguments, so the comparator can be
 * pinned down against hand-written releases rather than against a live indexer — and the
 * ordering rules are exactly the kind that break quietly, because a list in the wrong
 * order still looks like a list.
 */

/**
 * The part of a release this can order on.
 *
 * `Release` and `ReleaseGroup` both satisfy it, which is why it is a structural type and
 * not one of them: the manager orders groups, the grouping orders the copies inside a
 * group, and both are the same question about the same four facts.
 */
/**
 * What ranking needs of a release, which a `Release` and a `ReleaseGroup` both answer.
 *
 * The last three are optional because the two shapes carry them differently: one release
 * has one tracker and its own flags, a group has every tracker its copies came from and
 * the union of their flags. Both are legitimate answers to "which trackers is this on",
 * and a reader that insisted on one of them would rank a group as coming from nowhere.
 */
export type PreferableRelease = Pick<Release, 'title' | 'quality' | 'source' | 'languages'> & {
	flags?: string[];
	indexer?: string;
	indexers?: string[];
};

/** Guard against a reordering that silently drops a row: never move, never remove. */
type Comparator<T> = (left: T, right: T) => number;

const firstMatch = (value: string, table: [RegExp, string][]): string | null => {
	for (const [pattern, label] of table) {
		if (pattern.test(value)) {
			return label;
		}
	}

	return null;
};

/**
 * `x265`, `HEVC`, `H.265` and `h 265` are one opinion, and trackers use all four.
 *
 * Checked in this order because `AV1` and `XviD` say nothing about 264 or 265 and the
 * two numbered families do not overlap — but a name can carry both `H.264` and `AAC`,
 * so nothing here may match on a bare number.
 */
const CODECS: [RegExp, string][] = [
	[/\bav1\b/i, 'AV1'],
	[/\b(?:[xh][\s._-]?265|hevc)\b/i, 'x265'],
	[/\b(?:[xh][\s._-]?264|avc)\b/i, 'x264'],
	[/\b(?:xvid|divx)\b/i, 'XviD'],
];

/**
 * Resolutions, as somebody types them rather than as the name spells them.
 *
 * `SD` is a genuine answer and covers three different numbers: somebody who says they
 * want SD last does not want to write `576p, 480p, 360p` and would not think to. Folding
 * them here is what makes their one line mean what they meant.
 */
const RESOLUTIONS: [RegExp, string][] = [
	[/\b(?:2160p|4k|uhd)\b/i, '2160p'],
	[/\b1080p\b/i, '1080p'],
	[/\b720p\b/i, '720p'],
	[/\b(?:sd|576p|480p|360p)\b/i, 'SD'],
];

const SOURCES: [RegExp, string][] = [
	[/\b(?:blu[\s._-]?ray|bdrip|brrip|bdremux|remux)\b/i, 'BluRay'],
	[/\bweb[\s._-]?dl\b/i, 'WEB-DL'],
	[/\bweb[\s._-]?rip\b/i, 'WEBRip'],
	[/\bhdtv\b/i, 'HDTV'],
	[/\b(?:dvdrip|dvd)\b/i, 'DVD'],
];

const LANGUAGES: [RegExp, string][] = [
	[/\bmulti\b/i, 'MULTI'],
	[/\b(?:vostfr|subfrench)\b/i, 'VOSTFR'],
	[/\b(?:truefrench|french)\b/i, 'FRENCH'],
	[/\bvff?\b/i, 'VF'],
	[/\b(?:vo|english|eng)\b/i, 'VO'],
];

/** A release name's own suffixes, which are not part of what it is called. */
const EXTENSION = /\.(?:mkv|mp4|avi|ts|m2ts|iso)$/i;

/**
 * A tracker's signature at the end of a name: `[rartv]`, `(www.site.org)`, `{eztv}`.
 *
 * The first of the two traps this reader exists for. `…x264-KILLERS[rartv]` ends in
 * `rartv]` and the group is `KILLERS`, so reading the tail of the name outright answers
 * with the tracker on a large share of a real search — and then every release from that
 * tracker shares a team nobody listed.
 */
const TRAILING_TAG = /[[({][^[({\])}]*[\])}]\s*$/;

/**
 * Words that follow a dash and are never a group.
 *
 * The second trap, and the expensive one. A name with no group at all still has a dash —
 * `WEB-DL`, `Blu-Ray`, `H-264` — and so does a title: `Spider-Man.2021.1080p.WEB-DL`
 * would answer `DL`, which is not wrong once but wrong for every release of that source,
 * so `DL` would climb to the top of a team order nobody typed. A name whose tail is one
 * of these has no readable group, and saying so is the correct answer.
 */
const NOT_A_TEAM = new Set([
	'dl', 'rip', 'web', 'bd', 'bdrip', 'brrip', 'dvd', 'dvdrip', 'hdtv', 'tv', 'hd',
	'sd', 'uhd', 'hdr', 'sdr', 'remux', 'proper', 'repack', 'internal', 'extended',
	'unrated', 'limited', 'complete', 'integrale', 'final',
	'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'xvid', 'divx', '264', '265',
	'aac', 'ac3', 'eac3', 'dts', 'ddp', 'ma', 'atmos', 'flac', 'mp3',
	'multi', 'french', 'truefrench', 'vf', 'vff', 'vfq', 'vo', 'vostfr', 'subfrench',
	'fr', 'en', 'eng', 'vost',
	'1080p', '720p', '2160p', '576p', '480p', '360p', '4k',
]);

/**
 * A plausible group tag: one word, no separators, two characters or more.
 *
 * The separators are what does the work. A group is always the last word of the name and
 * never contains a dot, a space or an underscore, so `Le.Nom-Du.Film.2019` answers
 * nothing rather than answering `Du.Film` — which is the shape of every French title
 * that happens to carry a dash.
 */
const TEAM = /^[a-z\d][a-z\d&'!+]{1,19}$/i;

/**
 * The release group, or null when the name does not carry one readably.
 *
 * Null rather than a guess, and that is the point: a wrong team is worse than no team,
 * because it is an opinion applied to every release that shares the wrong reading, while
 * an unread one simply ties with every other unlisted value and keeps its seeder order.
 */
export const releaseTeamOf = (title: string): string | null => {
	let name = title.trim().replace(EXTENSION, '');
	let stripped: string | null = null;

	// Repeatedly: a name really does end in `[tracker][hash]`, and stripping once would
	// leave the second bracket in the tail and read the whole thing as unreadable.
	for (;;) {
		const tag = TRAILING_TAG.exec(name);

		if (tag === null) {
			break;
		}

		stripped = tag[0];
		name = name.slice(0, tag.index).trim();
	}

	const dash = name.lastIndexOf('-');

	if (dash <= 0) {
		return null;
	}

	const tail = name.slice(dash + 1).trim();

	/*
	 * `…BluRay.x264-[YTS.AM]`, where the bracket *is* the group.
	 *
	 * Only reached when the name ends on its dash once the brackets are off, which no
	 * other shape does — so it cannot swallow `…-KILLERS[rartv]`, whose tail is a group
	 * already. The first word of the tag is taken because the commonest of them is a
	 * domain and the group is what comes before the dot.
	 */
	if (tail === '' && stripped !== null) {
		const inner = /[a-z\d]+/i.exec(stripped);

		return inner !== null && TEAM.test(inner[0]) && !NOT_A_TEAM.has(inner[0].toLowerCase())
			? inner[0]
			: null;
	}

	return TEAM.test(tail) && !NOT_A_TEAM.has(tail.toLowerCase()) ? tail : null;
};

/** The video codec the name claims, folded to one spelling per family. */
export const releaseCodecOf = (title: string): string | null => firstMatch(title, CODECS);

/**
 * What a release carries in one dimension, as zero, one or several values.
 *
 * Several because a release really is `MULTI.VOSTFR`, and the best of its values is the
 * one it should be ranked on — anything else would punish a release for also carrying a
 * language somebody ranked low.
 */
const listOf = (value: string | null): string[] => (value === null ? [] : [value]);

/**
 * The two answers an indexer can give about what a release costs, and the words for them.
 *
 * Folded like every other dimension so a typed opinion meets a reported flag: the tracker
 * says `freeleech`, the household typed `gratuit`, and they are the same sentence.
 */
const COSTS: [RegExp, string][] = [
	[/free\s*leech|freeleech|gratuit|\bfree\b|golden/i, 'free'],
	[/half\s*leech|halfleech|demi|\bhalf\b/i, 'half'],
];

const readers: Record<ReleasePreferenceDimension, (release: PreferableRelease) => string[]> = {
	// The parser fills `quality`, and the name is read only when it did not: a group
	// assembled by something other than `parseReleaseName` would otherwise be ranked as
	// having no resolution at all, which is a silent last place.
	[ReleasePreferenceDimension.RESOLUTION]: (release) =>
		release.quality !== null ? [release.quality] : listOf(firstMatch(release.title, RESOLUTIONS)),
	// Read off the name because nothing upstream carries it: the indexer does not report
	// a codec and the name parser has no field for one.
	[ReleasePreferenceDimension.CODEC]: (release) => listOf(releaseCodecOf(release.title)),
	[ReleasePreferenceDimension.TEAM]: (release) => listOf(releaseTeamOf(release.title)),
	[ReleasePreferenceDimension.SOURCE]: (release) =>
		release.source !== null ? [release.source] : listOf(firstMatch(release.title, SOURCES)),
	[ReleasePreferenceDimension.LANGUAGE]: (release) =>
		release.languages.length > 0 ? release.languages : listOf(firstMatch(release.title, LANGUAGES)),
	/*
	 * From the indexer's flags and never from the name.
	 *
	 * The one dimension a release name cannot carry: whether a tracker gives it away is a
	 * fact about that tracker on that day, and a name that said `FREELEECH` would be a
	 * name somebody typed. A release nothing was said about answers nothing and ranks with
	 * the unlisted, which is right — most public trackers report no flags at all, and
	 * reading that silence as "full price" would push every public copy to the bottom of a
	 * list for a household that never said anything about cost.
	 */
	[ReleasePreferenceDimension.COST]: (release) => listOf(releaseCostOf(release.flags ?? [])),
	// One tracker for a single copy, all of them for a group: a release on three trackers
	// is ranked on the best of the three, because taking that one is a press away.
	[ReleasePreferenceDimension.INDEXER]: (release) =>
		release.indexers ?? (release.indexer === undefined ? [] : [release.indexer]),
};

const folds: Record<ReleasePreferenceDimension, [RegExp, string][]> = {
	[ReleasePreferenceDimension.RESOLUTION]: RESOLUTIONS,
	[ReleasePreferenceDimension.CODEC]: CODECS,
	// Nothing to fold: a group's name is its name, and two groups whose names differ by a
	// letter are two groups.
	[ReleasePreferenceDimension.TEAM]: [],
	[ReleasePreferenceDimension.SOURCE]: SOURCES,
	[ReleasePreferenceDimension.LANGUAGE]: LANGUAGES,
	// Somebody types what their tracker prints — `freeleech`, `gratuit`, `free` — and
	// means the one thing the indexer reports as `free`.
	[ReleasePreferenceDimension.COST]: COSTS,
	// A tracker's name is its name, exactly as a team's is.
	[ReleasePreferenceDimension.INDEXER]: [],
};

/**
 * One value reduced to what it means, so a typed opinion meets a parsed release.
 *
 * Somebody types `HEVC` because that is what their tracker prints; the name says `x265`;
 * the parser says `WEB-DL` and they wrote `web dl`. Comparing the strings would make
 * every one of those a setting that silently does nothing — which is exactly the failure
 * an ordering feature cannot report, because the list still comes back looking ordered.
 */
const fold = (dimension: ReleasePreferenceDimension, value: string): string =>
	(firstMatch(value, folds[dimension]) ?? value).toLowerCase().replace(/[^a-z\d]+/g, '');

/**
 * Where a release sits in one rank: lower is better, and unlisted is last.
 *
 * Unlisted values all share one place rather than being spread out behind the listed
 * ones, because a preference says what is wanted and says nothing whatever about the
 * order of everything else. Two releases from two groups nobody named must tie here and
 * fall through to whatever ordered them before — their seeders.
 */
const placeOf = (release: PreferableRelease, rank: ReleasePreferenceRank): number => {
	const wanted = rank.values.map((value) => fold(rank.dimension, value));
	const carried = readers[rank.dimension](release).map((value) => fold(rank.dimension, value));

	let best = Number.MAX_SAFE_INTEGER;

	for (const value of carried) {
		const place = wanted.indexOf(value);

		if (place !== -1 && place < best) {
			best = place;
		}
	}

	return best;
};

/**
 * Better first, by the dimensions in their order.
 *
 * The first rank that separates two releases decides and the rest are never consulted,
 * which is the whole meaning of the dimension order: resolution above codec says a 1080p
 * x264 beats a 720p x265, and swapping the two lines says the opposite. Both are
 * defensible answers and the point of the feature is that the household gives its own.
 *
 * Zero on everything it cannot separate, so the caller's existing order survives. Never
 * use it on a freshly built list expecting a total order — it is a tie-breaker *above* an
 * order, not a replacement for one, and `sortByReleasePreference` says so by construction.
 */
export const compareByReleasePreference = (
	preference: ReleasePreference,
): Comparator<PreferableRelease> => (left, right) => {
	for (const rank of preference.ranks) {
		// An empty rank is a dimension somebody deliberately has no opinion about — a
		// category silencing one the global order cares about — and it must separate
		// nothing rather than putting every release in last place together.
		if (rank.values.length === 0) {
			continue;
		}

		const difference = placeOf(left, rank) - placeOf(right, rank);

		if (difference !== 0) {
			return difference;
		}
	}

	return 0;
};

/**
 * The list reordered by preference, with everything it does not separate left alone.
 *
 * A copy rather than a sort in place, and it leans on the sort being stable: whatever
 * ordered the list before — seeders, then size, out of `groupReleases` — is what still
 * decides between two releases the preference finds equally good. That is why an empty
 * preference is not a special case here and returns the same order it was given.
 */
export const sortByReleasePreference = <T extends PreferableRelease>(
	releases: T[],
	preference: ReleasePreference,
): T[] => [...releases].sort(compareByReleasePreference(preference));

/**
 * Which of the three levels applies, and it is whole-level replacement.
 *
 * Most specific wins outright: a media's own order is not merged with the category's and
 * the category's is not merged with the household's. Merging was the alternative and it
 * was rejected for one reason — nobody could predict the result. A per-media order that
 * inherited the dimensions it did not mention would answer differently depending on a
 * global setting on another screen, and "cancel the specific preference on this series"
 * would stop being a thing anybody could describe.
 *
 * Presence, never emptiness. `null` at a level means "no override here"; a preference
 * with no values means "order by nothing, on purpose", which is how one series opts out
 * of a household order that is wrong for it. See `isEmptyReleasePreference`.
 */
export const resolveReleasePreference = (
	levels: ReleasePreferenceLevels,
): ResolvedReleasePreference => {
	if (levels.media !== null && levels.media !== undefined) {
		return { scope: ReleasePreferenceScope.MEDIA, preference: levels.media };
	}

	if (levels.category !== null && levels.category !== undefined) {
		return { scope: ReleasePreferenceScope.CATEGORY, preference: levels.category };
	}

	if (levels.global !== null && levels.global !== undefined) {
		return { scope: ReleasePreferenceScope.GLOBAL, preference: levels.global };
	}

	return { scope: ReleasePreferenceScope.NONE, preference: { ranks: [] } };
};

/**
 * The folded groups, reordered, with a copy already on the disk still last.
 *
 * `heldAlready` stays above the preference and that is not an oversight: a file this
 * gateway already holds is not a better copy for being 1080p x265, and letting a
 * preference lift it over something that would actually bring a missing episode is the
 * one way this feature could make a list worse. It is still listed, because "you already
 * have this one" is an answer.
 */
export const orderGroupsByPreference = (
	groups: ReleaseGroup[],
	preference: ReleasePreference,
): ReleaseGroup[] => {
	const order = compareByReleasePreference(preference);

	return [...groups]
		/*
		 * The copies inside a line are ordered too, and that is not cosmetic: the first of
		 * them is what a grab takes.
		 *
		 * Two of the dimensions — what it costs and which tracker it is on — separate the
		 * copies of one release rather than the releases from each other, and ordering only
		 * the lines would leave a household that said "free first, and YGG before the rest"
		 * watching its own order decide which row to press and then be ignored the moment
		 * it did. Everything else ties between copies of the same release, so the seeded
		 * order the grouping produced survives underneath.
		 */
		.map((group) => ({ ...group, releases: sortByReleasePreference(group.releases, preference) }))
		.map((group) => ({ ...group, indexers: [...new Set(group.releases.map((one) => one.indexer))] }))
		.sort(
			(left, right) => Number(left.heldAlready) - Number(right.heldAlready) || order(left, right),
		);
};
