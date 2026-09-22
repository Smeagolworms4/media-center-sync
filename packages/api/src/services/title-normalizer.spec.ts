import {
	extractYear,
	foldAccents,
	normalizeTitle,
	parseEpisodeNumbers,
	parseTitle,
	similarity,
	stripExtension,
} from './title-normalizer';

describe('title-normalizer', () => {
	describe('normalizeTitle', () => {
		// A table of names taken from what libraries actually contain, because the
		// value of this function is entirely in the awkward cases.
		const cases: [string, string][] = [
			['The Expanse', 'expanse'],
			['the expanse', 'expanse'],
			['Amélie', 'amelie'],
			['Les Misérables', 'miserables'],
			['Der Untergang', 'untergang'],
			['Rick & Morty', 'rick and morty'],
			['Rick and Morty', 'rick and morty'],
			["Don't Look Up", 'dont look up'],
			['Blade Runner 2049 (2017)', 'blade runner 2049'],
			['The.Expanse.S01E02.1080p.WEB-DL.x265-GRP', 'expanse s01e02 grp'],
			['Spirited.Away.2001.1080p.BluRay.x264.DTS-HD.MA.5.1-FGT', 'spirited away fgt'],
			['[SubsPlease] Frieren - 01 (1080p) [A1B2C3D4]', 'frieren 01'],
			['Movie_Title_2019_2160p_HDR_x265', 'movie title'],
			['A Quiet Place', 'quiet place'],
			['Mission: Impossible - Fallout', 'mission impossible fallout'],
			// The pair that went unmatched on a real gateway: one server writes the
			// ellipsis as a single character, the next writes nothing at all, and only
			// the three-dot spelling used to be cleaned away.
			['Il était une fois… les Découvreurs', 'etait une fois les decouvreurs'],
			['Il était une fois... les Découvreurs', 'etait une fois les decouvreurs'],
			['Il était une fois les découvreurs', 'etait une fois les decouvreurs'],
			['Il était une fois… la Vie', 'etait une fois la vie'],
			// Typographic marks nobody types but every scraper emits: an en dash where
			// a hyphen was meant, guillemets, and the full-width punctuation that comes
			// with a Japanese or Chinese title.
			['Mission: Impossible – Fallout', 'mission impossible fallout'],
			['«Solaris»', 'solaris'],
			['“Stalker”', 'stalker'],
			['Ghost in the Shell: 攻殻機動隊', 'ghost in the shell 攻殻機動隊'],
		];

		it.each(cases)('reduces %s to %s', (raw, expected) => {
			expect(normalizeTitle(raw)).toBe(expected);
		});

		it('never reduces a numeric title to nothing', () => {
			// `2012` and `1917` are entirely made of things the cleaner removes. Falling
			// back is what stops them from matching every other unreadable title.
			expect(normalizeTitle('2012')).toBe('2012');
			expect(normalizeTitle('1917')).toBe('1917');
		});

		it('keeps a leading article when it is the whole title', () => {
			expect(normalizeTitle('The')).toBe('the');
		});

		it('returns an empty string for an empty input', () => {
			expect(normalizeTitle('')).toBe('');
		});
	});

	describe('foldAccents and stripExtension', () => {
		it('folds every accent it meets', () => {
			expect(foldAccents('Ångström Éloïse Ñuñez')).toBe('Angstrom Eloise Nunez');
		});

		it('strips only a plausible extension', () => {
			expect(stripExtension('Film.2019.mkv')).toBe('Film.2019');
			expect(stripExtension('Film Without Extension')).toBe('Film Without Extension');
		});
	});

	describe('parseEpisodeNumbers', () => {
		const cases: [string, number, number][] = [
			['The.Expanse.S01E02.mkv', 1, 2],
			['the expanse s1e2', 1, 2],
			['The Expanse - 1x02 - Title', 1, 2],
			['Show/Season 1/Episode 2.mkv', 1, 2],
			['Show.S01.E02.1080p', 1, 2],
			['Show 102 720p', 1, 2],
			['Show.S12E134.mkv', 12, 134],
		];

		it.each(cases)('reads %s as season %i episode %i', (raw, season, episode) => {
			expect(parseEpisodeNumbers(raw)).toEqual({
				seasonNumber: season,
				episodeNumber: episode,
			});
		});

		it('takes the first episode of a multi-episode file', () => {
			expect(parseEpisodeNumbers('Show.S02E03E04.mkv')).toEqual({
				seasonNumber: 2,
				episodeNumber: 3,
			});
		});

		it('refuses to read a year as a season and an episode', () => {
			expect(parseEpisodeNumbers('Show 1984 720p')).toBeNull();
		});

		it('refuses absolute anime numbering', () => {
			// `Show - 137` is episode 137 of the whole run, not season 1 episode 37, and
			// guessing would be wrong far more often than right.
			expect(parseEpisodeNumbers('Frieren - 12 [1080p].mkv')).toBeNull();
		});

		it('returns null for a film', () => {
			expect(parseEpisodeNumbers('Blade Runner 2049 (2017).mkv')).toBeNull();
		});
	});

	describe('extractYear', () => {
		it('prefers a parenthesised year over a number in the title', () => {
			expect(extractYear('Blade Runner 2049 (2017).mkv')).toBe(2017);
		});

		it('reads a bare year from a release name', () => {
			expect(extractYear('Spirited.Away.2001.1080p.BluRay.mkv')).toBe(2001);
		});

		it('does not read a leading year as metadata', () => {
			expect(extractYear('2012')).toBeNull();
		});

		it('returns null when there is none', () => {
			expect(extractYear('The Expanse S01E02')).toBeNull();
		});
	});

	describe('parseTitle', () => {
		it('cuts a release name at the episode tag', () => {
			expect(parseTitle('/media/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv')).toEqual({
				title: 'The Expanse',
				normalizedTitle: 'expanse',
				year: null,
				seasonNumber: 1,
				episodeNumber: 2,
			});
		});

		it('cuts a film name at the year and keeps the year', () => {
			expect(parseTitle('Spirited.Away.2001.1080p.BluRay.x264-FGT.mkv')).toEqual({
				title: 'Spirited Away',
				normalizedTitle: 'spirited away',
				year: 2001,
				seasonNumber: null,
				episodeNumber: null,
			});
		});

		it('works on a bare title with nothing to cut', () => {
			expect(parseTitle('Amélie')).toMatchObject({
				title: 'Amélie',
				normalizedTitle: 'amelie',
			});
		});
	});

	describe('similarity', () => {
		it('is 1 for identical titles', () => {
			expect(similarity('expanse', 'expanse')).toBe(1);
		});

		it('is 0 when either side is empty', () => {
			expect(similarity('', 'expanse')).toBe(0);
			expect(similarity('expanse', '')).toBe(0);
			expect(similarity('', '')).toBe(0);
		});

		it('scores a contained title highly', () => {
			expect(
				similarity('star wars episode v the empire strikes back', 'the empire strikes back'),
			).toBeGreaterThanOrEqual(0.85);
		});

		it('ignores a short coincidental containment', () => {
			// `up` inside `growing up` is a coincidence, and the length floor is what
			// keeps it from scoring as a match.
			expect(similarity('up', 'growing up')).toBeLessThan(0.85);
		});

		it('separates two unrelated titles', () => {
			expect(similarity('the expanse', 'breaking bad')).toBeLessThan(0.3);
		});

		it('tolerates a small spelling difference', () => {
			expect(similarity('the hitchhikers guide', 'the hitch hikers guide')).toBeGreaterThan(0.8);
		});
	});
});
