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
import { PlacementService, type PlacementLibrary, type PlacementPin } from './placement.service';

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

	it('writes into the root a destination names, not the library’s first', async () => {
		/*
		 * A library is not one folder. The owner's `Series TV` is five directories on
		 * five disks and his `Films` is two, and naming the library named only the first
		 * — every pull landed there and nothing on any screen said why.
		 *
		 * A root the service declared is a directory that server scans, so choosing one
		 * keeps the guarantee that made this a library rather than a path in the first
		 * place.
		 */
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ categoryTargets: { films: movies } }),
			categoryKey: 'films',
			libraries: [
				library({
					id: 'lib-movies',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					localPath: shows,
					localRoots: [shows, movies],
				}),
			],
			relativeName: 'Casper (1995)/Casper (1995).mkv',
		});

		expect(target.libraryId).toBe('lib-movies');
		expect(target.path.startsWith(movies)).toBe(true);
		// The answer a later file of the same download has to be handed: `lib-movies`
		// designates two directories, so the identifier alone cannot say which one its
		// siblings went into.
		expect(target.root).toBe(movies);
	});

	it('skips a path no library declares rather than writing into it', async () => {
		// The difference between a setting that stopped applying and a gateway quietly
		// filling a folder nothing indexes.
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			settings: settings({ categoryTargets: { films: '/somewhere/nobody/declared' } }),
			categoryKey: 'films',
			libraries: [
				library({
					id: 'lib-movies',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					localPath: movies,
					localRoots: [movies],
				}),
			],
			relativeName: 'Casper (1995)/Casper (1995).mkv',
		});

		expect(target.path.startsWith(movies)).toBe(true);
	});

	it('lands a media on the shelf it came from, with nothing configured', async () => {
		/*
		 * The owner pulled *Casper* from his `Films` shelf and found it under
		 * `Animes/Films`. Both are movie libraries, so banding by kind alone put them on
		 * exactly the same footing and the chain fell through to its last rule — the one
		 * that means "anything that could take it".
		 *
		 * A category is the shelf people think in, and a media pulled from one belongs on
		 * the same one. Nothing here is configured: this is the default doing the obvious
		 * thing rather than a setting being read.
		 */
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			categoryKey: 'films',
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [
				library({
					id: 'lib-animes',
					name: 'Animes - Films',
					kind: LibraryKind.MOVIES,
					localPath: shows,
					categoryKey: 'animes-films',
				}),
				library({
					id: 'lib-movies',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					localPath: movies,
					categoryKey: 'films',
				}),
			],
			relativeName: 'Casper (1995)/Casper (1995).mkv',
		});

		expect(target.libraryId).toBe('lib-movies');
	});

	it('takes a shelf of the right kind over the media’s own of the wrong one', async () => {
		// A preference and never a requirement: the bands still decide first, or a
		// documentary filed under a music shelf would drag every pull onto it.
		const target = await service.resolve({
			kind: MediaKind.MOVIE,
			categoryKey: 'musique',
			settings: settings({ placement: PlacementStrategy.DEFAULT_LIBRARY }),
			libraries: [
				library({
					id: 'lib-music',
					name: 'Musique',
					kind: LibraryKind.MUSIC,
					localPath: shows,
					categoryKey: 'musique',
				}),
				library({
					id: 'lib-movies',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					localPath: movies,
					categoryKey: 'films',
				}),
			],
			relativeName: 'Casper (1995)/Casper (1995).mkv',
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
	/**
	 * Where a library whose server declared no content type is tried.
	 *
	 * The case is the owner's whole gateway: every one of his seven Jellyfin libraries
	 * reports no collection type, so every one of them used to read as "something
	 * else" and sit behind the music library as somewhere to put a film — behind the
	 * one kind of library a film certainly cannot go in.
	 */
	describe('a library that may hold either', () => {
		it('is tried after the right kind and before a kind that is wrong', async () => {
			const target = await service.resolve({
				kind: MediaKind.MOVIE,
				settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
				libraries: [
					library({ id: 'lib-music', kind: LibraryKind.MUSIC, localPath: shows, isDefaultTarget: true }),
					library({ id: 'lib-mixed', kind: LibraryKind.MIXED, localPath: anime, isDefaultTarget: false }),
					library({ id: 'lib-movies', kind: LibraryKind.MOVIES, localPath: movies, isDefaultTarget: false }),
				],
				relativeName: 'Arrival.mkv',
			});

			expect(target.libraryId).toBe('lib-movies');
		});

		it('beats a library of a kind this is not, even one marked as the default', async () => {
			// The regression, stated as a rule: a mixed library is the only shelf a film
			// can actually go on here, and a music library marked as the default target
			// is still not a home for a film.
			const target = await service.resolve({
				kind: MediaKind.MOVIE,
				settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
				libraries: [
					library({ id: 'lib-music', kind: LibraryKind.MUSIC, localPath: shows, isDefaultTarget: true }),
					library({ id: 'lib-mixed', kind: LibraryKind.MIXED, localPath: anime, isDefaultTarget: false }),
				],
				relativeName: 'Arrival.mkv',
			});

			expect(target.libraryId).toBe('lib-mixed');
		});

		it('takes the one somebody marked as the default among several', async () => {
			const target = await service.resolve({
				kind: MediaKind.MOVIE,
				settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
				libraries: [
					library({ id: 'lib-mixed-a', kind: LibraryKind.MIXED, localPath: shows, isDefaultTarget: false }),
					library({ id: 'lib-mixed-b', kind: LibraryKind.MIXED, localPath: anime, isDefaultTarget: true }),
				],
				relativeName: 'Arrival.mkv',
			});

			expect(target.libraryId).toBe('lib-mixed-b');
		});
	});

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

	/**
	 * A download is a lot, and every file of it lands in one place.
	 *
	 * A film, a series, a season or an episode: somebody pressed one button, and the
	 * chain answering per file let it answer differently halfway down a season — a disk
	 * that filled, a sibling found for one episode and not the next. The season then sat
	 * in two libraries, which no media server shows as one series.
	 */
	describe('a lot already sent somewhere', () => {
		const pin = (overrides: Partial<PlacementPin> = {}): PlacementPin => ({
			root: anime,
			libraryId: 'lib-anime',
			libraryName: 'Animes',
			strategy: PlacementStrategy.DEFAULT_LIBRARY,
			fallback: false,
			placedBy: PlacedBy.DEFAULT_LIBRARY,
			...overrides,
		});

		it('goes where the lot went, even when a better candidate exists', async () => {
			// `existingPath` is the top of the chain and would win outright. The pin is not
			// a preference sitting above it: it replaces the chain, or the second episode
			// of a season would quietly take the step below it the first time this root
			// was busy.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
				libraries: [
					library(),
					library({ id: 'lib-anime', name: 'Animes', localPath: anime }),
				],
				relativeName: 'Sonic X (2003)/Season 01/S01E02.mkv',
				existingPath: join(shows, 'Sonic X (2003)', 'S01E01.mkv'),
				pinned: pin(),
			});

			expect(target.root).toBe(anime);
			expect(target.libraryId).toBe('lib-anime');
			expect(target.path).toBe(join(anime, 'Sonic X (2003)', 'Season 01', 'S01E02.mkv'));
		});

		it('keeps the hierarchy under the root it was given', async () => {
			// The pin fixes the root and nothing below it. The folders are still rendered
			// per item, against that root, so a series already on the disk keeps the layout
			// it has and a new one gets the template.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library({ id: 'lib-anime', name: 'Animes', localPath: anime })],
				relativeName: (libraryRoot) =>
					libraryRoot === anime ? 'Sonic X (2003)/Season 02/S02E04.mkv' : 'wrong/S02E04.mkv',
				pinned: pin(),
			});

			expect(target.path).toBe(join(anime, 'Sonic X (2003)', 'Season 02', 'S02E04.mkv'));
		});

		it('fails the lot rather than scattering its tail somewhere else', async () => {
			/*
			 * The whole point of a pin over a preference. A writable library is sitting
			 * right there and is deliberately not used: half a season in the library
			 * somebody chose and half in one they did not is worse than a refusal, because
			 * a refusal can be acted on and a split is discovered months later.
			 */
			await expect(
				service.resolve({
					kind: MediaKind.EPISODE,
					settings: settings(),
					libraries: [
						library(),
						library({ id: 'lib-locked', name: 'Locked', localPath: readOnly }),
					],
					relativeName: 'Show/S01E01.mkv',
					pinned: pin({ root: readOnly, libraryId: 'lib-locked', libraryName: 'Locked' }),
				}),
			).rejects.toMatchObject({ response: { key: ErrorKey.LIBRARY_PATH_NOT_WRITABLE } });
		});

		it('reports the decision the lot made, not one derived again for this file', async () => {
			/*
			 * Every file of a lot is where it is for the reason the first one was. Deriving
			 * the reason again per file would report the tail of a download as a different
			 * kind of decision from its head — an episode landing "wherever could take it"
			 * inside a series somebody deliberately filed, which is the one distinction the
			 * queue screen is built on.
			 */
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings({ placement: PlacementStrategy.BESIDE_EXISTING }),
				libraries: [library({ id: 'lib-anime', name: 'Animes', localPath: anime })],
				relativeName: 'Sonic X (2003)/Season 02/S02E05.mkv',
				pinned: pin({ fallback: true, placedBy: PlacedBy.EXISTING_COPY }),
			});

			expect(target.placedBy).toBe(PlacedBy.EXISTING_COPY);
			expect(target.fallback).toBe(true);
			expect(target.strategy).toBe(PlacementStrategy.DEFAULT_LIBRARY);
		});

		it('writes into a root no registered library claims, when that is where the lot went', async () => {
			// A lot that started in the fallback folder or in a fixed path finishes there.
			// The pin names a root, and a root outside every library is still a directory
			// the first file of this download is already sitting in.
			const target = await service.resolve({
				kind: MediaKind.EPISODE,
				settings: settings(),
				libraries: [library()],
				relativeName: 'Show/S01E02.mkv',
				pinned: pin({ root: incoming, libraryId: '', libraryName: incoming }),
			});

			expect(target.path).toBe(join(incoming, 'Show', 'S01E02.mkv'));
			expect(target.libraryId).toBe('');
		});
	});
});
