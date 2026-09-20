import request from 'supertest';
import {
	NotificationChannelType,
	NotificationEvent,
	UserRole,
	type NotificationChannel,
	type NotificationTestResult,
} from '@mcs/shared';
import { NotificationChannelRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * Notification channels, over HTTP.
 *
 * Three things are only provable here. The first is that the secret never comes back:
 * the redaction happens in the manager, the `@Exclude()` on the entity is a second
 * net, and the serialisation interceptor that would apply it is wiring rather than
 * controller code — so a unit test on the manager cannot see whether the shipped
 * application leaks the token anyway.
 *
 * The second is that `config` survives the validation pipe. It is declared as a bare
 * object, and a pipe configured to strip what it does not recognise is exactly how a
 * feature like this arrives with its settings silently emptied — which has happened
 * three times in this API already, to `alias`, `position` and `relay`.
 *
 * The third is the guard: the list alone names the mailbox and the topic a household
 * uses, which is most of what somebody would need to send them a message that looks
 * like it came from here.
 *
 * Nothing in this file reaches a real server: the only channel created points at an
 * address nothing answers on, and the one test that sends asserts on the failure
 * being *reported* rather than thrown.
 */
describe('Notification channels', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let guest: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		guest = await signInAs(context, UserRole.GUEST);
	});

	afterAll(async () => {
		await context.close();
	});

	const asAdmin = () => request(context.app.getHttpServer());

	const create = (body: Record<string, unknown>) =>
		asAdmin()
			.post('/api/notifications/channels')
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body);

	describe('adding one', () => {
		it('stores the settings the type needs and answers without the secret', async () => {
			const response = await create({
				type: NotificationChannelType.NTFY,
				name: 'Phones',
				events: [NotificationEvent.PLACEMENT_UNCONFIGURED],
				config: { url: 'http://127.0.0.1:9', topic: 'loft', token: 'tk_secret' },
			}).expect(201);

			const channel = response.body as NotificationChannel;

			expect(channel.config).toEqual({ url: 'http://127.0.0.1:9', topic: 'loft' });
			expect(JSON.stringify(response.body)).not.toContain('tk_secret');

			// And it really was stored, rather than stripped on the way in by a
			// validation pipe that did not recognise an opaque object.
			const stored = await context.app
				.get(NotificationChannelRepository)
				.findOne({ where: { id: channel.id } });

			expect(stored?.config).toMatchObject({ token: 'tk_secret' });
		});

		it('refuses settings the handler cannot use, naming the field', async () => {
			const response = await create({
				type: NotificationChannelType.NTFY,
				name: 'Broken',
				config: { url: 'https://ntfy.sh' },
			}).expect(400);

			expect(response.body).toMatchObject({
				key: 'error.notification.config_invalid',
				field: 'topic',
			});
		});

		it('refuses a channel type that does not exist', async () => {
			await create({
				type: 'carrier_pigeon',
				name: 'Nope',
				config: {},
			}).expect(400);
		});
	});

	describe('listing, changing and removing', () => {
		let channelId: string;

		beforeAll(async () => {
			const response = await create({
				type: NotificationChannelType.SMTP,
				name: 'Shared mailbox',
				config: {
					host: '127.0.0.1',
					port: 2525,
					from: 'gateway@example',
					to: 'household@example',
					password: 'hunter2',
				},
			}).expect(201);

			channelId = (response.body as NotificationChannel).id;
		});

		it('never returns a credential in the list either', async () => {
			const response = await asAdmin()
				.get('/api/notifications/channels')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect(JSON.stringify(response.body)).not.toContain('hunter2');
			expect(JSON.stringify(response.body)).not.toContain('tk_secret');
		});

		it('changes one field and leaves the stored secret alone', async () => {
			// The interface sends back what it was given, which has had the secrets
			// stripped out of it. A save that overwrote `config` every time would blank
			// the password on a rename.
			await asAdmin()
				.patch(`/api/notifications/channels/${channelId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ name: 'Household mailbox', enabled: false })
				.expect(200);

			const stored = await context.app
				.get(NotificationChannelRepository)
				.findOne({ where: { id: channelId } });

			expect(stored?.name).toBe('Household mailbox');
			expect(stored?.enabled).toBe(false);
			expect(stored?.config).toMatchObject({ password: 'hunter2' });
		});

		it('refuses an update that would leave the channel unable to deliver', async () => {
			await asAdmin()
				.patch(`/api/notifications/channels/${channelId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ config: { host: '127.0.0.1', from: 'gateway@example' } })
				.expect(400);
		});

		it('removes one, and says so with a key afterwards', async () => {
			await asAdmin()
				.delete(`/api/notifications/channels/${channelId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			await asAdmin()
				.get(`/api/notifications/channels/${channelId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(404);
		});
	});

	describe('the test route', () => {
		it('answers what happened rather than failing the request', async () => {
			// Port 9 is the discard port: nothing answers, which is what a channel
			// somebody typed wrongly looks like. A 502 here would report that the
			// gateway is broken about a gateway that is working perfectly.
			const response = await create({
				type: NotificationChannelType.NTFY,
				name: 'Nowhere',
				config: { url: 'http://127.0.0.1:9', topic: 'void' },
			}).expect(201);

			const { id } = response.body as NotificationChannel;

			const result = await asAdmin()
				.post(`/api/notifications/channels/${id}/test`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			const body = result.body as NotificationTestResult;

			expect(body.delivered).toBe(false);
			expect(body.error).toBeTruthy();

			// And the failure is on the row, which is the only thing that can say a
			// channel has gone quiet.
			const stored = await context.app
				.get(NotificationChannelRepository)
				.findOne({ where: { id } });

			expect(stored?.lastError).toBeTruthy();
			expect(stored?.lastSentAt).toBeNull();
		}, 20_000);
	});

	describe('who may look', () => {
		it('refuses somebody without settings.manage, list included', async () => {
			// The list alone names the mailbox and the topic this household uses.
			await asAdmin()
				.get('/api/notifications/channels')
				.set('Authorization', `Bearer ${guest.token}`)
				.expect(403);
		});

		it('refuses an unauthenticated caller outright', async () => {
			await asAdmin().get('/api/notifications/channels').expect(401);
		});
	});
});
