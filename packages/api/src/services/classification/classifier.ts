import {
	ClassificationSignal,
	ClassificationWithheld,
	DetectedCategory,
	MediaKind,
	type ClassificationCandidate,
	type ClassificationEvidence,
} from '@mcs/shared';
import {
	DECISIVE_SIGNALS,
	signalsOf,
	STRONG_JAPANESE_SIGNALS,
	type ClassificationFacts,
} from './signals';

/**
 * Turning signals into zero or more categories somebody may be asked to confirm.
 *
 * Pure, and the only place a judgement is made. Nothing here reads a row, writes a row or
 * knows that libraries exist: mapping a category onto a shelf is the manager's problem,
 * and a detector that knew about shelves would be a detector that could be tempted to
 * pick one.
 *
 * **Zero is the expected answer.** Most of a library is live-action films and ordinary
 * shows, and for every one of them this returns nothing. The cases that must return
 * nothing are pinned down in the tests as carefully as the cases that must return
 * something, because a wrong proposal is more expensive than a missing one: every
 * proposal somebody rejects teaches them to read the next one less carefully, and a
 * household that clicks yes without reading has an automatic classifier it never agreed
 * to.
 */

/**
 * The confidence a candidate has to reach to be proposed at all.
 *
 * It is 0.65 because that is where two things meet, and the pair is the whole rule:
 *
 * - it is **above the largest single weight** (0.55, an explicit `Anime` genre), so no one
 *   observation ever proposes anything on its own. Somebody being asked to press yes can
 *   always see at least two independent reasons;
 * - it is **exactly the weakest admissible pair** — a decisive signal at 0.45 plus the one
 *   fact the catalogue never guesses, at 0.20 — so the bar refuses one-signal guesses
 *   without also refusing the weakest evidence that is genuinely worth acting on: a fansub
 *   release of something already held as a series. The same decisive signal corroborated
 *   only by a romanised-looking title reaches 0.55 and is refused, which is the intended
 *   asymmetry: the weakest signal in the table can never be the one that tips an answer.
 *
 * The threshold does not work alone and is not meant to. Four corroborating signals add
 * to more than this with nothing saying what the media *is*, so `_candidate` also demands
 * a decisive signal. Raising the bar instead of keeping that rule was tried, and it only
 * moved the arithmetic: the pile of weak signals got one member bigger.
 */
export const CLASSIFICATION_THRESHOLD = 0.65;

/** Signals that say the media is animated, whoever made it. */
const ANIMATION_SIGNALS: readonly ClassificationSignal[] = [
	ClassificationSignal.ANIME_GENRE,
	ClassificationSignal.ANIMATION_GENRE,
	ClassificationSignal.ANIMATION_STUDIO,
	ClassificationSignal.FANSUB_GROUP,
	ClassificationSignal.ANIMATION_PATH_KEYWORD,
];

/** Signals that say where the animation came from. */
const ORIGIN_SIGNALS: readonly ClassificationSignal[] = [
	ClassificationSignal.JAPANESE_STUDIO,
	ClassificationSignal.ORIGINAL_LANGUAGE_JAPANESE,
	ClassificationSignal.COUNTRY_JAPAN,
	ClassificationSignal.ROMANISED_JAPANESE_TITLE,
];

/** Signals that say the media is a recorded performance. */
const CONCERT_SIGNALS: readonly ClassificationSignal[] = [
	ClassificationSignal.CONCERT_GENRE,
	ClassificationSignal.MUSIC_GENRE,
	ClassificationSignal.LIVE_PERFORMANCE_PHRASE,
	ClassificationSignal.VENUE,
	ClassificationSignal.CONCERT_PATH_KEYWORD,
];

/**
 * Counted against every category, and included in every candidate's evidence.
 *
 * In the evidence and not merely in the arithmetic, so that a withheld candidate can say
 * *why* it fell short. "This looks like a concert but it is also a documentary" is a
 * useful sentence; a confidence of 0.2 with no explanation is not.
 */
const COUNTER_SIGNALS: readonly ClassificationSignal[] = [ClassificationSignal.DOCUMENTARY_GENRE];

const filmKind = (kind: MediaKind): boolean =>
	kind === MediaKind.MOVIE || kind === MediaKind.COLLECTION;

const pick = (
	evidence: readonly ClassificationEvidence[],
	signals: readonly ClassificationSignal[],
): ClassificationEvidence[] => evidence.filter((one) => signals.includes(one.signal));

const has = (
	evidence: readonly ClassificationEvidence[],
	signals: readonly ClassificationSignal[] | ReadonlySet<ClassificationSignal>,
): boolean => {
	const wanted = signals instanceof Set ? signals : new Set(signals);

	return evidence.some((one) => wanted.has(one.signal));
};

/**
 * One category's verdict, from the evidence that bears on it.
 *
 * Clamped into 0…1 rather than left as a raw sum, because a confidence is shown next to a
 * question and `1.3` reads as a bug. What it costs is that two overwhelming signals and
 * five look the same from outside — which is why the evidence travels with the number and
 * is what the interface is expected to show.
 */
const candidateOf = (
	category: DetectedCategory,
	evidence: ClassificationEvidence[],
): ClassificationCandidate => {
	const total = evidence.reduce((sum, one) => sum + one.weight, 0);
	const confidence = Math.min(1, Math.max(0, total));

	if (!has(evidence, DECISIVE_SIGNALS)) {
		return { category, confidence, evidence, withheld: ClassificationWithheld.NO_DECISIVE_SIGNAL };
	}

	return {
		category,
		confidence,
		evidence,
		withheld:
			confidence >= CLASSIFICATION_THRESHOLD ? null : ClassificationWithheld.BELOW_THRESHOLD,
	};
};

/** The same, forced to a verdict somebody else has already reached. */
const withheldAs = (
	candidate: ClassificationCandidate,
	reason: ClassificationWithheld,
): ClassificationCandidate => ({ ...candidate, withheld: reason });

/**
 * Zero or more candidate categories, proposed or explicitly withheld.
 *
 * Sorted with the proposals first and by descending confidence inside each group, which
 * is the order a dialog reads them in. Several proposals for one media is a legitimate
 * answer and not a failure to decide — an anime film is an anime *and* an animated film,
 * and which shelf the household keeps it on is theirs to say, not ours to guess. What is
 * never returned is two proposals that contradict each other; see the origin rule below.
 */
export const classify = (facts: ClassificationFacts): ClassificationCandidate[] => {
	const evidence = signalsOf(facts);
	const counter = pick(evidence, COUNTER_SIGNALS);
	// The counter-evidence rides along, but it never *raises* a category: a plain
	// documentary would otherwise be reported as a withheld animated film, which is a
	// sentence about a media nothing has said anything animated about.
	const animated = pick(evidence, ANIMATION_SIGNALS);
	const animation = [...animated, ...counter];
	const origin = pick(evidence, ORIGIN_SIGNALS);
	const kind = pick(evidence, [
		ClassificationSignal.KIND_IS_FILM,
		ClassificationSignal.KIND_IS_SERIES,
	]);
	const candidates: ClassificationCandidate[] = [];

	if (animated.length > 0) {
		candidates.push(...animationCandidates(facts, animation, origin, kind));
	}

	const performance = pick(evidence, CONCERT_SIGNALS);
	const concert = [...performance, ...counter];

	if (performance.length > 0) {
		/*
		 * No kind signal, and that is not an omission. A recorded performance is neither a
		 * film nor a show in the usual sense — media servers file them as either, more or
		 * less at random — so "the catalogue calls this a film" says nothing whatever about
		 * whether it is a concert, and counting it would hand every concert candidate a
		 * free 0.20 towards the bar.
		 */
		candidates.push(candidateOf(DetectedCategory.CONCERTS, concert));
	}

	return candidates.sort(
		(left, right) =>
			Number(left.withheld !== null) - Number(right.withheld !== null)
			|| right.confidence - left.confidence
			|| left.category.localeCompare(right.category),
	);
};

/**
 * The three animation shelves, and the one place the household's shelving is decided.
 *
 * **Anime and cartoons are the same question.** Both ask what an animated series is, and
 * exactly one answer can be true, so they are never both proposed — a screen offering
 * both would be asking the person to do the classifying. The tie-break is origin, and it
 * is explicit rather than a matter of which scored higher:
 *
 * - a **strong** origin signal — an `Anime` genre, a Japanese studio, a Japanese original
 *   language, a country of Japan, a fansub group — settles it as anime, and cartoons is
 *   withheld as settled rather than dropped, so the screen can say why it is not offered;
 * - **no** origin signal at all makes it a cartoon, and anime is not raised: there is
 *   nothing to raise it on, and a category mentioned with no evidence is noise;
 * - **only the weak** signal — a romanised-looking title — withholds *both*. This is the
 *   case worth being careful about. A romanised title is wrong in both directions often
 *   enough that choosing on it is a coin flip, and a coin flip about which shelf a series
 *   lives on is precisely the wrong thing to ask somebody to rubber-stamp. Abstaining
 *   names the ambiguity instead, which is something they can act on.
 *
 * **Animated films is a different question** and does not ask about origin at all: it is
 * animation plus "the catalogue already holds this as a film". So it stands beside anime
 * rather than against it — an anime film yields both, anime first — and it survives the
 * ambiguous case untouched, because nothing about a romanised title makes a film less of
 * an animated film.
 */
const animationCandidates = (
	facts: ClassificationFacts,
	animation: ClassificationEvidence[],
	origin: ClassificationEvidence[],
	kind: ClassificationEvidence[],
): ClassificationCandidate[] => {
	const candidates: ClassificationCandidate[] = [];
	const strongOrigin = has(origin, STRONG_JAPANESE_SIGNALS) || has(animation, STRONG_JAPANESE_SIGNALS);
	const weakOrigin = has(origin, [ClassificationSignal.ROMANISED_JAPANESE_TITLE]);
	const series = !filmKind(facts.kind);
	const anime = candidateOf(DetectedCategory.ANIME, [...animation, ...origin, ...kind]);
	const shelf = series
		? candidateOf(DetectedCategory.CARTOONS, [...animation, ...kind])
		: candidateOf(DetectedCategory.ANIMATED_FILMS, [...animation, ...kind]);

	if (strongOrigin) {
		candidates.push(anime);

		// Cartoons is the other side of a question now answered; animated films is not,
		// and an anime film belongs in both lists.
		candidates.push(series ? withheldAs(shelf, ClassificationWithheld.SETTLED_BY_ORIGIN) : shelf);

		return candidates;
	}

	if (weakOrigin && series) {
		return [
			withheldAs(anime, ClassificationWithheld.AMBIGUOUS_ORIGIN),
			withheldAs(shelf, ClassificationWithheld.AMBIGUOUS_ORIGIN),
		];
	}

	return [shelf];
};
