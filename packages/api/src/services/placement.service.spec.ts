import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	PlacedBy,
	PlacementStrategy,
	type Settings,
} from '@mcs/shared';
import { DEFAULT_SETTINGS } from './settings.service';
import { PlacementService, type PlacementLibrary } from './placement.service';

describe('PlacementService', () => {
	const service = new PlacementService();
	let root: string;
	let shows: string;
	let movies: string;
	let anime: string;
	let incoming: string;
	let readOnly: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcs-placement-'));
		shows = join(root, 'shows');
		movies = join(root, 'movies');
		anime = join(root, 'anime');
		incoming = join(root, 'incoming');
		readOnly = join(root, 'locked');

		await mkdir(shows, { recursive: true });
		await mkdir(movies, { recursive: true });
		await mkdir(anime, { recursive: true });
		await mkdir(incoming, { recursive: true });
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

	/**
	 * Where the plan's preference sits in the rule, which is the whole design of it.
	 *
	 * It decides where something *new* goes and never where a show we already hold
	 * goes. The two tests below are the two halves of that sentence, and they are the
	 * reason a preference is not simply tried first: a plan pointed at the anime shelf
	 * would otherwise file the fourth season of a show into it while the first three
	 * stayed on the shows shelf, and neither media server shows that as one series.
	 * Landing somewhere unexpected is recoverable in one move; a split show is a thing
	 * nobody notices until they go looking for an episode.
	 */
	describe('a plan that prefers a library', () => {
		it('keeps a series we already hold in its own folder, preference or not', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
				libraries: [
					library(),
					library({ id: 'lib-anime', kind: LibraryKind.SHOWS, localPath: anime }),
				],
				relativeName: 'The Expanse/S01E02.mkv',
				existingPath: join(shows, 'The Expanse', 'S01E01.mkv'),
				preferredLibraryId: 'lib-anime',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.path).toBe(join(shows, 'The Expanse', 'S01E02.mkv'));
			expect(target.placedBy).toBe(PlacedBy.EXISTING_COPY);
		});

		it('takes everything genuinely new, ahead of the category and the default', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings({
					placement: PlacementStrategy.DEFAULT_LIBRARY,
					categoryTargets: { shows: 'lib-shows' },
					defaultTargetLibraryId: 'lib-shows',
				}),
				categoryKey: 'shows',
				libraries: [
					library(),
					library({ id: 'lib-anime', kind: LibraryKind.SHOWS, localPath: anime }),
				],
				relativeName: 'Frieren/S01E01.mkv',
				existingPath: null,
				preferredLibraryId: 'lib-anime',
				preferredBy: PlacedBy.PLAN_PREFERENCE,
			});

			expect(target.libraryId).toBe('lib-anime');
			expect(target.placedBy).toBe(PlacedBy.PLAN_PREFERENCE);
		});

		it('is passed over rather than obeyed when it names a library nothing can use', async () => {
			// A preference only ever appends a candidate, so a disk that has been
			// unplugged since somebody chose it hands the question to the next rule
			// instead of failing a download that has already finished.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings({
					placement: PlacementStrategy.DEFAULT_LIBRARY,
					defaultTargetLibraryId: 'lib-shows',
				}),
				libraries: [
					library(),
					library({ id: 'lib-locked', localPath: readOnly, writable: false }),
				],
				relativeName: 'Frieren/S01E01.mkv',
				preferredLibraryId: 'lib-locked',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.placedBy).toBe(PlacedBy.DEFAULT_LIBRARY);
		});
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

	/**
	 * The case that destroyed files, and the only one worth being pedantic about.
	 *
	 * Two versions of one episode render the same name, so the second transfer landed on
	 * the first at the end of a completed download — no error, no log line, no way to
	 * tell afterwards. Every test here is about a file that must still be readable when
	 * the placement is done.
	 */
	describe('an occupied path', () => {
		const occupied = async (directory: string, name: string): Promise<string> => {
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, name), 'the copy somebody already has');

			return join(directory, name);
		};

		it('never lands on a file it is not replacing', async () => {
			const existing = await occupied(join(shows, 'Occupied'), 'S01E02.mkv');

			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Occupied/S01E02.mkv',
				disambiguate: (name, attempt) => name.replace('.mkv', ` - ${attempt + 1}.mkv`),
			});

			expect(target.path).toBe(join(shows, 'Occupied', 'S01E02 - 2.mkv'));
			await expect(readFile(existing, 'utf8')).resolves.toBe(
				'the copy somebody already has',
			);
		});

		it('says in the reason what it had to do, so a transfer can be explained', async () => {
			await occupied(join(shows, 'Explained'), 'S01E02.mkv');

			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Explained/S01E02.mkv',
				disambiguate: (name, attempt) => name.replace('.mkv', ` - ${attempt + 1}.mkv`),
			});

			expect(target.reason).toContain('S01E02.mkv is taken');
		});

		it('replaces our own copy, because that is what an upgrade is', async () => {
			// The one legitimate overwrite: a better encode of the copy we hold, which
			// is what the whole sync exists to do. Refusing here would leave two files
			// and double the library on every quality upgrade.
			const existing = await occupied(join(shows, 'Upgraded'), 'S01E02.mkv');

			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Upgraded/S01E02.mkv',
				replacesPath: existing,
				disambiguate: (name, attempt) => name.replace('.mkv', ` - ${attempt + 1}.mkv`),
			});

			expect(target.path).toBe(existing);
			expect(target.reason).toBeNull();
		});

		it('treats a path an earlier item of the same run claimed as taken', async () => {
			// Nothing is written while a plan is built, so the filesystem answers "free"
			// for both versions and the second would overwrite the first hours later.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Planned/S01E02.mkv',
				reserved: [join(shows, 'Planned', 'S01E02.mkv')],
				disambiguate: (name, attempt) => name.replace('.mkv', ` - ${attempt + 1}.mkv`),
			});

			expect(target.path).toBe(join(shows, 'Planned', 'S01E02 - 2.mkv'));
		});

		it('keeps trying until it finds a free name', async () => {
			await occupied(join(shows, 'Crowded'), 'S01E02.mkv');
			await occupied(join(shows, 'Crowded'), 'S01E02 - 2.mkv');

			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Crowded/S01E02.mkv',
				disambiguate: (name, attempt) => name.replace('.mkv', ` - ${attempt + 1}.mkv`),
			});

			expect(target.path).toBe(join(shows, 'Crowded', 'S01E02 - 3.mkv'));
		});

		it('refuses rather than overwrite when no other name can be built', async () => {
			// A caller with no naming callback has nothing to offer, and a transfer that
			// fails with a key somebody can act on beats a file nobody can get back.
			await occupied(join(shows, 'Stuck'), 'S01E02.mkv');

			await expect(
				service.resolve({
					kind: MediaKind.EPISODE,
					settings: settings(),
					libraries: [library()],
					relativeName: 'Stuck/S01E02.mkv',
				}),
			).rejects.toMatchObject({
				response: { key: ErrorKey.TRANSFER_TARGET_OCCUPIED },
			});
		});
	});

	/**
	 * Where a pull lands, decided per category rather than once for the whole gateway.
	 *
	 * Three rules in one order, and the order is the whole feature: a series we already
	 * hold keeps its own folder, anything else goes where its category was told to go,
	 * and a category nobody answered for still lands somewhere a person named. Each
	 * test below pins one step of that chain and one way it is allowed to be overruled,
	 * because the failure this replaces was invisible — a first pull of an unknown
	 * series landed in whichever library happened to carry the default-target flag, and
	 * no setting anywhere said so.
	 */
	describe('the library a category is configured to receive', () => {
		const animeLibrary = (overrides: Partial<PlacementLibrary> = {}): PlacementLibrary =>
			library({
				id: 'lib-anime',
				name: 'Animés',
				localPath: anime,
				isDefaultTarget: false,
				...overrides,
			});

		it('sends a series we do not hold to the library its category names', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
				libraries: [library(), animeLibrary()],
				relativeName: 'Frieren/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-anime');
			expect(target.path).toBe(join(anime, 'Frieren', 'S01E01.mkv'));
		});

		it('leaves a series we already hold where its own episodes are', async () => {
			// The rule that outranks everything configured: the category says `Animés`,
			// and filing there anyway would split the season across two folders, which
			// neither media server shows as one series.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
				libraries: [library(), animeLibrary()],
				relativeName: 'Frieren/S01E02.mkv',
				existingPath: join(shows, 'Frieren', 'S01E01.mkv'),
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.path).toBe(join(shows, 'Frieren', 'S01E02.mkv'));
		});

		it('leaves it there whatever the global strategy says, which is the defect', async () => {
			// This used to be gated behind the strategy being `beside_existing`, so a
			// gateway set to anything else filed a new episode of a show it already had
			// into a second copy of that show somewhere else — quietly, and for ever.
			for (const placement of [
				PlacementStrategy.DEFAULT_LIBRARY,
				PlacementStrategy.FIXED_PATH,
			]) {
				const target = await service.resolve({
					kind: MediaKind.EPISODE,
					categoryKey: 'animes',
					settings: settings({
						placement,
						fixedPath: movies,
						defaultTargetLibraryId: 'lib-anime',
					}),
					libraries: [library({ isDefaultTarget: false }), animeLibrary({ isDefaultTarget: true })],
					relativeName: 'Frieren/S01E03.mkv',
					existingPath: join(shows, 'Frieren', 'S01E01.mkv'),
				});

				expect(target.path).toBe(join(shows, 'Frieren', 'S01E03.mkv'));
				expect(target.strategy).toBe(PlacementStrategy.BESIDE_EXISTING);
			}
		});

		it('ignores an entry for a category this item is not in', async () => {
			// A key whose category has vanished — a service offline, a library renamed —
			// is simply never reached. Cleaning it up would lose a deliberate choice to a
			// temporary outage.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ categoryTargets: { 'a-category-that-went-away': 'lib-anime' } }),
				libraries: [library(), animeLibrary()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toBeNull();
		});

		it('ignores the table entirely for an item that belongs to no category', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: null,
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
				libraries: [library(), animeLibrary()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
		});

		it('skips a configured library that no longer exists, and says which', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-unplugged' } }),
				libraries: [library()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toContain('lib-unplugged');
			expect(target.fallback).toBe(true);
		});

		it('skips a configured library that is read-only, naming it', async () => {
			// The pull has already been chosen, queued and downloaded by the time this
			// runs. Refusing here would turn an unplugged disk into a lost transfer;
			// going somewhere else silently would leave nobody able to explain it.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
				libraries: [library(), animeLibrary({ writable: false })],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toContain('Animés');
			expect(target.reason).toContain('not writable');
		});

		it('skips a configured library the gateway has no path for, naming it', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-anime' } }),
				libraries: [library(), animeLibrary({ localPath: null })],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toContain('Animés');
			expect(target.reason).toContain('no local path');
		});

		it('skips a configured library that is there but cannot be written into', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({ categoryTargets: { animes: 'lib-locked' } }),
				libraries: [
					library(),
					library({ id: 'lib-locked', name: 'Locked', localPath: readOnly, isDefaultTarget: false }),
				],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toContain('Locked');
		});
	});

	/**
	 * The global answer, for everything no category names.
	 *
	 * Most people will set only this one and never open the category table, so the
	 * order around it matters more than the table does: a category entry outranks it,
	 * and it outranks the fallback folder.
	 */
	describe('the default target library', () => {
		it('receives an item whose category names nothing', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ defaultTargetLibraryId: 'lib-movies' }),
				libraries: [
					library(),
					library({ id: 'lib-movies', name: 'Films', kind: LibraryKind.MOVIES, localPath: movies }),
				],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-movies');
		});

		it('gives way to the entry the category carries', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({
					categoryTargets: { animes: 'lib-anime' },
					defaultTargetLibraryId: 'lib-movies',
				}),
				libraries: [
					library(),
					library({ id: 'lib-anime', name: 'Animés', localPath: anime, isDefaultTarget: false }),
					library({ id: 'lib-movies', name: 'Films', kind: LibraryKind.MOVIES, localPath: movies }),
				],
				relativeName: 'Frieren/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-anime');
		});

		it('is skipped like any other configured library, with the reason kept', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ defaultTargetLibraryId: 'lib-unplugged' }),
				libraries: [library()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
			expect(target.reason).toContain('default target library');
		});

		it('is tried before the fallback folder', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ defaultTargetLibraryId: 'lib-movies', defaultTargetPath: incoming }),
				libraries: [
					library(),
					library({ id: 'lib-movies', name: 'Films', kind: LibraryKind.MOVIES, localPath: movies }),
				],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.path).toBe(join(movies, 'Show', 'S01E01.mkv'));
		});
	});

	/**
	 * The last nameable answer, before the gateway starts choosing for itself.
	 *
	 * A category with no entry on a gateway with no default library still has to land
	 * somewhere a person typed, rather than fail at the end of a completed download.
	 */
	describe('the fallback folder', () => {
		it('takes what no library was named for, ahead of the preference order', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ defaultTargetPath: incoming }),
				libraries: [library()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.path).toBe(join(incoming, 'Show', 'S01E01.mkv'));
		});

		it('gives way to the library the category names', async () => {
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'animes',
				settings: settings({
					categoryTargets: { animes: 'lib-anime' },
					defaultTargetPath: incoming,
				}),
				libraries: [
					library(),
					library({ id: 'lib-anime', name: 'Animés', localPath: anime, isDefaultTarget: false }),
				],
				relativeName: 'Frieren/S01E01.mkv',
			});

			expect(target.path).toBe(join(anime, 'Frieren', 'S01E01.mkv'));
		});

		it('is ignored when it is not an absolute path', async () => {
			// Relative resolves against whatever directory the process was started in,
			// which in a container is inside the container.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				categoryKey: 'shows',
				settings: settings({ defaultTargetPath: 'incoming' }),
				libraries: [library()],
				relativeName: 'Show/S01E01.mkv',
			});

			expect(target.libraryId).toBe('lib-shows');
		});
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
