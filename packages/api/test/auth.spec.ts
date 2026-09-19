import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import request from 'supertest';
import { UserRole, type AuthProvider, type SessionUser, type TokenPair } from '@mcs/shared';
import { UserRepository } from '@/repositories';
import { createTestApp, type TestApp } from './utils/app-factory';

const PASSWORD = 'correct-horse';

/**
 * Sign-in, over the real application.
 *
 * The unit tests pin the rules; this pins the thing people actually talk to — the
 * validation pipe, the guards and the serialisation interceptor included. None of
 * those are controller code, and all of them can be removed without a single test on a
 * manager noticing.
 */
describe('Sessions', () => {
	let context: TestApp;
	let username: string;

	beforeAll(async () => {
		context = await createTestApp();
		username = `signin-${randomUUID().slice(0, 8)}`;

		const users = context.app.get(UserRepository);

		await users.save(
			users.create({
				username,
				role: UserRole.ADMIN,
				provider: 'internal',
				passwordHash: await hash(PASSWORD, 4),
			}),
		);
	});

	afterAll(async () => {
		await context.close();
	});

	const signIn = (password = PASSWORD): request.Test =>
		request(context.app.getHttpServer())
			.post('/api/auth/login')
			.send({ provider: 'internal', username, password });

	it('offers the internal way in before anything is registered', async () => {
		const response = await request(context.app.getHttpServer())
			.get('/api/auth/providers')
			.expect(200);
		const providers = response.body as AuthProvider[];

		expect(providers.map((provider) => provider.key)).toEqual(['internal']);
	});

	it('signs in and hands back a pair with the rights of the role', async () => {
		const response = await signIn().expect(200);
		const pair = response.body as TokenPair;

		expect(pair.accessToken).toEqual(expect.any(String));
		expect(pair.refreshToken).toEqual(expect.any(String));
		expect(pair.expiresIn).toBeGreaterThan(0);
		expect(pair.rights).toContain('service.manage');
	});

	it('never lets the password hash out, whatever the entity carries', async () => {
		const response = await signIn().expect(200);

		expect(JSON.stringify(response.body)).not.toContain('passwordHash');
		expect(JSON.stringify(response.body)).not.toContain('$2');
	});

	it('answers a key, never a sentence, for a wrong password', async () => {
		const response = await signIn('nope').expect(401);

		expect(response.body).toMatchObject({ message: 'error.auth.invalid_credentials' });
	});

	it('exchanges a refresh token for a new pair', async () => {
		const first = (await signIn().expect(200)).body as TokenPair;

		const response = await request(context.app.getHttpServer())
			.post('/api/auth/refresh')
			.send({ refreshToken: first.refreshToken })
			.expect(200);
		const second = response.body as TokenPair;

		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect(second.accessToken).toEqual(expect.any(String));
	});

	it('refuses the same refresh token a second time', async () => {
		const pair = (await signIn().expect(200)).body as TokenPair;

		await request(context.app.getHttpServer())
			.post('/api/auth/refresh')
			.send({ refreshToken: pair.refreshToken })
			.expect(200);

		const replay = await request(context.app.getHttpServer())
			.post('/api/auth/refresh')
			.send({ refreshToken: pair.refreshToken })
			.expect(401);

		expect(replay.body).toMatchObject({ message: 'error.auth.session_expired' });
	});

	it('says who is signed in, and refuses to say it to nobody', async () => {
		const pair = (await signIn().expect(200)).body as TokenPair;

		const response = await request(context.app.getHttpServer())
			.get('/api/auth/me')
			.set('Authorization', `Bearer ${pair.accessToken}`)
			.expect(200);

		expect((response.body as SessionUser).username).toBe(username);

		const anonymous = await request(context.app.getHttpServer())
			.get('/api/auth/me')
			.expect(401);

		// A key, like every other failure. A route needing a session but naming no right
		// is the one place passport's plain "Unauthorized" would have got through.
		expect(anonymous.body).toMatchObject({ message: 'error.auth.session_expired' });
	});

	it('signs out of every session of the account', async () => {
		const pair = (await signIn().expect(200)).body as TokenPair;

		await request(context.app.getHttpServer())
			.post('/api/auth/logout')
			.set('Authorization', `Bearer ${pair.accessToken}`)
			.expect(204);

		// The access token is checked against its session row on every call, so signing
		// out takes effect now rather than when the token would have expired.
		await request(context.app.getHttpServer())
			.get('/api/auth/me')
			.set('Authorization', `Bearer ${pair.accessToken}`)
			.expect(401);
	});

	it('rejects a body that is missing a field, with the field named', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/auth/login')
			.send({ provider: 'internal' })
			.expect(400);
		const messages = (response.body as { message: string[] }).message;

		expect(messages.some((entry) => entry.startsWith('username'))).toBe(true);
		expect(messages.some((entry) => entry.startsWith('password'))).toBe(true);
	});
});
