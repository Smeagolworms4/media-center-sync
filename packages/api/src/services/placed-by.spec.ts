import { PlacedBy, PlacementStrategy, UNCONFIGURED_PLACEMENTS, type Settings } from '@mcs/shared';
import { placedByFor, type PlacedByRequest, type PlacedByTarget } from './placed-by';
import { DEFAULT_SETTINGS } from './settings.service';

/**
 * The mapping the whole feature turns on.
 *
 * Every step of the placement rule has to come back as itself, and the three that
 * mean nobody chose have to be exactly the three in `UNCONFIGURED_PLACEMENTS` — no
 * more, because a dashboard that lists a series filed beside its own episodes as a
 * problem is one nobody will read twice, and no fewer, because a step that stops
 * being reported goes back to being invisible.
 */
describe('placedByFor', () => {
	const settings = (overrides: Partial<Settings> = {}): Settings => ({
		...DEFAULT_SETTINGS,
		...overrides,
	});

	const target = (overrides: Partial<PlacedByTarget> = {}): PlacedByTarget => ({
		libraryId: 'lib-shows',
		path: '/media/shows/The Expanse/S01E02.mkv',
		strategy: PlacementStrategy.DEFAULT_LIBRARY,
		...overrides,
	});

	const request = (overrides: Partial<PlacedByRequest> = {}): PlacedByRequest => ({
		settings: settings(),
		categoryKey: null,
		preferredLibraryId: null,
		...overrides,
	});

	it('names the run that asked, whatever the settings would have said', () => {
		const answer = placedByFor(
			target(),
			request({
				preferredLibraryId: 'lib-shows',
				settings: settings({ defaultTargetLibraryId: 'lib-shows' }),
			}),
		);

		expect(answer).toBe(PlacedBy.REQUESTED);
	});

	it('names the copy we already hold', () => {
		const answer = placedByFor(
			target({ strategy: PlacementStrategy.BESIDE_EXISTING }),
			request(),
		);

		expect(answer).toBe(PlacedBy.EXISTING_COPY);
	});

	it('names the library the category was pointed at', () => {
		const answer = placedByFor(
			target({ libraryId: 'lib-anime' }),
			request({
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
			}),
		);

		expect(answer).toBe(PlacedBy.CATEGORY);
	});

	/**
	 * The distinction `PlacementStrategy` cannot make.
	 *
	 * Both of these come back as `DEFAULT_LIBRARY` from the placement service — the
	 * enum has no value for "the library this category names" — and one of them is a
	 * destination somebody chose while the other is one nobody did. Reading the
	 * strategy instead of the settings would report them identically, which is the
	 * whole reason this function exists.
	 */
	it('tells the category entry apart from the global default on the same value', () => {
		const configured = settings({
			categoryTargets: { animes: 'lib-anime' },
			defaultTargetLibraryId: 'lib-shows',
		});

		expect(
			placedByFor(target({ libraryId: 'lib-anime' }), request({ categoryKey: 'animes', settings: configured })),
		).toBe(PlacedBy.CATEGORY);
		expect(
			placedByFor(target({ libraryId: 'lib-shows' }), request({ categoryKey: 'animes', settings: configured })),
		).toBe(PlacedBy.DEFAULT_LIBRARY);
	});

	it('names the global default when the category names nothing', () => {
		const answer = placedByFor(
			target({ libraryId: 'lib-shows' }),
			request({
				categoryKey: 'animes',
				settings: settings({ defaultTargetLibraryId: 'lib-shows' }),
			}),
		);

		expect(answer).toBe(PlacedBy.DEFAULT_LIBRARY);
	});

	it('names the fixed path while that setting still exists', () => {
		const answer = placedByFor(
			target({ strategy: PlacementStrategy.FIXED_PATH }),
			request({ settings: settings({ placement: PlacementStrategy.FIXED_PATH, fixedPath: '/media/all' }) }),
		);

		expect(answer).toBe(PlacedBy.FIXED_PATH);
	});

	it('names the fallback folder by where the file went, not by an identifier', () => {
		// It is a path and belongs to no library at all, which is the case it exists
		// for — so identity cannot answer and containment has to.
		const answer = placedByFor(
			target({ libraryId: '', path: '/media/incoming/Show/S01E01.mkv' }),
			request({ settings: settings({ defaultTargetPath: '/media/incoming' }) }),
		);

		expect(answer).toBe(PlacedBy.FALLBACK_PATH);
	});

	it('does not mistake a sibling directory for the fallback folder', () => {
		// `/media/incoming2` is not inside `/media/incoming`, though every string
		// comparison says it is.
		const answer = placedByFor(
			target({ libraryId: '', path: '/media/incoming2/Show/S01E01.mkv' }),
			request({ settings: settings({ defaultTargetPath: '/media/incoming' }) }),
		);

		expect(answer).toBe(PlacedBy.ANY_WRITABLE);
	});

	it('ignores a relative fallback folder, as placement itself does', () => {
		// A relative path would resolve against the gateway's working directory, which
		// is inside the container, so it is never a candidate — and must not be able to
		// claim a destination here either.
		const answer = placedByFor(
			target({ libraryId: '', path: '/media/shows/Show/S01E01.mkv' }),
			request({ settings: settings({ defaultTargetPath: 'incoming' }) }),
		);

		expect(answer).toBe(PlacedBy.ANY_WRITABLE);
	});

	it('falls to whatever was writable when nothing was configured at all', () => {
		const answer = placedByFor(target({ libraryId: 'lib-films' }), request());

		expect(answer).toBe(PlacedBy.ANY_WRITABLE);
	});

	describe('which steps mean nobody chose', () => {
		it.each([PlacedBy.DEFAULT_LIBRARY, PlacedBy.FALLBACK_PATH, PlacedBy.ANY_WRITABLE])(
			'%s is one the interface offers to correct',
			(step) => {
				expect(UNCONFIGURED_PLACEMENTS).toContain(step);
			},
		);

		/**
		 * The two steps that are answers rather than guesses.
		 *
		 * A run that named its destination and a series filed beside its own episodes
		 * are both where they belong; listing them would bury the ones that are not.
		 */
		it.each([PlacedBy.REQUESTED, PlacedBy.EXISTING_COPY, PlacedBy.CATEGORY, PlacedBy.FIXED_PATH])(
			'%s is not',
			(step) => {
				expect(UNCONFIGURED_PLACEMENTS).not.toContain(step);
			},
		);
	});
});
