import request from 'supertest';
import { UserRole } from '@mcs/shared';
import { createTestApp, signInAs, type TestApp } from './utils';

/**
 * A gateway nobody has claimed yet.
 *
 * This is the one moment the API lets somebody in without credentials, and the only
 * thing that makes it safe is that the door shuts the instant an account exists. It
 * is worth a functional test rather than a unit one: what matters is that the route
 * really is reachable without a token, and that it really stops being useful.
 */
describe('the first administrator', () => {
	let context: TestApp;

	beforeEach(async () => {
		context = await createTestApp();
	});

	afterEach(async () => {
		await context.app.close();
	});

	it('says it needs setting up while no account exists', async () => {
		const response = await request(context.app.getHttpServer()).get('/api/auth/setup').expect(200);

		expect(response.body).toMatchObject({ required: true });
	});

	it('creates the account without a token, and signs it in straight away', async () => {
		// Answering a session rather than a redirect: telling somebody to go and log in
		// with the credentials they just typed is a step for nobody.
		const response = await request(context.app.getHttpServer())
			.post('/api/auth/setup')
			.send({ username: 'root', password: 'a-good-password' })
			.expect(201);

		expect(response.body.user).toMatchObject({ username: 'root', role: UserRole.ADMIN });
		expect(response.body.accessToken).toEqual(expect.any(String));
	});

	it('refuses a password short enough to guess', async () => {
		await request(context.app.getHttpServer())
			.post('/api/auth/setup')
			.send({ username: 'root', password: 'short' })
			.expect(400);
	});

	it('shuts the door as soon as an account exists', async () => {
		await signInAs(context, UserRole.GUEST);

		const state = await request(context.app.getHttpServer()).get('/api/auth/setup').expect(200);

		expect(state.body).toMatchObject({ required: false });

		// Even a guest account closes it. The check is "is this gateway claimed", not
		// "does it have an administrator" — anything else leaves the door open on a
		// gateway somebody is already using.
		await request(context.app.getHttpServer())
			.post('/api/auth/setup')
			.send({ username: 'intruder', password: 'another-password' })
			.expect(409);
	});
});
