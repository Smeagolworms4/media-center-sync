import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceType,
	SyncState,
	UserRole,
	type SyncEstimate,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * An estimate on a gateway with nowhere to land, over HTTP.
 *
 * A file of its own because the whole point is the gateway `sync.spec.ts` never
 * builds: one with no library it can write into — a clean install, or a household
 * that only reads a friend's server. There, the estimate used to go through placement
 * and answer 409 `path_not_writable`, and the Keep-in-sync dialog could only say that
 * nobody had worked the figure out. A count and a size do not depend on where the
 * files would land, so the estimate answers; the preview, which does need a path,
 * still refuses, and by key.
 */
describe('Estimating a scope with nowhere to land', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let episodeId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		// Only a friend's server: nothing here is ours, so nothing is writable.
		const theirs = await services.save(
			services.create({
				name: "A friend's server",
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:51',
			}),
		);

		const shelf = await libraries.save(
			libraries.create({
				serviceId: theirs.id,
				externalId: 'their-shows',
				name: 'Their shows',
				kind: LibraryKind.SHOWS,
				paths: ['/srv/shows'],
			}),
		);

		episodeId = (
			await items.save(
				items.create({
					serviceId: theirs.id,
					libraryId: shelf.id,
					externalId: 'their-s01e01',
					kind: MediaKind.EPISODE,
					title: 'Pilot',
					normalizedTitle: 'pilot',
					seasonNumber: 1,
					episodeNumber: 1,
					syncState: SyncState.MISSING,
					file: {
						path: '/srv/shows/Pilot/S01E01.mkv',
						size: 16_384,
						container: 'mkv',
						videoCodec: 'hevc',
						audioCodec: 'aac',
						width: 1920,
						height: 1080,
						durationMs: 4000,
						bitrate: 2_000_000,
						quickHash: 'v1:pilot',
						contentId: 'v1:pilot:16384',
						checksum: null,
					},
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	it('still says what the scope comes to', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/estimate')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ scope: { itemIds: [episodeId] }, filter: { missingOnly: true } })
			.expect(200);

		expect(response.body as SyncEstimate).toMatchObject({
			itemCount: 1,
			bytes: 16_384,
			unbounded: false,
			truncated: false,
		});
	});

	it('refuses the preview, which needs a destination, and names why', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ scope: { itemIds: [episodeId] } })
			.expect(409);

		expect(JSON.stringify(response.body)).toContain('error.library.path_not_writable');
	});
});
