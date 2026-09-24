import {
	ClassificationSignal,
	ClassificationWithheld,
	DetectedCategory,
	MediaKind,
	type ClassificationCandidate,
} from '@mcs/shared';
import { classify, CLASSIFICATION_THRESHOLD } from './classifier';
import { noFacts, type ClassificationFacts } from './signals';

const facts = (overrides: Partial<ClassificationFacts> = {}): ClassificationFacts => ({
	...noFacts(MediaKind.SERIES, 'Some Show'),
	...overrides,
});

/** The categories actually proposed — the only ones a screen offers a button for. */
const proposed = (overrides: Partial<ClassificationFacts> = {}): DetectedCategory[] =>
	classify(facts(overrides))
		.filter((candidate) => candidate.withheld === null)
		.map((candidate) => candidate.category);

const candidate = (
	overrides: Partial<ClassificationFacts>,
	category: DetectedCategory,
): ClassificationCandidate | undefined =>
	classify(facts(overrides)).find((one) => one.category === category);

describe('what must be proposed', () => {
	it('proposes anime for an animated series a service says is Japanese', () => {
		expect(
			proposed({ genres: ['Animation'], originalLanguage: 'ja', title: 'Frieren' }),
		).toEqual([DetectedCategory.ANIME]);
	});

	it('proposes anime on an explicit demographic genre alone with the kind', () => {
		expect(proposed({ genres: ['Shounen'] })).toEqual([DetectedCategory.ANIME]);
	});

	it('proposes cartoons for an animated series with nothing Japanese about it', () => {
		expect(proposed({ genres: ['Animation'], studios: ['Cartoon Network Studios'] })).toEqual([
			DetectedCategory.CARTOONS,
		]);
	});

	it('proposes animated films for an animated film', () => {
		expect(
			proposed({ kind: MediaKind.MOVIE, genres: ['Animation'], title: 'Ernest et Célestine' }),
		).toEqual([DetectedCategory.ANIMATED_FILMS]);
	});

	it('proposes both shelves for an anime film, anime first', () => {
		// Not a failure to decide. An anime film is an anime and an animated film, and
		// which shelf the household keeps it on is theirs to say.
		expect(
			proposed({ kind: MediaKind.MOVIE, studios: ['Studio Ghibli'], title: 'Spirited Away' }),
		).toEqual([DetectedCategory.ANIME, DetectedCategory.ANIMATED_FILMS]);
	});

	it('proposes concerts for a recorded performance', () => {
		expect(
			proposed({
				kind: MediaKind.MOVIE,
				title: 'Queen — Live at Wembley Stadium',
				genres: ['Music'],
			}),
		).toEqual([DetectedCategory.CONCERTS]);
	});

	it('proposes anime for a fansub release the index knows nothing else about', () => {
		// The case that keeps the route from being inert: the catalogue carries no genres,
		// so a file named after its release is all there is.
		expect(
			proposed({
				title: 'Frieren - 01',
				releaseName: '[SubsPlease] Sousou no Frieren - 01 (1080p)',
			}),
		).toEqual([DetectedCategory.ANIME]);
	});
});

describe('what must be proposed for nothing at all', () => {
	it('says nothing about a live-action film with an animated character in its title', () => {
		for (const title of ['Detective Pikachu', 'Casper', 'Who Framed Roger Rabbit']) {
			expect(
				proposed({ kind: MediaKind.MOVIE, title, genres: ['Adventure', 'Comedy'] }),
			).toEqual([]);
		}
	});

	it('says nothing about a documentary that happens to carry animation', () => {
		// The animated inserts are real; the media is a documentary about anime and belongs
		// on none of the four shelves.
		expect(
			proposed({
				kind: MediaKind.MOVIE,
				title: 'The Story of Anime',
				genres: ['Documentary', 'Animation'],
			}),
		).toEqual([]);
	});

	it('says nothing about a concert film that is also a documentary', () => {
		expect(
			proposed({
				kind: MediaKind.MOVIE,
				title: 'Stop Making Sense — Live at Pantages',
				genres: ['Music', 'Documentary'],
			}),
		).toEqual([]);
	});

	it('says nothing when only the folder a file sits in suggests anything', () => {
		// A file under `/media/Animes/` is usually there because somebody already decided.
		// Reading that as evidence is reading our own answer back to ourselves.
		expect(proposed({ path: '/media/Animes/Something/S01E01.mkv' })).toEqual([]);
	});

	it('says nothing about an ordinary live-action series', () => {
		expect(proposed({ title: 'The Wire', genres: ['Drama', 'Crime'] })).toEqual([]);
	});

	it('says nothing about a venue in a title with no performance anywhere near it', () => {
		expect(proposed({ kind: MediaKind.MOVIE, title: 'Olympia', year: 1938 })).toEqual([]);
	});
});

describe('the anime and cartoons tie-break', () => {
	it('withholds cartoons as settled once the origin is known', () => {
		const withheld = candidate({ genres: ['Animation'], countries: ['JP'] }, DetectedCategory.CARTOONS);

		expect(withheld?.withheld).toBe(ClassificationWithheld.SETTLED_BY_ORIGIN);
	});

	it('does not raise anime at all when nothing says anything about origin', () => {
		expect(
			classify(facts({ genres: ['Animation'] })).map((one) => one.category),
		).toEqual([DetectedCategory.CARTOONS]);
	});

	it('withholds both shelves when a romanised title is the only origin signal', () => {
		/*
		 * The one place the detector refuses to choose. A romanised-looking title is wrong
		 * in both directions often enough that deciding on it is a coin flip, and a coin
		 * flip about which shelf a series lives on is exactly the thing not to ask somebody
		 * to rubber-stamp.
		 */
		const result = classify(facts({ genres: ['Animation'], title: 'Gakuen Heaven' }));

		expect(result.map((one) => one.category).sort()).toEqual([
			DetectedCategory.ANIME,
			DetectedCategory.CARTOONS,
		]);
		expect(result.every((one) => one.withheld === ClassificationWithheld.AMBIGUOUS_ORIGIN)).toBe(
			true,
		);
	});

	it('still proposes animated films in that ambiguous case, because origin is not its question', () => {
		expect(
			proposed({ kind: MediaKind.MOVIE, genres: ['Animation'], title: 'Gakuen Densetsu' }),
		).toEqual([DetectedCategory.ANIMATED_FILMS]);
	});
});

describe('withholding, and saying so', () => {
	it('reports a category it considered and found no decisive signal for', () => {
		const withheld = candidate(
			{ path: '/media/Concerts/Some Band/set.mkv', title: 'Some Band' },
			DetectedCategory.CONCERTS,
		);

		expect(withheld?.withheld).toBe(ClassificationWithheld.NO_DECISIVE_SIGNAL);
	});

	it('reports the documentary genre as the counter-evidence that sank it', () => {
		const withheld = candidate(
			{
				kind: MediaKind.MOVIE,
				title: 'Stop Making Sense — Live at Pantages',
				genres: ['Music', 'Documentary'],
			},
			DetectedCategory.CONCERTS,
		);

		expect(withheld?.withheld).toBe(ClassificationWithheld.BELOW_THRESHOLD);
		expect(withheld?.evidence.map((one) => one.signal)).toContain(
			ClassificationSignal.DOCUMENTARY_GENRE,
		);
	});

	it('does not report an animation shelf for a documentary with no animation in it', () => {
		expect(classify(facts({ kind: MediaKind.MOVIE, genres: ['Documentary'] }))).toEqual([]);
	});
});

describe('every candidate carries its own evidence', () => {
	it('quotes the signals that produced the confidence', () => {
		const one = candidate(
			{ genres: ['Animation'], studios: ['MAPPA'], originalLanguage: 'ja' },
			DetectedCategory.ANIME,
		);

		expect(one?.withheld).toBeNull();
		expect(one?.confidence).toBeGreaterThanOrEqual(CLASSIFICATION_THRESHOLD);
		expect(one?.evidence.map((evidence) => evidence.signal)).toEqual(
			expect.arrayContaining([
				ClassificationSignal.ANIMATION_GENRE,
				ClassificationSignal.ANIMATION_STUDIO,
				ClassificationSignal.JAPANESE_STUDIO,
				ClassificationSignal.ORIGINAL_LANGUAGE_JAPANESE,
			]),
		);
	});

	it('leaves origin evidence out of the animated films candidate', () => {
		// It is not evidence about being a film or about being animated, and a proposal
		// listing reasons that do not bear on it is a proposal nobody can check.
		const one = candidate(
			{ kind: MediaKind.MOVIE, studios: ['Studio Ghibli'] },
			DetectedCategory.ANIMATED_FILMS,
		);

		expect(one?.evidence.map((evidence) => evidence.signal)).not.toContain(
			ClassificationSignal.JAPANESE_STUDIO,
		);
	});

	it('never reports a confidence outside nought to one', () => {
		const everything = classify(
			facts({
				genres: ['Anime', 'Animation', 'Music', 'Concert'],
				studios: ['MAPPA'],
				originalLanguage: 'ja',
				countries: ['Japan'],
				title: 'Live at Budokan',
				path: '/media/Animes/Concerts/x.mkv',
				releaseName: '[SubsPlease] Live at Budokan',
			}),
		);

		for (const one of everything) {
			expect(one.confidence).toBeGreaterThanOrEqual(0);
			expect(one.confidence).toBeLessThanOrEqual(1);
		}
	});
});
