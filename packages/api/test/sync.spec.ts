import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceType,
	SpaceVerdict,
	SyncState,
	SyncTrigger,
	UserRole,
	type ItemSyncPlans,
	type MediaGroup,
	type ResultList,
	type Settings,
	type SyncEstimate,
	type SyncJob,
	type SyncJobItem,
	type SyncPlan,
	type SyncPreview,
} from '@mcs/shared';
import { MediaManager } from '@/managers';
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
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:31',
				priority: 10,
			}),
		);

		remoteServiceId = remote.id;

		const local = await services.save(
			services.create({
				name: 'Ours',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
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
			// The coordinates with the episode's own name: a queue of forty rows reading
			// `The Hunt`, `Monstres`, `Mors Indecepta` says nothing about which show or
			// which season any of them belongs to.
			title: 'S01E03 — The Hunt',
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
			expect(preview.targets[0].verdict).toBe(SpaceVerdict.INSUFFICIENT);
			expect(preview.targets[0].requiredBytes).toBe(preview.bytesPlanned);

			// Close to what this suite measured, not equal to it. The two readings are
			// taken seconds apart from a live filesystem that the machine is also using,
			// and asserting equality made this test fail perhaps one run in three — for
			// a few hundred kilobytes written by something else entirely, which says
			// nothing about the verdict the test is here to pin.
			expect(Math.abs((preview.targets[0].freeBytes ?? 0) - freeBytes)).toBeLessThan(
				freeBytes * 0.01,
			);
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
				title: 'S01E03 — The Hunt',
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

	/**
	 * Where a pull lands, decided by the category it belongs to.
	 *
	 * Over HTTP because every part of the claim is somewhere else: the DTO has to let
	 * the table through at all — a key it does not declare is stripped by the validation
	 * pipe, the request answers 200 and the setting silently never arrives, which has
	 * happened three times in this repository — the settings service has to store it,
	 * and placement has to prefer it over the library that merely carries the
	 * default-target flag. A unit test proves any one of those and none of them
	 * together.
	 */
	describe('the library a category is configured to receive', () => {
		let configured: string;
		let configuredLibraryId: string;

		const patchSettings = (body: Record<string, unknown>) =>
			request(context.app.getHttpServer())
				.patch('/api/settings')
				.set('Authorization', `Bearer ${admin.token}`)
				.send(body);

		const previewTheEpisode = async (): Promise<SyncPreview> =>
			(
				await request(context.app.getHttpServer())
					.post('/api/sync/preview')
					.set('Authorization', `Bearer ${admin.token}`)
					.send({ scope: { itemIds: [episodeId] } })
					.expect(200)
			).body as SyncPreview;

		beforeAll(async () => {
			configured = await mkdtemp(join(tmpdir(), 'mcs-sync-anime-'));

			const services = context.app.get(MediaServiceRepository);
			const libraries = context.app.get(LibraryRepository);
			const local = (await services.findLocal())[0];

			// A second library of ours, and deliberately not the default target for
			// anything: the whole claim is that the category sends the file here and the
			// flag does not.
			const second = await libraries.save(
				libraries.create({
					serviceId: local?.id,
					externalId: 'lib-local-second',
					name: 'Animés',
					kind: LibraryKind.SHOWS,
					paths: ['/media/anime'],
					localPath: configured,
					writable: true,
					isDefaultTarget: false,
				}),
			);

			configuredLibraryId = second.id;
		});

		afterAll(async () => {
			await patchSettings({ categoryTargets: {} }).expect(200);
			await rm(configured, { recursive: true, force: true });
		});

		it('lands in the default library while no category names one', async () => {
			const preview = await previewTheEpisode();

			expect(preview.items[0].targetPath.startsWith(destination)).toBe(true);
		});

		it('lands in the library the category names once one is configured', async () => {
			// `their-shows` is the key of the merged category the source library belongs
			// to — folded from the name somebody reads, which is what the settings screen
			// saves against.
			const saved = await patchSettings({
				categoryTargets: { 'their-shows': configuredLibraryId },
			}).expect(200);

			// And the entry has moved, because saving it renamed the category it was
			// saved against: the mapping aliases the libraries of `their-shows` to
			// `Animés`, and a key is folded from the name people read. Left under the old
			// key it named a category that no longer existed — placement found nothing,
			// fell back to the default library, and the file landed in a folder nobody
			// chose with no error anywhere. That is the bug this line pins.
			expect((saved.body as Settings).categoryTargets).toEqual({
				animes: configuredLibraryId,
			});

			const preview = await previewTheEpisode();

			expect(preview.items[0].targetPath.startsWith(configured)).toBe(true);
			// The destination the preview reports room for, which is the other half of
			// the same answer: a path in one library and a space check against another
			// would be two readings of one decision.
			expect(preview.targets).toEqual([
				expect.objectContaining({ libraryId: configuredLibraryId, localPath: configured }),
			]);
		});

		it('survives a reread, so the table was stored and not merely echoed', async () => {
			const settings = await request(context.app.getHttpServer())
				.get('/api/settings')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect((settings.body as Settings).categoryTargets).toEqual({
				animes: configuredLibraryId,
			});
		});

		it('goes back to the default library when the entry is taken away', async () => {
			await patchSettings({ categoryTargets: {} }).expect(200);

			const preview = await previewTheEpisode();

			expect(preview.items[0].targetPath.startsWith(destination)).toBe(true);
		});

		it('falls back to the default library when a stored key names no category', async () => {
			// The stale entry, written directly so the table really holds a key nothing
			// reads as — which is what a rename on the libraries screen produces after a
			// mapping, and what the re-keying above prevents when the mapping itself
			// causes it. The file is not lost and the transfer does not fail; it lands in
			// the default library. That it lands there *recorded as a step nobody chose*
			// is pinned in `placed-by.spec.ts`, which is where the step is decided — the
			// preview does not carry `placedBy`, a run's lines do.
			await patchSettings({
				categoryTargets: { 'a-category-nothing-reads-as': configuredLibraryId },
			}).expect(200);

			const preview = await previewTheEpisode();

			expect(preview.items[0].targetPath.startsWith(destination)).toBe(true);

			await patchSettings({ categoryTargets: {} }).expect(200);
		});

		it('refuses a destination that is neither an identifier nor a path', async () => {
			// A path is an answer now — one of a library's own roots, since a library can
			// be several directories. Anything that is neither is still refused here
			// rather than stored and quietly ignored.
			const refused = await patchSettings({
				categoryTargets: { 'their-shows': 'somewhere' },
			}).expect(400);

			expect(refused.body).toMatchObject({
				key: 'error.settings.invalid',
				field: 'categoryTargets',
			});
		});
	});

	/**
	 * Several versions of one film, asked for in one call.
	 *
	 * Booted over a real database and gone through over HTTP because every part of the
	 * claim is somewhere else: the DTO has to accept two services, the planner has to
	 * keep two versions apart, and placement has to give them two paths. A unit test can
	 * prove any one of those and none of them together, and the way this used to fail —
	 * one transfer planned, the run reporting success, one of the two cuts never fetched
	 * and the other overwritten — leaves nothing behind to notice.
	 */
	describe('several versions of one media', () => {
		let theatricalId: string;
		let extendedId: string;
		let secondServiceId: string;

		beforeAll(async () => {
			const services = context.app.get(MediaServiceRepository);
			const libraries = context.app.get(LibraryRepository);
			const items = context.app.get(MediaItemRepository);

			const second = await services.save(
				services.create({
					name: 'Another friend',
					type: MediaServiceType.PLEX,
					filesMounted: false,
					baseUrl: 'http://127.0.0.1:33',
					priority: 30,
				}),
			);

			secondServiceId = second.id;

			const secondLibrary = await libraries.save(
				libraries.create({
					serviceId: second.id,
					externalId: 'lib-second',
					name: 'Their films',
					kind: LibraryKind.MOVIES,
					paths: ['/srv/films'],
				}),
			);

			const film = async (
				serviceId: string,
				libraryId: string,
				externalId: string,
				overrides: Record<string, unknown>,
			): Promise<string> =>
				(
					await items.save(
						items.create({
							serviceId,
							libraryId,
							externalId,
							kind: MediaKind.MOVIE,
							title: 'Titanic',
							normalizedTitle: 'titanic',
							year: 1997,
							externalIds: { imdb: 'tt0120338' },
							syncState: SyncState.MISSING,
							...overrides,
						}),
					)
				).id;

			const reel = (overrides: Record<string, unknown>): Record<string, unknown> => ({
				path: '/srv/films/Titanic (1997)/Titanic (1997).mkv',
				size: 4096,
				container: 'mkv',
				videoCodec: 'hevc',
				audioCodec: 'aac',
				width: 1920,
				height: 1080,
				durationMs: 11_640_000,
				bitrate: 2_000_000,
				checksum: null,
				...overrides,
			});

			theatricalId = await film(remoteServiceId, remoteLibraryId, 'their-titanic', {
				file: reel({ quickHash: 'theatrical', contentId: 'q1-theatrical' }),
			});

			// The same film to every scraper — same title, same year, same IMDb number —
			// and a different cut: a quarter of an hour longer, and a different file.
			extendedId = await film(second.id, secondLibrary.id, 'second-titanic', {
				file: reel({
					quickHash: 'extended',
					contentId: 'q1-extended',
					durationMs: 11_640_000 + 15 * 60 * 1000,
					edition: 'Extended Cut',
				}),
			});
		});

		it('plans one transfer per version, from the services the call names', async () => {
			const response = await request(context.app.getHttpServer())
				.post('/api/sync/preview')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					scope: { itemIds: [theatricalId, extendedId] },
					sourceServiceIds: [remoteServiceId, secondServiceId],
				})
				.expect(200);
			const preview = response.body as SyncPreview;

			expect(preview.itemsPlanned).toBe(2);
			expect(preview.items.map((planned) => planned.itemId).sort()).toEqual(
				[theatricalId, extendedId].sort(),
			);
		});

		it('lands neither of them on a file that is already there', async () => {
			// The occupant stands in for the copy somebody already has. Both versions
			// render the same name as it does — that is the whole trap — and the one that
			// used to be overwritten is whichever finished last.
			const folder = join(destination, 'Titanic (1997)');

			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, 'Titanic (1997).mkv'), 'the copy somebody already has');

			const response = await request(context.app.getHttpServer())
				.post('/api/sync/preview')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					scope: { itemIds: [theatricalId, extendedId] },
					sourceServiceIds: [remoteServiceId, secondServiceId],
				})
				.expect(200);
			const preview = response.body as SyncPreview;
			const pathOf = (itemId: string): string =>
				preview.items.find((planned) => planned.itemId === itemId)?.targetPath ?? '';

			expect(new Set(preview.items.map((planned) => planned.targetPath)).size).toBe(2);
			// The label both media servers read: Plex parses the tag and strips it before
			// matching the title, Jellyfin takes what follows the last ` - ` as the name
			// of the version. The copy nobody labelled falls back to its resolution.
			expect(pathOf(extendedId)).toBe(join(folder, 'Titanic (1997) - {edition-Extended Cut}.mkv'));
			expect(pathOf(theatricalId)).toBe(join(folder, 'Titanic (1997) - 1080p.mkv'));

			await expect(readFile(join(folder, 'Titanic (1997).mkv'), 'utf8')).resolves.toBe(
				'the copy somebody already has',
			);
		});

		it('shows them as one media with two versions, because the identifier decides the work', async () => {
			// The real correlation, over the real index, then the grouped route — which
			// is the question somebody asks on the screen: is this one poster or two?
			// One, on the strength of the IMDb number they share; the running time only
			// decides that they are two versions of it, and the plan above already pulls
			// each of them as its own transfer.
			await context.app.get(MediaManager).correlateService(secondServiceId);

			const page = await request(context.app.getHttpServer())
				.get('/api/media/groups?kind=movie&limit=50')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);
			const groups = (page.body as ResultList<MediaGroup>).items;
			const holding = (itemId: string): MediaGroup | undefined =>
				groups.find((group) => group.sources.some((source) => source.itemId === itemId));

			expect(holding(theatricalId)?.id).toBe(holding(extendedId)?.id);
			expect(holding(theatricalId)?.sources).toHaveLength(2);
			// Each version says which it is, which is what the picker offers and what a
			// pull is chosen from — and neither is ours, so the group is still missing
			// here rather than in conflict: there is nothing local to arbitrate yet.
			expect(holding(extendedId)?.versions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ versionId: 'q1-theatrical', heldLocally: false }),
					expect.objectContaining({
						versionId: 'q1-extended',
						edition: 'Extended Cut',
						heldLocally: false,
					}),
				]),
			);
			expect(holding(extendedId)?.sync).toBe(SyncState.MISSING);
		});
	});

	/**
	 * A plan made from the media it is about, over HTTP, against real rows.
	 *
	 * The whole point of the route: the only thing somebody on a season card has to say
	 * is *this season*, and everything the blank form asked for first is either derived
	 * or asked at the moment of creation. What is proved here and nowhere else is that
	 * the guards, the validation pipe and the serialisation actually apply to it — a
	 * plan created from a card and then found in the list, with the scope it was given.
	 */
	describe('keeping a media in sync from its card', () => {
		let showId: string;
		let seasonId: string;
		let otherShowId: string;
		let spareShowId: string;
		let planId: string;

		beforeAll(async () => {
			const items = context.app.get(MediaItemRepository);

			const node = async (
				externalId: string,
				kind: MediaKind,
				title: string,
				overrides: Record<string, unknown> = {},
			): Promise<string> =>
				(
					await items.save(
						items.create({
							serviceId: remoteServiceId,
							libraryId: remoteLibraryId,
							externalId,
							kind,
							title,
							normalizedTitle: title.toLowerCase(),
							syncState: SyncState.MISSING,
							...overrides,
						}),
					)
				).id;

			showId = await node('their-show', MediaKind.SERIES, 'Bonnie');
			seasonId = await node('their-season', MediaKind.SEASON, 'Season 1', { parentId: showId });
			otherShowId = await node('their-other-show', MediaKind.SERIES, 'Clyde');
			// A show no plan ever touches, so the refusals below are refused for the
			// reason each one is about rather than for being covered already.
			spareShowId = await node('their-spare-show', MediaKind.SERIES, 'Sundance');

			await node('their-s01e01', MediaKind.EPISODE, 'The Getaway', {
				parentId: seasonId,
				seasonNumber: 1,
				episodeNumber: 1,
				normalizedTitle: 'bonnie',
				file: {
					path: '/srv/shows/Bonnie/S01E01.mkv',
					size: 8192,
					container: 'mkv',
					videoCodec: 'hevc',
					audioCodec: 'aac',
					width: 1920,
					height: 1080,
					durationMs: 4000,
					bitrate: 2_000_000,
					quickHash: 'v1:bonnie',
					contentId: 'v1:bonnie:8192',
					checksum: null,
				},
			});
		});

		it('says what the subtree comes to before anything is saved', async () => {
			const response = await request(context.app.getHttpServer())
				.post('/api/sync/estimate')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ scope: { rootItemIds: [showId] }, filter: { missingOnly: true } })
				.expect(200);

			expect(response.body as SyncEstimate).toMatchObject({
				itemCount: 1,
				bytes: 8192,
				unbounded: false,
				truncated: false,
			});
		});

		it('creates a plan scoped to the show, and it is in the list with that scope', async () => {
			const created = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ itemId: showId, trigger: SyncTrigger.MANUAL })
				.expect(201);
			const plan = created.body as SyncPlan;

			planId = plan.id;

			expect(plan).toMatchObject({
				name: 'Bonnie',
				trigger: SyncTrigger.MANUAL,
				scope: { rootItemIds: [showId] },
				// Empty means "wherever it turns up", and nothing is replaced behind
				// anybody's back.
				sourceServiceIds: [],
				filter: { missingOnly: true },
				maxItemsPerRun: null,
			});

			const list = await request(context.app.getHttpServer())
				.get('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			expect((list.body as SyncPlan[]).find((one) => one.id === planId)).toMatchObject({
				name: 'Bonnie',
				scope: { rootItemIds: [showId] },
			});
		});

		it('names the plan that covers a season, from the season itself', async () => {
			const response = await request(context.app.getHttpServer())
				.get(`/api/sync/plans/for-item/${seasonId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);
			const answer = response.body as ItemSyncPlans;

			// The plan is on the series, and somebody standing on the season has to be
			// sent to it rather than told to make a second one.
			expect(answer.covering).toHaveLength(1);
			expect(answer.covering[0]).toMatchObject({ coveredItemId: showId, exact: false });
			expect(answer.covering[0].plan.id).toBe(planId);
			expect(answer.suggestedName).toBe('Bonnie — Season 1');
		});

		it('refuses a second plan over a media one already covers', async () => {
			const refused = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ itemId: seasonId, trigger: SyncTrigger.MANUAL })
				.expect(409);

			expect(refused.body).toMatchObject({ message: 'error.sync.item_already_covered' });
		});

		it('adds the second show to that plan rather than standing up another', async () => {
			const extended = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ itemId: otherShowId, trigger: SyncTrigger.MANUAL, extendPlanId: planId })
				.expect(201);

			expect((extended.body as SyncPlan).scope).toEqual({
				rootItemIds: [showId, otherShowId],
			});

			const reread = await request(context.app.getHttpServer())
				.get(`/api/sync/plans/${planId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			// Stored and not merely echoed: the plural is the whole reason a second plan
			// is refused above.
			expect((reread.body as SyncPlan).scope).toEqual({
				rootItemIds: [showId, otherShowId],
			});
		});

		it('refuses to extend a plan whose scope is not subtrees', async () => {
			const category = await request(context.app.getHttpServer())
				.post('/api/sync/plans')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					name: 'Their shows, nightly',
					trigger: SyncTrigger.MANUAL,
					scope: { categoryKeys: ['their-shows'] },
				})
				.expect(201);

			const refused = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					itemId: otherShowId,
					trigger: SyncTrigger.MANUAL,
					extendPlanId: (category.body as SyncPlan).id,
				})
				.expect(409);

			expect(refused.body).toMatchObject({ message: 'error.sync.plan_not_extendable' });
		});

		it('refuses a plan that says it runs nightly and carries no cron', async () => {
			const refused = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ itemId: spareShowId, trigger: SyncTrigger.SCHEDULE })
				.expect(409);

			expect(refused.body).toMatchObject({ message: 'error.sync.schedule_required' });
		});

		it('answers a key for a media nobody holds', async () => {
			const missing = await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({
					itemId: '11111111-1111-4111-8111-111111111111',
					trigger: SyncTrigger.MANUAL,
				})
				.expect(404);

			expect(missing.body).toMatchObject({ message: 'error.media.not_found' });
		});

		it('refuses the trigger it was not given, rather than choosing one', async () => {
			// A schedule nobody chose is a gateway downloading at four in the morning, so
			// the field has no default and the pipe says so.
			await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ itemId: spareShowId })
				.expect(400);
		});

		it('refuses to create one for somebody who may only read syncs', async () => {
			await request(context.app.getHttpServer())
				.post('/api/sync/plans/for-item')
				.set('Authorization', `Bearer ${reader.token}`)
				.send({ itemId: spareShowId, trigger: SyncTrigger.MANUAL })
				.expect(403);
		});
	});
});
