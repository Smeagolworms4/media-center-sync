import {
	ClassificationSignal,
	ClassificationSource,
	MediaKind,
	type ClassificationEvidence,
} from '@mcs/shared';
import { stripExtension } from '../title-normalizer';
import {
	ANIMATION_GENRES,
	ANIMATION_PATH_KEYWORDS,
	ANIMATION_STUDIOS,
	ANIME_GENRES,
	CONCERT_GENRES,
	CONCERT_PATH_KEYWORDS,
	containsPhrase,
	DOCUMENTARY_GENRES,
	FANSUB_GROUPS,
	firstPhrase,
	fold,
	isOneOf,
	JAPANESE_ANIMATION_STUDIOS,
	JAPANESE_COUNTRIES,
	JAPANESE_LANGUAGES,
	LIVE_PERFORMANCE_PHRASES,
	MUSIC_GENRES,
	ROMANISED_JAPANESE_TOKENS,
	VENUES,
} from './vocabulary';

/**
 * Reading the signals out of what the gateway knows about one media.
 *
 * Pure, and with no opinion about what the signals add up to — that is the classifier's
 * job, and separating the two is what makes both testable. A signal is a fact ("the
 * genre string `Shounen` is present"); a candidate is a judgement ("this is an anime").
 * Mixing them produced a first version where fixing a wrong guess meant editing the
 * place a word was read, and the word was then missing from the evidence.
 */

/**
 * Everything the detector is allowed to look at.
 *
 * Deliberately not a `MediaItem`: this has to be constructible from a catalogue row, from
 * a `.nfo` a pull just wrote, or from a release name and nothing else, and taking the
 * entity would tie the detector to the persistence model and make it untestable without
 * one. It is also the honest statement of what the gateway *may one day* know — see the
 * note on `genres`.
 *
 * Every field is required and nullable rather than optional, so that a caller adding a
 * source of facts is told by the compiler about the fields it is not filling. A caller
 * that legitimately knows nothing passes `noFacts()`.
 */
export interface ClassificationFacts {
	/** What the catalogue already holds this as. The one fact that is never guessed. */
	kind: MediaKind;
	title: string;
	/** The title in its own language, when a service reported one. */
	originalTitle: string | null;
	year: number | null;
	/**
	 * Genres, as whoever reported them spelled them.
	 *
	 * The strongest signal available, and the index does not carry it yet: neither
	 * `NormalisedMediaItem` nor the `media_items` table has a genre column, so a caller
	 * reading from the catalogue passes an empty list today. That is why the detector
	 * leans on the release name and the path as well, and it is the one change that
	 * would make this materially better — adding genres to the handler interface, the
	 * entity and a migration, which is a change to files this feature does not own.
	 */
	genres: string[];
	/** Studios, as reported. Compared whole, never as substrings. */
	studios: string[];
	/** The original language, as a code or a name — services disagree about which. */
	originalLanguage: string | null;
	/** Countries of origin, as codes or names. */
	countries: string[];
	/** The path the file sits at, as the gateway spells it. */
	path: string | null;
	/** The release it came from, when it came from one. */
	releaseName: string | null;
}

/** A fact set that says nothing, for a caller that genuinely knows nothing. */
export const noFacts = (kind: MediaKind, title: string): ClassificationFacts => ({
	kind,
	title,
	originalTitle: null,
	year: null,
	genres: [],
	studios: [],
	originalLanguage: null,
	countries: [],
	path: null,
	releaseName: null,
});

/**
 * What each signal is worth, and the bar a candidate has to clear.
 *
 * Two rules keep this from becoming a pile of tuned numbers, and both matter:
 *
 * **No single signal reaches the bar.** The largest weight here is 0.55 and the
 * threshold is 0.65, so nothing is ever proposed on one observation. That is not caution
 * for its own sake — the household is being asked to press yes, and a proposal resting on
 * one string is a proposal nobody can sanity-check.
 *
 * **A pile of weak signals does not stand in for a strong one.** The threshold alone
 * would not give this: a Japanese language, a Japan country, a path keyword and a kind
 * add to 0.95 with nothing whatever saying the media is animated. So the classifier also
 * requires at least one *decisive* signal per candidate — see `DECISIVE_SIGNALS`. The
 * threshold stops one strong signal deciding; the decisive rule stops several weak ones
 * deciding. Neither substitutes for the other, and removing either has been tried.
 *
 * The bar therefore lands exactly on the cheapest admissible pair: a decisive signal at
 * 0.45 plus one corroborating signal at 0.20. Moving it up to 0.7 would refuse a fansub
 * release whose only other evidence is that the catalogue calls it a series, which is a
 * perfectly good proposal; moving it down to 0.55 would let an explicit `Anime` genre
 * decide on its own, which is one string away from the gateway filing things by itself.
 */
export const SIGNAL_WEIGHTS: Record<ClassificationSignal, number> = {
	[ClassificationSignal.ANIME_GENRE]: 0.55,
	[ClassificationSignal.ANIMATION_GENRE]: 0.5,
	[ClassificationSignal.CONCERT_GENRE]: 0.5,
	[ClassificationSignal.ANIMATION_STUDIO]: 0.45,
	[ClassificationSignal.FANSUB_GROUP]: 0.45,
	[ClassificationSignal.LIVE_PERFORMANCE_PHRASE]: 0.45,
	[ClassificationSignal.ORIGINAL_LANGUAGE_JAPANESE]: 0.3,
	[ClassificationSignal.JAPANESE_STUDIO]: 0.3,
	[ClassificationSignal.COUNTRY_JAPAN]: 0.25,
	[ClassificationSignal.MUSIC_GENRE]: 0.25,
	[ClassificationSignal.VENUE]: 0.25,
	[ClassificationSignal.ANIMATION_PATH_KEYWORD]: 0.2,
	[ClassificationSignal.CONCERT_PATH_KEYWORD]: 0.2,
	[ClassificationSignal.KIND_IS_FILM]: 0.2,
	[ClassificationSignal.KIND_IS_SERIES]: 0.2,
	[ClassificationSignal.ROMANISED_JAPANESE_TITLE]: 0.1,
	/*
	 * Large enough to sink the cheapest admissible pair on its own (0.65 − 0.45 = 0.20,
	 * below the bar), because a documentary genre is not a doubt to be outweighed: it is
	 * the media telling us what it is. Both cases it exists for — a documentary about
	 * anime, a concert film that is also a documentary — have to end in silence.
	 */
	[ClassificationSignal.DOCUMENTARY_GENRE]: -0.45,
};

/**
 * The signals that may found a candidate, as opposed to corroborate one.
 *
 * Each of these says something about what the media *is*. Everything else says something
 * about where it came from, how long it is, or which folder somebody put it in — all
 * useful beside a decisive signal and all worthless without one. A path keyword is the
 * clearest case: it usually only says where the media already is, which is the question
 * being asked rather than an answer to it.
 */
export const DECISIVE_SIGNALS: ReadonlySet<ClassificationSignal> = new Set([
	ClassificationSignal.ANIME_GENRE,
	ClassificationSignal.ANIMATION_GENRE,
	ClassificationSignal.ANIMATION_STUDIO,
	ClassificationSignal.FANSUB_GROUP,
	ClassificationSignal.CONCERT_GENRE,
	ClassificationSignal.LIVE_PERFORMANCE_PHRASE,
]);

/**
 * The signals that say this animation is Japanese, and mean it.
 *
 * This set *is* the anime-versus-cartoons tie-break. It excludes
 * `ROMANISED_JAPANESE_TITLE` on purpose, which is the whole of the reason it is a named
 * set rather than an inline condition: a romanised-looking title is the one origin signal
 * that is routinely wrong in both directions, and letting it settle which shelf a series
 * belongs on would be a coin flip dressed as a decision.
 */
export const STRONG_JAPANESE_SIGNALS: ReadonlySet<ClassificationSignal> = new Set([
	ClassificationSignal.ANIME_GENRE,
	ClassificationSignal.JAPANESE_STUDIO,
	ClassificationSignal.ORIGINAL_LANGUAGE_JAPANESE,
	ClassificationSignal.COUNTRY_JAPAN,
	ClassificationSignal.FANSUB_GROUP,
]);

const evidence = (
	signal: ClassificationSignal,
	source: ClassificationSource,
	value: string,
): ClassificationEvidence => ({ signal, source, value, weight: SIGNAL_WEIGHTS[signal] });

/**
 * The bracketed and trailing tokens of a release name.
 *
 * A group is `[SubsPlease]`, `(Judas)` or a trailing `-GROUP`, never a word in a
 * sentence, and reading it as one would make `judas` fire on a biblical drama. Both
 * bracket styles occur and the trailing form is what the scene uses, so all three are
 * read.
 */
export const releaseTokens = (releaseName: string): string[] => {
	const tokens: string[] = [];

	for (const match of releaseName.matchAll(/[[(]([^\])]+)[\])]/g)) {
		tokens.push(fold(match[1]));
	}

	/*
	 * The trailing group, taken from the last hyphen and not the first.
	 *
	 * A single expression cannot do it: `Show.S01E02.WEB-DL.x265-GROUP` has three hyphens
	 * and a character class permissive enough to hold `Erai-raws` swallows the lot, which
	 * yields `dl x265 group` and matches nothing. Splitting and reading from the end gives
	 * both the one-word form and the hyphenated one, which is the only reason the last two
	 * segments are joined.
	 */
	const segments = stripExtension(releaseName).split('-');
	const last = segments.length > 1 ? segments[segments.length - 1] : null;

	if (last !== null) {
		tokens.push(fold(last));

		if (segments.length > 2) {
			tokens.push(fold(`${segments[segments.length - 2]} ${last}`));
		}
	}

	return tokens.filter((token) => token !== '');
};

/** The folded components of a path, so a keyword matches a folder and not a substring. */
const pathComponents = (path: string): string[] =>
	path
		.replace(/\\/g, '/')
		.split('/')
		.map((component) => fold(component))
		.filter((component) => component !== '');

/**
 * One genre, compared whole.
 *
 * Whole and not by words, and this is the correction that matters most in the file: a media
 * server lists genres one per entry, so the entry *is* the genre — and containment read the
 * French `Dessin animé` as the Japanese `Anime`, since `anime` is a word inside it. Every
 * French-configured library in the house would have been proposed for the anime shelf.
 *
 * The anime reading is tried before the general animation one so that a value appearing in
 * both lists is scored once, under the more specific name.
 */
const genreSignal = (genre: string): ClassificationEvidence[] => {
	const folded = fold(genre);
	const found: ClassificationEvidence[] = [];

	if (isOneOf(folded, ANIME_GENRES)) {
		found.push(evidence(ClassificationSignal.ANIME_GENRE, ClassificationSource.GENRE, genre));
	} else if (isOneOf(folded, ANIMATION_GENRES)) {
		found.push(evidence(ClassificationSignal.ANIMATION_GENRE, ClassificationSource.GENRE, genre));
	}

	if (isOneOf(folded, CONCERT_GENRES)) {
		found.push(evidence(ClassificationSignal.CONCERT_GENRE, ClassificationSource.GENRE, genre));
	} else if (isOneOf(folded, MUSIC_GENRES)) {
		found.push(evidence(ClassificationSignal.MUSIC_GENRE, ClassificationSource.GENRE, genre));
	}

	if (isOneOf(folded, DOCUMENTARY_GENRES)) {
		found.push(
			evidence(ClassificationSignal.DOCUMENTARY_GENRE, ClassificationSource.GENRE, genre),
		);
	}

	return found;
};

/**
 * A studio, compared whole.
 *
 * A Japanese studio yields two signals and not one, and the pair is deliberate: it makes
 * animation and it is Japanese, and those are the two separate things a proposal for the
 * anime shelf has to be able to show. Folding them into one signal worth 0.75 would have
 * produced the same number with half the explanation.
 */
const studioSignal = (studio: string): ClassificationEvidence[] => {
	const folded = fold(studio);

	if (isOneOf(folded, JAPANESE_ANIMATION_STUDIOS)) {
		return [
			evidence(ClassificationSignal.ANIMATION_STUDIO, ClassificationSource.STUDIO, studio),
			evidence(ClassificationSignal.JAPANESE_STUDIO, ClassificationSource.STUDIO, studio),
		];
	}

	if (isOneOf(folded, ANIMATION_STUDIOS)) {
		return [evidence(ClassificationSignal.ANIMATION_STUDIO, ClassificationSource.STUDIO, studio)];
	}

	return [];
};

/**
 * Every signal the facts support, at most one per signal.
 *
 * One entry per signal and not per occurrence, which is what lets the classifier score by
 * plain addition. A library listing `Animation` and `Animated` as two genres is stating
 * one fact twice, and a release whose group tag also appears in its folder name is one
 * fact seen from two angles — counting either twice would let a verbose scraper reach the
 * bar on its own, and would fill a confirmation dialog with the same sentence three
 * times.
 *
 * Which occurrence survives is decided by the order the sources are read below, and that
 * order is the priority: what a service *declared* beats what a filename suggests, and an
 * original title beats a localised one. Reordering these calls changes which text a
 * person is shown as the reason.
 */
export const signalsOf = (facts: ClassificationFacts): ClassificationEvidence[] => {
	const found: ClassificationEvidence[] = [];

	for (const genre of facts.genres) {
		found.push(...genreSignal(genre));
	}

	for (const studio of facts.studios) {
		found.push(...studioSignal(studio));
	}

	if (facts.originalLanguage !== null) {
		const folded = fold(facts.originalLanguage);

		if (isOneOf(folded, JAPANESE_LANGUAGES)) {
			found.push(
				evidence(
					ClassificationSignal.ORIGINAL_LANGUAGE_JAPANESE,
					ClassificationSource.LANGUAGE,
					facts.originalLanguage,
				),
			);
		}
	}

	for (const country of facts.countries) {
		const folded = fold(country);

		if (isOneOf(folded, JAPANESE_COUNTRIES)) {
			found.push(
				evidence(ClassificationSignal.COUNTRY_JAPAN, ClassificationSource.COUNTRY, country),
			);
		}
	}

	if (facts.originalTitle !== null) {
		found.push(...titleSignals(facts.originalTitle, ClassificationSource.ORIGINAL_TITLE));
	}

	found.push(...titleSignals(facts.title, ClassificationSource.TITLE));

	if (facts.releaseName !== null) {
		found.push(...releaseSignals(facts.releaseName));
	}

	if (facts.path !== null) {
		found.push(...pathSignals(facts.path));
	}

	found.push(kindSignal(facts.kind));

	return dedupe(found);
};

/** The one thing the catalogue never guesses: whether this is a film or a show. */
const kindSignal = (kind: MediaKind): ClassificationEvidence => {
	// A collection is filed with the films, which is the same reading the placement rule
	// already uses — a box set of animated films belongs on the animated films shelf.
	const film = kind === MediaKind.MOVIE || kind === MediaKind.COLLECTION;

	return evidence(
		film ? ClassificationSignal.KIND_IS_FILM : ClassificationSignal.KIND_IS_SERIES,
		ClassificationSource.KIND,
		kind,
	);
};

/**
 * What a title says, which is only ever about performances and romanisation.
 *
 * There is deliberately no animation signal here, and it is the single most important
 * omission in the detector. A live-action film can carry an animated character's name —
 * *Detective Pikachu*, *Casper*, *Who Framed Roger Rabbit* — and a title-word rule would
 * propose moving every one of them onto the cartoons shelf. Nothing in a title says a
 * media is animated, so nothing here pretends it does.
 */
const titleSignals = (
	title: string,
	source: ClassificationSource,
): ClassificationEvidence[] => {
	const folded = fold(title);
	const found: ClassificationEvidence[] = [];
	const phrase = firstPhrase(folded, LIVE_PERFORMANCE_PHRASES);

	if (phrase !== null) {
		found.push(evidence(ClassificationSignal.LIVE_PERFORMANCE_PHRASE, source, phrase));
	}

	const venue = firstPhrase(folded, VENUES);

	if (venue !== null) {
		found.push(evidence(ClassificationSignal.VENUE, source, venue));
	}

	const token = ROMANISED_JAPANESE_TOKENS.find((known) => containsPhrase(folded, known));

	if (token !== undefined) {
		found.push(evidence(ClassificationSignal.ROMANISED_JAPANESE_TITLE, source, token));
	}

	return found;
};

/** A release name carries a group and, being a title of sorts, whatever a title carries. */
const releaseSignals = (releaseName: string): ClassificationEvidence[] => {
	const found: ClassificationEvidence[] = [];
	const tokens = releaseTokens(releaseName);
	const group = FANSUB_GROUPS.find((known) => tokens.includes(known));

	if (group !== undefined) {
		found.push(
			evidence(ClassificationSignal.FANSUB_GROUP, ClassificationSource.RELEASE_NAME, group),
		);
	}

	return [...found, ...titleSignals(releaseName, ClassificationSource.RELEASE_NAME)];
};

/**
 * What the folders on the way to the file say.
 *
 * Corroborating only, and the reason is worth stating where somebody might be tempted to
 * raise it: a file under `/media/Animes/` is usually there because somebody already
 * decided, so reading it as evidence that it *is* an anime is reading our own answer back
 * to ourselves. It earns its place on the other case — a file still in a download folder
 * called `Anime`, where it is the only thing anybody has said.
 */
const pathSignals = (path: string): ClassificationEvidence[] => {
	const components = pathComponents(path);
	const found: ClassificationEvidence[] = [];
	const families = [
		{ signal: ClassificationSignal.ANIMATION_PATH_KEYWORD, keywords: ANIMATION_PATH_KEYWORDS },
		{ signal: ClassificationSignal.CONCERT_PATH_KEYWORD, keywords: CONCERT_PATH_KEYWORDS },
	] as const;

	for (const family of families) {
		const keyword = family.keywords.find((one) =>
			components.some((component) => containsPhrase(component, one)),
		);

		if (keyword !== undefined) {
			found.push(evidence(family.signal, ClassificationSource.PATH, keyword));
		}
	}

	return found;
};

/** One entry per signal, first occurrence winning. See `signalsOf`. */
const dedupe = (found: readonly ClassificationEvidence[]): ClassificationEvidence[] => {
	const seen = new Map<ClassificationSignal, ClassificationEvidence>();

	for (const one of found) {
		if (!seen.has(one.signal)) {
			seen.set(one.signal, one);
		}
	}

	return [...seen.values()];
};
