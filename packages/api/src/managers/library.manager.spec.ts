import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorKey, LibraryKind } from '@mcs/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Library } from '@/entities';
import type { LibraryRepository } from '@/repositories';
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
}

const build = (row: Library = library()): { manager: LibraryManager; fakes: Fakes } => {
	const fakes: Fakes = {
		libraries: {
			find: jest.fn().mockResolvedValue([row]),
			findOne: jest.fn().mockResolvedValue(row),
			findByService: jest.fn().mockResolvedValue([row]),
			save: jest.fn((value: Library) => Promise.resolve(value)),
			clearDefaultTarget: jest.fn().mockResolvedValue(undefined),
		},
	};

	return {
		manager: new LibraryManager(fakes.libraries as unknown as LibraryRepository),
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
});
