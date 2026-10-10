import { applyOverride, pinnedFolderOf, snapshotReported, type OverridableItem } from './media-override';

const normalize = (title: string): string => title.trim().toLowerCase();

const anItem = (overrides: Partial<OverridableItem> = {}): OverridableItem => ({
	libraryId: 'library-films',
	title: 'Dulcinea',
	normalizedTitle: 'the expanse',
	seriesTitle: 'The Expanse',
	year: 2015,
	seasonNumber: 1,
	episodeNumber: 1,
	episodeNumberEnd: null,
	overview: 'The crew looks for answers.',
	externalIds: { tvdb: '5312341', imdb: 'tt4192812' },
	overrides: null,
	reported: null,
	ignored: false,
	...overrides,
});

describe('applyOverride', () => {
	it('moves an item into another library, which is what changes its category', () => {
		const item = anItem();

		applyOverride(item, { libraryId: 'library-docs' }, normalize);

		expect(item.libraryId).toBe('library-docs');
		expect(item.reported?.libraryId).toBe('library-films');
	});

	it('reassigns a season and an episode number', () => {
		// An anime numbered by absolute order against a library that expects seasons is
		// the ordinary case, and it has to reach correlation and filing — not just the
		// screen that made the correction.
		const item = anItem();

		applyOverride(item, { seasonNumber: 2, episodeNumber: 14 }, normalize);

		expect(item).toMatchObject({ seasonNumber: 2, episodeNumber: 14 });
	});

	it('follows a renamed show into the comparison form', () => {
		const item = anItem();

		applyOverride(item, { seriesTitle: 'Expanse' }, normalize);

		expect(item.seriesTitle).toBe('Expanse');
		expect(item.normalizedTitle).toBe('expanse');
	});

	it('tells a cleared field from an untouched one', () => {
		// `undefined` leaves the service's answer alone; `null` is how somebody removes
		// a year a scraper invented. Collapsing the two would make the second impossible.
		const untouched = anItem();
		const cleared = anItem();

		applyOverride(untouched, { title: 'Dulcinea (remastered)' }, normalize);
		applyOverride(cleared, { year: null }, normalize);

		expect(untouched.year).toBe(2015);
		expect(cleared.year).toBeNull();
	});

	it('merges identifiers rather than replacing them', () => {
		const item = anItem();

		applyOverride(item, { externalIds: { tvdb: '999' } }, normalize);

		expect(item.externalIds).toEqual({ tvdb: '999', imdb: 'tt4192812' });
	});

	it('does not compound two edits in a row', () => {
		// The second edit starts from what the service said, not from the first one, or
		// correcting a field twice would leave the earlier value behind.
		const item = anItem();

		applyOverride(item, { title: 'First' }, normalize);
		applyOverride(item, { seasonNumber: 3 }, normalize);

		expect(item.title).toBe('Dulcinea');
		expect(item.seasonNumber).toBe(3);
	});

	it('puts everything back when the override is cleared', () => {
		const item = anItem();

		applyOverride(item, { title: 'Wrong', seasonNumber: 9 }, normalize);
		applyOverride(item, null, normalize);

		expect(item).toMatchObject({ title: 'Dulcinea', seasonNumber: 1, year: 2015 });
		expect(item.overrides).toBeNull();
		expect(item.reported).toBeNull();
	});

	it('marks an item ignored, and puts it back when the instruction is withdrawn', () => {
		// A special a scraper filed as an episode. It stays visible and stays labelled
		// — what changes is that it stops counting as a gap.
		const item = anItem();

		applyOverride(item, { ignored: true }, normalize);
		expect(item.ignored).toBe(true);

		applyOverride(item, null, normalize);
		expect(item.ignored).toBe(false);
	});

	it('does not ignore an item because some other field was corrected', () => {
		// The baseline has to be re-applied on every write, or an item ignored once
		// stays ignored through every later edit that never mentions it.
		const item = anItem();

		applyOverride(item, { ignored: true }, normalize);
		applyOverride(item, { title: 'Pilot' }, normalize);

		expect(item.ignored).toBe(false);
		expect(item.title).toBe('Pilot');
	});

	it('reads only an explicit true as ignoring', () => {
		const item = anItem();

		applyOverride(item, { ignored: false }, normalize);

		expect(item.ignored).toBe(false);
	});

	it('treats an absent instruction the same as a cleared one', () => {
		// A row built from a scan has no `overrides` property at all. Reading only for
		// `null` let `undefined` through to `Object.keys()`, which throws — and it threw
		// inside the indexing loop, so every service reported `Indexing <id> failed:
		// Cannot convert undefined or null to object` and nothing was indexed at all.
		const item = anItem();

		expect(() => applyOverride(item, undefined, normalize)).not.toThrow();
		expect(item).toMatchObject({ title: 'Dulcinea', seasonNumber: 1, year: 2015 });
		expect(item.overrides).toBeNull();
	});

	/**
	 * A correction that reproduces the service's own answer is not a correction.
	 *
	 * The difference is invisible the day it is made and decides everything afterwards:
	 * an item with no correction keeps following its server, so the day Jellyfin fixes a
	 * title the next scan picks it up; an item whose correction happens to equal today's
	 * reported values is frozen on them for ever and no scan will ever change it again.
	 */
	describe('a correction that says what the service already says', () => {
		it('records nothing at all when every field matches', () => {
			// What the interface sends after "reset to what the service reports": every
			// box holds the reported value, so the body is a correction of nothing.
			const item = anItem();

			applyOverride(item, {
				libraryId: 'library-films',
				title: 'Dulcinea',
				seriesTitle: 'The Expanse',
				year: 2015,
				seasonNumber: 1,
				episodeNumber: 1,
				overview: 'The crew looks for answers.',
				externalIds: { tvdb: '5312341', imdb: 'tt4192812' },
			}, normalize);

			expect(item.overrides).toBeNull();
			expect(item.reported).toBeNull();
			expect(item).toMatchObject({ title: 'Dulcinea', year: 2015, seasonNumber: 1 });
		});

		it('keeps only the fields that really differ', () => {
			// Per field rather than all-or-nothing: a form sends every box it renders, and
			// an item corrected on its year alone must not end up frozen on the title, the
			// overview and the identifiers nobody touched.
			const item = anItem();

			applyOverride(item, { title: 'Dulcinea', year: 2016 }, normalize);

			expect(item.overrides).toEqual({ year: 2016 });
			expect(item.year).toBe(2016);
			expect(item.title).toBe('Dulcinea');
		});

		it('drops an identifier that repeats the service and keeps one that corrects it', () => {
			const item = anItem();

			applyOverride(
				item,
				{ externalIds: { tvdb: '5312341', imdb: 'tt9999999' } },
				normalize,
			);

			expect(item.overrides).toEqual({ externalIds: { imdb: 'tt9999999' } });
			// Merged over the service's answer, so the TVDB number it got right survives.
			expect(item.externalIds).toEqual({ tvdb: '5312341', imdb: 'tt9999999' });
		});

		it('reads erasing a field the service never filled as nothing to erase', () => {
			// There is no year to remove, so "remove the year" is an instruction with no
			// effect — and storing it would stop the item ever taking the year the service
			// finally scrapes.
			const item = anItem({ year: null });

			applyOverride(item, { year: null }, normalize);

			expect(item.overrides).toBeNull();
		});

		it('drops a whole correction the moment its last real field is withdrawn', () => {
			const item = anItem();

			applyOverride(item, { title: 'Wrong' }, normalize);
			expect(item.overrides).toEqual({ title: 'Wrong' });

			applyOverride(item, { title: 'Dulcinea' }, normalize);

			expect(item.overrides).toBeNull();
			expect(item.reported).toBeNull();
			expect(item.title).toBe('Dulcinea');
		});
	});
});

/**
 * Saying by hand that one file holds two episodes.
 *
 * Everything that counts gaps already expands this range — `spanOf` is the one rule —
 * and both media servers report it when they work it out. What was missing was the hand:
 * a file holding twenty and twenty-one that neither the server nor the file name said so
 * about left twenty-one reading as a hole for ever, and the household was invited to
 * download an episode playing off its own disk.
 */
describe('correcting a double episode', () => {
	it('writes the end into the column everything reads', () => {
		const item = anItem({ episodeNumber: 20, episodeNumberEnd: null });

		applyOverride(item, { episodeNumberEnd: 21 }, normalize);

		expect(item.episodeNumberEnd).toBe(21);
		expect(item.reported?.episodeNumberEnd).toBeNull();
	});

	it('clears a double the scraper invented', () => {
		// `null` is a different instruction from leaving the field out, exactly as it is
		// for the year: it is how somebody says "this file is one episode".
		const item = anItem({ episodeNumber: 20, episodeNumberEnd: 21 });

		applyOverride(item, { episodeNumberEnd: null }, normalize);

		expect(item.episodeNumberEnd).toBeNull();
		expect(item.reported?.episodeNumberEnd).toBe(21);
	});

	it('is not a correction when it says what the service already says', () => {
		// Otherwise the item is frozen on today's values and no scan will ever change it
		// again — invisible the day it is made, unexplainable six months later.
		const item = anItem({ episodeNumber: 20, episodeNumberEnd: 21 });

		applyOverride(item, { episodeNumberEnd: 21 }, normalize);

		expect(item.overrides).toBeNull();
		expect(item.reported).toBeNull();
		expect(item.episodeNumberEnd).toBe(21);
	});

	it('gives the service its answer back when the correction is removed', () => {
		const item = anItem({ episodeNumber: 20, episodeNumberEnd: 21 });

		applyOverride(item, { episodeNumberEnd: null }, normalize);
		applyOverride(item, null, normalize);

		expect(item.episodeNumberEnd).toBe(21);
		expect(item.overrides).toBeNull();
	});

	it('leaves a shape that carries no such column alone', () => {
		// Not every caller knows about doubles, and one that does not must not have one
		// invented for it. Same rule as `seriesTitle` beside it.
		const item = anItem({ episodeNumber: 20 });

		delete (item as { episodeNumberEnd?: number | null }).episodeNumberEnd;
		applyOverride(item, { episodeNumberEnd: 21 }, normalize);

		expect('episodeNumberEnd' in item).toBe(false);
	});
});

describe('snapshotReported', () => {
	it('copies the identifiers rather than aliasing them', () => {
		// A shared reference would let a later edit rewrite the record of what the
		// service said, which is the one thing it exists to remember.
		const item = anItem();
		const reported = snapshotReported(item);

		item.externalIds.tvdb = 'changed';

		expect(reported.externalIds.tvdb).toBe('5312341');
	});
});

/**
 * Where a pinned folder is read from, which was two defects in one line.
 *
 * The correction dialog is offered on a season's page and on an episode's, and it writes
 * the field on the row it was opened for — while this read the top of the tree and
 * nowhere else. The owner, having corrected the destination on the season four page and
 * pressed download: *pas de prise en compte de la correction*.
 */
describe('pinnedFolderOf', () => {
	const pinned = (id: string, folder: string | null) => ({
		id,
		overrides: folder === null ? null : { targetFolder: folder },
	});

	it('takes the nearest decision, not the highest', () => {
		const chain = [
			pinned('season-4', '/share/SeriesTV/From/Saison 04'),
			pinned('series', '/share/SeriesTV/From/Saison 01'),
		];

		expect(pinnedFolderOf(chain)).toBe('/share/SeriesTV/From/Saison 04');
	});

	it('still finds a decision taken about the show', () => {
		const chain = [pinned('episode', null), pinned('season', null), pinned('series', '/elsewhere/From')];

		expect(pinnedFolderOf(chain)).toBe('/elsewhere/From');
	});

	it('puts the season being filed into a pin that names a season', () => {
		/*
		 * The second defect. A pin reading `…/Saison 01` — which is exactly what the
		 * dialog pre-fills while somebody corrects a season one placement — filed season
		 * four into season one. A pinned path whose last segment names a season says "this
		 * show lives there, in per-season folders", so the season that belongs in it is
		 * the one being filed.
		 */
		expect(pinnedFolderOf([pinned('series', '/share/SeriesTV/From/Saison 01')], 4))
			.toBe('/share/SeriesTV/From/Saison 04');
	});

	it('leaves a pin that names no season exactly as it was typed', () => {
		expect(pinnedFolderOf([pinned('series', '/share/SeriesTV/From')], 4))
			.toBe('/share/SeriesTV/From');
	});

	it('leaves it alone when there is no season to put in it', () => {
		// A film, or a prediction made from a series page: there is no number, and
		// inventing one is worse than imitating.
		expect(pinnedFolderOf([pinned('series', '/share/SeriesTV/From/Saison 01')], null))
			.toBe('/share/SeriesTV/From/Saison 01');
	});

	it('reads an emptied field as a pin somebody removed', () => {
		expect(pinnedFolderOf([pinned('season', '   '), pinned('series', '/elsewhere/From')]))
			.toBe('/elsewhere/From');
		expect(pinnedFolderOf([pinned('series', null)])).toBeNull();
		expect(pinnedFolderOf([])).toBeNull();
	});
});
