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
