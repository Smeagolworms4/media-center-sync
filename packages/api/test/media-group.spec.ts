import request from 'supertest';
import {
	LibraryKind,
	MatchStrategy,
	MediaKind,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
	type MediaGroup,
	type ResultList,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The grouped view, over two services that disagree the way real ones do.
 *
 * The fixture is the lab's shape in miniature: an episode both servers hold, one only
 * theirs, one only ours, one the scoring was not sure about, and one a conflict. The
 * last two are the ones worth booting a database for — they are the difference between
 * "computed a group" and "computed the right number of groups", and they are decided by
 * a `WHERE` clause no unit test can run.
 */
describe('Browsing the index by media rather than by row', () => {
	let context: TestApp;
	let reader: TestIdentity;
	const id: Record<string, string> = {};

	beforeAll(async () => {
		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);
		const matches = context.app.get(MediaMatchRepository);

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://127.0.0.1:8096',
				status: MediaServiceStatus.ONLINE,
				priority: 100,
			}),
		);

		const theirs = await services.save(
			services.create({
				name: 'Cabin',
				type: MediaServiceType.PLEX,
				scope: MediaServiceScope.REMOTE,
				baseUrl: 'http://127.0.0.1:32400',
				status: MediaServiceStatus.ONLINE,
				priority: 200,
			}),
		);

		id.ours = ours.id;
		id.theirs = theirs.id;

		const shelf = async (serviceId: string, externalId: string): Promise<string> =>
			(
				await libraries.save(
					libraries.create({
						serviceId,
						externalId,
						name: 'Shows',
						kind: LibraryKind.SHOWS,
						paths: ['/media/shows'],
					}),
				)
			).id;

		const ourLibrary = await shelf(ours.id, 'lib-ours');
		const theirLibrary = await shelf(theirs.id, 'lib-theirs');

		const put = async (
			key: string,
			serviceId: string,
			libraryId: string,
			overrides: Record<string, unknown>,
		): Promise<void> => {
			const saved = await items.save(
				items.create({
					serviceId,
					libraryId,
					externalId: key,
					kind: MediaKind.EPISODE,
					title: key,
					normalizedTitle: key.toLowerCase(),
					seasonNumber: 1,
					syncState: SyncState.UNKNOWN,
					...overrides,
				}),
			);

			id[key] = saved.id;
		};

		await put('series-ours', ours.id, ourLibrary, {
			kind: MediaKind.SERIES,
			title: 'Big Buck Bunny',
			normalizedTitle: 'big buck bunny',
			seasonNumber: null,
			artworkUrl: '/ours/poster.jpg',
			syncState: SyncState.IN_SYNC,
		});
		await put('series-theirs', theirs.id, theirLibrary, {
			kind: MediaKind.SERIES,
			title: 'Bunny, Big Buck',
			normalizedTitle: 'bunny big buck',
			seasonNumber: null,
			artworkUrl: '/theirs/poster.jpg',
			overview: 'A rabbit takes his revenge.',
			syncState: SyncState.IN_SYNC,
		});

		await put('season-ours', ours.id, ourLibrary, {
			kind: MediaKind.SEASON,
			title: 'Season 1',
			normalizedTitle: 'season 1',
			parentId: id['series-ours'],
			syncState: SyncState.OUTDATED,
		});
		await put('season-theirs', theirs.id, theirLibrary, {
			kind: MediaKind.SEASON,
			title: 'Season 1',
			normalizedTitle: 'season 1',
			parentId: id['series-theirs'],
			syncState: SyncState.IN_SYNC,
		});

		const episode = async (
			key: string,
			serviceId: string,
			libraryId: string,
			parentId: string,
			number: number,
			syncState: SyncState,
		): Promise<void> =>
			put(key, serviceId, libraryId, {
				parentId,
				episodeNumber: number,
				title: `Episode ${number}`,
				normalizedTitle: `episode ${number}`,
				syncState,
			});

		await episode('e1-ours', ours.id, ourLibrary, id['season-ours'], 1, SyncState.IN_SYNC);
		await episode('e1-theirs', theirs.id, theirLibrary, id['season-theirs'], 1, SyncState.IN_SYNC);
		await episode('e2-theirs', theirs.id, theirLibrary, id['season-theirs'], 2, SyncState.MISSING);
		await episode('e3-ours', ours.id, ourLibrary, id['season-ours'], 3, SyncState.LOCAL_ONLY);
		await episode('e4-ours', ours.id, ourLibrary, id['season-ours'], 4, SyncState.LOCAL_ONLY);
		await episode('e4-theirs', theirs.id, theirLibrary, id['season-theirs'], 4, SyncState.MISSING);
		await episode('e5-ours', ours.id, ourLibrary, id['season-ours'], 5, SyncState.CONFLICT);
		await episode('e5-theirs', theirs.id, theirLibrary, id['season-theirs'], 5, SyncState.CONFLICT);

		const correlate = async (
			local: string,
			remote: string,
			confidence: number,
			state: SyncState,
		): Promise<void> => {
			await matches.save(
				matches.create({
					localItemId: id[local],
					remoteItemId: id[remote],
					remoteServiceId: theirs.id,
					strategy: MatchStrategy.NORMALIZED_TITLE,
					confidence,
					state,
				}),
			);
		};

		await correlate('series-ours', 'series-theirs', 0.95, SyncState.IN_SYNC);
		await correlate('season-ours', 'season-theirs', 0.95, SyncState.OUTDATED);
		await correlate('e1-ours', 'e1-theirs', 0.95, SyncState.IN_SYNC);
		// Below the default threshold of 0.8: scored, recorded, never applied.
		await correlate('e4-ours', 'e4-theirs', 0.5, SyncState.MISSING);
		// The same bytes under numbers that disagree: a pair nobody has settled.
		await correlate('e5-ours', 'e5-theirs', 1, SyncState.CONFLICT);
	});

	afterAll(async () => {
		await context.close();
	});

	const browse = (path: string): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api${path}`)
			.set('Authorization', `Bearer ${reader.token}`);

	const groups = async (path: string): Promise<ResultList<MediaGroup>> =>
		(await browse(path).expect(200)).body as ResultList<MediaGroup>;

	it('answers the grouped route rather than reading “groups” as an identifier', async () => {
		// With `:id` declared first, Nest matches `groups` as a UUID parameter and
		// answers a validation error that says nothing about the route being shadowed.
		const page = await groups('/media/groups?limit=50');

		expect(page.pagination.total).toBeGreaterThan(0);
	});

	it('shows one entry per media, with the servers that hold it underneath', async () => {
		const page = await groups('/media/groups?kind=episode&limit=50');
		const first = page.items.find((group) => group.title === 'Episode 1');

		// Eight rows, seven groups: only the pair the correlation applied is folded.
		expect(page.pagination.total).toBe(7);
		expect(first?.sources).toHaveLength(2);
		expect(first?.sources.map((source) => source.serviceName).sort()).toEqual([
			'Cabin',
			'Living room',
		]);
		expect(first?.sources.find((source) => source.local)?.serviceId).toBe(id.ours);
		expect(first?.id).toBe(id['e1-ours']);
	});

	it('leaves a proposal below the threshold, and a conflict, as two entries each', async () => {
		const page = await groups('/media/groups?kind=episode&limit=50');

		expect(page.items.filter((group) => group.title === 'Episode 4')).toHaveLength(2);
		expect(page.items.filter((group) => group.title === 'Episode 5')).toHaveLength(2);
	});

	it('prefers the local copy for the poster and fills its gaps from the other', async () => {
		const group = (await browse(`/media/groups/${id['series-ours']}`).expect(200))
			.body as MediaGroup;

		expect(group.id).toBe(id['series-ours']);
		expect(group.title).toBe('Big Buck Bunny');
		expect(group.artworkItemId).toBe(id['series-ours']);
		// Ours never received an overview; theirs did, and a poster with a description
		// is better than a poster without one.
		expect(group.overview).toBe('A rabbit takes his revenge.');
	});

	it('is reachable from the far copy and answers the same group', async () => {
		const group = (await browse(`/media/groups/${id['series-theirs']}`).expect(200))
			.body as MediaGroup;

		expect(group.id).toBe(id['series-ours']);
		expect(group.sources).toHaveLength(2);
	});

	it('counts the children of the whole group, and what we do not hold', async () => {
		const group = (await browse(`/media/groups/${id['season-ours']}`).expect(200))
			.body as MediaGroup;

		expect(group.childCount).toBe(7);
		// Their episode 2, and the halves of 4 and 5 we never joined: three posters a
		// season card has to account for.
		expect(group.missingCount).toBe(3);
	});

	it('merges the children of every copy, wherever they live', async () => {
		const page = await groups(`/media/groups/${id['season-ours']}/children?limit=50`);
		const only = page.items.find((group) => group.title === 'Episode 2');

		expect(page.pagination.total).toBe(7);
		// An episode nobody local holds still appears on our season page — that is the
		// whole point of the screen.
		expect(only?.sources).toHaveLength(1);
		expect(only?.sources[0].local).toBe(false);
		expect(only?.sync).toBe(SyncState.MISSING);
	});

	it('addresses the parent by group, so the far copy reaches the same children', async () => {
		const page = await groups(`/media/groups/${id['season-theirs']}/children?limit=50`);

		expect(page.pagination.total).toBe(7);
	});

	it('takes the parent from the route and not from the query string', async () => {
		const page = await groups(
			`/media/groups/${id['season-ours']}/children?parentId=${id['series-ours']}&limit=50`,
		);

		expect(page.pagination.total).toBe(7);
	});

	it('pages groups rather than rows', async () => {
		const first = await groups('/media/groups?kind=episode&limit=3&page=1');
		const last = await groups('/media/groups?kind=episode&limit=3&page=3');

		expect(first.items).toHaveLength(3);
		expect(first.pagination).toMatchObject({ page: 1, limit: 3, total: 7, pages: 3 });
		expect(last.items).toHaveLength(1);
		expect(first.items.map((group) => group.id)).not.toEqual(last.items.map((group) => group.id));
	});

	it('narrows by service without ungrouping what survives', async () => {
		const page = await groups(`/media/groups?kind=episode&serviceIds=${id.theirs}&limit=50`);
		const shared = page.items.find((group) => group.title === 'Episode 1');

		// Four of their rows, four groups — and episode 1 is still shown with both of
		// its sources, because a group is a media and not a row.
		expect(page.pagination.total).toBe(4);
		expect(shared?.sources).toHaveLength(2);
	});

	it('filters on the group’s state, with a single value read as a list of one', async () => {
		const page = await groups(`/media/groups?kind=episode&states=${SyncState.MISSING}&limit=50`);

		// Their episodes 2, 4 and 5, none of which we hold under any name.
		expect(page.pagination.total).toBe(3);
		expect(page.items.every((group) => group.sources.every((source) => !source.local))).toBe(true);
	});

	it('refuses a page size nobody could render rather than quietly shrinking it', async () => {
		await browse('/media/groups?limit=100000').expect(400);
	});

	it('answers a key for a group nobody holds', async () => {
		const response = await browse('/media/groups/11111111-2222-4333-8444-555555555555').expect(
			404,
		);

		expect(response.body).toMatchObject({ message: 'error.media.not_found' });
	});

	it('answers nothing to a filter nothing satisfies', async () => {
		// Asking for a friend nobody has linked must answer nothing. Reading an empty
		// list as "no filter" answered the whole library instead, which is the one way
		// of getting this wrong that looks like the filter being ignored rather than
		// like a bug.
		const page = await groups('/media/groups?origins=friend&limit=50');

		expect(page.pagination.total).toBe(0);
		expect(page.items).toHaveLength(0);
	});

	it('answers nothing for a service that exists nowhere', async () => {
		const page = await groups(
			'/media/groups?serviceIds=00000000-0000-4000-8000-000000000000&limit=50',
		);

		expect(page.pagination.total).toBe(0);
	});

	it('accepts a category key rather than refusing the parameter', async () => {
		// Whitelisting validation turns a field the manager understands but the DTO does
		// not into a 400 that blames the caller. The library screen filters on this.
		await browse('/media/groups?categoryKey=nothing-of-that-name&limit=5').expect(200);
	});

});
