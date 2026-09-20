import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaServiceType,
	NamingScheme,
	PlacementStrategy,
	UserRole,
	type Library,
	type MediaCategory,
	type Settings,
} from '@mcs/shared';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A partial update has to be partial.
 *
 * This suite exists because it was not. The interface always sent the whole settings
 * object, so every screen worked and every unit test passed, while a client sending
 * the one field it wanted to change — which is what the documented type invites —
 * got a 400 blaming it for `placement`, a field it never mentioned.
 *
 * The cause was not in this code at all: ES2022 class fields define every declared
 * property, so a DTO arrived carrying `placement: undefined` as a real key, and a
 * real key wins a spread. It is guarded here, at the HTTP surface, rather than where
 * the merge happens, because the merge was already correct.
 */
describe('PATCH /api/settings', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	const patch = (body: Record<string, unknown>) =>
		request(context.app.getHttpServer())
			.patch('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body);

	it('changes one field and leaves every other one alone', async () => {
		const before = (await patch({
			placement: PlacementStrategy.FIXED_PATH,
			fixedPath: '/mnt/media',
			namingOrder: [NamingScheme.STANDARD],
			maxParallelTransfers: 4,
		}).expect(200)) as { body: Settings };

		const after = (await patch({ uploadRateLimit: 2_097_152 }).expect(200)) as {
			body: Settings;
		};

		expect(after.body.uploadRateLimit).toBe(2_097_152);
		expect(after.body.placement).toBe(before.body.placement);
		expect(after.body.fixedPath).toBe(before.body.fixedPath);
		expect(after.body.namingOrder).toEqual(before.body.namingOrder);
		expect(after.body.maxParallelTransfers).toBe(before.body.maxParallelTransfers);
	});

	it('survives a reread, so the untouched fields were kept and not merely echoed', async () => {
		await patch({ downloadRateLimit: 1_048_576 }).expect(200);

		const response = await request(context.app.getHttpServer())
			.get('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);
		const settings = response.body as Settings;

		expect(settings.downloadRateLimit).toBe(1_048_576);
		expect(settings.placement).toBe(PlacementStrategy.FIXED_PATH);
		expect(settings.fixedPath).toBe('/mnt/media');
		expect(settings.namingOrder).toEqual([NamingScheme.STANDARD]);
	});

	it('still refuses a value out of bounds', async () => {
		await patch({ maxParallelTransfers: 999 }).expect(400);
	});

	it('still refuses a field it does not declare', async () => {
		await patch({ role: 'admin' }).expect(400);
	});

	it('still refuses a fixed-path strategy with no path', async () => {
		await patch({ placement: PlacementStrategy.FIXED_PATH, fixedPath: '  ' }).expect(400);
	});
});

/**
 * The gateway's own address, and where a pull lands when nothing else decides.
 *
 * Over HTTP rather than against the service, because the failure this guards is not in
 * the service at all: a setting the DTO does not declare is stripped by the validation
 * pipe before anything sees it, the request answers 200, and the value simply never
 * arrives. That has happened three times here — `alias`, `position`, `relay` — and
 * every unit test passed each time.
 */
describe('PATCH /api/settings — the gateway’s address and its fallback folder', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let writable: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		writable = await mkdtemp(join(tmpdir(), 'mcs-target-'));
	});

	afterAll(async () => {
		await context.close();
	});

	const patch = (body: Record<string, unknown>) =>
		request(context.app.getHttpServer())
			.patch('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body);

	const read = () =>
		request(context.app.getHttpServer())
			.get('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

	it('accepts both, stores them normalised and reads them back', async () => {
		await patch({
			publicUrl: 'https://mcs.example.org/',
			defaultTargetPath: `${writable}/`,
		}).expect(200);

		const settings = (await read()).body as Settings;

		expect(settings.publicUrl).toBe('https://mcs.example.org');
		expect(settings.defaultTargetPath).toBe(writable);
	});

	it('changes one of them and leaves the other alone', async () => {
		await patch({ publicUrl: 'http://192.168.0.12:4200' }).expect(200);

		const settings = (await read()).body as Settings;

		expect(settings.publicUrl).toBe('http://192.168.0.12:4200');
		expect(settings.defaultTargetPath).toBe(writable);
	});

	it('takes an empty string as a clearing and not as an empty value', async () => {
		await patch({ publicUrl: '', defaultTargetPath: '' }).expect(200);

		const settings = (await read()).body as Settings;

		expect(settings.publicUrl).toBeNull();
		expect(settings.defaultTargetPath).toBeNull();
	});

	it('refuses an address with no scheme, naming the field', async () => {
		const response = await patch({ publicUrl: 'mcs.example.org' }).expect(400);

		expect(response.body).toMatchObject({
			key: 'error.settings.public_url_invalid',
			field: 'publicUrl',
		});
	});

	it('refuses a peer address that is not host:port', async () => {
		await patch({ peerAddress: 'https://mcs.example.org:4210' }).expect(400);
	});

	it('refuses a fallback target that is not absolute', async () => {
		await patch({ defaultTargetPath: 'incoming' }).expect(400);
	});

	it('refuses a fallback target that cannot be written, rather than failing later', async () => {
		const response = await patch({
			defaultTargetPath: join(writable, 'no-such-directory'),
		}).expect(400);

		expect(response.body).toMatchObject({ field: 'defaultTargetPath' });
	});

	it('writes nothing when a refusal happens', async () => {
		await patch({ publicUrl: 'https://mcs.example.org' }).expect(200);
		await patch({ publicUrl: 'nonsense' }).expect(400);

		expect(((await read()).body as Settings).publicUrl).toBe('https://mcs.example.org');
	});
});

/**
 * Where a pull lands, per category and in general.
 *
 * Over HTTP rather than against the service, because the failure this guards is the
 * validation pipe's: a setting the DTO does not declare is stripped from the body
 * before anything sees it, the request answers 200, and the value simply never
 * arrives. The refusals are checked for their shape as well as their status — these
 * are all saved from one form, so an error with no field on it can only be shown above
 * the whole screen, with the person left to guess which of a dozen controls it means.
 */
describe('PATCH /api/settings — where a pull lands', () => {
	let context: TestApp;
	let admin: TestIdentity;
	const library = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	const patch = (body: Record<string, unknown>) =>
		request(context.app.getHttpServer())
			.patch('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body);

	const read = () =>
		request(context.app.getHttpServer())
			.get('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

	it('starts with no category answered for and no default library', async () => {
		const settings = (await read()).body as Settings;

		expect(settings.categoryTargets).toEqual({});
		expect(settings.defaultTargetLibraryId).toBeNull();
	});

	it('stores a category table and a default library, and reads both back', async () => {
		await patch({ categoryTargets: { animes: library }, defaultTargetLibraryId: library }).expect(
			200,
		);

		const settings = (await read()).body as Settings;

		expect(settings.categoryTargets).toEqual({ animes: library });
		expect(settings.defaultTargetLibraryId).toBe(library);
	});

	it('replaces the whole table, because a removed row is a removed choice', async () => {
		await patch({ categoryTargets: { films: library } }).expect(200);

		expect(((await read()).body as Settings).categoryTargets).toEqual({ films: library });
	});

	it('takes an emptied select as no choice rather than as a library called nothing', async () => {
		await patch({ defaultTargetLibraryId: '' }).expect(200);

		expect(((await read()).body as Settings).defaultTargetLibraryId).toBeNull();
	});

	it('refuses a destination that is a path, naming the field', async () => {
		const refused = await patch({ categoryTargets: { animes: '/mnt/nas/anime' } }).expect(400);

		expect(refused.body).toMatchObject({
			key: 'error.settings.invalid',
			field: 'categoryTargets',
		});
	});

	it('refuses a table that is not a table', async () => {
		await patch({ categoryTargets: ['lib-1'] }).expect(400);
		await patch({ categoryTargets: null }).expect(400);
	});

	it('refuses a default library that is not an identifier, naming the field', async () => {
		const refused = await patch({ defaultTargetLibraryId: 'the big disk' }).expect(400);

		expect(refused.body).toMatchObject({
			key: 'error.settings.invalid',
			field: 'defaultTargetLibraryId',
		});
	});

	it('writes nothing when a refusal happens', async () => {
		await patch({ categoryTargets: { films: library } }).expect(200);
		await patch({ categoryTargets: { films: 'nonsense' } }).expect(400);

		expect(((await read()).body as Settings).categoryTargets).toEqual({ films: library });
	});
});

/**
 * A destination says what a category *is*, not only where its files go.
 *
 * The report: `Séries` was mapped onto the `Shows` library in the table above, and the
 * library screen went on showing two categories with fourteen episodes stranded in the
 * first. Two mechanisms, one control — `categoryTargets` places files, `Library.alias`
 * is what categories merge on — and nothing on the screen said so.
 *
 * Over HTTP and end to end on purpose: the assertion that matters is not that a
 * manager was called, it is that `GET /libraries/categories` answers one category
 * holding the items of both afterwards, which is exactly what somebody expected and
 * did not get.
 */
describe('PATCH /api/settings — a destination that also names the category', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let seriesId: string;
	let showsId: string;
	let theirSeriesId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);

		const jellyfin = await services.save(
			services.create({
				name: 'Jellyfin (local)',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:51',
			}),
		);

		const plex = await services.save(
			services.create({
				name: 'Plex (mine)',
				type: MediaServiceType.PLEX,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:52',
			}),
		);

		// A friend's server, holding a library of the same name as ours. Renaming it
		// would fold their shelf into our category and count their episodes as filed in
		// a library they can never be filed in.
		const friend = await services.save(
			services.create({
				name: 'Jellyfin (a friend)',
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:53',
			}),
		);

		seriesId = (
			await libraries.save(
				libraries.create({
					serviceId: jellyfin.id,
					externalId: 'lib-series',
					name: 'Séries',
					kind: LibraryKind.SHOWS,
					paths: ['/media/series'],
					itemCount: 14,
				}),
			)
		).id;

		showsId = (
			await libraries.save(
				libraries.create({
					serviceId: plex.id,
					externalId: 'lib-shows',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					paths: ['/media/shows'],
					itemCount: 24,
				}),
			)
		).id;

		theirSeriesId = (
			await libraries.save(
				libraries.create({
					serviceId: friend.id,
					externalId: 'lib-series',
					name: 'Séries',
					kind: LibraryKind.SHOWS,
					paths: ['/srv/series'],
					itemCount: 7,
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	const patch = (body: Record<string, unknown>) =>
		request(context.app.getHttpServer())
			.patch('/api/settings')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body);

	const categories = async (): Promise<MediaCategory[]> =>
		(
			await request(context.app.getHttpServer())
				.get('/api/libraries/categories')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200)
		).body as MediaCategory[];

	const library = async (id: string): Promise<Library> =>
		(
			await request(context.app.getHttpServer())
				.get(`/api/libraries/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200)
		).body as Library;

	it('starts as the gateway that was reported: two categories, nothing merged', async () => {
		const before = await categories();

		expect(before.map((category) => category.key).sort()).toEqual(['series', 'shows']);
		expect(before.find((category) => category.key === 'series')).toMatchObject({
			name: 'Séries',
			itemCount: 21,
		});
		expect(before.find((category) => category.key === 'shows')).toMatchObject({ itemCount: 24 });
		expect((await library(seriesId)).alias).toBeNull();
	});

	it('makes the two one category, holding the items of both', async () => {
		await patch({ categoryTargets: { series: showsId } }).expect(200);

		const after = await categories();
		const shows = after.find((category) => category.key === 'shows');

		// Fourteen and twenty-four, under one name, from the two libraries that are
		// ours. This is the whole point: the mapping said Séries is Shows here, and the
		// library screen now reads that way instead of showing two shelves for one.
		expect(shows).toMatchObject({ name: 'Shows', itemCount: 38 });
		expect(shows?.libraryIds.sort()).toEqual([seriesId, showsId].sort());
		expect((await library(seriesId)).alias).toBe('Shows');
	});

	it('leaves the friend’s library in its own category, under its own name', async () => {
		const after = await categories();
		const series = after.find((category) => category.key === 'series');

		expect(series).toMatchObject({ itemCount: 7, libraryIds: [theirSeriesId] });
		expect((await library(theirSeriesId)).alias).toBeNull();
	});

	it('keeps the name when the destination is cleared, and still stops placing there', async () => {
		// The decision written down in `SettingsManager._followCategoryTargets`: an alias
		// somebody may have typed by hand is indistinguishable from one a mapping wrote,
		// so clearing an unrelated setting must not destroy a name. Coming back is one
		// rename on the libraries screen.
		await patch({ categoryTargets: {} }).expect(200);

		const after = await categories();

		expect(after.find((category) => category.key === 'shows')).toMatchObject({ itemCount: 38 });
		expect((await library(seriesId)).alias).toBe('Shows');
	});

	it('leaves a name somebody typed by hand alone when a mapping is cleared', async () => {
		await request(context.app.getHttpServer())
			.patch(`/api/libraries/${showsId}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ alias: 'Séries et animés' })
			.expect(200);

		await patch({ categoryTargets: { animes: seriesId } }).expect(200);
		await patch({ categoryTargets: {} }).expect(200);

		expect((await library(showsId)).alias).toBe('Séries et animés');
	});
});
