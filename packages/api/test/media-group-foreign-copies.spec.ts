import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
	type MediaFileInfo,
	type MediaGroup,
	type ResultList,
} from '@mcs/shared';
import { MediaManager } from '@/managers';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * One film held by two friends and by nobody here — one card, not two.
 *
 * This is the owner's bug, reproduced from his own rows: *Big Buck Bunny*, 2008, on a
 * friend's Plex and a friend's Jellyfin, neither of them a server whose files we can
 * reach. It showed twice on the library screen, counted twice, and a sync would have
 * offered to fetch it twice.
 *
 * The fixture deliberately runs the real correlation rather than seeding match rows,
 * because the seeded version of this test passes against the broken gateway: grouping
 * two foreign copies has always worked, and `media-group.spec.ts` already proves it.
 * What did not work was correlation ever writing the row — `MatchingService` vetoed the
 * pair as two different cuts, the two copies being four-second stubs one second apart.
 * Only a test that goes through `correlateService` can tell the two failures apart.
 *
 * The two files are copied field for field off the gateway's database, down to the
 * durations, because the numbers are the whole point: rounder ones would clear the
 * veto by accident and the test would prove nothing.
 */
describe('A film two friends hold and we do not', () => {
	let context: TestApp;
	let reader: TestIdentity;
	let plexServiceId: string;
	let jellyfinServiceId: string;
	let plexItemId: string;
	let jellyfinItemId: string;

	beforeAll(async () => {
		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const friend = async (name: string, type: MediaServiceType): Promise<string> =>
			(
				await services.save(
					services.create({
						name,
						type,
						// The gateway holds neither copy. Both tests below turn on this:
						// with a mounted service in the group the state would be read off
						// ours and the interesting case would never be reached.
						filesMounted: false,
						baseUrl: `http://127.0.0.1:${type === MediaServiceType.PLEX ? 32400 : 8096}`,
						status: MediaServiceStatus.ONLINE,
						priority: 100,
					}),
				)
			).id;

		const shelf = async (serviceId: string, externalId: string): Promise<string> =>
			(
				await libraries.save(
					libraries.create({
						serviceId,
						externalId,
						name: 'Films',
						kind: LibraryKind.MOVIES,
						paths: ['/media/movies'],
					}),
				)
			).id;

		plexServiceId = await friend('Plex (a friend)', MediaServiceType.PLEX);
		jellyfinServiceId = await friend('Jellyfin (a friend)', MediaServiceType.JELLYFIN);

		const copy = async (
			serviceId: string,
			externalId: string,
			file: MediaFileInfo,
		): Promise<string> =>
			(
				await items.save(
					items.create({
						serviceId,
						libraryId: await shelf(serviceId, `lib-${externalId}`),
						externalId,
						kind: MediaKind.MOVIE,
						title: 'Big Buck Bunny',
						normalizedTitle: 'big buck bunny',
						year: 2008,
						syncState: SyncState.UNKNOWN,
						file,
					}),
				)
			).id;

		plexItemId = await copy(plexServiceId, 'plex-bbb', {
			path: '/media/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4',
			size: 92_752,
			container: 'mp4',
			videoCodec: 'hevc',
			audioCodec: 'aac',
			width: 3840,
			height: 2160,
			durationMs: 3_023,
			bitrate: 229_000,
			quickHash: null,
			contentId: null,
			checksum: null,
			edition: null,
		});

		jellyfinItemId = await copy(jellyfinServiceId, 'jellyfin-bbb', {
			path: '/media/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008) - 1080p.mp4',
			size: 162_173,
			container: 'mp4',
			videoCodec: 'h264',
			audioCodec: 'aac',
			width: 1920,
			height: 1080,
			durationMs: 4_000,
			bitrate: 324_346,
			quickHash: null,
			contentId: null,
			checksum: null,
			edition: null,
		});

		await context.app.get(MediaManager).correlateService(jellyfinServiceId);
	});

	afterAll(async () => {
		await context.close();
	});

	/** The order `MediaGroupManager` breaks its own tie with, to the comparator. */
	const byId = (left: string, right: string): number => left.localeCompare(right);

	const films = async (): Promise<MediaGroup[]> => {
		const page = await request(context.app.getHttpServer())
			.get('/api/media/groups?kind=movie&limit=50')
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(200);

		return (page.body as ResultList<MediaGroup>).items;
	};

	it('shows one card naming both friends, where it used to show two', async () => {
		const groups = await films();

		expect(groups).toHaveLength(1);
		expect(groups[0].title).toBe('Big Buck Bunny');
		expect(groups[0].sources.map((source) => source.serviceName).sort()).toEqual([
			'Jellyfin (a friend)',
			'Plex (a friend)',
		]);
		expect(groups[0].sources.map((source) => source.itemId).sort(byId)).toEqual(
			[plexItemId, jellyfinItemId].sort(byId),
		);
	});

	it('reads missing once, because neither copy is one we can reach', async () => {
		const groups = await films();

		expect(groups[0].sync).toBe(SyncState.MISSING);
		expect(groups.filter((group) => group.sync === SyncState.MISSING)).toHaveLength(1);
	});

	it('answers the same representative to two identical requests', async () => {
		// Nothing local separates the copies and neither service outranks the other, so
		// the identifier decides — and it has to decide the same way twice or the
		// interface loses the card it was looking at on every reload.
		const [first, second] = [await films(), await films()];

		expect(first[0].id).toBe(second[0].id);
		expect(first[0].id).toBe([plexItemId, jellyfinItemId].sort(byId)[0]);
	});

	it('is reachable from either copy and answers the one group', async () => {
		const reach = async (itemId: string): Promise<MediaGroup> =>
			(
				await request(context.app.getHttpServer())
					.get(`/api/media/groups/${itemId}`)
					.set('Authorization', `Bearer ${reader.token}`)
					.expect(200)
			).body as MediaGroup;

		expect((await reach(plexItemId)).id).toBe((await reach(jellyfinItemId)).id);
		expect((await reach(plexItemId)).sources).toHaveLength(2);
	});
});
