import { chmod, mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemService, MAX_DIRECTORY_ENTRIES } from './filesystem.service';

/**
 * The listing, against a real directory tree.
 *
 * Everything this service answers is a fact about a filesystem — which entries are
 * directories, which of them can be written into, which are links out — and a mocked
 * `fs` would only pin the shape of the answers it was told to give. The tree is built
 * in a temporary directory and thrown away with it.
 */
describe('FilesystemService', () => {
	const service = new FilesystemService();

	let root: string;
	let outside: string;

	beforeAll(async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-listing-')));

		root = join(base, 'media');
		outside = join(base, 'elsewhere');

		await mkdir(join(root, 'Shows'), { recursive: true });
		await mkdir(join(root, 'Movies'), { recursive: true });
		await mkdir(join(root, '.hidden'), { recursive: true });
		await mkdir(join(outside, 'secrets'), { recursive: true });
		await writeFile(join(root, 'readme.txt'), 'not a directory');
		await symlink(join(root, 'Shows'), join(root, 'Series'));
		await symlink(outside, join(root, 'Escape'));
	});

	it('lists directories and nothing else', async () => {
		const scan = await service.list(root, { roots: [root] });
		const names = scan.entries.map((entry) => entry.name);

		expect(names).toContain('Shows');
		expect(names).toContain('Movies');
		// A path field asks which folder; a file offered there is an answer every
		// caller of the field would then have to refuse.
		expect(names).not.toContain('readme.txt');
	});

	it('answers in a stable order, so the same directory reads the same twice', async () => {
		const scan = await service.list(root, { roots: [root] });

		expect(scan.entries.map((entry) => entry.name)).toEqual(
			[...scan.entries.map((entry) => entry.name)].sort((left, right) =>
				left.localeCompare(right),
			),
		);
	});

	it('hides dot directories until it is asked for them', async () => {
		const plain = await service.list(root, { roots: [root] });
		const all = await service.list(root, { roots: [root], includeHidden: true });

		expect(plain.entries.map((entry) => entry.name)).not.toContain('.hidden');
		expect(all.entries.map((entry) => entry.name)).toContain('.hidden');
	});

	it('follows a symlink to a directory inside the roots', async () => {
		const scan = await service.list(root, { roots: [root] });

		expect(scan.entries.map((entry) => entry.name)).toContain('Series');
	});

	it('drops a symlink that leaves the roots', async () => {
		// Offering it would show a directory the browse route then refuses to open,
		// which reads as a bug rather than as the boundary it is.
		const scan = await service.list(root, { roots: [root] });

		expect(scan.entries.map((entry) => entry.name)).not.toContain('Escape');
	});

	it('says what it can write into, which is the question being asked', async () => {
		const scan = await service.list(root, { roots: [root] });
		const shows = scan.entries.find((entry) => entry.name === 'Shows');

		expect(shows).toBeDefined();
		expect(shows?.readable).toBe(true);
		expect(shows?.writable).toBe(true);
		expect(shows?.path).toBe(join(root, 'Shows'));
	});

	it('reports a directory it cannot read as unreadable rather than hiding it', async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-listing-perm-')));

		await mkdir(join(base, 'locked'));
		await chmod(join(base, 'locked'), 0o000);

		const scan = await service.list(base, { roots: [base] });
		const locked = scan.entries.find((entry) => entry.name === 'locked');

		// Root ignores the permission bits entirely, and a suite that asserted
		// otherwise would fail in a container that happens to run as root while the
		// code is perfectly correct.
		if (process.getuid?.() === 0) {
			expect(locked).toBeDefined();
		} else {
			expect(locked?.readable).toBe(false);
			expect(locked?.writable).toBe(false);
		}

		await chmod(join(base, 'locked'), 0o755);
	});

	it('caps a large directory and says that it did', async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-listing-many-')));

		for (let index = 0; index < 12; index += 1) {
			await mkdir(join(base, `folder-${String(index).padStart(2, '0')}`));
		}

		const scan = await service.list(base, { roots: [base], limit: 5 });

		expect(scan.entries).toHaveLength(5);
		expect(scan.limit).toBe(5);
		// Without this flag a shortened list is indistinguishable from a complete one,
		// and somebody looks for a folder that is there and concludes it is not.
		expect(scan.truncated).toBe(true);
		expect(scan.entries[0].name).toBe('folder-00');
	});

	it('does not claim to be capped when it answered everything', async () => {
		const scan = await service.list(root, { roots: [root] });

		expect(scan.truncated).toBe(false);
		expect(scan.limit).toBe(MAX_DIRECTORY_ENTRIES);
	});

	it('throws what the filesystem threw, for the manager to translate', async () => {
		await expect(service.list(join(root, 'nothing'), { roots: [root] })).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('answers the rights of a path it is asked about', async () => {
		expect(await service.rights(root)).toEqual({ readable: true, writable: true });
		expect(await service.rights(join(root, 'nothing'))).toEqual({
			readable: false,
			writable: false,
		});
	});
});
