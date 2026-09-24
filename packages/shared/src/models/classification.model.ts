/**
 * A pre-filing the gateway *proposes*, and never one it performs.
 *
 * The gateway can often tell that something on the `Films` shelf is an anime, or that
 * a two-hour file called `Live at Wembley` is a concert and not a film. Acting on that
 * would be the worst possible version of the feature: the household would find media
 * moved with nobody having decided, and the only honest account of what happened would
 * be "some code guessed". So the whole of this model is a sentence somebody is asked to
 * agree with, and the act of agreeing is `PUT /media/:id/override` with `libraryId` —
 * the same single mechanism a person re-filing by hand already uses. There is no second
 * path, no job, and nothing here writes anything.
 *
 * That is also why `ClassificationEvidence` exists and why every proposal carries it. A
 * suggestion nobody can check is a suggestion people learn to accept without reading,
 * and at that point it is automatic again — by a route nobody chose. The interface is
 * expected to show the evidence beside the proposal, not behind a disclosure triangle.
 */

/**
 * The four shelves the gateway knows how to recognise.
 *
 * Four because they are the four the household asked for, and because each is
 * distinguished by a different *kind* of signal rather than by a different threshold on
 * the same one — which is what makes them separately checkable. They are not library
 * identifiers and not category keys: a detected category is a statement about the
 * media, and mapping it onto a shelf this gateway actually has is a second step that
 * can fail. See `ClassificationBlocker`.
 */
export enum DetectedCategory {
	/** Japanese animation, whatever its length. */
	ANIME = 'anime',
	/** Animated series that are not anime. */
	CARTOONS = 'cartoons',
	/** Animation that is a film. */
	ANIMATED_FILMS = 'animated_films',
	/** A recorded performance: neither a film nor a show in the usual sense. */
	CONCERTS = 'concerts',
}

/**
 * Which field a piece of evidence was read out of.
 *
 * Carried beside the signal because the two together are what makes a proposal
 * checkable: "the genre says animation" and "the folder it sits in says animation" are
 * worth very different amounts, and a person reading the second one knows immediately
 * that it may only be saying where somebody already put it.
 */
export enum ClassificationSource {
	GENRE = 'genre',
	STUDIO = 'studio',
	LANGUAGE = 'language',
	COUNTRY = 'country',
	TITLE = 'title',
	ORIGINAL_TITLE = 'original_title',
	/** What the catalogue already knows the item to be — a film, a series. */
	KIND = 'kind',
	PATH = 'path',
	RELEASE_NAME = 'release_name',
}

/**
 * One thing the gateway noticed, in a vocabulary the interface can put into words.
 *
 * A closed list rather than free text, for the reason every other key in this package
 * is closed: the wording belongs to the interface and has to be translatable, and a
 * sentence assembled on the API is a sentence that exists in one language.
 */
export enum ClassificationSignal {
	/** A genre that names Japanese animation outright: `Anime`, `Shounen`, `Isekai`. */
	ANIME_GENRE = 'anime_genre',
	/** A genre that names animation without saying where it came from. */
	ANIMATION_GENRE = 'animation_genre',
	/** A studio that makes animation and nothing else. */
	ANIMATION_STUDIO = 'animation_studio',
	/** That studio is a Japanese one, which is a separate statement about origin. */
	JAPANESE_STUDIO = 'japanese_studio',
	ORIGINAL_LANGUAGE_JAPANESE = 'original_language_japanese',
	COUNTRY_JAPAN = 'country_japan',
	/**
	 * The title reads as romanised Japanese.
	 *
	 * The weakest signal here by a wide margin, and deliberately incapable of deciding
	 * anything on its own — see `CLASSIFICATION_THRESHOLD`.
	 */
	ROMANISED_JAPANESE_TITLE = 'romanised_japanese_title',
	/** A fansub group that subtitles nothing but anime. */
	FANSUB_GROUP = 'fansub_group',
	/** A genre that names a recorded performance. */
	CONCERT_GENRE = 'concert_genre',
	/** A music genre, which is what a concert usually carries instead. */
	MUSIC_GENRE = 'music_genre',
	/** `Live at …`, `Unplugged`, `en concert`. */
	LIVE_PERFORMANCE_PHRASE = 'live_performance_phrase',
	/** A venue or a festival, named in the title or the release. */
	VENUE = 'venue',
	/**
	 * A folder on the way to the file names an animation shelf.
	 *
	 * Split from the concert one rather than one `PATH_KEYWORD` carrying the word it
	 * matched, because a folder called `Concerts` must not corroborate a proposal about
	 * animation. One signal read by two families is a signal that eventually supports the
	 * wrong one.
	 */
	ANIMATION_PATH_KEYWORD = 'animation_path_keyword',
	/** A folder on the way to the file names a performances shelf. */
	CONCERT_PATH_KEYWORD = 'concert_path_keyword',
	/** The catalogue already holds this as a film. */
	KIND_IS_FILM = 'kind_is_film',
	/** The catalogue already holds this as a series, a season or an episode. */
	KIND_IS_SERIES = 'kind_is_series',
	/**
	 * A documentary genre, which counts *against* every category here.
	 *
	 * A documentary about anime is not an anime and a concert film that is also a
	 * documentary is a documentary first. Both were guessed wrongly before this existed.
	 */
	DOCUMENTARY_GENRE = 'documentary_genre',
}

/**
 * One signal, with the text that fired it.
 *
 * `value` is quoted rather than summarised because it is the whole point: somebody
 * asked to agree that this is an anime needs to see that the genre said `Shounen`, not
 * that "a genre matched".
 */
export interface ClassificationEvidence {
	signal: ClassificationSignal;
	source: ClassificationSource;
	/**
	 * What fired it: the genre or studio as the service spells it, or the phrase that
	 * was found in the title, the release name or the path.
	 */
	value: string;
	/** What this added to the confidence. Negative for counter-evidence. */
	weight: number;
}

/**
 * Why a category was considered and then not proposed.
 *
 * Reported rather than dropped, because a detector that silently answers nothing is the
 * defect this project keeps naming: something that succeeds while doing nothing
 * visible. A person who expected a suggestion and got none can read which category
 * nearly made it and what was missing.
 */
export enum ClassificationWithheld {
	/** Evidence was found and did not add up. */
	BELOW_THRESHOLD = 'below_threshold',
	/**
	 * Only corroborating signals fired — a folder name, a year, a kind.
	 *
	 * A pile of weak signals must not stand in for one real one; see
	 * `CLASSIFICATION_THRESHOLD`.
	 */
	NO_DECISIVE_SIGNAL = 'no_decisive_signal',
	/**
	 * Animation, and nothing trustworthy about where it came from.
	 *
	 * `ANIME` and `CARTOONS` are the same question asked of one media, so guessing
	 * between them on a romanised-looking title would be a coin flip on the household's
	 * shelf. Neither is proposed.
	 */
	AMBIGUOUS_ORIGIN = 'ambiguous_origin',
	/** Its origin is settled and this is the other side of that answer. */
	SETTLED_BY_ORIGIN = 'settled_by_origin',
}

/**
 * Why a proposal cannot be acted on, although the detector is confident.
 *
 * A proposal naming a shelf this gateway does not have is not actionable, and offering
 * it as though it were would end in a dialog whose button does nothing. It is still
 * reported — "this looks like a concert and you have no concerts library" is useful, and
 * it is the one sentence that tells somebody what to create.
 */
export enum ClassificationBlocker {
	/** No library on this gateway carries a category that reads as this one. */
	NO_SUCH_CATEGORY = 'no_such_category',
	/**
	 * The category exists, and only on servers whose files this gateway cannot write.
	 *
	 * A friend's anime shelf is a category here and re-filing into it would move
	 * nothing: `MediaOverride.libraryId` reclassifies a row, and the files still have to
	 * land somewhere this gateway reaches.
	 */
	NO_WRITABLE_LIBRARY = 'no_writable_library',
	/** It is already there. Nothing to propose, and worth saying rather than hiding. */
	ALREADY_FILED = 'already_filed',
}

/**
 * One category the detector settled on, or explicitly did not.
 *
 * `withheld` being null is what "proposed" means. The two live in one shape because
 * they carry the same evidence and a screen shows them in the same list — the
 * difference is whether there is a button beside it.
 */
export interface ClassificationCandidate {
	category: DetectedCategory;
	/** Between 0 and 1. Only meaningful next to the evidence that produced it. */
	confidence: number;
	evidence: ClassificationEvidence[];
	withheld: ClassificationWithheld | null;
}

/**
 * A proposed pre-filing, resolved against the shelves this gateway actually has.
 *
 * `libraryId` is the payload of the write somebody may go on to make, and it is null
 * whenever `blocker` is set — which is the invariant that keeps an unactionable
 * proposal from being turned into a request that would half-work.
 */
export interface CategoryProposal {
	category: DetectedCategory;
	confidence: number;
	evidence: ClassificationEvidence[];
	/** The local category this maps to, as `MediaCategory.key` reads today. */
	categoryKey: string | null;
	/** That category's name, which is the word to put in the question. */
	categoryName: string | null;
	/** The library `PUT /media/:id/override` would name. Null when blocked. */
	libraryId: string | null;
	libraryName: string | null;
	blocker: ClassificationBlocker | null;
}

/**
 * Everything the gateway has to say about where one media might belong.
 *
 * Read-only, and the shape says so: there is no field here that anybody writes back.
 * The interface offers `proposals`, shows `withheld` to whoever asks why there is no
 * suggestion, and performs exactly one write when somebody agrees — the override.
 */
export interface ClassificationProposal {
	itemId: string;
	title: string;
	/** Where it sits now, so a screen can put the question as "from … to …". */
	currentLibraryId: string;
	currentCategoryKey: string | null;
	currentCategoryName: string | null;
	/** Actionable first, then the blocked ones, each by descending confidence. */
	proposals: CategoryProposal[];
	/** Considered and deliberately not proposed, with the evidence that fell short. */
	withheld: ClassificationCandidate[];
	/**
	 * Always `true`, and typed as the literal so it cannot become anything else.
	 *
	 * Not decoration: it is the contract of this route stated on the wire. A client
	 * reading a `ClassificationProposal` has been told nothing was done, and a later
	 * change that made the gateway file on its own would have to change this type and
	 * fail to compile in every consumer — which is exactly the review nobody would
	 * otherwise get.
	 */
	requiresConfirmation: true;
}
