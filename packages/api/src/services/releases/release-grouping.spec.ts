import { ReleaseKind, type Release } from '@mcs/shared';
import { groupReleases } from './release-grouping';

/**
 * Folding forty rows into the four choices they really are.
 *
 * Every test here is a way of folding too much or too little, and the two fail in
 * opposite directions: folded too hard, a 2 GB encode and a 6 GB one share a line and
 * somebody grabs the copy they did not choose, with the other one's seeders credited to
 * it; folded too little, the four real choices stay invisible in a wall of duplicates
 * and the whole screen is unreadable. Neither shows up as an error anywhere.
 */

interface Sketch {
	title?: string;
	indexer?: string;
	kind?: ReleaseKind;
	seasonNumber?: number | null;
	episodeNumbers?: number[];
	wholeSeason?: boolean;
	wholeSeries?: boolean;
	quality?: string | null;
	source?: string | null;
	languages?: string[];
	size?: number | null;
	seeders?: number | null;
	heldAlready?: boolean;
}

const GIGABYTE = 1_000_000_000;

/**
 * A release, spelled out rather than parsed from a name.
 *
 * The parser has its own suite; going through it here would mean every failure in this
 * file could equally be a misreading of a name, which is the one thing a grouping test
 * must not be ambiguous about.
 */
function release(sketch: Sketch = {}): Release {
	const episodeNumbers = sketch.episodeNumbers ?? [1];
	const seasonNumber = sketch.seasonNumber === undefined ? 1 : sketch.seasonNumber;

	return {
		id: `${sketch.indexer ?? 'tracker'}:${sketch.title ?? 'Show.S01E01'}:${String(sketch.size ?? 0)}`,
		title: sketch.title ?? 'Show.S01E01.1080p.WEB-DL-GRP',
		indexer: sketch.indexer ?? 'tracker',
		size: sketch.size === undefined ? 2 * GIGABYTE : sketch.size,
		seeders: sketch.seeders === undefined ? 10 : sketch.seeders,
		leechers: 0,
		publishedAt: null,
		magnetUrl: 'magnet:?xt=urn:btih:abc',
		downloadUrl: null,
		kind: sketch.kind ?? ReleaseKind.EPISODE,
		seasonNumber,
		episodeNumber: episodeNumbers[0] ?? null,
		quality: sketch.quality === undefined ? '1080p' : sketch.quality,
		source: sketch.source === undefined ? 'WEB-DL' : sketch.source,
		languages: sketch.languages ?? ['MULTI'],
		coverage: {
			seasonNumber,
			episodeNumbers,
			wholeSeason: sketch.wholeSeason ?? false,
			wholeSeries: sketch.wholeSeries ?? false,
		},
		heldAlready: sketch.heldAlready ?? false,
	};
}

describe('groupReleases', () => {
	it('answers nothing for nothing', () => {
		expect(groupReleases([])).toEqual([]);
	});

	describe('what folds together', () => {
		/**
		 * The case the whole function exists for: one file, re-listed by every tracker
		 * that carries it, under a name that differs by whatever tag each one appends.
		 */
		it('folds one release listed by several trackers into one line', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', seeders: 40, size: 2 * GIGABYTE }),
				release({ indexer: 'beta', seeders: 12, size: 2 * GIGABYTE + 4096 }),
				release({ indexer: 'gamma', seeders: 3, size: 2 * GIGABYTE - 8192 }),
			]);

			expect(groups).toHaveLength(1);
			expect(groups[0].releases).toHaveLength(3);
			// Summed, not taken from the best copy: a release carried by three trackers
			// really is better seeded than the same file on one, and that is the number
			// somebody is choosing on.
			expect(groups[0].seeders).toBe(55);
		});

		it('ignores the order the languages were spelled in', () => {
			// `MULTI.VOSTFR` and `VOSTFR.MULTI` are one file. Two lines for it would be
			// two lines that differ in nothing a reader can see.
			const groups = groupReleases([
				release({ indexer: 'alpha', languages: ['MULTI', 'VOSTFR'] }),
				release({ indexer: 'beta', languages: ['VOSTFR', 'MULTI'] }),
			]);

			expect(groups).toHaveLength(1);
		});

		it('folds two copies of one file whose reported sizes differ by kilobytes', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', size: 2_000_000_000 }),
				release({ indexer: 'beta', size: 2_000_131_072 }),
			]);

			expect(groups).toHaveLength(1);
		});

		it('folds two listings of one file, whatever each tracker calls it', () => {
			// The same release re-listed: one tracker decorating the name and the other
			// not. Spelling is exactly what must not split a line.
			const groups = groupReleases([
				release({ indexer: 'alpha', title: 'Show.S01E01.1080p.WEB-DL-NTb' }),
				release({ indexer: 'beta', title: 'Show S01E01 1080p WEB-DL-NTb [beta]' }),
			]);

			expect(groups).toHaveLength(1);
		});

		/**
		 * The one place this screen could say something untrue.
		 *
		 * A line is named after its best-seeded member, and a grab takes that member. So
		 * two groups' 1080p WEB-DLs of one episode folded together gave a line ranked on
		 * one team's name that fetched the other team's file — and somebody who had
		 * ranked their teams watched the preference apply to a name that was not the one
		 * arriving. They really are different files; the list says so now.
		 */
		it('keeps two release groups apart, because a line names the file a grab takes', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', title: 'Show.S01E01.1080p.WEB-DL.x264-NTb' }),
				release({ indexer: 'beta', title: 'Show.S01E01.1080p.WEB-DL.x264-FLUX' }),
			]);

			expect(groups).toHaveLength(2);
		});

		it('keeps two codecs of one episode apart', () => {
			const groups = groupReleases([
				release({ title: 'Show.S01E01.1080p.WEB-DL.x265-NTb' }),
				release({ title: 'Show.S01E01.1080p.WEB-DL.x264-NTb' }),
			]);

			expect(groups).toHaveLength(2);
		});
	});

	describe('what does not fold together', () => {
		it('keeps a 1080p and a 2160p of one episode apart', () => {
			const groups = groupReleases([
				release({ quality: '1080p', seeders: 30 }),
				release({ quality: '2160p', seeders: 5, size: 20 * GIGABYTE }),
			]);

			expect(groups).toHaveLength(2);
			expect(groups.map((group) => group.quality)).toEqual(['1080p', '2160p']);
		});

		/**
		 * The size bucket, and the reason it is in the key at all.
		 *
		 * A 2 GB and a 6 GB WEB-DL of one episode are two encodes and two choices. Folded
		 * into one line, the seeders of one are credited to the other and a grab takes
		 * whichever happened to sort first.
		 */
		it('keeps a 2 GB and a 6 GB encode of one episode apart', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', size: 2 * GIGABYTE, seeders: 7 }),
				release({ indexer: 'beta', size: 6 * GIGABYTE, seeders: 9 }),
			]);

			expect(groups).toHaveLength(2);
			expect(groups.map((group) => group.size).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual([
				2 * GIGABYTE,
				6 * GIGABYTE,
			]);
			expect(groups.map((group) => group.seeders).sort()).toEqual([7, 9]);
		});

		/**
		 * The difference between one file and three.
		 *
		 * Folded together, one line promises one episode and delivers three — or offers
		 * the three under a name that says one, which is a gap somebody thinks is still
		 * open after they have already fetched it.
		 */
		it('keeps a run of episodes apart from the single episode it starts at', () => {
			const groups = groupReleases([
				release({ title: 'Show.S01E01.1080p.WEB-DL', episodeNumbers: [1] }),
				release({ title: 'Show.S01E01-E03.1080p.WEB-DL', episodeNumbers: [1, 2, 3] }),
			]);

			expect(groups).toHaveLength(2);
			expect(
				groups.map((group) => group.coverage.episodeNumbers).sort((left, right) => left.length - right.length),
			).toEqual([[1], [1, 2, 3]]);
		});

		it('keeps a season pack apart from the first episode of that season', () => {
			const groups = groupReleases([
				release({ kind: ReleaseKind.EPISODE, episodeNumbers: [1] }),
				release({
					kind: ReleaseKind.SEASON_PACK,
					episodeNumbers: [],
					wholeSeason: true,
					size: 20 * GIGABYTE,
				}),
			]);

			expect(groups).toHaveLength(2);
		});

		it('keeps two seasons apart', () => {
			const groups = groupReleases([
				release({ seasonNumber: 1, episodeNumbers: [1] }),
				release({ seasonNumber: 2, episodeNumbers: [1] }),
			]);

			expect(groups).toHaveLength(2);
		});

		it.each([
			['the source', { source: 'BluRay' }],
			['the language tags', { languages: ['VOSTFR'] }],
		])('keeps two releases apart when %s differ', (_label, difference: Sketch) => {
			expect(groupReleases([release(), release(difference)])).toHaveLength(2);
		});

		it('keeps a release whose size is unknown apart from one that reported a size', () => {
			// Nothing is known about where an unreported size would bucket, and guessing
			// it into the nearest line is guessing which file somebody grabs.
			expect(groupReleases([release({ size: null }), release({ size: 2 * GIGABYTE })])).toHaveLength(2);
		});
	});

	describe('what a line says', () => {
		it('takes its name from the copy a grab would actually take', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', title: 'Show.S01E01.1080p.WEB-DL-POOR', seeders: 2 }),
				release({ indexer: 'beta', title: 'Show.S01E01.1080p.WEB-DL-BEST', seeders: 90 }),
			]);

			expect(groups[0].title).toBe('Show.S01E01.1080p.WEB-DL-BEST');
			expect(groups[0].releases[0].indexer).toBe('beta');
		});

		it('orders the copies inside a line best seeded first', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', seeders: 2 }),
				release({ indexer: 'beta', seeders: 90 }),
				release({ indexer: 'gamma', seeders: 41 }),
			]);

			expect(groups[0].releases.map((one) => one.indexer)).toEqual(['beta', 'gamma', 'alpha']);
		});

		it('breaks a tie between equally seeded copies on size', () => {
			// Between two copies nobody can tell apart on seeders, the larger is the less
			// compressed.
			const groups = groupReleases([
				release({ indexer: 'small', seeders: 10, size: 2_000_000_000 }),
				release({ indexer: 'large', seeders: 10, size: 2_000_100_000 }),
			]);

			expect(groups[0].releases.map((one) => one.indexer)).toEqual(['large', 'small']);
		});

		it('reports the largest size in the group', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', size: 2_000_000_000 }),
				release({ indexer: 'beta', size: 2_000_150_000, seeders: 99 }),
			]);

			expect(groups[0].size).toBe(2_000_150_000);
		});

		it('counts a copy reporting no seeders as none rather than dropping the number', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', seeders: 20 }),
				release({ indexer: 'beta', seeders: null }),
			]);

			expect(groups[0].seeders).toBe(20);
		});

		it('says nothing about seeders when no copy reported any', () => {
			// Zero and "the tracker did not say" are different answers, and a screen that
			// shows the first for the second offers a download that looks dead.
			const groups = groupReleases([
				release({ indexer: 'alpha', seeders: null }),
				release({ indexer: 'beta', seeders: null }),
			]);

			expect(groups[0].seeders).toBeNull();
		});

		it('marks a line as held when any of its copies is', () => {
			const groups = groupReleases([
				release({ indexer: 'alpha', heldAlready: false }),
				release({ indexer: 'beta', heldAlready: true }),
			]);

			expect(groups[0].heldAlready).toBe(true);
		});

		it('leaves what we hold and what it fills to the layer that knows', () => {
			// A service has never heard of the catalogue. Filling these here would be a
			// second placement rule nobody could see.
			const groups = groupReleases([release()]);

			expect(groups[0].fills).toEqual([]);
			expect(groups[0].brings).toEqual([]);
		});

		it('gives every line a key of its own', () => {
			const groups = groupReleases([
				release({ quality: '1080p' }),
				release({ quality: '2160p' }),
				release({ quality: '720p' }),
			]);

			expect(new Set(groups.map((group) => group.key)).size).toBe(3);
		});
	});

	describe('the order of the lines', () => {
		it('puts the best seeded first', () => {
			const groups = groupReleases([
				release({ quality: '720p', seeders: 4 }),
				release({ quality: '2160p', seeders: 60, size: 20 * GIGABYTE }),
				release({ quality: '1080p', seeders: 25 }),
			]);

			expect(groups.map((group) => group.quality)).toEqual(['2160p', '1080p', '720p']);
		});

		/**
		 * Something already on the disk is not a choice worth putting at the top of a list
		 * of things to fetch — and it is still listed, because "you already have this one"
		 * is an answer somebody came to the screen for.
		 */
		it('sinks a held line below everything else, however well seeded', () => {
			const groups = groupReleases([
				release({ quality: '2160p', seeders: 500, size: 20 * GIGABYTE, heldAlready: true }),
				release({ quality: '1080p', seeders: 1 }),
			]);

			expect(groups.map((group) => group.quality)).toEqual(['1080p', '2160p']);
			expect(groups).toHaveLength(2);
		});

		it('orders the held lines among themselves as it orders the rest', () => {
			const groups = groupReleases([
				release({ quality: '720p', seeders: 3, heldAlready: true }),
				release({ quality: '1080p', seeders: 30, heldAlready: true }),
			]);

			expect(groups.map((group) => group.quality)).toEqual(['1080p', '720p']);
		});
	});
});
