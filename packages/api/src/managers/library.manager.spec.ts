import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorKey, LibraryKind, MediaServiceScope } from '@mcs/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Library } from '@/entities';
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
		findByService: jest.Mock;
		save: jest.Mock;
		clearDefaultTarget: jest.Mock;
	};
	services: { find: jest.Mock };
}

const build = (
	row: Library | Library[] = library(),
): { manager: LibraryManager; fakes: Fakes } => {
	const rows = Array.isArray(row) ? row : [row];
	const fakes: Fakes = {
		libraries: {
			find: jest.fn().mockResolvedValue(rows),
			findOne: jest.fn().mockResolvedValue(rows[0]),
			findByService: jest.fn().mockResolvedValue(rows),
			save: jest.fn((value: Library) => Promise.resolve(value)),
			clearDefaultTarget: jest.fn().mockResolvedValue(undefined),
		},
		services: { find: jest.fn().mockResolvedValue([{ id: 'jellyfin', scope: MediaServiceScope.LOCAL }]) },
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

			fakes.services.find.mockResolvedValue([{ id: 'remote', scope: MediaServiceScope.REMOTE }]);

			const [category] = await manager.categories();

			expect(category.local).toBe(false);
		});
	});

});
