import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	SyncState,
	SyncTrigger,
	UserRole,
	type SyncPlan,
	type SyncPreview,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

describe('Syncing', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let reader: TestIdentity;
	let destination: string;
	let remoteServiceId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		reader = await signInAs(context, UserRole.GUEST);
		destination = await mkdtemp(join(tmpdir(), 'mcs-sync-'));

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		// One service we can only read from, and one of ours whose library the gateway
		// can really write into — which is what a preview has to resolve a path against.
		const remote = await services.save(
			services.create({
				name: 'A friend',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.REMOTE,
				baseUrl: 'http://127.0.0.1:31',
				priority: 10,
			}),
		);

		remoteServiceId = remote.id;

		const local = await services.save(
			services.create({
				name: 'Ours',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://127.0.0.1:32',
				priority: 20,
			}),
		);

		await libraries.save(
			libraries.create({
				serviceId: local.id,
				externalId: 'lib-local',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
				localPath: destination,
				writable: true,
				isDefaultTarget: true,
			}),
		);

		const remoteLibrary = await libraries.save(
			libraries.create({
				serviceId: remote.id,
				externalId: 'lib-remote',
				name: 'Their shows',
				kind: LibraryKind.SHOWS,
				paths: ['/srv/shows'],
			}),
		);

		await items.save(
			items.create({
				serviceId: remote.id,
				libraryId: remoteLibrary.id,
				externalId: 'their-s01e03',
				kind: MediaKind.EPISODE,
				title: 'The Hunt',
				normalizedTitle: 'big buck bunny',
				seasonNumber: 1,
				episodeNumber: 3,
				syncState: SyncState.LOCAL_ONLY,
				file: {
					path: '/srv/shows/Big.Buck.Bunny.S01E03.1080p.mkv',
					size: 4096,
					container: 'mkv',
					videoCodec: 'hevc',
					audioCodec: 'aac',
					width: 1920,
					height: 1080,
					durationMs: 4000,
					bitrate: 2_000_000,
					quickHash: 'v1:abc',
					contentId: 'v1:abc:4096',
					checksum: null,
				},
			}),
		);
	});

	afterAll(async () => {
		await context.close();
		await rm(destination, { recursive: true, force: true });
	});

	it('previews what a run would pull, and where it would land', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({})
			.expect(200);
		const preview = response.body as SyncPreview;

		expect(preview.itemsPlanned).toBe(1);
		expect(preview.bytesPlanned).toBe(4096);
		expect(preview.items[0]).toMatchObject({
			title: 'The Hunt',
			kind: MediaKind.EPISODE,
			sourceServiceId: remoteServiceId,
			sourceServiceName: 'A friend',
			state: SyncState.MISSING,
			bytes: 4096,
		});
		expect(preview.items[0].targetPath.startsWith(destination)).toBe(true);
	});

	it('changes nothing: the queue is still empty afterwards', async () => {
		await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({})
			.expect(200);

		const queue = await request(context.app.getHttpServer())
			.get('/api/transfers')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		expect((queue.body as { pagination: { total: number } }).pagination.total).toBe(0);
	});

	it('honours the filter it was given', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ filter: { maxBytes: 100 } })
			.expect(200);

		expect((response.body as SyncPreview).itemsPlanned).toBe(0);
	});

	it('refuses a preview to somebody without the right to read syncs', async () => {
		await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${reader.token}`)
			.send({})
			.expect(403);
	});

	it('rejects a body whose identifiers are not identifiers', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ rootItemId: 'not-a-uuid' })
			.expect(400);

		expect((response.body as { message: string[] }).message.join(' ')).toContain('rootItemId');
	});

	describe('plans', () => {
		it('creates one, reads it back and deletes it', async () => {
			const created = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ name: 'Nightly', trigger: SyncTrigger.MANUAL })
				.expect(201);
			const plan = created.body as SyncPlan;

			expect(plan.enabled).toBe(true);
			// Empty means "follow the priority set in the administration screen".
			expect(plan.sourceServiceIds).toEqual([]);

			await request(context.app.getHttpServer())
				.get(`/api/sync/plans/${plan.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			await request(context.app.getHttpServer())
				.patch(`/api/sync/plans/${plan.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ enabled: false })
				.expect(200);

			await request(context.app.getHttpServer())
				.delete(`/api/sync/plans/${plan.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			const gone = await request(context.app.getHttpServer())
				.get(`/api/sync/plans/${plan.id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(404);

			expect(gone.body).toMatchObject({ message: 'error.sync.plan_not_found' });
		});
	});

	it('answers 202 for a run, and hands back the job', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/run')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ filter: { maxBytes: 1 } })
			.expect(202);

		expect(response.body).toMatchObject({ itemsPlanned: 0, planId: null });
	});

	it('pages the run history', async () => {
		const response = await request(context.app.getHttpServer())
			.get('/api/sync/jobs?page=1&limit=10')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		expect(response.body).toMatchObject({ pagination: { page: 1, limit: 10 } });
	});
});
