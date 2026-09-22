/**
 * Relating a show numbered straight through to the same show cut into seasons.
 *
 * Anime is routinely published as one continuous run — episode 1 to 291 — while the
 * same show elsewhere is filed as nine seasons. Correlation compares season and
 * episode numbers, so `E153` here and `S06E12` there look like two different things
 * and the gateway calls missing what somebody already owns. This is the arithmetic
 * that relates the two, and the guards that decide when it is allowed to.
 *
 * **This is the fallback, not the first answer.** Where both copies carry an
 * identifier that genuinely names *that episode*, the identifier settles it and no
 * arithmetic happens at all — see `MatchingService._externalIdMatch` and
 * `episodeIdentifierKeys` below, which is what tells an episode's own identifier from
 * a show's stamped onto all four hundred of them. Only where identifiers cannot
 * settle it — none carried, or only the series' — does anything here run. A pairing
 * made by this path is recorded as `MatchStrategy.ABSOLUTE_EPISODE` precisely so that
 * somebody debugging a wrong pairing can see which of the two produced it.
 *
 * ## Where the conversion comes from
 *
 * An absolute number can be turned into a season and an episode only with the season
 * lengths of that particular show, and there is no formula for them: seasons run 13,
 * 22, 26 or 39 episodes as the broadcaster felt like. So the lengths are read off the
 * side that *is* split into seasons, as this gateway has already indexed it. Nothing
 * is guessed and nothing is fetched.
 *
 * ## What is required before a single pair is made
 *
 * A wrong merge files the wrong episode under a name for ever and is worse than
 * leaving it missing, so the evidence demanded is deliberately more than the
 * arithmetic needs:
 *
 * 1. **The two sides plainly use different conventions.** Exactly one of them is flat
 *    — one season number for the whole show, or none at all — and the other has two
 *    seasons or more; and the flat side's highest number runs past the longest season
 *    the split side actually has, so it cannot be read as a season coordinate at all.
 *    Two sides that both number by season never get here, which is the point: there the
 *    numbers are the evidence, a disagreement between them means one of the episodes is
 *    missing, and "converting" that away is how the wrong episode ends up under the
 *    right name for ever.
 * 2. **The split side is contiguous from season 1 and every season is complete**, its
 *    episodes running 1..L with no hole. A hole makes that season's true length
 *    unknowable, and the length is what every later season's offset is built on: one
 *    missing episode in season 2 shifts seasons 3 to 9 by one, silently, and every
 *    pair after the hole is the wrong episode.
 * 3. **The two sides account for the same show, end to end**: the sum of the split
 *    side's season lengths equals the highest absolute number on the flat side.
 *
 * The third is the one worth arguing about, because it is what refuses an incomplete
 * peer. The weaker rule — map as far as the split side is provably complete and stop
 * — was written first and rejected. Its failure mode is the dangerous one: a
 * neighbouring cut of the same show (a remaster, a re-edit, a series that absorbed its
 * films) agrees on the early seasons and drifts later, so the prefix looks perfect and
 * the pairs past the drift are quietly wrong. Total agreement is the only cheap
 * evidence that the season lengths in hand are *this* show's. The cost is stated
 * plainly: a hole on either side suspends absolute pairing for the whole show, and
 * those episodes stay missing. That is the intended trade.
 *
 * Holes on the flat side are the one thing tolerated, because they cannot shift
 * anything: the mapping is a function of the split side's lengths alone, and the flat
 * side only contributes the axis it is measured on. Its *highest* number is compared,
 * not how many rows it has.
 *
 * ## Specials
 *
 * Season 0 is dropped on both sides and never paired here. No convention places
 * specials in the absolute run — some libraries interleave them, some append them,
 * most leave them out — and counting them into a season length would shift every
 * offset after it. They keep correlating by identifier and by title exactly as before.
 */

/** One episode as the numbering rules see it, which is all they are allowed to see. */
export interface NumberedEpisode {
	id: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
}

/** Two rows that are the same episode under two numberings. */
export interface NumberingPair {
	/** The row numbered straight through. */
	absoluteId: string;
	/** The row numbered inside a season. */
	splitId: string;
}

/** The split side, reduced to what the conversion needs. */
interface SeasonTable {
	/** Absolute number to the row that holds it on the split side. */
	byAbsolute: Map<number, string>;
	/** The sum of the season lengths: how many episodes this side says the show has. */
	total: number;
	/**
	 * The longest season this show actually has, which is what "past any plausible
	 * season length" is measured against.
	 *
	 * Measured rather than assumed. A constant would have to be wrong somewhere —
	 * seasons run 13, 22, 26 and 39 depending on the decade and the broadcaster — and
	 * the one number that is certainly right for this show is the one the side that has
	 * seasons is indexed with.
	 */
	longest: number;
}

/** The flat side, reduced to what the conversion needs. */
interface FlatRun {
	/** Episode number to the row that holds it. */
	byNumber: Map<number, string>;
	highest: number;
}

/**
 * Season 0 and anything unnumbered, gone.
 *
 * Unnumbered rows are dropped rather than treated as a hole: a service that reported
 * no episode number for one row has said nothing about the show's shape, and refusing
 * the whole show over it would make this fire on almost nobody. What it *does* make
 * impossible is the row being paired, which is the safe half of the answer.
 */
const numbered = (episodes: readonly NumberedEpisode[]): NumberedEpisode[] =>
	episodes.filter(
		(episode) =>
			episode.episodeNumber !== null &&
			episode.episodeNumber >= 1 &&
			episode.seasonNumber !== 0,
	);

/**
 * The flat side, or null when these rows are not one continuous run.
 *
 * Two rows claiming the same absolute number make the whole side ambiguous — one of
 * them would have to be chosen, and choosing wrongly is the failure this file exists
 * to avoid — so the run is refused rather than de-duplicated.
 */
const flatRun = (episodes: readonly NumberedEpisode[]): FlatRun | null => {
	const seasons = new Set(episodes.map((episode) => episode.seasonNumber));

	// One season number for the whole show, or none stated at all. Anything else is a
	// side that has seasons, whatever its episode numbers look like.
	if (seasons.size !== 1) {
		return null;
	}

	const byNumber = new Map<number, string>();

	for (const episode of episodes) {
		const number = episode.episodeNumber as number;

		if (byNumber.has(number)) {
			return null;
		}

		byNumber.set(number, episode.id);
	}

	// Safe without an emptiness test: a set of one season number can only have come
	// from at least one episode.
	return { byNumber, highest: Math.max(...byNumber.keys()) };
};

/**
 * The split side, or null when its seasons cannot state their own lengths.
 *
 * Refused rather than repaired on the first thing that makes a length a guess: a
 * missing season 1, a gap between seasons, a gap inside one, or two rows at the same
 * coordinates. Each of those would leave an offset that is nearly right, and a nearly
 * right offset is a confident wrong answer.
 */
const seasonTable = (episodes: readonly NumberedEpisode[]): SeasonTable | null => {
	const seasons = new Map<number, Map<number, string>>();

	for (const episode of episodes) {
		const season = episode.seasonNumber;

		if (season === null || season < 1) {
			return null;
		}

		const within = seasons.get(season) ?? new Map<number, string>();
		const number = episode.episodeNumber as number;

		if (within.has(number)) {
			return null;
		}

		within.set(number, episode.id);
		seasons.set(season, within);
	}

	if (seasons.size < 2) {
		return null;
	}

	const byAbsolute = new Map<number, string>();
	let total = 0;
	let longest = 0;

	for (let season = 1; season <= seasons.size; season += 1) {
		const within = seasons.get(season);

		// The seasons have to be 1..K with nothing skipped. A gateway holding seasons 1,
		// 2 and 4 knows nothing about how long season 3 was, and season 4 sits behind it.
		if (within === undefined) {
			return null;
		}

		for (let episode = 1; episode <= within.size; episode += 1) {
			const id = within.get(episode);

			// A hole inside a season is the same failure one level down: the season's
			// length is whatever the broadcaster decided, not what this library holds.
			if (id === undefined) {
				return null;
			}

			byAbsolute.set(total + episode, id);
		}

		total += within.size;
		longest = Math.max(longest, within.size);
	}

	return { byAbsolute, total, longest };
};

/**
 * The episodes of two copies of one series, paired across the two numberings.
 *
 * Empty whenever the evidence in this file's doc block is not all present, which is
 * the common answer and the safe one. The caller has already established that the two
 * series are the same show; this only decides which episode is which.
 */
export const alignAbsoluteNumbering = (
	left: readonly NumberedEpisode[],
	right: readonly NumberedEpisode[],
): NumberingPair[] => {
	const leftEpisodes = numbered(left);
	const rightEpisodes = numbered(right);
	const flatLeft = flatRun(leftEpisodes);
	const flatRight = flatRun(rightEpisodes);

	// Both flat or both split is not this problem. Both flat already correlates on the
	// numbers both servers declared, and both split likewise; firing here would be a
	// computed answer overruling two servers that already agree on the question.
	if ((flatLeft === null) === (flatRight === null)) {
		return [];
	}

	const flat = flatLeft ?? (flatRight as FlatRun);
	const table = seasonTable(flatLeft === null ? leftEpisodes : rightEpisodes);

	if (table === null) {
		return [];
	}

	/*
	 * The two sides have to be using different conventions, and this is where that is
	 * decided rather than assumed.
	 *
	 * The flat side's highest number must run past the longest season this show has, so
	 * that it cannot be read as a season coordinate at all: `E153` is not an episode of
	 * any season of a show whose longest season is 39, while `E12` is, and would be
	 * being "converted" out of a perfectly ordinary season. Two sides that both number
	 * by season never reach this line — the test above requires exactly one of them to
	 * be flat — and two sides that both number by season and simply disagree are left
	 * disagreeing, because there the numbers are the evidence and the honest answer is
	 * that one of the episodes is missing.
	 *
	 * Then the totals, which is the evidence that the season lengths in hand belong to
	 * this show rather than to a neighbouring cut of it. See the doc block above for
	 * why a prefix agreement was not enough.
	 */
	if (flat.highest <= table.longest || table.total !== flat.highest) {
		return [];
	}

	const pairs: NumberingPair[] = [];

	for (const [absolute, absoluteId] of flat.byNumber) {
		const splitId = table.byAbsolute.get(absolute);

		if (splitId !== undefined) {
			pairs.push({ absoluteId, splitId });
		}
	}

	return pairs;
};

/** One episode and the identifiers a service stamped on it. */
export interface IdentifiedEpisode {
	id: string;
	/** `provider:value` for every identifier worth comparing, already filtered. */
	keys: readonly string[];
}

/**
 * The identifiers that genuinely name one episode, per episode.
 *
 * Media servers routinely stamp every episode of a show with the *series'* identifier,
 * and the key is the same either way — `tvdb` carries both — so the key name cannot
 * be used to tell them apart. What can is the data: inside one service and one show,
 * an identifier that appears on more than one episode is the show's and proves nothing
 * about which episode this is, while one that appears exactly once is that episode's.
 *
 * Getting this wrong is the worst outcome available here. Pairing on a show-level
 * identifier merges episode 3 with episode 47 at full confidence, and a merge nobody
 * can see the reason for is one nobody unpicks.
 *
 * Scoped per service and per series because that is the only scope in which the count
 * means anything: the same value legitimately appears once under each of two servers,
 * and counting across them would find two and conclude the identifier is the show's.
 */
export const episodeIdentifierKeys = (
	episodes: readonly IdentifiedEpisode[],
): Map<string, Set<string>> => {
	const seen = new Map<string, number>();

	for (const episode of episodes) {
		for (const key of new Set(episode.keys)) {
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
	}

	const distinctive = new Map<string, Set<string>>();

	for (const episode of episodes) {
		const keys = new Set(episode.keys.filter((key) => seen.get(key) === 1));

		if (keys.size > 0) {
			distinctive.set(episode.id, keys);
		}
	}

	return distinctive;
};
