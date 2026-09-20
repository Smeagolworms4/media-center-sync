import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInside, PathVerdict, resolveWithinRoots } from './path-containment';

/**
 * The boundary of the directory browser, tested against a real filesystem.
 *
 * A symlink is the case that cannot be faked: it is precisely the thing a string
 * comparison cannot see, so the test that would have caught a prefix check has to
 * create one on disk.
 */
describe('resolveWithinRoots', () => {
	let root: string;
	let outside: string;
	let roots: string[];

	beforeAll(async () => {
		// The temporary directory is itself a symlink on macOS, so everything the
		// assertions compare against is the resolved form from the start.
		const base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-contain-')));

		root = join(base, 'media');
		outside = join(base, 'elsewhere');
		roots = [root];

		await mkdir(join(root, 'shows', 'season'), { recursive: true });
		await mkdir(join(outside, 'secrets'), { recursive: true });
		await writeFile(join(root, 'note.txt'), 'x');
		await symlink(outside, join(root, 'escape'));
		await symlink(join(root, 'shows'), join(root, 'inner-link'));
	});

	it('accepts a directory under the root', async () => {
		const resolved = await resolveWithinRoots(join(root, 'shows', 'season'), roots);

		expect(resolved.verdict).toBe(PathVerdict.INSIDE);
		expect(resolved.path).toBe(join(root, 'shows', 'season'));
		expect(resolved.root).toBe(root);
	});

	it('accepts the root itself, which is where a browse starts', async () => {
		const resolved = await resolveWithinRoots(root, roots);

		expect(resolved.verdict).toBe(PathVerdict.INSIDE);
		expect(resolved.path).toBe(root);
	});

	it('refuses an escape spelled with ..', async () => {
		const resolved = await resolveWithinRoots(join(root, 'shows', '..', '..', 'elsewhere'), roots);

		expect(resolved.verdict).toBe(PathVerdict.OUTSIDE);
		expect(resolved.root).toBeNull();
	});

	it('refuses an absolute path somewhere else entirely', async () => {
		expect((await resolveWithinRoots('/etc', roots)).verdict).toBe(PathVerdict.OUTSIDE);
		expect((await resolveWithinRoots(outside, roots)).verdict).toBe(PathVerdict.OUTSIDE);
	});

	it('refuses a symlink that points out of the root', async () => {
		// The case a prefix test on the raw input passes: the path reads as being under
		// the root from beginning to end, and opening it reads somebody else's files.
		const resolved = await resolveWithinRoots(join(root, 'escape', 'secrets'), roots);

		expect(resolved.verdict).toBe(PathVerdict.OUTSIDE);
		expect(resolved.path).toBe(join(outside, 'secrets'));
	});

	it('follows a symlink that stays inside, which is an ordinary mount', async () => {
		const resolved = await resolveWithinRoots(join(root, 'inner-link', 'season'), roots);

		expect(resolved.verdict).toBe(PathVerdict.INSIDE);
		expect(resolved.path).toBe(join(root, 'shows', 'season'));
	});

	it('tells a missing path inside the root from one outside it', async () => {
		const inside = await resolveWithinRoots(join(root, 'nothing', 'here'), roots);

		expect(inside.verdict).toBe(PathVerdict.MISSING);
		expect(inside.path).toBe(join(root, 'nothing', 'here'));

		// Outside wins over missing: answering "no such directory" for a path we refuse
		// to look at would say whether it exists, one guess at a time.
		const elsewhere = await resolveWithinRoots(join(outside, 'nothing'), roots);

		expect(elsewhere.verdict).toBe(PathVerdict.OUTSIDE);
	});

	it('resolves a root that is itself a symlink, or it would match nothing', async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-contain-link-')));
		const real = join(base, 'real');
		const link = join(base, 'link');

		await mkdir(join(real, 'shows'), { recursive: true });
		await symlink(real, link);

		const resolved = await resolveWithinRoots(join(link, 'shows'), [link]);

		expect(resolved.verdict).toBe(PathVerdict.INSIDE);
		expect(resolved.path).toBe(join(real, 'shows'));
	});

	it('finds a path under any of several roots', async () => {
		const resolved = await resolveWithinRoots(join(outside, 'secrets'), [root, outside]);

		expect(resolved.verdict).toBe(PathVerdict.INSIDE);
		expect(resolved.root).toBe(outside);
	});
});

describe('isInside', () => {
	it('compares whole components, so /mnt/media2 is not inside /mnt/media', () => {
		expect(isInside('/mnt/media/shows', '/mnt/media')).toBe(true);
		expect(isInside('/mnt/media', '/mnt/media')).toBe(true);
		expect(isInside('/mnt/media2', '/mnt/media')).toBe(false);
		expect(isInside('/mnt', '/mnt/media')).toBe(false);
	});
});
