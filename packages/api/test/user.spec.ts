import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { UserRole, type User } from '@mcs/shared';
import { UserRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/** An identifier that is a valid UUID and belongs to nobody. */
const ABSENT = '11111111-2222-4333-8444-555555555555';

describe('Accounts', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let guest: TestIdentity;
	let mirroredId: string;
	let internalId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		guest = await signInAs(context, UserRole.GUEST);

		const users = context.app.get(UserRepository);

		mirroredId = (
			await users.save(
				users.create({
					username: 'jelly-bob',
					displayName: 'Bob',
					role: UserRole.USER,
					// Mirrored from a media service: the gateway does not own the name or
					// the password, only the role.
					provider: 'jellyfin',
					providerUserId: 'bob-at-jellyfin',
				}),
			)
		).id;

		internalId = (
			await users.save(
				users.create({
					username: 'internal-carol',
					role: UserRole.USER,
					provider: 'internal',
					passwordHash: 'a-hash-nobody-should-ever-see',
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	const read = (path: string, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/users${path}`)
			.set('Authorization', `Bearer ${identity.token}`);

	const patch = (id: string, body: Record<string, unknown>, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.patch(`/api/users/${id}`)
			.set('Authorization', `Bearer ${identity.token}`)
			.send(body);

	describe('reading', () => {
		it('lists every account, whatever authenticated it', async () => {
			const response = await read('').expect(200);
			const list = response.body as User[];

			expect(list.map((user) => user.username)).toEqual(expect.arrayContaining([
				'internal-carol',
				'jelly-bob',
			]));
			expect(list.find((user) => user.id === mirroredId)).toMatchObject({
				username: 'jelly-bob',
				displayName: 'Bob',
				role: UserRole.USER,
				provider: 'jellyfin',
				providerUserId: 'bob-at-jellyfin',
			});
		});

		it('never hands out a password hash, on a list or on a read', async () => {
			const list = await read('').expect(200);
			const one = await read(`/${internalId}`).expect(200);

			for (const payload of [list.body, one.body]) {
				expect(JSON.stringify(payload)).not.toContain('a-hash-nobody-should-ever-see');
				expect(JSON.stringify(payload)).not.toContain('passwordHash');
			}
		});

		it('answers one account', async () => {
			const response = await read(`/${internalId}`).expect(200);

			expect(response.body as User).toMatchObject({ id: internalId, username: 'internal-carol' });
		});

		it('answers a key for an account nobody holds', async () => {
			const response = await read(`/${ABSENT}`).expect(404);

			expect(response.body).toMatchObject({ message: 'error.user.not_found' });
		});

		it('refuses an identifier that is not one', async () => {
			await read('/not-a-uuid').expect(400);
		});
	});

	describe('updating', () => {
		it('accepts `displayName`', async () => {
			await patch(internalId, { displayName: 'Carol' }).expect(200);

			expect(((await read(`/${internalId}`).expect(200)).body as User).displayName).toBe('Carol');
		});

		it('accepts `email`', async () => {
			await patch(internalId, { email: 'carol@example.org' }).expect(200);

			expect(((await read(`/${internalId}`).expect(200)).body as User).email).toBe(
				'carol@example.org',
			);
		});

		it('accepts `role`', async () => {
			await patch(internalId, { role: UserRole.GUEST }).expect(200);

			expect(((await read(`/${internalId}`).expect(200)).body as User).role).toBe(UserRole.GUEST);

			await patch(internalId, { role: UserRole.USER }).expect(200);
		});

		it('leaves every field the request did not name alone', async () => {
			const before = (await read(`/${internalId}`).expect(200)).body as User;

			await patch(internalId, { displayName: 'Carol again' }).expect(200);

			const after = (await read(`/${internalId}`).expect(200)).body as User;

			expect(after.displayName).toBe('Carol again');
			expect(after.email).toBe(before.email);
			expect(after.role).toBe(before.role);
			expect(after.username).toBe(before.username);
			expect(after.provider).toBe(before.provider);
		});

		it('clears a field on an explicit null, which is not the same as omitting it', async () => {
			await patch(internalId, { displayName: null }).expect(200);

			expect(((await read(`/${internalId}`).expect(200)).body as User).displayName).toBeNull();
		});

		it('changes the role of a mirrored account, because the role is ours', async () => {
			await patch(mirroredId, { role: UserRole.GUEST }).expect(200);

			expect(((await read(`/${mirroredId}`).expect(200)).body as User).role).toBe(UserRole.GUEST);

			await patch(mirroredId, { role: UserRole.USER }).expect(200);
		});

		it('offers no way to rename anybody, mirrored or not', async () => {
			// The manager refuses renaming a mirrored account, but the DTO declares no
			// `username` at all — so over HTTP the whitelist answers first and the rule
			// never runs. The refusal the manager holds is for the callers that are not
			// this route: a command, an import. Asserted so that adding `username` to the
			// DTO is a deliberate act with a test to update rather than a silent opening.
			const response = await patch(mirroredId, { username: 'renamed' }).expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('username');
		});

		it('refuses a property the DTO never declared', async () => {
			const response = await patch(internalId, { provider: 'internal' }).expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('provider');
		});

		it('refuses a role that is not one, and an address that is not one', async () => {
			await patch(internalId, { role: 'superuser' }).expect(400);
			await patch(internalId, { email: 'not an address' }).expect(400);
		});

		it('answers a key for an account nobody holds', async () => {
			const response = await patch(ABSENT, { displayName: 'Ghost' }).expect(404);

			expect(response.body).toMatchObject({ message: 'error.user.not_found' });
		});
	});

	describe('deleting', () => {
		it('deletes an account and forgets it', async () => {
			const users = context.app.get(UserRepository);
			const doomed = await users.save(
				users.create({ username: `doomed-${randomUUID().slice(0, 8)}`, role: UserRole.USER, provider: 'internal' }),
			);

			await request(context.app.getHttpServer())
				.delete(`/api/users/${doomed.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			await read(`/${doomed.id}`).expect(404);
		});

		it('answers a key for an account nobody holds', async () => {
			const response = await request(context.app.getHttpServer())
				.delete(`/api/users/${ABSENT}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(404);

			expect(response.body).toMatchObject({ message: 'error.user.not_found' });
		});
	});

	describe('rights', () => {
		it('refuses a guest every route, because accounts need USER_MANAGE', async () => {
			await read('', guest).expect(403);
			await read(`/${internalId}`, guest).expect(403);
			await patch(internalId, { displayName: 'Mine now' }, guest).expect(403);
			await request(context.app.getHttpServer())
				.delete(`/api/users/${internalId}`)
				.set('Authorization', `Bearer ${guest.token}`)
				.expect(403);
		});

		it('refuses an anonymous caller entirely', async () => {
			await request(context.app.getHttpServer()).get('/api/users').expect(401);
		});
	});
});

/**
 * The last administrator, on a gateway that has exactly one.
 *
 * Its own application, because the rule is about how many administrator rows exist and
 * a suite that created a second one anywhere would stop testing anything. There is no
 * screen for recovering from a gateway nobody can configure: the account simply stops
 * being able to do anything, and the way back in is a shell on the host.
 */
describe('The last administrator', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	it('cannot be demoted', async () => {
		const response = await request(context.app.getHttpServer())
			.patch(`/api/users/${admin.user.id}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ role: UserRole.USER })
			.expect(409);

		// Its own key rather than a generic refusal: "forbidden" on the screen where you
		// are the administrator reads as a bug rather than as a safeguard.
		expect(response.body).toMatchObject({ message: 'error.user.last_admin' });
	});

	it('cannot be deleted', async () => {
		const response = await request(context.app.getHttpServer())
			.delete(`/api/users/${admin.user.id}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(409);

		expect(response.body).toMatchObject({ message: 'error.user.last_admin' });
	});

	it('can be demoted once there is a second one', async () => {
		const users = context.app.get(UserRepository);
		const second = await users.save(
			users.create({ username: 'second-admin', role: UserRole.ADMIN, provider: 'internal' }),
		);

		await request(context.app.getHttpServer())
			.patch(`/api/users/${second.id}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ role: UserRole.USER })
			.expect(200);
	});
});
