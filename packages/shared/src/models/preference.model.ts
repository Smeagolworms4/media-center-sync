/**
 * Which of forty copies somebody actually wants, said once instead of forty times.
 *
 * A search for one episode comes back folded into a handful of real choices, ordered by
 * seeders and size — which is the only ordering a gateway that knows nothing about the
 * household can produce, and the wrong one for everybody: a house that watches on a
 * 1080p television and keeps a fixed disk wants 1080p x265 from the two groups whose
 * encodes it trusts, and a well-seeded 2160p remux is the single worst line on the
 * screen for them. Saying so per search is saying it every search.
 *
 * **This orders and never hides.** Every release found stays listed, because the one
 * thing a preference cannot be trusted with is the case it did not foresee: the only
 * copy of an episode that aired last night, from a group nobody listed, in 720p. A
 * filter answers "nothing found" there, and the person goes looking for a better search
 * term for a release that was on the screen all along. An order answers "here is
 * everything, worst last", which is never wrong.
 *
 * Three ordered lists and the order between them, which is the part worth reading
 * twice. `1080p, 2160p, 720p` says which resolution wins; putting resolution ahead of
 * codec says that resolution wins *first* — so 1080p x264 beats 720p x265 — and
 * swapping the two lines says the opposite. Both are legitimate answers to "what is a
 * better copy" and neither could be expressed by three lists without an order over
 * them.
 */

/**
 * A thing releases differ by and somebody can have an opinion about.
 *
 * Adding one costs a value here, a reader in `release-preferences.ts` and a label in the
 * catalogues — deliberately, which is why the preference is a list of dimensions rather
 * than three named fields. Three fields would have made "source before codec" an
 * unrepresentable sentence and a fourth opinion a change to every layer that carries a
 * preference: the model, the settings validator, the comparator and the editor.
 */
export enum ReleasePreferenceDimension {
	/** `1080p`, `2160p`, `720p`, `SD` — read off the name, as everything here is. */
	RESOLUTION = 'resolution',
	/** `x265`, `x264`, `AV1`. Spelt half a dozen ways by trackers; folded to one. */
	CODEC = 'codec',
	/** The release group: the tail of a scene name, `-NTb`, `-FLUX`. */
	TEAM = 'team',
	/** `BluRay`, `WEB-DL`, `HDTV`, as the name parser reports it. */
	SOURCE = 'source',
	/** `MULTI`, `VOSTFR`, `FRENCH` — the tags the parser read, in the name's order. */
	LANGUAGE = 'language',
	/**
	 * What it costs on the tracker's ratio: `free`, `half`.
	 *
	 * The one dimension that is not about the file at all, and on a private tracker it is
	 * often the one that decides: two identical encodes, one free and one not, is not a
	 * choice anybody makes twice. Put ahead of the others it says "the cheapest of the
	 * acceptable copies"; put behind them, "the best copy, free if that is an option".
	 *
	 * Read from the flags the indexer reported, so it is only ever known for a tracker
	 * that says — most public ones do not, and a release that said nothing ranks with the
	 * unlisted rather than last.
	 */
	COST = 'cost',
	/**
	 * Which tracker the copy comes from.
	 *
	 * Not a property of the release either: the same file sits on several, and which one
	 * it is taken from decides what it costs, how fast it comes and whose ratio pays. A
	 * household with a private tracker it trusts and a public one it falls back on has
	 * exactly one sentence to say here, and it is an order rather than a filter — the
	 * fallback is still worth having when the good one has nothing.
	 *
	 * This one also chooses **within** a line: a release found on three trackers is one
	 * row, and the copy a grab takes is the first one this order puts.
	 */
	INDEXER = 'indexer',
}

/** One dimension and the values somebody prefers in it, best first. */
export interface ReleasePreferenceRank {
	dimension: ReleasePreferenceDimension;
	/**
	 * Best first. Anything a release carries that is not in here ranks after
	 * everything that is, and ties with every other unlisted value — which is what
	 * makes the list a preference and not a whitelist.
	 *
	 * Matched loosely on purpose: case, separators and the commonest spellings of one
	 * thing all fold together, so `HEVC`, `H.265` and `x265` are one value. Somebody
	 * typing what they see on a tracker should not have to guess our spelling of it.
	 *
	 * Empty is meaningful and is not the same as leaving the dimension out: it says
	 * "I have no opinion here", which is how a category silences a dimension the
	 * global order cares about.
	 */
	values: string[];
}

/**
 * What a better copy is, as an order over dimensions and an order inside each.
 *
 * The dimension order is the list order: the first rank that separates two releases
 * decides between them, and the rest are never consulted. A preference with no ranks
 * separates nothing and leaves the list exactly as it arrived, which is what a gateway
 * nobody has configured must do.
 */
export interface ReleasePreference {
	ranks: ReleasePreferenceRank[];
}

/**
 * The preference as the settings hold it: one for the household, one per category.
 *
 * Per category because the answer genuinely differs by shelf and not by taste: the same
 * house wants 2160p remux for `Films` and 1080p x265 for `Séries`, since one is watched
 * once on the projector and the other is twelve hours that has to live on the disk. One
 * global order could only be right for one shelf.
 *
 * Keyed by the folded category key — `categoryKeyOf` in `library.model.ts` — for the
 * reason `categoryTargets` is: categories are derived from library names and have no
 * row of their own. A key whose category is not currently reported is kept rather than
 * pruned, because a shelf disappears the moment a media service is offline and dropping
 * the row would lose a deliberate choice to a temporary outage.
 */
export interface ReleasePreferenceSettings {
	global: ReleasePreference;
	byCategory: Record<string, ReleasePreference>;
}

/**
 * The three levels a search is ordered by, most specific first when they disagree.
 *
 * The media's own preference is **not** in the settings and is carried by the media,
 * which is the one structural decision here worth defending: a map of media id to
 * preference in a key/value settings row would grow with every series anybody ever had
 * an opinion about, would be read whole on every search, and would keep rows for media
 * that no longer exist with nothing able to tell that they do not. A media is a row
 * already; its preference belongs on it.
 *
 * Each level is optional because most searches have none of them.
 */
export interface ReleasePreferenceLevels {
	global?: ReleasePreference | null;
	category?: ReleasePreference | null;
	media?: ReleasePreference | null;
}

/**
 * Which level actually decided an order, which the media screen has to be able to say.
 *
 * A preference that applies to one series and is written somewhere else is the defect
 * this whole feature can most easily reintroduce: somebody wonders why a search on that
 * one show answers differently from every other, and nothing on the screen they are
 * looking at mentions a setting. So the resolution reports where it came from, the media
 * says so out loud, and cancelling is one press on the same line.
 */
export enum ReleasePreferenceScope {
	GLOBAL = 'global',
	CATEGORY = 'category',
	MEDIA = 'media',
	/** Nothing set anywhere, so seeders and size still decide, as they always did. */
	NONE = 'none',
}

/** A preference and the level it was taken from. See `ReleasePreferenceScope`. */
export interface ResolvedReleasePreference {
	scope: ReleasePreferenceScope;
	preference: ReleasePreference;
}

/**
 * True when this preference would separate nothing, whatever its shape.
 *
 * For labelling a screen, and deliberately **not** how a level is chosen. Absent and
 * empty are two different sentences at a level: `null` says "I have no override, use the
 * one above", and a preference with no values says "here, order by nothing" — which is
 * how one series opts out of a household order that is wrong for it. Resolving on
 * emptiness instead of on presence would make that second sentence unsayable, and the
 * only way to say it would be to list every value in the order they already arrive in.
 */
export const isEmptyReleasePreference = (
	preference: ReleasePreference | null | undefined,
): boolean =>
	preference === null
	|| preference === undefined
	|| preference.ranks.every((rank) => rank.values.length === 0);

/** A gateway nobody has configured: no opinion, so seeders and size still decide. */
export const DEFAULT_RELEASE_PREFERENCES: ReleasePreferenceSettings = {
	global: { ranks: [] },
	byCategory: {},
};

/**
 * The order the dimensions are offered in, and the one a new preference is built with.
 *
 * Resolution first because it is the dimension people answer without being asked — it
 * is the number on the box — and team last because it is the one that presumes the most
 * knowledge. It is only a starting order: the whole point is that it can be changed.
 */
export const RELEASE_PREFERENCE_DIMENSIONS: ReleasePreferenceDimension[] = [
	ReleasePreferenceDimension.RESOLUTION,
	ReleasePreferenceDimension.CODEC,
	ReleasePreferenceDimension.TEAM,
	ReleasePreferenceDimension.SOURCE,
	ReleasePreferenceDimension.LANGUAGE,
	// The two that are about where a copy comes from rather than what it is, last in the
	// offered order because a household answers "what is a good copy" before "and from
	// whom" — and moving either to the front is one press, which is the whole point.
	ReleasePreferenceDimension.COST,
	ReleasePreferenceDimension.INDEXER,
];

/**
 * Values worth offering as a starting point, per dimension.
 *
 * Suggestions and never a closed list. Teams have none for the obvious reason — the
 * groups a household trusts are the household's business and no list we ship would be
 * theirs — and every other dimension accepts a typed value too, because a tracker will
 * eventually carry a tag nothing here has heard of and a preference that could not name
 * it would be a preference somebody abandons.
 */
export const RELEASE_PREFERENCE_SUGGESTIONS: Record<ReleasePreferenceDimension, string[]> = {
	[ReleasePreferenceDimension.RESOLUTION]: ['2160p', '1080p', '720p', 'SD'],
	[ReleasePreferenceDimension.CODEC]: ['AV1', 'x265', 'x264', 'XviD'],
	[ReleasePreferenceDimension.TEAM]: [],
	[ReleasePreferenceDimension.SOURCE]: ['BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVD'],
	[ReleasePreferenceDimension.LANGUAGE]: ['MULTI', 'VF', 'FRENCH', 'VOSTFR', 'VO'],
	// `free` and `half` are the two an indexer can actually report; a release nothing was
	// said about carries neither and ranks with the unlisted.
	[ReleasePreferenceDimension.COST]: ['free', 'half'],
	// None, for the reason teams have none: the trackers a household uses are its own
	// business, and they are typed as they appear on the rows.
	[ReleasePreferenceDimension.INDEXER]: [],
};
