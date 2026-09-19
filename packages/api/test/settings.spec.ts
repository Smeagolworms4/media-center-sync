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
