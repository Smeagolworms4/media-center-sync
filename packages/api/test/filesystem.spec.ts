import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ErrorKey, UserRole, type DirectoryListing } from '@mcs/shared';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The directory browser, over HTTP.
 *
 * The containment is the only thing standing between a read-only convenience and a
 * map of the host's filesystem, and it is exactly the kind of rule that is correct in
 * the unit test and bypassed by the time it reaches a route — a query string that is
 * never decoded, a guard that was never put on, a validation pipe that strips the
 * field. This suite is the only place those are proved.
 *
 * This suite runs the **restricted** deployment: `MCS_BROWSE_ROOTS` is set to the
 * system temporary directory before the application boots, which is the narrow
 * behaviour somebody on a shared host asks for. It is no longer the default — see the
 * suite at the bottom of this file for what an unconfigured gateway does, and
 * `FilesystemManager` for why the default was inverted.
 */
describe('GET /api/filesystem/directories', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let base: string;

	beforeAll(async () => {
		// Before the application boots, because the roots are read once in the
		// manager's constructor: setting it afterwards would configure nothing and the
		// suite would quietly prove the default instead of the restriction.
		process.env.MCS_BROWSE_ROOTS = tmpdir();

		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-browse-')));

		await mkdir(join(base, 'Shows', 'Season 01'), { recursive: true });
		await mkdir(join(base, '.cache'), { recursive: true });
		await writeFile(join(base, 'note.txt'), 'x');
		await symlink('/etc', join(base, 'escape'));
	});

	afterAll(async () => {
		delete process.env.MCS_BROWSE_ROOTS;
		await context.close();
	});

	const browse = (query: Record<string, string>, token = admin.token) =>
		request(context.app.getHttpServer())
			.get('/api/filesystem/directories')
			.query(query)
			.set('Authorization', `Bearer ${token}`);

	it('lists the directories under a path, and says what it can write into', async () => {
		const response = await browse({ path: base }).expect(200);
		const listing = response.body as DirectoryListing;

		expect(listing.path).toBe(base);
		expect(listing.entries.map((entry) => entry.name)).toEqual(['Shows']);
		expect(listing.entries[0].path).toBe(join(base, 'Shows'));
		expect(listing.entries[0].writable).toBe(true);
		expect(listing.truncated).toBe(false);
		expect(listing.roots.length).toBeGreaterThan(0);
	});

	it('hides dot directories until the flag asks for them', async () => {
		const hidden = (await browse({ path: base, includeHidden: 'true' }).expect(200))
			.body as DirectoryListing;

		expect(hidden.entries.map((entry) => entry.name)).toEqual(['.cache', 'Shows']);
	});

	it('offers no way up out of the root', async () => {
		const root = await realpath(tmpdir());
		const listing = (await browse({ path: root }).expect(200)).body as DirectoryListing;

		// Null rather than a path somebody would be refused for asking: a boundary
		// discovered by being told off is a boundary people assume is a bug.
		expect(listing.parent).toBeNull();
	});

	it('refuses a path outside the roots with 403 and a key, never a 404', async () => {
		const response = await browse({ path: '/etc' }).expect(403);

		expect(response.body).toMatchObject({ message: ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT });
	});

	it('refuses an escape spelled with .., after resolving it', async () => {
		const response = await browse({ path: join(base, '..', '..', '..', '..', 'etc') }).expect(403);

		expect(response.body).toMatchObject({ message: ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT });
	});

	it('refuses a symlink that points out of the roots', async () => {
		// The case a prefix test on the raw input lets through: the path reads as being
		// under the root from beginning to end.
		const response = await browse({ path: join(base, 'escape') }).expect(403);

		expect(response.body).toMatchObject({ message: ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT });
	});

	it('answers 404 for a path inside the roots that is not there', async () => {
		const response = await browse({ path: join(base, 'nothing') }).expect(404);

		expect(response.body).toMatchObject({ message: ErrorKey.FILESYSTEM_PATH_NOT_FOUND });
	});

	it('answers 404 for a file, which is not a directory to browse', async () => {
		await browse({ path: join(base, 'note.txt') }).expect(404);
	});

	it('starts at the first allowed root when no path is given', async () => {
		const listing = (await browse({}).expect(200)).body as DirectoryListing;

		expect(listing.path).toBe(await realpath(tmpdir()));
	});

	it('refuses a caller without the right, and one without a session', async () => {
		const user = await signInAs(context, UserRole.USER);
		const refused = await browse({ path: base }, user.token).expect(403);

		expect(refused.body).toMatchObject({ message: ErrorKey.AUTH_FORBIDDEN });

		await request(context.app.getHttpServer())
			.get('/api/filesystem/directories')
			.query({ path: base })
			.expect(401);
	});

	it('still refuses a field it does not declare', async () => {
		await browse({ path: base, depth: '5' }).expect(400);
	});
});

/**
 * The same route on a gateway nobody restricted, which is the ordinary case.
 *
 * The boundary used to be `MCS_MEDIA_ROOT`, and the consequence was a picker that
 * opened on a directory holding none of the media and refused every step above it —
 * so the person typed the path by hand, which is the failure the picker exists to
 * prevent. The trade is stated in `FilesystemManager`: the route is behind a session
 * and a right, it lists directory names and never file contents, and a deployment
 * that wants the narrow version sets `MCS_BROWSE_ROOTS`, which the suite above runs.
 */
describe('GET /api/filesystem/directories — unrestricted', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		delete process.env.MCS_BROWSE_ROOTS;

		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	const browse = (query: Record<string, string>) =>
		request(context.app.getHttpServer())
			.get('/api/filesystem/directories')
			.query(query)
			.set('Authorization', `Bearer ${admin.token}`);

	it('lists the filesystem root, and offers no way above it', async () => {
		const listing = (await browse({ path: '/' }).expect(200)).body as DirectoryListing;

		expect(listing.path).toBe('/');
		// Not because it is refused — because there is nothing above `/`. The interface
		// disables the step rather than offering one that would be told off.
		expect(listing.parent).toBeNull();
		expect(listing.entries.length).toBeGreaterThan(0);
	});

	it('reaches a directory outside the media root instead of answering 403', async () => {
		const listing = (await browse({ path: '/usr' }).expect(200)).body as DirectoryListing;

		expect(listing.path).toBe('/usr');
		expect(listing.parent).toBe('/');
	});

	it('still opens where the media are when nothing is asked for', async () => {
		// The starting point and the boundary are different things, and conflating them
		// is what made the picker a dead end. Opening on `/` would be correct and
		// useless: the first screen would be `bin`, `boot`, `dev`.
		const listing = (await browse({}).expect(200)).body as DirectoryListing;

		expect(listing.path).toBe(await realpath(tmpdir()));
		expect(listing.parent).not.toBeNull();
	});

	it('still answers 404 for a directory that is not there', async () => {
		await browse({ path: '/nowhere-at-all-12345' }).expect(404);
	});
});
