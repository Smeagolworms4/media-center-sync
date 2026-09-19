import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	SpaceVerdict,
	SyncState,
	SyncTrigger,
	UserRole,
	type ResultList,
	type SyncEstimate,
	type SyncJob,
	type SyncJobItem,
	type SyncPlan,
	type SyncPreview,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { SettingsService } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

describe('Syncing', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let reader: TestIdentity;
	let destination: string;
	let remoteServiceId: string;
	let remoteLibraryId: string;
	let episodeId: string;

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

		remoteLibraryId = remoteLibrary.id;

		const episode = await items.save(
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

		episodeId = episode.id;
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
			.send({ scope: { rootItemIds: ['not-a-uuid'] } })
			.expect(400);

		expect((response.body as { message: string[] }).message.join(' ')).toContain('rootItemIds');
	});

	describe('plans', () => {
		it('creates one, reads it back and deletes it', async () => {
			const created = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					name: 'Nightly',
					trigger: SyncTrigger.MANUAL,
					scope: { categoryKeys: ['their-shows'] },
				})
				.expect(201);
			const plan = created.body as SyncPlan;

			expect(plan.enabled).toBe(true);
			expect(plan.scope).toEqual({ categoryKeys: ['their-shows'] });
			// Nobody has worked out what it comes to yet, which is a different answer
			// from zero and is shown as such.
			expect(plan.estimate).toBeNull();
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
	/**
	 * What a plan's scope comes to, asked for rather than carried on every read.
	 */
	describe('estimating a scope', () => {
		it('counts what the scope covers, and says when it covers everything', async () => {
			const bounded = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					name: 'That one episode',
					trigger: SyncTrigger.MANUAL,
					scope: { itemIds: [episodeId] },
				})
				.expect(201);

			const estimate = await request(context.app.getHttpServer())
				.post(`/api/sync/plans/${(bounded.body as SyncPlan).id}/estimate`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect(estimate.body as SyncEstimate).toMatchObject({
				itemCount: 1,
				bytes: 4096,
				unbounded: false,
				truncated: false,
			});
			expect((estimate.body as SyncEstimate).computedAt).toEqual(expect.any(String));
		});

		it('says a plan that names nothing covers everything', async () => {
			const everything = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					name: 'Everything, knowingly',
					trigger: SyncTrigger.MANUAL,
					acknowledgeUnbounded: true,
				})
				.expect(201);

			const estimate = await request(context.app.getHttpServer())
				.post(`/api/sync/plans/${(everything.body as SyncPlan).id}/estimate`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect((estimate.body as SyncEstimate).unbounded).toBe(true);
		});

		it('refuses to stand up a plan that says everything without being told to', async () => {
			const refused = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ name: 'Everything, by accident', trigger: SyncTrigger.SCHEDULE, schedule: '0 4 * * *' })
				.expect(409);

			expect(refused.body).toMatchObject({ message: 'error.sync.scope_unbounded' });
		});
	});

	/**
	 * Free space, against the real filesystem the test writes into.
	 *
	 * The sizes are computed from what the destination actually reports rather than
	 * written as constants: a test that assumed a small disk would pass on the machine
	 * it was written on and fail on the next one, which is how a check this important
	 * ends up disabled.
	 */
	describe('free space on the destination', () => {
		let freeBytes: number;
		let crowdIds: string[];
		let tightId: string;
		let reserveBytes: number;

		beforeAll(async () => {
			const stats = await statfs(destination);

			freeBytes = Number(stats.bavail) * Number(stats.bsize);
			reserveBytes = Math.min(Math.floor(freeBytes / 25), 1024 ** 4);

			const items = context.app.get(MediaItemRepository);
			const bigOne = async (suffix: string, size: number): Promise<string> => {
				const saved = await items.save(
					items.create({
						serviceId: remoteServiceId,
						libraryId: remoteLibraryId,
						externalId: `their-${suffix}`,
						kind: MediaKind.MOVIE,
						title: `Something large ${suffix}`,
						normalizedTitle: `something large ${suffix}`,
						syncState: SyncState.LOCAL_ONLY,
						file: {
							path: `/srv/shows/large-${suffix}.mkv`,
							size,
							container: 'mkv',
							videoCodec: 'hevc',
							audioCodec: 'aac',
							width: 3840,
							height: 2160,
							durationMs: 4000,
							bitrate: 20_000_000,
							quickHash: `v1:${suffix}`,
							contentId: `v1:${suffix}:${size}`,
							checksum: null,
						},
					}),
				);

				return saved.id;
			};

			// Three films that each fit on their own and do not fit together. That is the
			// case the per-file check inside placement cannot see, and the reason the
			// comparison is made over the whole run.
			crowdIds = [
				await bigOne('a', Math.floor(freeBytes * 0.4)),
				await bigOne('b', Math.floor(freeBytes * 0.4)),
				await bigOne('c', Math.floor(freeBytes * 0.4)),
			];

			// One film that fits, and leaves less than the reserve behind it.
			tightId = await bigOne('tight', freeBytes - Math.floor(reserveBytes / 2));

			await context.app.get(SettingsService).update({ diskReserveBytes: reserveBytes });
		});

		afterAll(async () => {
			await context.app.get(SettingsService).update({ diskReserveBytes: 0 });
		});

		it('says in the preview that the destination cannot take it', async () => {
			const response = await request(context.app.getHttpServer())
				.post('/api/sync/preview')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: crowdIds } })
				.expect(200);
			const preview = response.body as SyncPreview;

			expect(preview.targets).toHaveLength(1);
			expect(preview.targets[0]).toMatchObject({
				verdict: SpaceVerdict.INSUFFICIENT,
				freeBytes,
			});
			expect(preview.targets[0].requiredBytes).toBe(preview.bytesPlanned);
		});

		it('refuses the run outright, and starts nothing', async () => {
			const before = await request(context.app.getHttpServer())
				.get('/api/sync/jobs?page=1&limit=1')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			const refused = await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				// Acknowledged, and still refused: this one is arithmetic.
				.send({ scope: { itemIds: crowdIds }, acknowledgeSpace: true })
				.expect(409);

			expect(refused.body).toMatchObject({ key: 'error.sync.not_enough_space' });

			const after = await request(context.app.getHttpServer())
				.get('/api/sync/jobs?page=1&limit=1')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect((after.body as ResultList<SyncJob>).pagination.total).toBe(
				(before.body as ResultList<SyncJob>).pagination.total,
			);
		});

		it('asks before eating into the reserve', async () => {
			const asked = await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: [tightId] } })
				.expect(409);

			expect(asked.body).toMatchObject({ key: 'error.sync.space_not_acknowledged' });
			expect((asked.body as { targets: { verdict: string }[] }).targets[0].verdict).toBe(
				SpaceVerdict.TIGHT,
			);
		});

		it('starts once somebody has said so', async () => {
			await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: [episodeId] }, acknowledgeSpace: true })
				.expect(202);
		});
	});

	describe('the detail of a run', () => {
		it('serves a page of lines, each carrying where it will land', async () => {
			const run = await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: [episodeId] } })
				.expect(202);
			const job = run.body as SyncJob;

			expect(job.itemsPlanned).toBe(1);
			expect(job.scope).toEqual({ itemIds: [episodeId] });
			expect(job.targets).toHaveLength(1);

			const lines = await request(context.app.getHttpServer())
				.get(`/api/sync/jobs/${job.id}/items?page=1&limit=10`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);
			const page = lines.body as ResultList<SyncJobItem>;

			expect(page.pagination).toMatchObject({ page: 1, limit: 10, total: 1 });
			expect(page.items[0]).toMatchObject({
				itemId: episodeId,
				title: 'The Hunt',
				bytes: 4096,
				jobId: job.id,
			});
			expect(page.items[0].targetPath.startsWith(destination)).toBe(true);
		});

		it('keeps the lines a ceiling dropped, so the run can explain itself', async () => {
			const run = await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: [episodeId] }, maxItemsPerRun: 0 })
				.expect(202);
			const job = run.body as SyncJob;

			expect(job).toMatchObject({ itemsPlanned: 0, stoppedBy: 'max_items' });

			const lines = await request(context.app.getHttpServer())
				.get(`/api/sync/jobs/${job.id}/items`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect((lines.body as ResultList<SyncJobItem>).items).toEqual([
				expect.objectContaining({ itemId: episodeId, state: 'skipped' }),
			]);
		});

		it('leaves nothing pending on a run somebody stopped', async () => {
			const run = await request(context.app.getHttpServer())
				.post('/api/sync/run')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { itemIds: [episodeId] } })
				.expect(202);
			const job = run.body as SyncJob;

			await request(context.app.getHttpServer())
				.post(`/api/sync/jobs/${job.id}/cancel`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			const lines = await request(context.app.getHttpServer())
				.get(`/api/sync/jobs/${job.id}/items`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			// Not "skipped" exactly: the transfer of an unreachable source may have failed
			// on its own first, and that is a truer answer than the cancellation. What is
			// asserted is the claim that matters — a stopped run whose lines still say
			// they are waiting is one that looks like it is still going.
			expect(['skipped', 'failed', 'done']).toContain(
				(lines.body as ResultList<SyncJobItem>).items[0].state,
			);
		});

		it('answers a key for a run nobody has', async () => {
			const gone = await request(context.app.getHttpServer())
				.get('/api/sync/jobs/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b/items')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(404);

			expect(gone.body).toMatchObject({ message: 'error.sync.job_not_found' });
		});
	});
});
