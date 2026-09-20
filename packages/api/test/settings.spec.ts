import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { NamingScheme, PlacementStrategy, UserRole, type Settings } from '@mcs/shared';
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
			naming: NamingScheme.STANDARD,
			maxParallelTransfers: 4,
		}).expect(200)) as { body: Settings };

		const after = (await patch({ uploadRateLimit: 2_097_152 }).expect(200)) as {
			body: Settings;
		};

		expect(after.body.uploadRateLimit).toBe(2_097_152);
		expect(after.body.placement).toBe(before.body.placement);
		expect(after.body.fixedPath).toBe(before.body.fixedPath);
		expect(after.body.naming).toBe(before.body.naming);
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
		expect(settings.naming).toBe(NamingScheme.STANDARD);
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
