import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorKey } from '@mcs/shared';
import { ForbiddenException, NotFoundException, type HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MediaConfig } from '@/config';
import type { LibraryRepository, MediaServiceRepository } from '@/repositories';
import type { FilesystemService } from '@/services';
import { FilesystemManager } from './filesystem.manager';

/**
 * The directory browser's decisions, against a real temporary tree.
 *
 * The path resolution is not faked, on purpose: containment is decided on the path as
 * the disk resolves it — `..` collapsed, symlinks followed — and a fake resolver would
 * prove the manager against a filesystem that does not behave like one. Everything the
 * manager is *given* is faked instead: the configuration, the repositories holding the
 * configured roots, and the listing service, so a failure names the rule and not the
 * `readdir` underneath it.
 */

interface Fakes {
	services: { find: jest.Mock };
	libraries: { find: jest.Mock };
	filesystem: { list: jest.Mock; rights: jest.Mock };
}

interface Setup {
	/** `MCS_BROWSE_ROOTS`, exactly as the environment would spell it. */
	browseRoots?: string;
	media?: Partial<MediaConfig>;
}

let base: string;

const build = (setup: Setup = {}): { manager: FilesystemManager; fakes: Fakes } => {
	const fakes: Fakes = {
		services: { find: jest.fn().mockResolvedValue([]) },
		libraries: { find: jest.fn().mockResolvedValue([]) },
		filesystem: {
			list: jest.fn().mockResolvedValue({ entries: [], truncated: false, limit: 500 }),
			rights: jest.fn().mockResolvedValue({ readable: true, writable: true }),
		},
	};
	const media: MediaConfig = {
		root: join(base, 'media'),
		transferRoot: join(base, 'transfer'),
		...setup.media,
	};
	const config = {
		getOrThrow: () => media,
		get: (key: string) => (key === 'MCS_BROWSE_ROOTS' ? setup.browseRoots : undefined),
	};

	const manager = new FilesystemManager(
		config as unknown as ConfigService,
		fakes.filesystem as unknown as FilesystemService,
		fakes.services as unknown as MediaServiceRepository,
		fakes.libraries as unknown as LibraryRepository,
	);

	return { manager, fakes };
};

/** The refusal a browse ended on, so its class and its key are both asserted. */
const refusal = async (attempt: Promise<unknown>): Promise<HttpException> => {
	try {
		await attempt;
	} catch (error) {
		return error as HttpException;
	}

	throw new Error('The browse was expected to be refused and was answered instead.');
};

beforeAll(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-browse-manager-')));

	await mkdir(join(base, 'media', 'Shows'), { recursive: true });
	await mkdir(join(base, 'transfer'));
	await mkdir(join(base, 'elsewhere'));
	await mkdir(join(base, 'service-root'));
	await mkdir(join(base, 'library-root'));
	await writeFile(join(base, 'media', 'note.txt'), 'x');
	// A link to itself: realpath answers ELOOP, which is the filesystem refusing to
	// resolve a path for a reason other than absence — the same branch a mount without
	// traversal rights takes, but deterministic under root, where permission bits are
	// ignored and a chmod-based case would silently prove nothing.
	await symlink(join(base, 'media', 'loop'), join(base, 'media', 'loop'));
});

afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

describe('FilesystemManager — unrestricted, the default', () => {
	it('reaches a directory nowhere near the media, with / as the only root', async () => {
		const { manager } = build();

		const listing = await manager.browse({ path: join(base, 'elsewhere') });

		expect(listing.path).toBe(join(base, 'elsewhere'));
		expect(listing.roots).toEqual(['/']);
		// A way up, which is the whole difference from the restricted mode: somebody
		// who opened in the wrong place can walk to the right one.
		expect(listing.parent).toBe(base);
	});

	it('offers no way above the filesystem root', async () => {
		const { manager } = build();

		const listing = await manager.browse({ path: '/' });

		expect(listing.path).toBe('/');
		expect(listing.parent).toBeNull();
	});

	it('opens on the media root when nothing is asked for, and can still walk above it', async () => {
		const { manager } = build();

		const listing = await manager.browse();

		// The starting point is not the boundary: opening on the media is a convenience,
		// and the parent above it stays reachable.
		expect(listing.path).toBe(join(base, 'media'));
		expect(listing.parent).toBe(base);
	});

	it('treats a path of blanks as nothing asked for', async () => {
		const { manager } = build();

		const listing = await manager.browse({ path: '   ' });

		expect(listing.path).toBe(join(base, 'media'));
	});

	it('opens on the transfer directory when the media root is not there', async () => {
		const { manager } = build({ media: { root: join(base, 'not-mounted-yet') } });

		const listing = await manager.browse({});

		// Answering the empty request with a 404 would leave the picker unable to open
		// at all on a host that keeps its media somewhere other than /media.
		expect(listing.path).toBe(join(base, 'transfer'));
	});

	it('opens on the filesystem root when no starting point is there or configured', async () => {
		const { manager } = build({
			media: { root: join(base, 'not-mounted-yet'), transferRoot: '' },
		});

		const listing = await manager.browse({});

		expect(listing.path).toBe('/');
	});

	it('answers 404 for a directory that is not there, without listing anything', async () => {
		const { manager, fakes } = build();

		const error = await refusal(manager.browse({ path: join(base, 'media', 'Movies') }));

		expect(error).toBeInstanceOf(NotFoundException);
		expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_NOT_FOUND);
		expect(fakes.filesystem.list).not.toHaveBeenCalled();
	});

	it('answers 403 unreadable when the filesystem refuses to resolve the path', async () => {
		const { manager, fakes } = build();

		const error = await refusal(manager.browse({ path: join(base, 'media', 'loop', 'x') }));

		expect(error).toBeInstanceOf(ForbiddenException);
		expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_UNREADABLE);
		expect(fakes.filesystem.list).not.toHaveBeenCalled();
	});
});

describe('FilesystemManager — restricted by MCS_BROWSE_ROOTS', () => {
	it('keeps only the configured roots, ignoring blanks between the commas', async () => {
		const { manager } = build({ browseRoots: ` ${join(base, 'media')} ,, ` });

		const listing = await manager.browse({ path: join(base, 'media', 'Shows') });

		expect(listing.roots).toEqual([join(base, 'media')]);
		expect(listing.parent).toBe(join(base, 'media'));
	});

	it('offers no way up out of a root', async () => {
		const { manager } = build({ browseRoots: join(base, 'media') });

		const listing = await manager.browse({ path: join(base, 'media') });

		expect(listing.parent).toBeNull();
	});

	it('refuses a path outside the roots with 403, never 404, even when it does not exist', async () => {
		const { manager, fakes } = build({ browseRoots: join(base, 'media') });

		const existing = await refusal(manager.browse({ path: join(base, 'elsewhere') }));
		const absent = await refusal(manager.browse({ path: join(base, 'nothing-here') }));

		// Both the same answer: a 404 for the absent one would tell the caller which
		// paths outside the roots exist, one guess at a time.
		for (const error of [existing, absent]) {
			expect(error).toBeInstanceOf(ForbiddenException);
			expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT);
		}

		expect(fakes.filesystem.list).not.toHaveBeenCalled();
	});

	it('refuses an escape spelled with .., judged after resolving it', async () => {
		const { manager } = build({ browseRoots: join(base, 'media') });

		const error = await refusal(
			manager.browse({ path: `${join(base, 'media')}/../elsewhere` }),
		);

		expect(error).toBeInstanceOf(ForbiddenException);
		expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT);
	});

	it('opens on the first root when the media root lies outside the restriction', async () => {
		const { manager } = build({
			browseRoots: join(base, 'transfer'),
			media: { root: join(base, 'elsewhere'), transferRoot: '' },
		});

		const listing = await manager.browse();

		// The media root exists, but opening on it would be a 403 for a request that
		// asked for nothing — a picker that cannot open.
		expect(listing.path).toBe(join(base, 'transfer'));
	});

	it('lets the configured roots of services and libraries be browsed', async () => {
		const { manager, fakes } = build({ browseRoots: join(base, 'media') });

		fakes.services.find.mockResolvedValue([
			{ rootMappings: [{ remoteRoot: '/media', localRoot: join(base, 'service-root') }] },
			{ rootMappings: [] },
			{ rootMappings: [{ remoteRoot: '/data', localRoot: '' }] },
		]);
		fakes.libraries.find.mockResolvedValue([
			{ localPath: join(base, 'library-root') },
			// Twice, as it is when a library sits at its service's root: one root, not two.
			{ localPath: join(base, 'service-root') },
			{ localPath: null },
		]);

		const service = await manager.browse({ path: join(base, 'service-root') });
		const library = await manager.browse({ path: join(base, 'library-root') });

		expect(service.path).toBe(join(base, 'service-root'));
		expect(library.path).toBe(join(base, 'library-root'));
		// The directory the gateway writes into is a root of its own, not a crack in
		// the boundary: its parent is still out of reach.
		expect(library.parent).toBeNull();
		expect(library.roots).toEqual([
			join(base, 'media'),
			join(base, 'service-root'),
			join(base, 'library-root'),
		]);
	});

	it('reads the configured roots per request, so a root added a minute ago is reachable', async () => {
		const { manager, fakes } = build({ browseRoots: join(base, 'media') });

		await expect(manager.browse({ path: join(base, 'library-root') })).rejects.toBeInstanceOf(
			ForbiddenException,
		);

		fakes.libraries.find.mockResolvedValue([{ localPath: join(base, 'library-root') }]);

		const listing = await manager.browse({ path: join(base, 'library-root') });

		expect(listing.path).toBe(join(base, 'library-root'));
	});
});

describe('FilesystemManager — what the listing itself answers', () => {
	it('returns the scan and the rights of the directory it resolved', async () => {
		const { manager, fakes } = build();

		fakes.filesystem.list.mockResolvedValue({
			entries: [{ name: 'Shows', path: join(base, 'media', 'Shows') }],
			truncated: true,
			limit: 1,
		});
		fakes.filesystem.rights.mockResolvedValue({ readable: true, writable: false });

		const listing = await manager.browse({ path: join(base, 'media') });

		expect(listing).toMatchObject({
			path: join(base, 'media'),
			readable: true,
			writable: false,
			entries: [{ name: 'Shows' }],
			truncated: true,
			limit: 1,
		});
	});

	it.each(['ENOENT', 'ENOTDIR'])(
		'answers 404 when the listing fails with %s — a file name typed is a typo',
		async (code) => {
			const { manager, fakes } = build();

			fakes.filesystem.list.mockRejectedValue(Object.assign(new Error(code), { code }));

			const error = await refusal(manager.browse({ path: join(base, 'media') }));

			expect(error).toBeInstanceOf(NotFoundException);
			expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_NOT_FOUND);
		},
	);

	it('answers 403 unreadable when the listing fails for any other reason', async () => {
		const { manager, fakes } = build();

		fakes.filesystem.list.mockRejectedValue(
			Object.assign(new Error('EACCES'), { code: 'EACCES' }),
		);

		const error = await refusal(manager.browse({ path: join(base, 'media') }));

		expect(error).toBeInstanceOf(ForbiddenException);
		expect(error.message).toBe(ErrorKey.FILESYSTEM_PATH_UNREADABLE);
	});
});
