import request from 'supertest';
import { MediaServiceScope, MediaServiceType, type MediaService } from '@mcs/shared';
import { MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A port that refuses immediately.
 *
 * The registration probes the service, and a real address would either hang for the
 * handler's whole timeout or — worse — reach something. Port 9 is the discard service:
 * nothing listens on it in a container, so the connection is refused at once and the
 * probe answers "unreachable", which is exactly the case worth exercising here.
 */
const UNREACHABLE = 'http://127.0.0.1:9';

describe('Media services', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context);
	});

	afterAll(async () => {
		await context.close();
	});

	const authorised = (): request.Test =>
		request(context.app.getHttpServer())
			.post('/api/services')
			.set('Authorization', `Bearer ${admin.token}`);

	it('registers a service and answers with it', async () => {
		const response = await authorised()
			.send({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: UNREACHABLE,
				token: 'a-very-secret-api-key',
			})
			.expect(201);
		const service = response.body as MediaService;

		expect(service.id).toEqual(expect.any(String));
		expect(service.name).toBe('Living room');
		// Registering a service that does not answer is allowed: somebody configures the
		// gateway before starting the media server as often as the other way round.
		expect(service.status).toBe('offline');
	});

	it('never returns the token, on create or on any read afterwards', async () => {
		const created = await authorised()
			.send({
				name: 'Kitchen',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.REMOTE,
				baseUrl: 'http://127.0.0.1:10',
				token: 'a-very-secret-api-key',
			})
			.expect(201);

		const list = await request(context.app.getHttpServer())
			.get('/api/services')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		const one = await request(context.app.getHttpServer())
			.get(`/api/services/${(created.body as MediaService).id}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		for (const payload of [created.body, list.body, one.body]) {
			expect(JSON.stringify(payload)).not.toContain('a-very-secret-api-key');
			expect(JSON.stringify(payload)).not.toContain('"token"');
		}

		// And it really was stored: the leak being tested is the response, not the write.
		const stored = await context.app
			.get(MediaServiceRepository)
			.findWithSecrets((created.body as MediaService).id);

		expect(stored?.token).toBe('a-very-secret-api-key');
	});

	it('refuses the same base URL twice', async () => {
		const body = {
			name: 'Twice',
			type: MediaServiceType.JELLYFIN,
			scope: MediaServiceScope.LOCAL,
			baseUrl: 'http://127.0.0.1:11',
		};

		await authorised().send(body).expect(201);

		const response = await authorised().send({ ...body, name: 'Again' }).expect(409);

		expect(response.body).toMatchObject({ message: 'error.service.duplicate' });
	});

	describe('validation', () => {
		it('rejects a bad body with one message per field', async () => {
			const response = await authorised()
				.send({ name: '', type: 'betamax', scope: 'local', baseUrl: 'not a url' })
				.expect(400);
			const messages = (response.body as { message: string[] }).message;

			expect(messages.some((entry) => entry.startsWith('name'))).toBe(true);
			expect(messages.some((entry) => entry.startsWith('type'))).toBe(true);
			expect(messages.some((entry) => entry.startsWith('baseUrl'))).toBe(true);
		});

		it('refuses a property the DTO never declared', async () => {
			// Without `forbidNonWhitelisted` this would be dropped quietly, and a body
			// carrying `role: "admin"` into an update meant for a display name would look
			// like nothing had happened.
			const response = await authorised()
				.send({
					name: 'Sneaky',
					type: MediaServiceType.JELLYFIN,
					scope: MediaServiceScope.LOCAL,
					baseUrl: 'http://127.0.0.1:12',
					status: 'online',
				})
				.expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('status');
		});

		it('accepts an address with no top-level domain, which is the only kind that matters', async () => {
			await authorised()
				.send({
					name: 'By hostname',
					type: MediaServiceType.JELLYFIN,
					scope: MediaServiceScope.LOCAL,
					baseUrl: 'http://jellyfin:8096',
				})
				.expect(201);
		});
	});

	it('answers a probe of something unregistered rather than throwing', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/services/probe')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ type: MediaServiceType.JELLYFIN, baseUrl: UNREACHABLE, token: 'wrong' })
			.expect(200);

		expect(response.body).toMatchObject({ reachable: false, authenticated: false });
	});

	it('answers 202 for a scan, because a full one takes minutes', async () => {
		const created = await authorised()
			.send({
				name: 'Scannable',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://127.0.0.1:13',
			})
			.expect(201);

		await request(context.app.getHttpServer())
			.post(`/api/services/${(created.body as MediaService).id}/scan`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(202);
	});
});
