import { ClassificationSignal, ClassificationSource, MediaKind } from '@mcs/shared';
import { CLASSIFICATION_THRESHOLD } from './classifier';
import {
	DECISIVE_SIGNALS,
	noFacts,
	releaseTokens,
	SIGNAL_WEIGHTS,
	signalsOf,
	STRONG_JAPANESE_SIGNALS,
	type ClassificationFacts,
} from './signals';
import { containsPhrase, fold } from './vocabulary';

const facts = (overrides: Partial<ClassificationFacts> = {}): ClassificationFacts => ({
	...noFacts(MediaKind.SERIES, 'Some Show'),
	...overrides,
});

const signals = (overrides: Partial<ClassificationFacts> = {}): ClassificationSignal[] =>
	signalsOf(facts(overrides)).map((one) => one.signal);

describe('folding and phrase matching', () => {
	it('collapses case, accents and punctuation', () => {
		expect(fold('Dessin animé — J.C.Staff')).toBe('dessin anime j c staff');
	});

	it('matches a phrase only as whole words', () => {
		expect(containsPhrase(fold('Live at Wembley'), 'live at')).toBe(true);
		// The trap this exists for: a substring test would find `live` inside `Olive`
		// and `docu` inside `documentary`.
		expect(containsPhrase(fold('Olive Kitteridge'), 'live')).toBe(false);
		expect(containsPhrase(fold('Documentary'), 'docu')).toBe(false);
	});
});

describe('release tokens', () => {
	it('reads square brackets, parentheses and the trailing group', () => {
		expect(releaseTokens('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv')).toEqual(
			expect.arrayContaining(['subsplease', '1080p', 'abcd1234']),
		);
		expect(releaseTokens('Show.S01E02.1080p.WEB-DL.x265-GROUP.mkv')).toContain('group');
	});
});

describe('weights and the bar', () => {
	/*
	 * The two invariants the abstention rules rest on. They are asserted rather than
	 * commented because both are properties of a table somebody will edit: adding a signal
	 * worth 0.7, or nudging the threshold down to 0.5, would quietly turn the detector into
	 * something that files on one observation.
	 */
	it('gives no single signal enough weight to reach the bar on its own', () => {
		for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS)) {
			expect(weight).toBeLessThan(CLASSIFICATION_THRESHOLD);
			expect(weight).toBeGreaterThanOrEqual(-CLASSIFICATION_THRESHOLD);
			expect(signal).toBeTruthy();
		}
	});

	it('puts the bar exactly on the weakest decisive signal plus the catalogue’s own kind', () => {
		// The pair the bar is placed to admit: a fansub group or an animation studio,
		// corroborated by the one fact the catalogue never guesses.
		const weakest = Math.min(...[...DECISIVE_SIGNALS].map((signal) => SIGNAL_WEIGHTS[signal]));

		expect(weakest + SIGNAL_WEIGHTS[ClassificationSignal.KIND_IS_SERIES]).toBeCloseTo(
			CLASSIFICATION_THRESHOLD,
		);
	});

	it('keeps the romanised title unable to carry a decisive signal over the bar', () => {
		// The weakest signal must not be the thing that tips anything, which is what makes
		// it safe to keep in the table at all.
		const weakest = Math.min(...[...DECISIVE_SIGNALS].map((signal) => SIGNAL_WEIGHTS[signal]));

		expect(weakest + SIGNAL_WEIGHTS[ClassificationSignal.ROMANISED_JAPANESE_TITLE]).toBeLessThan(
			CLASSIFICATION_THRESHOLD,
		);
	});

	it('makes the documentary counter heavy enough to sink that pair', () => {
		const cheapest = Math.min(...[...DECISIVE_SIGNALS].map((signal) => SIGNAL_WEIGHTS[signal]));

		expect(cheapest + SIGNAL_WEIGHTS[ClassificationSignal.DOCUMENTARY_GENRE]).toBeLessThan(
			CLASSIFICATION_THRESHOLD,
		);
	});

	it('leaves the romanised title out of the signals that settle an origin', () => {
		// The tie-break between the anime and cartoons shelves reads this set. A romanised
		// title in it would make a guess about somebody's shelf on the flimsiest evidence
		// the detector has.
		expect(STRONG_JAPANESE_SIGNALS.has(ClassificationSignal.ROMANISED_JAPANESE_TITLE)).toBe(false);
	});
});

describe('genres', () => {
	it('reads an explicit anime genre without also reading it as plain animation', () => {
		const found = signals({ genres: ['Shounen'] });

		expect(found).toContain(ClassificationSignal.ANIME_GENRE);
		expect(found).not.toContain(ClassificationSignal.ANIMATION_GENRE);
	});

	it('reads the more specific of two overlapping spellings once', () => {
		// `Animation japonaise` contains `animation`, and scoring both would count one
		// string twice and list the same fact under two names.
		const found = signals({ genres: ['Animation japonaise'] });

		expect(found).toEqual(
			expect.arrayContaining([ClassificationSignal.ANIME_GENRE]),
		);
		expect(found).not.toContain(ClassificationSignal.ANIMATION_GENRE);
	});

	it('reads animation in the language the media server was configured in', () => {
		expect(signals({ genres: ['Dessin animé'] })).toContain(ClassificationSignal.ANIMATION_GENRE);
	});

	it('counts a genre listed twice once', () => {
		const found = signalsOf(facts({ genres: ['Animation', 'Animated', 'Cartoon'] })).filter(
			(one) => one.signal === ClassificationSignal.ANIMATION_GENRE,
		);

		expect(found).toHaveLength(1);
		expect(found[0].value).toBe('Animation');
	});

	it('does not read a musical as a performance', () => {
		// La La Land is a film with songs in it, not a recorded concert.
		const found = signals({ kind: MediaKind.MOVIE, title: 'La La Land', genres: ['Musical'] });

		expect(found).not.toContain(ClassificationSignal.MUSIC_GENRE);
		expect(found).not.toContain(ClassificationSignal.CONCERT_GENRE);
	});
});

describe('studios', () => {
	it('reads a Japanese studio as both animation and an origin', () => {
		const found = signals({ studios: ['Kyoto Animation'] });

		expect(found).toContain(ClassificationSignal.ANIMATION_STUDIO);
		expect(found).toContain(ClassificationSignal.JAPANESE_STUDIO);
	});

	it('reads a western animation studio as animation and nothing about origin', () => {
		const found = signals({ studios: ['Pixar'] });

		expect(found).toContain(ClassificationSignal.ANIMATION_STUDIO);
		expect(found).not.toContain(ClassificationSignal.JAPANESE_STUDIO);
	});

	it('compares a studio whole, so a generic name cannot leak into a title', () => {
		// `Bones` is a real studio and a forensics procedural. Substring matching on the
		// list would have proposed the anime shelf for every episode of the latter.
		expect(signals({ studios: ['Bones'] })).toContain(ClassificationSignal.ANIMATION_STUDIO);
		expect(signals({ title: 'Bones', studios: ['20th Television'] })).not.toContain(
			ClassificationSignal.ANIMATION_STUDIO,
		);
	});
});

describe('titles', () => {
	it('never reads animation out of a title', () => {
		/*
		 * The single most important omission in the detector. Every one of these is
		 * live-action, and a title-word rule would have proposed moving all three onto an
		 * animation shelf.
		 */
		for (const title of ['Detective Pikachu', 'Casper', 'Who Framed Roger Rabbit']) {
			const found = signals({ kind: MediaKind.MOVIE, title });

			expect(found).not.toContain(ClassificationSignal.ANIMATION_GENRE);
			expect(found).not.toContain(ClassificationSignal.ANIME_GENRE);
			expect(found).not.toContain(ClassificationSignal.ANIMATION_STUDIO);
		}
	});

	it('reads a performance phrase and the venue beside it', () => {
		const found = signals({
			kind: MediaKind.MOVIE,
			title: 'Queen — Live at Wembley Stadium',
		});

		expect(found).toContain(ClassificationSignal.LIVE_PERFORMANCE_PHRASE);
		expect(found).toContain(ClassificationSignal.VENUE);
	});

	it('does not read a performance out of an ordinary title containing live', () => {
		expect(signals({ kind: MediaKind.MOVIE, title: 'Live Free or Die Hard' })).not.toContain(
			ClassificationSignal.LIVE_PERFORMANCE_PHRASE,
		);
	});

	it('reads a romanised Japanese title without reading English particles', () => {
		expect(signals({ title: 'Shingeki no Kyojin' })).toContain(
			ClassificationSignal.ROMANISED_JAPANESE_TITLE,
		);
		// The particle `no` is also an English word, which is why it is not in the list.
		expect(signals({ kind: MediaKind.MOVIE, title: 'No Country for Old Men' })).not.toContain(
			ClassificationSignal.ROMANISED_JAPANESE_TITLE,
		);
	});

	it('prefers the original title as the quoted reason', () => {
		const found = signalsOf(
			facts({ title: 'Attack on Titan', originalTitle: 'Shingeki no Kyojin' }),
		).find((one) => one.signal === ClassificationSignal.ROMANISED_JAPANESE_TITLE);

		expect(found?.source).toBe(ClassificationSource.ORIGINAL_TITLE);
	});
});

describe('release names and paths', () => {
	it('reads a fansub group as a release token', () => {
		expect(signals({ releaseName: '[SubsPlease] Frieren - 01 (1080p)' })).toContain(
			ClassificationSignal.FANSUB_GROUP,
		);
	});

	it('does not read a group name out of a sentence', () => {
		expect(signals({ kind: MediaKind.MOVIE, title: 'Judas and the Black Messiah' })).not.toContain(
			ClassificationSignal.FANSUB_GROUP,
		);
	});

	it('keeps the two families of path keyword apart', () => {
		expect(signals({ path: '/media/Animes/Frieren/S01E01.mkv' })).toContain(
			ClassificationSignal.ANIMATION_PATH_KEYWORD,
		);
		expect(signals({ path: '/media/Concerts/Queen/wembley.mkv' })).toContain(
			ClassificationSignal.CONCERT_PATH_KEYWORD,
		);
		// A folder called `Concerts` must not corroborate a proposal about animation.
		expect(signals({ path: '/media/Concerts/Queen/wembley.mkv' })).not.toContain(
			ClassificationSignal.ANIMATION_PATH_KEYWORD,
		);
	});

	it('matches a keyword against whole path components', () => {
		expect(signals({ path: '/media/Reanimator/film.mkv' })).not.toContain(
			ClassificationSignal.ANIMATION_PATH_KEYWORD,
		);
	});
});

describe('kind', () => {
	it('reads a collection with the films', () => {
		expect(signals({ kind: MediaKind.COLLECTION })).toContain(ClassificationSignal.KIND_IS_FILM);
	});

	it('reads a season and an episode with the series', () => {
		expect(signals({ kind: MediaKind.SEASON })).toContain(ClassificationSignal.KIND_IS_SERIES);
		expect(signals({ kind: MediaKind.EPISODE })).toContain(ClassificationSignal.KIND_IS_SERIES);
	});
});
