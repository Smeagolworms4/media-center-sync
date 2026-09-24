import { ReleaseKind } from '@mcs/shared';
import { parseReleaseName } from './release-name';

/**
 * Reading a release name, which is the only thing every tracker agrees on.
 *
 * A category says `TV/HD` for a season pack and for one episode alike, and a quality
 * field is filled in by whoever uploaded it. The name is what the release *is*, so it
 * is what everything downstream — the grouping, the coverage, the plan — is built on.
 * A misreading here is not a wrong label: it is a season fetched for one episode, or
 * eleven gaps somebody thinks are still open.
 */
describe('parseReleaseName', () => {
	describe('the coordinate', () => {
		it.each([
			['Spartacus.S02E09.1080p.WEB-DL-GRP', 2, 9],
			['Spartacus 2x09 1080p', 2, 9],
			['Spartacus S02 E09 FRENCH', 2, 9],
			['Spartacus.s02e09.multi', 2, 9],
		])('reads %s', (name, season, episode) => {
			const parsed = parseReleaseName(name);

			expect(parsed.kind).toBe(ReleaseKind.EPISODE);
			expect(parsed.seasonNumber).toBe(season);
			expect(parsed.episodeNumber).toBe(episode);
			expect(parsed.coverage.episodeNumbers).toEqual([episode]);
		});

		/**
		 * The difference between one file and twelve.
		 *
		 * `S01E01-E12` read as episode one leaves eleven gaps somebody believes are still
		 * open, and a plan built on that grabs eleven things already on their way.
		 */
		it.each([
			['Show.S01E01-E03.1080p', [1, 2, 3]],
			['Show.S01E01E02.1080p', [1, 2]],
			['Show S01E05-08 WEB', [5, 6, 7, 8]],
		])('reads the run in %s', (name, episodes) => {
			expect(parseReleaseName(name).coverage.episodeNumbers).toEqual(episodes);
		});

		it('refuses a run long enough to be a mistake rather than a season', () => {
			// `E01-E999` is a name, not a release. Believing it would have one line claim
			// to fill every gap of every season.
			expect(parseReleaseName('Show.S01E01-E999').coverage.episodeNumbers).toEqual([1]);
		});
	});

	describe('a pack', () => {
		it.each([
			'Spartacus.S02.COMPLETE.1080p-GRP',
			'Spartacus Season 2 1080p',
			'Spartacus.S02.MULTI.BluRay',
		])('reads %s as a whole season', (name) => {
			const parsed = parseReleaseName(name);

			expect(parsed.kind).toBe(ReleaseKind.SEASON_PACK);
			expect(parsed.coverage.wholeSeason).toBe(true);
			expect(parsed.coverage.seasonNumber).toBe(2);
			// Nothing enumerated: what a pack holds is only known once a client has its
			// file list, so claiming episodes here would be claiming what nobody knows.
			expect(parsed.coverage.episodeNumbers).toEqual([]);
		});

		it.each([
			'Spartacus.Complete.Series.1080p-GRP',
			'Spartacus Intégrale MULTI',
			'Spartacus.Seasons.1-4.1080p',
		])('reads %s as the whole show', (name) => {
			expect(parseReleaseName(name).coverage.wholeSeries).toBe(true);
		});

		it('never claims a season and an enumeration at once', () => {
			// A name that spells its episodes has said exactly what it holds. Claiming the
			// season on top would make it fill gaps it does not cover.
			const parsed = parseReleaseName('Show.S02E01-E03.COMPLETE');

			expect(parsed.coverage.episodeNumbers).toEqual([1, 2, 3]);
			expect(parsed.coverage.wholeSeason).toBe(false);
		});
	});

	describe('a film', () => {
		/**
		 * The reason the caller says whether it is looking at a show.
		 *
		 * A film's name is full of numbers and none of them are coordinates: `Blade
		 * Runner 2049` read as a show is season 20, and every gap it claims to fill is
		 * a gap in something else entirely.
		 */
		it('reads no coordinate out of a title full of numbers', () => {
			const parsed = parseReleaseName('Blade.Runner.2049.2017.2160p.BluRay', false);

			expect(parsed.kind).toBe(ReleaseKind.MOVIE);
			expect(parsed.seasonNumber).toBeNull();
			expect(parsed.coverage.wholeSeason).toBe(false);
		});
	});

	describe('what the name says about the file', () => {
		it.each([
			['Show.S01E01.2160p.WEB-DL', '2160p', 'WEB-DL'],
			['Show.S01E01.1080p.BluRay.REMUX', '1080p', 'BluRay'],
			['Show.S01E01.720p.HDTV', '720p', 'HDTV'],
			['Show.S01E01.WEBRip.480p', '480p', 'WEBRip'],
		])('reads %s', (name, quality, source) => {
			const parsed = parseReleaseName(name);

			expect(parsed.quality).toBe(quality);
			expect(parsed.source).toBe(source);
		});

		/**
		 * The French tags are why this list is not the obvious one.
		 *
		 * `VOSTFR` is subtitled and `MULTI` is a promise of several rather than a
		 * language; both are what a French library is full of, and a reader that only
		 * knew `FRENCH` would label half of it as nothing.
		 */
		it.each([
			['Show.S01E01.MULTI.1080p', 'MULTI'],
			['Show.S01E01.VOSTFR.1080p', 'VOSTFR'],
			['Show.S01E01.TRUEFRENCH.1080p', 'FRENCH'],
		])('reads the language of %s', (name, language) => {
			expect(parseReleaseName(name).languages).toContain(language);
		});

		it('says nothing rather than guessing at a name it cannot read', () => {
			const parsed = parseReleaseName('some.random.upload');

			expect(parsed.kind).toBe(ReleaseKind.UNKNOWN);
			expect(parsed.quality).toBeNull();
			expect(parsed.coverage.episodeNumbers).toEqual([]);
			expect(parsed.coverage.wholeSeason).toBe(false);
		});
	});
});
