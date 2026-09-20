import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorKey, LibraryKind } from '@mcs/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Library, MediaService } from '@/entities';
import type { LibraryRepository, MediaServiceRepository } from '@/repositories';
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
	services: { find: jest.Mock; findOne: jest.Mock; update: jest.Mock };
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
				remoteRoot: null,
				localRoot: null,
				filesMounted: false,
			}),
			update: jest.fn().mockResolvedValue(undefined),
		},
	};

	return {
		manager: new LibraryManager(
			fakes.libraries as unknown as LibraryRepository,
			// Categories are the only thing that asks about services, and the tests that
			// care declare their own.
			fakes.services as unknown as MediaServiceRepository,
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
	});

	describe('deriving a path from the service mapping', () => {
		const mapped = (localRoot: string): MediaService =>
			({ id: 'service-1', remoteRoot: '/media', localRoot }) as MediaService;

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

		it('derives nothing for a service nobody gave roots', async () => {
			const { manager, fakes } = build(library({ paths: ['/media'] }));

			await manager.applyRootMapping({ id: 'service-1', remoteRoot: null, localRoot: null } as MediaService);

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

			fakes.services.findOne.mockResolvedValue({ remoteRoot: '/media', localRoot: writable });

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
				remoteRoot: '/media',
				localRoot: writable,
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
				remoteRoot: null,
				localRoot: null,
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
				remoteRoot: null,
				localRoot: null,
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
				remoteRoot: null,
				localRoot: null,
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
				remoteRoot: null,
				localRoot: null,
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

		it('leaves a library on somebody else’s server alone', async () => {
			// The alias is local, but folding a friend's shelf into one of ours claims
			// their media as filed in our library — and counts their items in a category
			// whose destination they can never be.
			const { manager, fakes } = build([
				library({ id: 'theirs', serviceId: 'friend', name: 'Séries', itemCount: 7 }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows', itemCount: 24 }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'friend', filesMounted: false, peerId: null },
			]);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
			await expect(manager.categories()).resolves.toHaveLength(2);
		});

		it('leaves a library reached through a peer alone, whatever its scope says', async () => {
			// A peer's service can carry any scope at all; it is still somebody else's
			// machine, which is why `serviceMode` puts the peer test first.
			const { manager, fakes } = build([
				library({ id: 'theirs', serviceId: 'lab', name: 'Séries' }),
				library({ id: 'shows', serviceId: 'plex', name: 'Shows' }),
			]);

			fakes.services.find.mockResolvedValue([
				...ours,
				{ id: 'lab', filesMounted: true, peerId: 'peer-1' },
			]);

			await expect(manager.mergeCategoryInto('series', 'shows')).resolves.toBeNull();
			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('renames ours and skips theirs when the category holds both', async () => {
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

			expect(fakes.libraries.save.mock.calls.map(([one]: [Library]) => one.id)).toEqual(['mine']);
		});

		it('does nothing when the destination is on somebody else’s server', async () => {
			// The mirror image: aliasing our libraries to their shelf's name would fold
			// ours into theirs, which is the same claim made backwards.
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
