import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	categoryKeyOf,
	ErrorKey,
	LibraryHintKind,
	LibraryKind,
	LibraryLayoutSignal,
	MediaKind,
	MediaServiceType,
	PathMatch,
	type RootMapping,
} from '@mcs/shared';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { CategoryKeyword, Library, MediaService } from '@/entities';
import type {
	CategoryKeywordRepository,
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
} from '@/repositories';
import type { PathMatchService, SettingsService } from '@/services';
import { LibraryManager } from './library.manager';

const library = (overrides: Partial<Library> = {}): Library =>
	({
		id: 'library-1',
		serviceId: 'service-1',
		externalId: 'lib-1',
		name: 'Shows',
		kind: LibraryKind.SHOWS,
		paths: ['/media/shows'],
		localPath: null,
		localPathDerived: false,
		writable: false,
		isDefaultTarget: false,
		scanCursor: null,
		lastScanAt: null,
		lastRefreshAt: null,
		itemCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Library;

interface Fakes {
	libraries: {
		find: jest.Mock;
		findOne: jest.Mock;
		findByIds: jest.Mock;
		findByService: jest.Mock;
		save: jest.Mock;
		clearDefaultTarget: jest.Mock;
	};
	services: {
		find: jest.Mock;
		findOne: jest.Mock;
		findWithSecrets: jest.Mock;
		update: jest.Mock;
	};
	pathMatch: { verify: jest.Mock };
	items: { findSeasonNames: jest.Mock; findByIds: jest.Mock };
	settings: { getValue: jest.Mock };
	keywords: {
		rows: CategoryKeyword[];
		findAllOrdered: jest.Mock;
		findByNormalized: jest.Mock;
		findOne: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
	};
}

const build = (
	row: Library | Library[] = library(),
): { manager: LibraryManager; fakes: Fakes } => {
	const rows = Array.isArray(row) ? row : [row];
	const fakes: Fakes = {
		libraries: {
			find: jest.fn().mockResolvedValue(rows),
			findOne: jest.fn().mockResolvedValue(rows[0]),
			findByIds: jest.fn((ids: string[]) =>
				Promise.resolve(rows.filter((one) => ids.includes(one.id))),
			),
			findByService: jest.fn().mockResolvedValue(rows),
			save: jest.fn((value: Library) => Promise.resolve(value)),
			clearDefaultTarget: jest.fn().mockResolvedValue(undefined),
		},
		services: {
			// Keyed by the identifier the library rows carry: `check` now only probes
			// libraries on our own services, so a service the library does not belong to
			// would make every row vanish rather than fail an assertion.
			find: jest.fn().mockResolvedValue([
				{ id: 'service-1', filesMounted: true, peerId: null },
			]),
			// No mapping by default, so every test that does not talk about roots sees
			// exactly the behaviour there was before there were any.
			findOne: jest.fn().mockResolvedValue({
				id: 'service-1',
				name: 'Living room',
				rootMappings: [],
				filesMounted: false,
			}),
			// The one read that brings the credentials back, which `check` needs before
			// it can have the service asked whether it sees what we wrote.
			findWithSecrets: jest.fn().mockResolvedValue({
				id: 'service-1',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
				token: 'a-token',
				username: null,
				password: null,
			}),
			update: jest.fn().mockResolvedValue(undefined),
		},
		// Nobody is asked by default: the tests about the filesystem probe must not
		// depend on what a media server would have answered.
		pathMatch: { verify: jest.fn().mockResolvedValue(PathMatch.UNKNOWN) },
		// An index with nothing in it by default: the hint tests declare the rows they
		// are about, and every other test must not grow a season list it never mentions.
		items: {
			findSeasonNames: jest.fn().mockResolvedValue([]),
			findByIds: jest.fn().mockResolvedValue([]),
		},
		settings: { getValue: jest.fn().mockResolvedValue([]) },
		// A tiny in-memory table rather than a mock per call: the manager reads the rows
		// back after writing them — a keyword is always answered through `keywords()` —
		// so a `save` that returned a value nobody stored would test nothing.
		keywords: {
			rows: [],
			findAllOrdered: jest.fn(() => Promise.resolve([...fakes.keywords.rows])),
			findByNormalized: jest.fn((normalized: string) =>
				Promise.resolve(
					fakes.keywords.rows.find((one) => one.normalized === normalized) ?? null,
				),
			),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(
					fakes.keywords.rows.find((one) => one.id === options.where.id) ?? null,
				),
			),
			create: jest.fn((value: Partial<CategoryKeyword>) => ({ ...value }) as CategoryKeyword),
			save: jest.fn((value: CategoryKeyword) => {
				const row = { ...value, id: value.id ?? `keyword-${fakes.keywords.rows.length + 1}` };
				const index = fakes.keywords.rows.findIndex((one) => one.id === row.id);

				if (index === -1) {
					fakes.keywords.rows.push(row);
				} else {
					fakes.keywords.rows[index] = row;
				}

				return Promise.resolve(row);
			}),
			delete: jest.fn((criteria: { id: string }) => {
				fakes.keywords.rows = fakes.keywords.rows.filter((one) => one.id !== criteria.id);

				return Promise.resolve({ affected: 1 });
			}),
		},
	};

	return {
		manager: new LibraryManager(
			fakes.libraries as unknown as LibraryRepository,
			// Categories are the only thing that asks about services, and the tests that
			// care declare their own.
			fakes.services as unknown as MediaServiceRepository,
			fakes.keywords as unknown as CategoryKeywordRepository,
			fakes.pathMatch as unknown as PathMatchService,
			fakes.items as unknown as MediaItemRepository,
			fakes.settings as unknown as SettingsService,
		),
		fakes,
	};
};

describe('LibraryManager', () => {
	let writable: string;
	let unwritable: string;

	beforeAll(async () => {
		writable = await mkdtemp(join(tmpdir(), 'mcs-writable-'));
		unwritable = await mkdtemp(join(tmpdir(), 'mcs-readonly-'));

		await chmod(unwritable, 0o500);
	});

	afterAll(async () => {
		await chmod(unwritable, 0o700);
		await rm(writable, { recursive: true, force: true });
		await rm(unwritable, { recursive: true, force: true });
	});

	describe('setting a local path', () => {
		it('accepts a directory the gateway can really write into', async () => {
			const { manager } = build();

			const saved = await manager.update('library-1', { localPath: writable });

			expect(saved.localPath).toBe(writable);
			expect(saved.writable).toBe(true);
		});

		it('refuses a path that does not exist, rather than recording it as broken', async () => {
			const { manager, fakes } = build();

			await expect(
				manager.update('library-1', { localPath: '/nowhere/at/all' }),
			).rejects.toThrow(ErrorKey.LIBRARY_PATH_UNREADABLE);

			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('refuses a directory it can read but not write', async () => {
			const { manager } = build();

			// Running the suite as root defeats the permission bits entirely, and the
			// rule is about the probe rather than about the filesystem.
			if (process.getuid?.() === 0) {
				return;
			}

			await expect(manager.update('library-1', { localPath: unwritable })).rejects.toThrow(
				ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
			);
		});

		it('refuses a relative path, which means a different directory in every process', async () => {
			const { manager } = build();

			await expect(manager.update('library-1', { localPath: 'var/media' })).rejects.toThrow(
				BadRequestException,
			);
		});

		it('clears the path, which makes the library read-only to us again', async () => {
			const { manager } = build(library({ localPath: writable, writable: true }));

			const saved = await manager.update('library-1', { localPath: null });

			expect(saved.localPath).toBeNull();
			expect(saved.writable).toBe(false);
		});
	});

	describe('default targets', () => {
		it('refuses a default the gateway cannot write to', async () => {
			const { manager } = build();

			await expect(manager.update('library-1', { isDefaultTarget: true })).rejects.toThrow(
				ConflictException,
			);
		});

		it('clears the flag on every other library of the kind', async () => {
			const { manager, fakes } = build(library({ localPath: writable, writable: true }));

			await manager.update('library-1', { isDefaultTarget: true });

			expect(fakes.libraries.clearDefaultTarget).toHaveBeenCalledWith(
				LibraryKind.SHOWS,
				'library-1',
			);
		});
	});

	describe('check', () => {
		it('reports read and write separately, because they fail for different reasons', async () => {
			const { manager } = build(library({ localPath: writable }));

			const [check] = await manager.check();

			expect(check).toMatchObject({
				libraryId: 'library-1',
				name: 'Shows',
				exists: true,
				readable: true,
				writable: true,
				error: null,
			});
			expect(check.freeBytes).toBeGreaterThan(0);
		});

		it('says where the path came from, because the two are fixed in different places', async () => {
			const { manager } = build([
				library({ id: 'a', localPath: writable }),
				library({ id: 'b', localPath: writable, localPathDerived: true }),
			]);

			const checks = await manager.check();

			expect(checks.map((check) => check.derived)).toEqual([false, true]);
		});

		it('says a library with no local path is unreadable rather than pretending it is fine', async () => {
			const { manager } = build();

			const [check] = await manager.check();

			expect(check).toMatchObject({
				exists: false,
				writable: false,
				error: ErrorKey.LIBRARY_PATH_UNREADABLE,
			});
		});

		it('names the failure nothing else reports: the two paths are not one directory', async () => {
			// A writable path with no other complaint is exactly the case where the
			// failure is invisible — every transfer succeeds, and the media server's
			// library stays empty because it is reading somewhere else entirely.
			const { manager, fakes } = build(
				library({ localPath: writable, paths: ['/data/media/shows'] }),
			);

			fakes.pathMatch.verify.mockResolvedValue(PathMatch.MISMATCHED);

			const [check] = await manager.check();

			expect(check).toMatchObject({
				writable: true,
				match: PathMatch.MISMATCHED,
				serverPaths: ['/data/media/shows'],
				error: ErrorKey.LIBRARY_PATH_MISMATCH,
			});
			// The server's own path and the local one, both of them, because a screen
			// showing one without the other cannot say which was got wrong.
			expect(fakes.pathMatch.verify).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'service-1', token: 'a-token' }),
				writable,
				['/data/media/shows'],
			);
		});

		it('says nothing at all when the server confirms it reads the same directory', async () => {
			const { manager, fakes } = build(
				library({ localPath: writable, paths: ['/data/media/shows'] }),
			);

			fakes.pathMatch.verify.mockResolvedValue(PathMatch.MATCHED);

			const [check] = await manager.check();

			expect(check).toMatchObject({ match: PathMatch.MATCHED, error: null });
		});

		it('leaves a server that cannot say as unknown rather than as a mismatch', async () => {
			// A Plex whose build has no browse route is not a misconfigured library, and
			// a warning that is wrong more often than right stops being read.
			const { manager, fakes } = build(
				library({ localPath: writable, paths: ['/data/media/shows'] }),
			);

			fakes.pathMatch.verify.mockResolvedValue(PathMatch.UNKNOWN);

			const [check] = await manager.check();

			expect(check).toMatchObject({ match: PathMatch.UNKNOWN, error: null });
		});

		it('asks nobody about a path it already knows cannot be written', async () => {
			// Nothing can be written, so nothing can be looked for — and a second
			// warning about the same directory sends somebody hunting a second problem.
			const { manager, fakes } = build(library({ localPath: unwritable, paths: ['/data'] }));

			const [check] = await manager.check();

			expect(check.match).toBe(PathMatch.UNKNOWN);
			expect(check.error).toBe(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
			expect(fakes.pathMatch.verify).not.toHaveBeenCalled();
		});
	});

	describe('deriving a path from the service mapping', () => {
		const mapped = (localRoot: string): MediaService =>
			({ id: 'service-1', rootMappings: [{ remoteRoot: '/media', localRoot }] }) as MediaService;

		it('gives a library with no path of its own the one the mapping implies', async () => {
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			await manager.applyRootMapping(mapped(writable));

			const [saved] = fakes.libraries.save.mock.calls[0] as [Library];
			expect(saved.localPath).toBe(writable);
			expect(saved.localPathDerived).toBe(true);
			// Probed like any other path: a mapping that is one character off must not
			// leave a library looking configured and writable.
			expect(saved.writable).toBe(true);
		});

		it('never touches a path somebody typed for this library', async () => {
			// The whole contract of `localPath`: it is for the exceptions the mapping
			// cannot express, and overwriting one would undo the fix at the next scan.
			const { manager, fakes } = build(
				library({ paths: ['/media'], localPath: '/elsewhere', writable: true }),
			);

			await manager.applyRootMapping(mapped(writable));

			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('moves a path it derived before when the mapping changes', async () => {
			const { manager, fakes } = build(
				library({ paths: ['/media'], localPath: '/old/media', localPathDerived: true }),
			);

			await manager.applyRootMapping(mapped(writable));

			const [saved] = fakes.libraries.save.mock.calls[0] as [Library];
			expect(saved.localPath).toBe(writable);
		});

		it('takes the path back when the mapping stops answering for the library', async () => {
			// A library the service moved outside the mapped root: keeping the old
			// directory would go on accepting transfers into a place nothing reads.
			const { manager, fakes } = build(
				library({ paths: ['/srv/other'], localPath: writable, localPathDerived: true, writable: true }),
			);

			await manager.applyRootMapping(mapped(writable));

			const [saved] = fakes.libraries.save.mock.calls[0] as [Library];
			expect(saved.localPath).toBeNull();
			expect(saved.localPathDerived).toBe(false);
			expect(saved.writable).toBe(false);
		});

		it('gives each library the path of the disk it is on', async () => {
			// Films on one disk, shows on another, nothing in common but `/`: the setup a
			// single pair could not describe, which is why a service carries a list.
			const films = join(writable, 'nas1-movies');
			const shows = join(writable, 'nas2-shows');
			const { manager, fakes } = build([
				library({ id: 'films', paths: ['/data/movies'] }),
				library({ id: 'shows', paths: ['/srv/shows'] }),
				library({ id: 'music', paths: ['/opt/music'] }),
			]);

			await manager.applyRootMapping({
				id: 'service-1',
				rootMappings: [
					{ remoteRoot: '/data/movies', localRoot: films },
					{ remoteRoot: '/srv/shows', localRoot: shows },
				],
			} as MediaService);

			const saved = fakes.libraries.save.mock.calls.map(([row]) => row as Library);
			expect(saved.map((row) => [row.id, row.localPath])).toEqual([
				['films', films],
				['shows', shows],
			]);
			// Under no mapping: left without a path rather than sent to the closer disk.
			expect(saved.find((row) => row.id === 'music')).toBeUndefined();
		});

		it('derives nothing for a service nobody gave roots', async () => {
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			await manager.applyRootMapping({ id: 'service-1', rootMappings: [] as RootMapping[] } as MediaService);

			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('stores a derived path it cannot write to, so the check can name it', async () => {
			// Refusing here would fail a scan because a NAS went to sleep, and would
			// hide the one thing somebody debugging needs: the directory we looked at.
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			await manager.applyRootMapping(mapped('/nowhere/at/all'));

			const [saved] = fakes.libraries.save.mock.calls[0] as [Library];
			expect(saved.localPath).toBe('/nowhere/at/all');
			expect(saved.writable).toBe(false);
		});

		it('marks a path somebody types as no longer derived', async () => {
			const { manager } = build(library({ localPath: '/old', localPathDerived: true }));

			const saved = await manager.update('library-1', { localPath: writable });

			expect(saved.localPath).toBe(writable);
		});

		it('falls back to the mapping when somebody empties the box', async () => {
			// Emptying it withdraws the override rather than removing the library from
			// every sync — which is what leaving it with no path at all would do.
			const { manager, fakes } = build(library({ paths: ['/media'], localPath: '/elsewhere', writable: true }));

			fakes.services.findOne.mockResolvedValue({ rootMappings: [{ remoteRoot: '/media', localRoot: writable }] });

			const saved = await manager.update('library-1', { localPath: null });

			expect(saved.localPath).toBe(writable);
			expect(saved.writable).toBe(true);
		});
	});

	/**
	 * Whether the gateway holds a service's files, which decides `serviceMode`.
	 *
	 * Derived and stored rather than asked, because asking produced the wrong answer
	 * every time: the question read as a statement about the network, and the
	 * consequences — no destination, no placement, libraries private — surfaced three
	 * screens later with nothing linking them to the word somebody had picked.
	 */
	describe('re-deriving whether the files are ours', () => {
		it('turns a service ours the moment a root mapping lands', async () => {
			// The registration that started all this: a Jellyfin on the same network,
			// registered before anybody mapped its folders. It has to flip here rather
			// than at the next restart, and nothing may be holding the old answer.
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			fakes.services.findOne.mockResolvedValue({
				id: 'service-1',
				name: 'JellyProd',
				rootMappings: [{ remoteRoot: '/media', localRoot: writable }],
				filesMounted: false,
			});

			await expect(manager.refreshMount('service-1')).resolves.toBe(true);
			expect(fakes.services.update).toHaveBeenCalledWith(
				{ id: 'service-1' },
				{ filesMounted: true },
			);
		});

		it('takes it back when the last mapping is withdrawn', async () => {
			const { manager, fakes } = build(library({ localPath: null }));

			fakes.services.findOne.mockResolvedValue({
				id: 'service-1',
				name: 'JellyProd',
				rootMappings: [],
				filesMounted: true,
			});

			await expect(manager.refreshMount('service-1')).resolves.toBe(false);
			expect(fakes.services.update).toHaveBeenCalledWith(
				{ id: 'service-1' },
				{ filesMounted: false },
			);
		});

		it('counts a library path of its own as a mapping', async () => {
			// The exception the root mapping cannot express is still a mapping: a service
			// holding only those is not a service we reach over HTTP alone.
			const { manager, fakes } = build(library({ localPath: '/mnt/one-off' }));

			fakes.services.findOne.mockResolvedValue({
				id: 'service-1',
				name: 'Odd one',
				rootMappings: [],
				filesMounted: false,
			});

			await expect(manager.refreshMount('service-1')).resolves.toBe(true);
		});

		it('writes nothing when the answer has not moved', async () => {
			// Every scan re-derives every path. Saving each time would touch `updatedAt`
			// on every service on every scan, for an answer nobody changed.
			const { manager, fakes } = build(library({ localPath: '/mnt/one-off' }));

			fakes.services.findOne.mockResolvedValue({
				id: 'service-1',
				name: 'Odd one',
				rootMappings: [],
				filesMounted: true,
			});

			await manager.refreshMount('service-1');

			expect(fakes.services.update).not.toHaveBeenCalled();
		});

		it('re-derives it after a library path is set, not only after a root moves', async () => {
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			fakes.services.findOne.mockResolvedValue({
				id: 'service-1',
				name: 'Odd one',
				rootMappings: [],
				filesMounted: false,
			});

			await manager.update('library-1', { localPath: writable });

			expect(fakes.services.update).toHaveBeenCalledWith(
				{ id: 'service-1' },
				{ filesMounted: true },
			);
		});
	});

	it('answers a key for a library nobody registered', async () => {
		const { manager, fakes } = build();

		fakes.libraries.findOne.mockResolvedValue(null);

		await expect(manager.read('ghost')).rejects.toThrow(ErrorKey.LIBRARY_NOT_FOUND);
	});

	/**
	 * The two things about this gateway's setup that nothing else reports.
	 *
	 * Both are read at a glance and both cost an evening when nobody says them: every
	 * row reading missing because no server has its folders declared, and a folder of
	 * shows the media server took for one show.
	 */
	describe('hints', () => {
		/**
		 * One row as the projection answers it.
		 *
		 * `seasonNumber` and `childCount` are not decoration: a season the server
		 * numbered is a season whatever it is called, and a season holding nothing is not
		 * drawn — so a row with neither is a row this can say nothing about.
		 */
		const season = (
			id: string,
			parentId: string,
			title: string,
			seasonNumber: number | null = null,
		): { id: string; parentId: string; title: string; seasonNumber: number | null; childCount: number } =>
			({ id, parentId, title, seasonNumber, childCount: 10 });

		const marvelFolder = [
			...Array.from({ length: 20 }, (_, index) =>
				season(`s${index}`, 'series-marvel', `Saison ${index + 1}`, index + 1)),
			season('s20', 'series-marvel', 'Agatha All Along'),
			season('s21', 'series-marvel', 'Agent Carter'),
			season('s22', 'series-marvel', 'Agents of SHIELD'),
			season('s23', 'series-marvel', 'Cloak and Dagger'),
		];

		const marvelSeries = {
			id: 'series-marvel',
			kind: MediaKind.SERIES,
			title: 'Scream',
			libraryId: 'library-1',
			serviceId: 'service-1',
		};

		it('says so when no server has its folders declared', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: false, peerId: null },
			]);

			const hints = await manager.hints();

			expect(hints).toEqual([expect.objectContaining({ kind: LibraryHintKind.NOTHING_MOUNTED })]);
		});

		it('stops saying it the moment one server is mounted', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: false, peerId: null },
				{ id: 'service-2', name: 'Plex', filesMounted: true, peerId: null },
			]);

			expect(await manager.hints()).toEqual([]);
		});

		it('says nothing on a gateway nobody has registered a service on', async () => {
			// New rather than misconfigured, and the setup screen is already saying so.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([]);

			expect(await manager.hints()).toEqual([]);
		});

		it('counts a friend\'s server as registered and never as mounted', async () => {
			// Their disks are not ours, so nothing is held here — which is exactly what
			// this hint says, and exactly what makes every row read missing.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: "Damien's gateway", filesMounted: true, peerId: 'peer-1' },
			]);

			expect(await manager.hints()).toEqual([
				expect.objectContaining({ kind: LibraryHintKind.NOTHING_MOUNTED }),
			]);
		});

		it('names the series whose seasons are named like shows, and quotes them', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: true, peerId: null },
			]);
			fakes.libraries.find.mockResolvedValue([library({ id: 'library-1', name: 'Series TV' })]);
			fakes.items.findSeasonNames.mockResolvedValue(marvelFolder);
			fakes.items.findByIds.mockResolvedValue([marvelSeries]);

			const hints = await manager.hints();

			expect(hints).toEqual([
				{
					key: 'misread-folder:series-marvel',
					kind: LibraryHintKind.MISREAD_FOLDER,
					itemId: 'series-marvel',
					title: 'Scream',
					libraryName: 'Series TV',
					serviceName: 'Jellyfin',
					signals: [LibraryLayoutSignal.NAMED_SEASONS],
					examples: ['Agatha All Along', 'Agent Carter', 'Agents of SHIELD', 'Cloak and Dagger'],
					seasonCount: 24,
				},
			]);
		});

		it('leaves an ordinary show alone', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: true, peerId: null },
			]);
			fakes.items.findSeasonNames.mockResolvedValue([
				season('s1', 'series-expanse', 'Season 1', 1),
				season('s2', 'series-expanse', 'Season 2', 2),
				season('s3', 'series-expanse', 'Specials', 0),
			]);

			expect(await manager.hints()).toEqual([]);
			// Nothing is suspect, so the full rows are never read at all.
			expect(fakes.items.findByIds).not.toHaveBeenCalled();
		});

		it('never shows a hint somebody has dismissed', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: true, peerId: null },
			]);
			fakes.items.findSeasonNames.mockResolvedValue(marvelFolder);
			fakes.items.findByIds.mockResolvedValue([marvelSeries]);
			fakes.settings.getValue.mockResolvedValue(['misread-folder:series-marvel']);

			expect(await manager.hints()).toEqual([]);
		});

		it('drops a suspicion whose series the index no longer holds', async () => {
			// A hint whose subject nobody can open is a hint nobody can act on.
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: true, peerId: null },
			]);
			fakes.items.findSeasonNames.mockResolvedValue(marvelFolder);
			fakes.items.findByIds.mockResolvedValue([]);

			expect(await manager.hints()).toEqual([]);
		});

		it('drops a parent that is not a series at all', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-1', name: 'Jellyfin', filesMounted: true, peerId: null },
			]);
			fakes.items.findSeasonNames.mockResolvedValue(marvelFolder);
			fakes.items.findByIds.mockResolvedValue([{ ...marvelSeries, kind: MediaKind.SEASON }]);

			expect(await manager.hints()).toEqual([]);
		});

		it('answers nothing for a library and a service it cannot name', async () => {
			const { manager, fakes } = build();

			fakes.services.find.mockResolvedValue([
				{ id: 'service-other', name: 'Plex', filesMounted: true, peerId: null },
			]);
			fakes.libraries.find.mockResolvedValue([]);
			fakes.items.findSeasonNames.mockResolvedValue(marvelFolder);
			fakes.items.findByIds.mockResolvedValue([marvelSeries]);

			expect(await manager.hints()).toEqual([
				expect.objectContaining({ libraryName: null, serviceName: null }),
			]);
		});
	});

	describe('categories', () => {
		it('merges libraries of the same name across services', () => {
			// Two servers both call their library Shows, and a friend makes a third. They
			// are one category to whoever is looking at them; three bands called Shows is
			// showing somebody the plumbing rather than their media.
			const { manager } = build([
				library({ id: 'a', serviceId: 'jellyfin', name: 'Shows', itemCount: 10 }),
				library({ id: 'b', serviceId: 'plex', name: 'Shows', itemCount: 4 }),
			]);

			return expect(manager.categories()).resolves.toEqual([
				expect.objectContaining({
					name: 'Shows',
					libraryIds: ['a', 'b'],
					serviceIds: ['jellyfin', 'plex'],
					itemCount: 14,
				}),
			]);
		});

		it('merges across case and accents, because those are not two categories', async () => {
			const { manager } = build([
				library({ id: 'a', name: 'Animes' }),
				library({ id: 'b', serviceId: 'other', name: 'animés' }),
			]);

			const categories = await manager.categories();

			expect(categories).toHaveLength(1);
			expect(categories[0].libraryIds).toEqual(['a', 'b']);
		});

		it('prefers the alias, since that is the name somebody chose', async () => {
			const { manager } = build([library({ id: 'a', name: 'Video2', alias: 'Documentaires' })]);

			const [category] = await manager.categories();

			expect(category.name).toBe('Documentaires');
			expect(category.key).toBe('documentaires');
		});

		it('lets the lowest position decide the order and the merged name', async () => {
			// Whichever library somebody put first is the one they meant this category to
			// be — and the same rule answers which category wins when a media is filed in
			// two of them.
			const { manager } = build([
				library({ id: 'a', name: 'Shows', position: 200 }),
				library({ id: 'b', serviceId: 'other', name: 'shows', position: 10 }),
				library({ id: 'c', serviceId: 'third', name: 'Films', position: 50 }),
			]);

			const categories = await manager.categories();

			expect(categories.map((category) => category.name)).toEqual(['shows', 'Films']);
			expect(categories[0].position).toBe(10);
		});

		it('keeps an aliased library out of the category it was renamed away from', async () => {
			// Renaming is how somebody separates: aliasing one of two libraries called
			// Shows to Séries says these are not the same category, and merging them
			// anyway would make the alias do nothing.
			const { manager } = build([
				library({ id: 'a', name: 'Shows' }),
				library({ id: 'b', serviceId: 'other', name: 'Shows', alias: 'Séries' }),
			]);

			const categories = await manager.categories();

			expect(categories.map((category) => category.name).sort()).toEqual(['Shows', 'Séries']);
		});

		it('says whether anything in the category is ours to write into', async () => {
			const { manager, fakes } = build([library({ id: 'a', serviceId: 'remote' })]);

			fakes.services.find.mockResolvedValue([{ id: 'remote', filesMounted: false }]);

			const [category] = await manager.categories();

			expect(category.local).toBe(false);
		});
	});

	describe('folding a name', () => {
		/*
		 * One function answers both "which category is this" and "does this keyword
		 * match". They have to agree: a keyword stored under one folding and looked up
		 * under another matches nothing, reports nothing, and looks exactly like a
		 * keyword that was never saved.
		 */
		it.each([
			['Series TV', 'series-tv'],
			['Séries TV', 'series-tv'],
			['series-tv', 'series-tv'],
			['  SERIES   tv  ', 'series-tv'],
			['Émissions TV', 'emissions-tv'],
			['Animés', 'animes'],
			['Films d’animation', 'films-d-animation'],
		])('folds %s to %s', (name, expected) => {
			expect(categoryKeyOf(name)).toBe(expected);
		});

		it('keeps names that are merely similar apart', () => {
			// Where the folding deliberately stops. No stemming, no distance, no score:
			// a near-match that fires wrongly buries media under a name nobody chose and
			// nothing on screen says why, whereas a keyword that does not fire is visible
			// the moment somebody looks at the pool.
			expect(categoryKeyOf('Animes - Films')).not.toBe(categoryKeyOf('Films'));
			expect(categoryKeyOf('Series')).not.toBe(categoryKeyOf('Series TV'));
		});
	});

	describe('the keywords plugged into a category', () => {
		/*
		 * What this replaces: eleven categories, every one of them a peer's shelf
		 * stranded on its own, folded together by typing the same alias once per
		 * library and again for every friend who ever appears. A keyword says it once.
		 *
		 * Nothing is written on a library when a keyword catches it. That is what makes
		 * the undo exact — deleting the row puts the shelf back under its own name in
		 * the same request — and it is why every assertion here reads `categories()`
		 * rather than looking at what was saved.
		 */
		const ours = [
			{ id: 'plex', filesMounted: true, peerId: null },
			{ id: 'friend', filesMounted: false, peerId: null },
			{ id: 'lab', filesMounted: true, peerId: 'peer-1' },
		];

		const withShows = (extra: Library[] = []): ReturnType<typeof build> => {
			const built = build([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', itemCount: 24 }),
				...extra,
			]);

			built.fakes.services.find.mockResolvedValue(ours);

			return built;
		};

		it('lets a folded shelf move the band without renaming it', async () => {
			// Two questions that were answered with one value, and only one of the two
			// answers was right. A folded shelf must never name the category — a friend's
			// `TV` read first would rebaptise our `Shows` — but it must still count for
			// the order, or moving it on the libraries screen does nothing at all and
			// nothing on screen says why.
			const { manager, fakes } = build([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', position: 100 }),
				library({ id: 'theirs', serviceId: 'friend', name: 'Series TV', position: 0 }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await manager.addKeyword('shows', 'Series TV');

			const categories = await manager.categories();

			expect(categories).toHaveLength(1);
			expect(categories[0].position).toBe(0);
			expect(categories[0].name).toBe('Shows');
		});

		it('still refuses to let a folded shelf name the category from the front', async () => {
			// The other half of the same rule, and the reason the anchor exists: position
			// zero buys the order, never the name.
			const { manager, fakes } = build([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', position: 100 }),
				library({ id: 'theirs', serviceId: 'friend', name: 'TV', position: 0 }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await manager.addKeyword('shows', 'TV');

			const categories = await manager.categories();
			const shows = categories.find((category) => category.libraryIds.includes('theirs'));

			expect(shows?.name).toBe('Shows');
			expect(shows?.position).toBe(0);
		});

		it('folds a shelf whose name differs only by case, accents or punctuation', async () => {
			// `Series TV`, `Séries TV` and `series-tv` are the same shelf to a person,
			// and a mapping that only caught one spelling would leave the other two in
			// the pool looking like a mapping that did not save.
			const { manager } = withShows([
				library({ id: 'a', serviceId: 'friend', name: 'Séries TV', itemCount: 3 }),
				library({ id: 'b', serviceId: 'lab', name: 'series-tv', itemCount: 2 }),
				library({ id: 'c', serviceId: 'friend', name: 'SERIES   TV', itemCount: 1 }),
			]);

			await manager.addKeyword('shows', 'Series TV');

			const categories = await manager.categories();

			expect(categories).toHaveLength(1);
			expect(categories[0].name).toBe('Shows');
			expect(categories[0].libraryIds.sort()).toEqual(['a', 'b', 'c', 'shows']);
			expect(categories[0].itemCount).toBe(30);
		});

		it('leaves a shelf that merely looks similar exactly where it was', async () => {
			// The line the folding stops at. `Animes - Films` is not `Films`, and a
			// near-match that fires wrongly buries somebody's media under a name they
			// never chose with nothing on screen saying why.
			const { manager } = withShows([
				library({ id: 'a', serviceId: 'friend', name: 'Animes - Films' }),
			]);

			await manager.addKeyword('shows', 'Films');

			const names = (await manager.categories()).map((category) => category.name).sort();

			expect(names).toEqual(['Animes - Films', 'Shows']);
		});

		it('reaches a peer’s library, which is the whole reason it exists', async () => {
			// A friend's gateway brings twenty shelves. The alias is local, renames
			// nothing on their server, and says only what this household calls the
			// thing — where a new file lands is the mount's answer, decided elsewhere.
			const { manager } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'TV', itemCount: 6 }),
			]);

			await manager.addKeyword('shows', 'TV');

			const [category] = await manager.categories();

			expect(category.libraryIds.sort()).toEqual(['shows', 'theirs']);
			// Still ours to write into, because one of the merged libraries is.
			expect(category.local).toBe(true);
		});

		it('reaches a library on a service whose files this gateway does not hold', async () => {
			const { manager } = withShows([
				library({ id: 'attic', serviceId: 'friend', name: 'Émissions TV' }),
			]);

			await manager.addKeyword('shows', 'Emissions TV');

			expect((await manager.categories())[0].libraryIds.sort()).toEqual(['attic', 'shows']);
		});

		it('never lets a folded shelf rename the category it joined', async () => {
			// A friend's `TV` sits at the same position as our `Shows`, so without the
			// anchor deciding the name the category would be called whichever of the two
			// the database handed back first — an answer that changes between two
			// identical requests.
			const { manager } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'TV', kind: LibraryKind.OTHER }),
			]);

			await manager.addKeyword('shows', 'TV');

			const [category] = await manager.categories();

			expect(category.name).toBe('Shows');
			expect(category.key).toBe('shows');
			expect(category.kind).toBe(LibraryKind.SHOWS);
		});

		it('lets an alias somebody typed win over a keyword', async () => {
			// The rename is the repair for a mapping that filed something wrongly, so a
			// keyword able to override it would make that repair last one request.
			const { manager } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'TV', alias: 'Direct' }),
			]);

			await manager.addKeyword('shows', 'TV');

			expect((await manager.categories()).map((one) => one.name).sort())
				.toEqual(['Direct', 'Shows']);
		});

		it('catches a library that arrives after the keyword was written', async () => {
			// The point of the whole feature: nobody touches anything when a new peer
			// turns up with a shelf the household already has a name for.
			const { manager, fakes } = withShows();

			await manager.addKeyword('shows', 'Séries');

			fakes.libraries.find.mockResolvedValue([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
				library({ id: 'new', serviceId: 'lab', name: 'SERIES' }),
			]);

			expect((await manager.categories())[0].libraryIds.sort()).toEqual(['new', 'shows']);
		});

		it('answers which category a keyword files into, and what it is catching', async () => {
			const { manager } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'Séries' }),
			]);

			const added = await manager.addKeyword('shows', 'Séries');

			expect(added).toMatchObject({
				categoryKey: 'shows',
				categoryName: 'Shows',
				keyword: 'Séries',
				normalized: 'series',
				libraryIds: ['theirs'],
			});
		});

		it('keeps a keyword through the rename that changes its category’s key', async () => {
			// The reason a keyword hangs off a library and not off `MediaCategory.key`.
			// The key is derived from the name, so renaming `Shows` to `Séries` would
			// orphan a list stored under `shows` — silently, and precisely when somebody
			// was tidying up.
			const { manager, fakes } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'TV' }),
			]);

			await manager.addKeyword('shows', 'TV');

			fakes.libraries.find.mockResolvedValue([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', alias: 'Séries' }),
				library({ id: 'theirs', serviceId: 'lab', name: 'TV' }),
			]);

			const [keyword] = await manager.keywords();

			expect(keyword.categoryKey).toBe('series');
			expect((await manager.categories())[0].libraryIds.sort()).toEqual(['shows', 'theirs']);
		});

		it('moves a keyword from one category to another', async () => {
			const { manager } = withShows([
				library({ id: 'films', serviceId: 'plex', name: 'Films' }),
				library({ id: 'theirs', serviceId: 'lab', name: 'Cinéma' }),
			]);

			const added = await manager.addKeyword('shows', 'Cinema');

			expect((await manager.categories()).find((one) => one.key === 'shows')?.libraryIds)
				.toContain('theirs');

			await manager.moveKeyword(added.id, 'films');

			const categories = await manager.categories();

			expect(categories.find((one) => one.key === 'shows')?.libraryIds).toEqual(['shows']);
			expect(categories.find((one) => one.key === 'films')?.libraryIds.sort())
				.toEqual(['films', 'theirs']);
		});

		it('puts a shelf back under its own name when the keyword is removed', async () => {
			// The undo. Nothing was written when the keyword was added, so there is no
			// previous alias to guess at and nothing to type back by hand.
			const { manager } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'TV' }),
			]);

			const added = await manager.addKeyword('shows', 'TV');

			await manager.removeKeyword(added.id);

			expect((await manager.categories()).map((one) => one.name).sort()).toEqual(['Shows', 'TV']);
			await expect(manager.keywords()).resolves.toEqual([]);
		});

		it('refuses a keyword another category already holds', async () => {
			const { manager } = withShows([library({ id: 'films', serviceId: 'plex', name: 'Films' })]);

			await manager.addKeyword('shows', 'TV');

			await expect(manager.addKeyword('films', 'tv')).rejects.toThrow(ConflictException);
		});

		it('answers the keyword it already has rather than failing on a second drop', async () => {
			const { manager } = withShows();

			const first = await manager.addKeyword('shows', 'TV');

			await expect(manager.addKeyword('shows', 'tv')).resolves.toMatchObject({ id: first.id });
			await expect(manager.keywords()).resolves.toHaveLength(1);
		});

		it('refuses a keyword that folds to nothing at all', async () => {
			// An empty folded form would match every library whose name is punctuation —
			// none today, and whichever one somebody adds tomorrow.
			const { manager } = withShows();

			await expect(manager.addKeyword('shows', '   ')).rejects.toThrow(BadRequestException);
			await expect(manager.addKeyword('shows', '- —')).rejects.toThrow(BadRequestException);
		});

		it('answers a key for a category no library reads as any more', async () => {
			const { manager } = withShows();

			await expect(manager.addKeyword('nothing-here', 'TV')).rejects.toThrow(NotFoundException);
		});

		it('answers a key for a keyword nobody wrote', async () => {
			const { manager } = withShows();

			await expect(manager.removeKeyword('keyword-9')).rejects.toThrow(NotFoundException);
		});

		it('hangs the keyword off one of our own libraries, not off a friend’s', async () => {
			// A peer's library is reachable while the link is. Anchoring the household's
			// whole mapping on a friend's row would take the list away with the friend.
			const { manager, fakes } = withShows([
				library({ id: 'theirs', serviceId: 'lab', name: 'Shows', position: 1 }),
			]);

			await manager.addKeyword('shows', 'TV');

			expect(fakes.keywords.rows[0].libraryId).toBe('shows');
		});
	});

	describe('following a destination onto the names', () => {
		/*
		 * The bug this whole block is about: mapping `Séries` onto the `Shows` library
		 * decided where new files land and nothing else, so the library screen went on
		 * showing two categories and the fourteen items stayed in the first one. A
		 * destination is also a statement about what the category is, and these are the
		 * cases where acting on that statement would be wrong.
		 */
		const ours = [
			{ id: 'jellyfin', filesMounted: true, peerId: null },
			{ id: 'plex', filesMounted: true, peerId: null },
		];

		it('gives the mapped category the destination’s name, so the two become one', async () => {
			const { manager, fakes } = build([
				library({ id: 'series', serviceId: 'jellyfin', name: 'Séries', itemCount: 14 }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', itemCount: 24 }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBe('Shows');
			expect(fakes.libraries.save).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'series', alias: 'Shows' }),
			);

			// The point of all of it: one category, holding what both held.
			const categories = await manager.categories();

			expect(categories).toHaveLength(1);
			expect(categories[0]).toMatchObject({ name: 'Shows', itemCount: 38 });
		});

		it('renames every library of the category, not only the first', async () => {
			const { manager, fakes } = build([
				library({ id: 'series-a', serviceId: 'jellyfin', name: 'Séries' }),
				library({ id: 'series-b', serviceId: 'plex', name: 'series' }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await manager.mergeCategoryInto('series', 'shows');

			expect(fakes.libraries.save.mock.calls.map(([one]: [Library]) => one.id).sort()).toEqual([
				'series-a',
				'series-b',
			]);
		});

		it('folds a library on somebody else’s server into the category too', async () => {
			// Renaming it on their server is not ours to do, which is the reason the alias
			// is local — and the reason it has to reach their shelf. One category of 31,
			// not two of 7 and 24 holding the same series under two names.
			const { manager, fakes } = build([
				library({ id: 'theirs', serviceId: 'friend', name: 'Séries', itemCount: 7 }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', itemCount: 24 }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'friend', filesMounted: false, peerId: null },
			]);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBe('Shows');
			expect(fakes.libraries.save).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'theirs', alias: 'Shows' }),
			);
			await expect(manager.categories()).resolves.toHaveLength(1);
		});

		it('folds a library reached through a peer into the category as well', async () => {
			// A peer's shelf is the friend's `Video2` the alias was written for. Nothing
			// is claimed by renaming it here: the name is ours, the files stay theirs, and
			// where a new episode lands is the destination's answer, not this one's.
			const { manager, fakes } = build([
				library({ id: 'theirs', serviceId: 'lab', name: 'Séries' }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'lab', filesMounted: true, peerId: 'peer-1' },
			]);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBe('Shows');
			expect(fakes.libraries.save).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'theirs', alias: 'Shows' }),
			);
		});

		it('renames every library of the category, ours and theirs alike', async () => {
			// The case this exists for. A friend's shelf under another name is precisely
			// what an alias joins to ours; refusing it left the same media sitting in two
			// categories with no control anywhere that could bring them together.
			const { manager, fakes } = build([
				library({ id: 'mine', serviceId: 'jellyfin', name: 'Séries' }),
				library({ id: 'theirs', serviceId: 'friend', name: 'séries' }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'friend', filesMounted: false, peerId: null },
			]);

			await manager.mergeCategoryInto('series', 'shows');

			expect(fakes.libraries.save.mock.calls.map(([one]: [Library]) => one.id).sort())
				.toEqual(['mine', 'theirs']);
		});

		it('does nothing when the destination is one the gateway cannot write into', async () => {
			// A category target says where a new pull lands. A library whose files this
			// gateway does not hold can never receive one, so there is no mapping here to
			// act on — and renaming our shelf to its name would say otherwise.
			const { manager, fakes } = build([
				library({ id: 'mine', serviceId: 'jellyfin', name: 'Séries' }),
				library({ id: 'theirs', serviceId: 'friend', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'friend', filesMounted: false, peerId: null },
			]);

			await expect(manager.mergeCategoryInto('series', 'theirs')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('does nothing when the destination is already in that category', async () => {
			// Aliasing a thing to itself rewrites every row of the category to the name it
			// already has, and the first rescan would look like somebody renamed them.
			const { manager, fakes } = build([
				library({ id: 'shows-a', serviceId: 'jellyfin', name: 'Shows' }),
				library({ id: 'shows-b', serviceId: 'plex', name: 'shows' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('shows', 'shows-b')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('does nothing when the destination belongs to no category the gateway knows', async () => {
			// A library that has since gone, whose identifier is still in the table: the
			// name to adopt would be nothing at all, and an empty alias is a category with
			// no name rather than no alias.
			const { manager, fakes } = build([
				library({ id: 'series', serviceId: 'jellyfin', name: 'Séries' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('series', 'gone')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('does nothing when the mapped category holds nothing', async () => {
			const { manager, fakes } = build([
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('animes', 'shows')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('never writes an empty alias, even from a library the service named nothing', async () => {
			const { manager, fakes } = build([
				library({ id: 'series', serviceId: 'jellyfin', name: 'Séries' }),
				library({ id: 'nameless', serviceId: 'plex', name: '  ' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('series', 'nameless')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('leaves the destination’s own hand-typed alias exactly where it is', async () => {
			// The name somebody chose is what the whole category now reads as; rewriting
			// it from the reported name would undo their rename on the way past.
			const { manager, fakes } = build([
				library({ id: 'series', serviceId: 'jellyfin', name: 'Séries' }),
				library({ id: 'shows', serviceId: 'plex', name: 'Video2', alias: 'Documentaires' }),
			]);

			fakes.services.find.mockResolvedValue(ours);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBe('Documentaires');
			expect(fakes.libraries.save).toHaveBeenCalledTimes(1);
			expect(fakes.libraries.save).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'series', alias: 'Documentaires' }),
			);
		});
	});

});
