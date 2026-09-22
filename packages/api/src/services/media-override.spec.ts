import { applyOverride, snapshotReported, type OverridableItem } from './media-override';

const normalize = (title: string): string => title.trim().toLowerCase();

const anItem = (overrides: Partial<OverridableItem> = {}): OverridableItem => ({
	libraryId: 'library-films',
	title: 'Dulcinea',
	normalizedTitle: 'the expanse',
	seriesTitle: 'The Expanse',
	year: 2015,
	seasonNumber: 1,
	episodeNumber: 1,
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
