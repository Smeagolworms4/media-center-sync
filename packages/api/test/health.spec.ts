import request from 'supertest';
import type { Health } from '@mcs/shared';
import { createTestApp, type TestApp } from './utils/app-factory';

describe('GET /api/health', () => {
	let context: TestApp;

	beforeAll(async () => {
		context = await createTestApp();
	});

	afterAll(async () => {
		await context.close();
	});

	it('answers without a token: the container polls it before anybody has signed in', async () => {
		const response = await request(context.app.getHttpServer()).get('/api/health').expect(200);
		const health = response.body as Health;

		expect(health.ok).toBe(true);
		expect(health.version).toBeDefined();
		expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
	});

	it('reports the database it actually queried', async () => {
		const response = await request(context.app.getHttpServer()).get('/api/health');
		const health = response.body as Health;
		const database = health.checks.find((check) => check.name === 'database');

		expect(database?.ok).toBe(true);
		// The engine it names, not a constant: the suite runs on the `sqlite3` binding
		// and the image on `better-sqlite3`, and the point of the check is that it
		// reports the connection it really queried.
		expect(database?.detail).toContain('sqlite');
	});

	it('reports the media root as its own check', async () => {
		const response = await request(context.app.getHttpServer()).get('/api/health');
		const health = response.body as Health;

		expect(health.checks.map((check) => check.name)).toEqual(['database', 'media-root']);
	});

	it('is served under the api prefix and nowhere else', async () => {
		await request(context.app.getHttpServer()).get('/health').expect(404);
	});
});
