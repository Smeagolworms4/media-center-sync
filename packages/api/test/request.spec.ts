import request from 'supertest';
import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaRequestState,
	MediaServiceStatus,
	MediaServiceType,
	RequestSourceType,
	SyncState,
	UserRole,
	type MediaRequestView,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { SettingsService } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The request screen, over the real application and a real Seerr's real answers.
 *
 * Every payload below was read off a running Seerr 3.4.1 rather than imagined, and the
 * one that matters is the first: **a request row carries no title.** Both rows come back
 * as `"title": null`, a film and a show, identifiers and statuses and nothing readable.
 * Left at that, this whole screen is a column of numbers — which is why the gateway looks
 * the work up separately, and why half of what is pinned here is that lookup.
 *
 * Boot rather than unit, because three of the four things that could break this are
 * wiring: the right on the route, the serialisation of a view assembled in a manager, and
 * the settings row being read at all. A manager test passes while the route answers 403.
 *
 * Nothing here may make bytes move. That is asserted, not assumed: the fake Seerr records
 * every call, and a test that saw a grab go out would fail on the list of calls alone.
 */

/** The film, as Seerr answers it. Its `media.id` is 1 and its request `id` is also 1. */
const MOVIE_ROW = {
	id: 1,
	type: 'movie',
	status: 2,
	title: null,
	createdAt: '2026-09-24T22:32:20.000Z',
	requestedBy: { id: 1, displayName: 'lab', jellyfinUsername: 'lab' },
	seasons: [],
	media: { id: 1, tmdbId: 438631, tvdbId: null, status: 3, mediaType: 'movie' },
};

/**
 * The show, asked for one season, and we hold none of it.
 *
 * `id` 2 and `media.id` 2 are both 2 here, which is the trap this fixture keeps honest:
 * on a fresh install the request's own number and the media's number are both small
 * integers, so reading one where the other belongs works perfectly until it closes
 * somebody else's ask. The film above has the same pair, deliberately.
 */
const SHOW_ROW = {
	id: 2,
	type: 'tv',
	status: 2,
	title: null,
	createdAt: '2026-09-24T22:32:20.000Z',
	requestedBy: { id: 1, displayName: 'lab', jellyfinUsername: 'lab' },
	seasons: [{ id: 1, seasonNumber: 1, status: 2 }],
	media: { id: 2, tmdbId: 95396, tvdbId: 371980, status: 3, mediaType: 'tv' },
};

/** `/api/v1/movie/438631`, trimmed to the fields the gateway reads. */
const MOVIE_DETAILS = {
	id: 438631,
	title: 'Dune',
	releaseDate: '2021-09-15',
	overview: 'Paul Atreides, a brilliant and gifted young man.',
	posterPath: '/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg',
};

/** `/api/v1/tv/95396`. Season zero is there because the real answer has it. */
const SHOW_DETAILS = {
	id: 95396,
	name: 'Severance',
	firstAirDate: '2022-02-17',
	overview: 'Mark leads a team of office workers.',
	posterPath: '/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg',
	seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
};

interface Call {
	method: string;
	path: string;
	body: unknown;
}

describe('requests', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let calls: Call[];
	let originalFetch: typeof global.fetch;

	/** What the fake Seerr answers, by path. Anything unrouted is a 404. */
	let routes: Record<string, unknown>;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		await context.app.get(SettingsService).update({
			requestSource: {
				type: RequestSourceType.SEERR,
				baseUrl: 'http://seerr.invalid:5055',
				apiKey: 'a-lab-key',
				enabled: true,
			},
		});

		// A film of ours that answers the first ask, and nothing at all for the show. One
		// held and one not is the whole point of the screen: a household asks for forty
		// things a year and most arrive some other way.
		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const service = await services.save(
			services.create({
				name: 'lab jellyfin',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin.invalid:8096',
				status: MediaServiceStatus.ONLINE,
				priority: 10,
			}),
		);
		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				name: 'Movies',
				kind: LibraryKind.MOVIES,
				externalId: 'movies',
				paths: ['/media/movies'],
				localPath: '/srv/movies',
			}),
		);

		await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'dune',
				kind: MediaKind.MOVIE,
				title: 'Dune',
				normalizedTitle: 'dune',
				year: 2021,
				syncState: SyncState.LOCAL_ONLY,
				externalIds: { tmdb: '438631' },
			}),
		);
	});

	afterAll(async () => {
		await context.close();
	});

	beforeEach(() => {
		originalFetch = global.fetch;
		calls = [];
		routes = {
			'/api/v1/request': { pageInfo: { results: 2 }, results: [SHOW_ROW, MOVIE_ROW] },
			// Closing an ask re-reads it first rather than trusting the row the screen was
			// drawn from. A list is minutes old by the time somebody presses anything, and
			// the ask may have been answered, declined or deleted since.
			'/api/v1/request/1': MOVIE_ROW,
			'/api/v1/request/2': SHOW_ROW,
			'/api/v1/movie/438631': MOVIE_DETAILS,
			'/api/v1/tv/95396': SHOW_DETAILS,
			'/api/v1/media/1/available': MOVIE_ROW.media,
			'/api/v1/media/2/available': SHOW_ROW.media,
		};

		global.fetch = jest.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;

			calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });

			const answer = routes[url.pathname];
			const found = answer !== undefined;

			return {
				ok: found,
				status: found ? 200 : 404,
				headers: new Headers(),
				text: async () => JSON.stringify(found ? answer : { message: 'Not Found' }),
			} as unknown as Response;
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	const list = async (): Promise<MediaRequestView[]> => {
		const response = await request(context.app.getHttpServer())
			.get('/api/requests')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as MediaRequestView[];
	};

	it('says which asks we already hold, and names the ones we do not', async () => {
		const views = await list();
		const movie = views.find((one) => one.tmdbId === '438631');
		const show = views.find((one) => one.tmdbId === '95396');

		expect(movie?.heldAlready).toBe(true);
		expect(movie?.holdings[0]?.title).toBe('Dune');
		// Named by our own shelf, and with no lookup spent on it.
		expect(movie?.title).toBe('Dune');
		// And the film's `tvdbId` is absent rather than the word "null" — Seerr answers an
		// explicit null there, which `String()` would turn into an identifier that is not one.
		expect(movie?.tvdbId).toBeNull();
		// Closing this one would be telling the truth, which is the only thing that may
		// put the action on the screen.
		expect(movie?.fulfillable).toBe(true);

		expect(show?.heldAlready).toBe(false);
		expect(show?.fulfillable).toBe(false);
		// The row Seerr could not name, named by Seerr's own metadata route.
		expect(show?.title).toBe('Severance');
		expect(show?.details).toMatchObject({ year: 2022, seasonNumbers: [1, 2, 3] });
		expect(show?.details?.artworkUrl).toMatch(/^https:\/\//);
	});

	it('suggests a search for what we are short of, and never runs one', async () => {
		const show = (await list()).find((one) => one.tmdbId === '95396');

		// The season that was actually asked for, not the whole show: a suggestion that
		// widened the ask would have somebody grab three seasons to answer a request for
		// one.
		expect(show?.suggestion).toEqual({
			term: 'Severance',
			kind: MediaKind.SERIES,
			seasonNumbers: [1],
		});

		// The proof that it is a sentence and not an action. Nothing was searched, nothing
		// was grabbed, and the only writes on the wire are the ones a lookup needs — which
		// is none.
		expect(calls.every((call) => call.method === 'GET')).toBe(true);
		expect(calls.some((call) => call.path.includes('release') || call.path.includes('torrent')))
			.toBe(false);
	});

	it('does not spend a round trip re-learning a title we already hold', async () => {
		await list();

		// One lookup, for the show nothing of ours matches. A listing that asked about
		// every open ask would cost a request per row for names it already has.
		expect(calls.filter((call) => call.path.startsWith('/api/v1/movie/'))).toEqual([]);
		expect(calls.filter((call) => call.path.startsWith('/api/v1/tv/'))).toHaveLength(1);
	});

	it('still lists everything when the source cannot name one of them', async () => {
		delete routes['/api/v1/tv/95396'];

		const views = await list();
		const show = views.find((one) => one.tmdbId === '95396');

		// A lookup that fails costs that row its name. It may not cost the household the
		// screen: a request list that will not load hides every other ask alongside it.
		expect(views).toHaveLength(2);
		expect(show?.title).toBeNull();
		expect(show?.details).toBeNull();
		expect(show?.suggestion).toBeNull();
	});

	describe('marking one answered', () => {
		it("addresses the media's number and not the request's", async () => {
			await request(context.app.getHttpServer())
				.post('/api/requests/1/fulfilled')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			const marked = calls.find((call) => call.method === 'POST');

			// `mediaId`, which is a different row with a different number — see the fixture
			// above. Both are 1 here on purpose: this assertion is the only thing standing
			// between a mix-up and somebody else's ask being closed.
			expect(marked?.path).toBe('/api/v1/media/1/available');
			// An empty object rather than no body: the route reads `is4k` off it, and
			// leaving it unset is how the gateway avoids claiming a 4k copy it has not got.
			expect(marked?.body).toEqual({});
		});

		it('refuses to close an ask nothing of ours answers', async () => {
			const response = await request(context.app.getHttpServer())
				.post('/api/requests/2/fulfilled')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(409);

			expect(response.body).toMatchObject({ message: ErrorKey.REQUEST_NOT_HELD });
			// And it said so without telling Seerr anything. Telling it would have
			// succeeded, which is exactly why the refusal has to happen before.
			expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
		});
	});

	/*
	 * Looking is not acting.
	 *
	 * The list is a read of the household's asks and a guest may see it; closing one and
	 * pushing one are decisions, and the route says so rather than a role being checked
	 * in a manager. This is the assertion a unit test cannot make.
	 */
	it('lets a guest read the asks and not answer them', async () => {
		const viewer = await signInAs(context, UserRole.GUEST);

		await request(context.app.getHttpServer())
			.get('/api/requests')
			.set('Authorization', `Bearer ${viewer.token}`)
			.expect(200);

		await request(context.app.getHttpServer())
			.post('/api/requests/1/fulfilled')
			.set('Authorization', `Bearer ${viewer.token}`)
			.expect(403);

		await request(context.app.getHttpServer())
			.post('/api/requests')
			.set('Authorization', `Bearer ${viewer.token}`)
			.send({ tmdbId: '603', kind: MediaKind.MOVIE })
			.expect(403);
	});

	it('refuses an anonymous caller outright', async () => {
		await request(context.app.getHttpServer()).get('/api/requests').expect(401);
	});

	/*
	 * A request server that is down is not an empty request list.
	 *
	 * "Nobody has asked for anything" and "your request server is not answering" are
	 * opposite sentences, and a screen showing the first for the second tells a household
	 * that nothing is outstanding.
	 */
	it('fails the listing when the source will not answer', async () => {
		global.fetch = jest.fn(async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;

		const response = await request(context.app.getHttpServer())
			.get('/api/requests')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(503);

		expect((response.body as { key?: string }).key).toBe('error.request_source.unreachable');
	});

	it('narrows to one state when asked, in the gateway’s vocabulary', async () => {
		const response = await request(context.app.getHttpServer())
			.get('/api/requests')
			.query({ state: MediaRequestState.AVAILABLE })
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		// Both fixtures are approved with their media processing, so a filter on
		// "available" answers nothing — and Seerr's own `filter` is never asked to narrow
		// it, because its `approved` includes asks whose media is already held.
		expect(response.body).toEqual([]);
		expect(calls[0]?.path).toBe('/api/v1/request');
	});
});
