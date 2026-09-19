import request from 'supertest';
import { UserRole } from '@mcs/shared';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * What the guards do, over the real application.
 *
 * Three questions a unit test on a manager cannot answer: does an anonymous caller get
 * in, does a signed-in caller without the right get in, and does a browser session
 * open the peer protocol. The last one is the one worth having — those routes carry a
 * link credential, and a session that worked on them would hand a user's browser the
 * catalogue somebody shared with one specific gateway.
 */
describe('Guards', () => {
	let context: TestApp;
	let guest: TestIdentity;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		guest = await signInAs(context, UserRole.GUEST);
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	it('refuses an anonymous caller on a route that names a right', async () => {
		const response = await request(context.app.getHttpServer()).get('/api/services').expect(401);

		expect(response.body).toMatchObject({ message: 'error.auth.session_expired' });
	});

	it('refuses a signed-in caller who lacks the right', async () => {
		const response = await request(context.app.getHttpServer())
			.get('/api/services')
			.set('Authorization', `Bearer ${guest.token}`)
			.expect(403);

		expect(response.body).toMatchObject({ message: 'error.auth.forbidden' });
	});

	it('lets through a caller who carries it', async () => {
		await request(context.app.getHttpServer())
			.get('/api/services')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);
	});

	it('gives a guest what a guest may read, and nothing more', async () => {
		await request(context.app.getHttpServer())
			.get('/api/media')
			.set('Authorization', `Bearer ${guest.token}`)
			.expect(200);

		await request(context.app.getHttpServer())
			.get('/api/settings')
			.set('Authorization', `Bearer ${guest.token}`)
			.expect(403);
	});

	describe('the peer protocol', () => {
		it('refuses a browser session, however good it is', async () => {
			const response = await request(context.app.getHttpServer())
				.get('/api/peer/catalogue')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.rejected' });
		});

		it('refuses an anonymous caller too', async () => {
			await request(context.app.getHttpServer()).get('/api/peer/catalogue').expect(401);
		});

		it('refuses a peer credential naming a fingerprint nothing linked to', async () => {
			const response = await request(context.app.getHttpServer())
				.get('/api/peer/catalogue')
				.set('Authorization', 'Peer deadbeef:a-signature')
				.expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.rejected' });
		});
	});
});
