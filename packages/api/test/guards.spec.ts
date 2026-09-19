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
/** A well-formed identifier nothing holds, so a route's answer is about the right. */
const ABSENT = '00000000-0000-4000-8000-000000000000';

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

	/*
	 * Browsing is not a reason to be trusted with the catalogue.
	 *
	 * Both override routes sat behind `MEDIA_READ`, which a guest carries, so anybody
	 * who could look at the library could rewrite a title, change a year, or file a
	 * media into another library — and the correction is written into the fields
	 * correlation and filing read, so it is as much a write as a transfer is. Found by
	 * a journey author reading the rights table, not by anything that was failing.
	 */
	it('refuses a guest the right to rewrite what a media server reported', async () => {
		const overridden = await request(context.app.getHttpServer())
			.put(`/api/media/${ABSENT}/override`)
			.set('Authorization', `Bearer ${guest.token}`)
			.send({ title: 'Anything at all' })
			.expect(403);

		expect(overridden.body).toMatchObject({ message: 'error.auth.forbidden' });

		await request(context.app.getHttpServer())
			.delete(`/api/media/${ABSENT}/override`)
			.set('Authorization', `Bearer ${guest.token}`)
			.expect(403);
	});

	it('lets a caller who carries the write right through to the media itself', async () => {
		// A 404 rather than a 403: the right was granted and the identifier is simply
		// not one we hold. That distinction is the whole assertion — a 403 here would
		// mean the route is shut to everybody, which passes for the wrong reason.
		await request(context.app.getHttpServer())
			.put(`/api/media/${ABSENT}/override`)
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ title: 'Anything at all' })
			.expect(404);
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
