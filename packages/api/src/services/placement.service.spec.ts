import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryKind, MediaKind, PlacementStrategy, type Settings } from '@mcs/shared';
import { DEFAULT_SETTINGS } from './settings.service';
import { PlacementService, type PlacementLibrary } from './placement.service';

describe('PlacementService', () => {
	const service = new PlacementService();
	let root: string;
	let shows: string;
	let movies: string;
	let readOnly: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcs-placement-'));
		shows = join(root, 'shows');
		movies = join(root, 'movies');
		readOnly = join(root, 'locked');

		await mkdir(shows, { recursive: true });
		await mkdir(movies, { recursive: true });
		await mkdir(readOnly, { recursive: true });
		await chmod(readOnly, 0o500);
	});

	afterAll(async () => {
		await chmod(readOnly, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	});

	function library(overrides: Partial<PlacementLibrary> = {}): PlacementLibrary {
		return {
			id: 'lib-shows',
			name: 'Shows',
			kind: LibraryKind.SHOWS,
			localPath: shows,
			writable: true,
			isDefaultTarget: true,
			...overrides,
		};
	}

	function settings(overrides: Partial<Settings> = {}): Settings {
		return { ...DEFAULT_SETTINGS, ...overrides };
	}

	it('places beside an existing copy when there is one', async () => {
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
			libraries: [library(), library({ id: 'lib-movies', kind: LibraryKind.MOVIES, localPath: movies })],
			relativeName: 'The Expanse/S01E02.mkv',
			existingPath: join(shows, 'The Expanse', 'S01E01.mkv'),
		});

		expect(target.libraryId).toBe('lib-shows');
		expect(target.strategy).toBe(PlacementStrategy.BESIDE_EXISTING);
		expect(target.fallback).toBe(false);
		expect(target.path).toBe(join(shows, 'The Expanse', 'S01E02.mkv'));
	});

	it('falls back to the default library when we hold no local copy', async () => {
		// The common case on a first sync, and not a fault: there is simply nothing to
		// sit beside yet.
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
			libraries: [library()],
			relativeName: 'Show/S01E01.mkv',
			existingPath: null,
		});

		expect(target.strategy).toBe(PlacementStrategy.DEFAULT_LIBRARY);
		expect(target.fallback).toBe(true);
	});

	it('prefers the default target of the right kind', async () => {
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [
				library({ isDefaultTarget: true }),
				library({
					id: 'lib-movies',
					name: 'Movies',
					kind: LibraryKind.MOVIES,
					localPath: movies,
					isDefaultTarget: true,
				}),
			],
			relativeName: 'Blade Runner (1982)/Blade Runner (1982).mkv',
		});

		expect(target.libraryId).toBe('lib-movies');
	});

	it('uses a library of the wrong kind rather than losing the transfer', async () => {
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [library()],
			relativeName: 'Film.mkv',
		});

		expect(target.libraryId).toBe('lib-shows');
	});

	it('honours a fixed path', async () => {
		const fixed = join(root, 'fixed');

		await mkdir(fixed, { recursive: true });

		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ placement: PlacementStrategy.FIXED_PATH, fixedPath: fixed }),
			libraries: [library()],
			relativeName: 'Film.mkv',
		});

		expect(target.path).toBe(join(fixed, 'Film.mkv'));
		expect(target.strategy).toBe(PlacementStrategy.FIXED_PATH);
	});

	it('ignores a relative fixed path instead of resolving it inside the container', async () => {
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ placement: PlacementStrategy.FIXED_PATH, fixedPath: 'media/films' }),
			libraries: [library()],
			relativeName: 'Film.mkv',
		});

		expect(target.strategy).toBe(PlacementStrategy.DEFAULT_LIBRARY);
	});

	it('lets the sync plan override the global strategy', async () => {
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [
				library(),
				library({ id: 'lib-movies', kind: LibraryKind.MOVIES, localPath: movies }),
			],
			relativeName: 'Show/S01E01.mkv',
			preferredLibraryId: 'lib-movies',
		});

		expect(target.libraryId).toBe('lib-movies');
	});

	it('skips a library that is not writable and says why', async () => {
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [
				library({ id: 'lib-locked', name: 'Locked', localPath: readOnly, isDefaultTarget: true }),
				library({ isDefaultTarget: false }),
			],
			relativeName: 'Show/S01E01.mkv',
		});

		expect(target.libraryId).toBe('lib-shows');
		expect(target.reason).toContain('Locked');
	});

	it('refuses rather than guessing when nothing is writable', async () => {
		await expect(
			service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library({ writable: false }), library({ id: 'x', localPath: null })],
				relativeName: 'Show/S01E01.mkv',
			}),
		).rejects.toMatchObject({ response: { key: 'error.library.path_not_writable' } });
	});

	it('refuses when the disk cannot hold the file', async () => {
		await expect(
			service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Show/S01E01.mkv',
				requiredBytes: Number.MAX_SAFE_INTEGER,
			}),
		).rejects.toMatchObject({ response: { key: 'error.transfer.no_space' } });
	});

	it('keeps a hostile name inside the library', async () => {
		// The title comes from a remote service's metadata, which makes `../../etc`
		// somebody else's input reaching our filesystem.
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings(),
			libraries: [library()],
			relativeName: '../../etc/passwd',
		});

		expect(target.path).toBe(join(shows, 'etc', 'passwd'));
	});

	it('does not mistake a sibling directory for the library holding a file', async () => {
		const near = join(root, 'shows2');

		await mkdir(near, { recursive: true });

		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
			libraries: [library()],
			relativeName: 'Show/S01E02.mkv',
			existingPath: join(near, 'Show', 'S01E01.mkv'),
		});

		// `/root/shows2` is not inside `/root/shows`, so the beside-existing strategy
		// cannot apply and the default library takes over.
		expect(target.strategy).toBe(PlacementStrategy.DEFAULT_LIBRARY);
	});

	it('creates the destination directory when asked to prepare', async () => {
		const target = await service.resolve({
			kind: MediaKind.EPISODE,
			settings: settings(),
			libraries: [library()],
			relativeName: 'Fresh Show/Season 01/Episode.mkv',
		});

		await service.prepare(target);

		await expect(
			import('node:fs/promises').then((fs) => fs.stat(target.directory)),
		).resolves.toBeDefined();
	});
});
