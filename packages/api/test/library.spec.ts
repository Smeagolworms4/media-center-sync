import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaServiceType,
	UserRole,
	type CategoryKeyword,
	type Library,
	type LibraryCheck,
	type MediaCategory,
} from '@mcs/shared';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * Libraries over HTTP.
 *
 * The suite exists because of one bug it would have caught the day it was written:
 * `PATCH /libraries/:id` answered `400 property alias should not exist` for `alias`
 * and `position` — two fields the entity, the column, the shared model and
 * `docs/API.md` all declared, and which `UpdateLibraryDto` alone did not. So every
 * documented field is sent here on its own and read back, rather than assumed to
 * work because the column exists.
 */
describe('Libraries', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let guest: TestIdentity;
	let showsId: string;
	let filmsId: string;
	let otherShowsId: string;
	let writablePath: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		guest = await signInAs(context, UserRole.GUEST);

		// A directory that really exists and really is writable: the manager probes the
		// path it is given, so a made-up one would be refused for the right reason and
		// prove nothing about the field being accepted.
		writablePath = mkdtempSync(join(tmpdir(), 'mcs-library-'));

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);

		const living = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:41',
			}),
		);

		const attic = await services.save(
			services.create({
				name: 'Attic',
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:42',
			}),
		);

		showsId = (
			await libraries.save(
				libraries.create({
					serviceId: living.id,
					externalId: 'lib-shows',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					paths: ['/media/shows'],
					position: 100,
					itemCount: 7,
				}),
			)
		).id;

		filmsId = (
			await libraries.save(
				libraries.create({
					serviceId: living.id,
					externalId: 'lib-films',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					paths: ['/media/films'],
					position: 50,
					itemCount: 3,
				}),
			)
		).id;

		otherShowsId = (
			await libraries.save(
				libraries.create({
					serviceId: attic.id,
					externalId: 'lib-shows',
					name: 'shóws',
					kind: LibraryKind.SHOWS,
					paths: ['/srv/shows'],
					position: 120,
					itemCount: 4,
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	const read = (path: string, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/libraries${path}`)
			.set('Authorization', `Bearer ${identity.token}`);

	const patch = (id: string, body: Record<string, unknown>, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.patch(`/api/libraries/${id}`)
			.set('Authorization', `Bearer ${identity.token}`)
			.send(body);

	describe('reading', () => {
		it('lists every library of every service, with the fields the model documents', async () => {
			const response = await read('').expect(200);
			const list = response.body as Library[];

			expect(list).toHaveLength(3);
			expect(list.find((library) => library.id === showsId)).toMatchObject({
				serviceId: expect.any(String),
				externalId: 'lib-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
				itemCount: 7,
				writable: false,
			});

			// `alias` and `position` are the two fields the update route used to refuse.
			// They have to be readable as well as writable, or a form cannot show what
			// it is about to change.
			for (const library of list) {
				expect(library).toHaveProperty('alias');
				expect(library).toHaveProperty('position');
			}
		});

		it('answers one library', async () => {
			const response = await read(`/${filmsId}`).expect(200);

			expect(response.body as Library).toMatchObject({ id: filmsId, name: 'Films' });
		});

		it('answers a key for a library nobody holds', async () => {
			const response = await read('/11111111-2222-4333-8444-555555555555').expect(404);

			expect(response.body).toMatchObject({ message: 'error.library.not_found' });
		});

		it('refuses an identifier that is not one', async () => {
			// `ParseUUIDPipe` on the route, which is also what keeps `categories` and
			// `check` from being read as identifiers.
			await read('/not-a-uuid').expect(400);
		});

		it('serves `check` rather than reading it as an identifier', async () => {
			const response = await read('/check').expect(200);
			const checks = response.body as LibraryCheck[];

			// Two of the three, because the third is on a service that is not ours. A
			// library we cannot write into is not a misconfiguration to report — it is
			// somebody else's disk — and probing it answered "does not exist, not
			// readable, not writable" on every one, which had the dashboard asking
			// people to fix what is neither broken nor fixable.
			expect(checks).toHaveLength(2);
			expect(checks.map((one) => one.libraryId)).not.toContain(otherShowsId);
			expect(checks[0]).toMatchObject({
				libraryId: expect.any(String),
				name: expect.any(String),
				exists: expect.any(Boolean),
				readable: expect.any(Boolean),
				writable: expect.any(Boolean),
			});

			// A library with no local path is the failure this route exists for, and it
			// has to be reported rather than left blank.
			expect(checks.every((entry) => entry.localPath !== null || entry.error !== null)).toBe(true);
		});

		it('serves `categories` rather than reading it as an identifier', async () => {
			const response = await read('/categories').expect(200);
			const categories = response.body as MediaCategory[];

			// `Shows` and `shóws` are one category: case and accents are folded, and the
			// counts of both libraries are added.
			const shows = categories.find((category) => category.key === 'shows');

			expect(shows).toMatchObject({ name: 'Shows', itemCount: 11, position: 100 });
			expect(shows?.libraryIds).toHaveLength(2);
			// One of the two sits on a local service, which is what decides whether
			// anything can be written into the category at all.
			expect(shows?.local).toBe(true);

			// Lowest position first, which is what the order on screen is built from.
			expect(categories[0].name).toBe('Films');
		});
	});

	describe('updating', () => {
		it('accepts `localPath`, probes it, and marks the library writable', async () => {
			const response = await patch(showsId, { localPath: writablePath }).expect(200);

			expect(response.body as Library).toMatchObject({
				localPath: writablePath,
				writable: true,
			});

			const reread = await read(`/${showsId}`).expect(200);

			expect((reread.body as Library).localPath).toBe(writablePath);
		});

		it('accepts `isDefaultTarget`', async () => {
			await patch(showsId, { isDefaultTarget: true }).expect(200);

			const reread = await read(`/${showsId}`).expect(200);

			expect((reread.body as Library).isDefaultTarget).toBe(true);
		});

		it('accepts `alias`, the field the route used to refuse', async () => {
			await patch(otherShowsId, { alias: 'Séries' }).expect(200);

			const reread = await read(`/${otherShowsId}`).expect(200);

			expect((reread.body as Library).alias).toBe('Séries');
		});

		it('accepts `position`, the other field the route used to refuse', async () => {
			await patch(otherShowsId, { position: 10 }).expect(200);

			const reread = await read(`/${otherShowsId}`).expect(200);

			expect((reread.body as Library).position).toBe(10);
		});

		it('leaves every field the request did not name alone', async () => {
			const before = (await read(`/${showsId}`).expect(200)).body as Library;

			await patch(showsId, { alias: 'Seen here' }).expect(200);

			const after = (await read(`/${showsId}`).expect(200)).body as Library;

			expect(after.alias).toBe('Seen here');
			expect(after.localPath).toBe(before.localPath);
			expect(after.writable).toBe(before.writable);
			expect(after.isDefaultTarget).toBe(before.isDefaultTarget);
			expect(after.position).toBe(before.position);
			expect(after.name).toBe(before.name);
		});

		it('takes an alias of whitespace as no alias, rather than a category with no name', async () => {
			await patch(showsId, { alias: '   ' }).expect(200);

			expect(((await read(`/${showsId}`).expect(200)).body as Library).alias).toBeNull();
		});

		it('clears the path on an explicit null, which is not the same as omitting it', async () => {
			await patch(filmsId, { localPath: writablePath }).expect(200);
			await patch(filmsId, { localPath: null }).expect(200);

			const reread = (await read(`/${filmsId}`).expect(200)).body as Library;

			expect(reread.localPath).toBeNull();
			expect(reread.writable).toBe(false);
		});

		it('refuses a path that does not exist, with the key that says why', async () => {
			const response = await patch(showsId, {
				localPath: join(writablePath, 'nothing-here'),
			}).expect(409);

			expect(response.body).toMatchObject({ message: 'error.library.path_unreadable' });
		});

		it('refuses a relative path, which resolves differently in every process', async () => {
			const response = await patch(showsId, { localPath: 'media/shows' }).expect(400);

			expect(response.body).toMatchObject({ message: 'error.library.path_unreadable' });
		});

		it('refuses a default target it cannot write into', async () => {
			const response = await patch(otherShowsId, { isDefaultTarget: true }).expect(409);

			expect(response.body).toMatchObject({ message: 'error.library.path_not_writable' });
		});

		it('refuses a property the DTO never declared', async () => {
			const response = await patch(showsId, { writable: true }).expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('writable');
		});

		it('refuses a position outside the range the model allows', async () => {
			await patch(showsId, { position: -1 }).expect(400);
			await patch(showsId, { position: 100_000 }).expect(400);
		});

		it('answers a key for a library nobody holds', async () => {
			const response = await patch('11111111-2222-4333-8444-555555555555', {
				alias: 'Ghost',
			}).expect(404);

			expect(response.body).toMatchObject({ message: 'error.library.not_found' });
		});
	});

	/**
	 * The screen this suite exists for, over HTTP and over a real database.
	 *
	 * The gateway's own categories are two rows; a friend's gateway brings nine more,
	 * every one of them stranded under a name of its own. Folding them by hand meant
	 * typing the same alias once per library, again for every peer that ever appears.
	 * A keyword is that sentence written once — and the case that matters most is the
	 * last one here, where a library simply turns up and files itself with nobody
	 * touching anything.
	 */
	describe('keywords plugged into a category', () => {
		const post = (key: string, body: Record<string, unknown>, identity: TestIdentity = admin): request.Test =>
			request(context.app.getHttpServer())
				.post(`/api/libraries/categories/${key}/keywords`)
				.set('Authorization', `Bearer ${identity.token}`)
				.send(body);

		const remove = (id: string, identity: TestIdentity = admin): request.Test =>
			request(context.app.getHttpServer())
				.delete(`/api/libraries/keywords/${id}`)
				.set('Authorization', `Bearer ${identity.token}`);

		let planted: string[] = [];

		afterEach(async () => {
			for (const id of planted) {
				await remove(id);
			}

			planted = [];
		});

		const plant = async (key: string, keyword: string): Promise<CategoryKeyword> => {
			const response = await post(key, { keyword }).expect(201);
			const created = response.body as CategoryKeyword;

			planted.push(created.id);

			return created;
		};

		it('serves `keywords` rather than reading it as an identifier', async () => {
			const response = await read('/keywords').expect(200);

			expect(response.body).toEqual([]);
		});

		it('folds a shelf into the category, across case, accents and punctuation', async () => {
			await plant('shows', 'series-tv');

			const libraries = context.app.get(LibraryRepository);
			const arrival = await libraries.save(
				libraries.create({
					serviceId: (await libraries.findOneOrFail({ where: { id: otherShowsId } })).serviceId,
					externalId: 'lib-series-tv',
					// Nobody types this spelling anywhere: it has to fold to the keyword on
					// its own, or the mapping is a rename by another name.
					name: 'Séries TV',
					kind: LibraryKind.OTHER,
					paths: ['/srv/series-tv'],
					position: 100,
					itemCount: 5,
				}),
			);

			try {
				const categories = (await read('/categories').expect(200)).body as MediaCategory[];
				const shows = categories.find((category) => category.key === 'shows');

				// Nobody patched anything: the row went in and the category answered.
				expect(shows?.libraryIds).toContain(arrival.id);
				expect(categories.some((category) => category.key === 'series-tv')).toBe(false);

				// And the alias column is untouched, which is what makes the undo exact.
				expect((await libraries.findOneOrFail({ where: { id: arrival.id } })).alias).toBeNull();
			} finally {
				await libraries.delete({ id: arrival.id });
			}
		});

		it('says which category a keyword files into and what it is catching', async () => {
			const created = await plant('films', 'Émissions TV');

			expect(created).toMatchObject({
				categoryKey: 'films',
				categoryName: 'Films',
				keyword: 'Émissions TV',
				normalized: 'emissions-tv',
				libraryIds: [],
			});
		});

		it('moves a keyword to another category', async () => {
			const created = await plant('films', 'TV');

			const moved = await request(context.app.getHttpServer())
				.patch(`/api/libraries/keywords/${created.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ categoryKey: 'shows' })
				.expect(200);

			expect((moved.body as CategoryKeyword).categoryKey).toBe('shows');
		});

		it('refuses a keyword another category already holds', async () => {
			await plant('shows', 'Documentaires');

			const response = await post('films', { keyword: 'documentaires' }).expect(409);

			expect(response.body).toMatchObject({ message: 'error.library.keyword_taken' });
		});

		it('refuses a keyword that folds to nothing', async () => {
			const response = await post('shows', { keyword: '  -  ' }).expect(400);

			expect(response.body).toMatchObject({ message: 'error.library.keyword_invalid' });
		});

		it('answers a key for a category nobody reads as anything', async () => {
			const response = await post('no-such-category', { keyword: 'TV' }).expect(404);

			expect(response.body).toMatchObject({ message: 'error.library.category_not_found' });
		});

		it('answers a key for a keyword nobody wrote', async () => {
			const response = await remove('11111111-2222-4333-8444-555555555555').expect(404);

			expect(response.body).toMatchObject({ message: 'error.library.keyword_not_found' });
		});

		it('puts the shelf back under its own name when the keyword is unplugged', async () => {
			const created = await plant('shows', 'shóws');

			await remove(created.id).expect(204);
			planted = [];

			const categories = (await read('/categories').expect(200)).body as MediaCategory[];

			// The undo is a deletion and nothing else, because nothing was written.
			expect(categories.some((category) => category.key === 'shows')).toBe(true);
			expect((await read('/keywords').expect(200)).body).toEqual([]);
		});

		it('lets a guest read the keywords, because the wall is built from them', async () => {
			await read('/keywords', guest).expect(200);
		});

		it('refuses a guest the mapping, which needs LIBRARY_MANAGE', async () => {
			const response = await post('shows', { keyword: 'Nope' }, guest).expect(403);

			expect(response.body).toMatchObject({ message: 'error.auth.forbidden' });
		});
	});

	describe('rights', () => {
		it('lets a guest read, because a library screen is all a guest has', async () => {
			await read('', guest).expect(200);
			await read('/categories', guest).expect(200);
			await read(`/${showsId}`, guest).expect(200);
		});

		it('refuses a guest the update, which needs LIBRARY_MANAGE', async () => {
			const response = await patch(showsId, { alias: 'Not yours' }, guest).expect(403);

			expect(response.body).toMatchObject({ message: 'error.auth.forbidden' });
		});

		it('refuses an anonymous caller entirely', async () => {
			await request(context.app.getHttpServer()).get('/api/libraries').expect(401);
		});
	});
});
