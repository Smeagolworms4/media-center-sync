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
 * `MCS_MEDIA_ROOT` is the system temporary directory here, set in `test/setup.ts`
 * before the configuration is read, so everything built under `mkdtemp` is inside the
 * allowed root by construction.
 */
describe('GET /api/filesystem/directories', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let base: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		base = await realpath(await mkdtemp(join(tmpdir(), 'mcs-browse-')));

		await mkdir(join(base, 'Shows', 'Season 01'), { recursive: true });
		await mkdir(join(base, '.cache'), { recursive: true });
		await writeFile(join(base, 'note.txt'), 'x');
		await symlink('/etc', join(base, 'escape'));
	});

	afterAll(async () => {
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
