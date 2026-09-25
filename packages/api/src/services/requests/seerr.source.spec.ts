import {
	ErrorKey,
	MediaKind,
	MediaRequestState,
	RequestSourceType,
	type RequestSourceSettings,
} from '@mcs/shared';
import { SeerrRequestSource } from './seerr.source';

/**
 * Reading somebody else's request server, over a version nobody pins.
 *
 * Three things are pinned here. The state, because two statuses are folded into one word
 * and both fields are called `status`: reading one with the other's vocabulary compiles,
 * runs, and closes the wrong ask. The two identifiers, because `mediaId` means Seerr's own
 * row when a request is completed and the *TMDB* number when one is created — same word,
 * two numbering schemes, both small integers on a fresh install. And the failures, because
 * a request somebody deleted and a server that is down have to stay different answers.
 */

const SETTINGS: RequestSourceSettings = {
	type: RequestSourceType.SEERR,
	baseUrl: 'http://seerr:5055',
	apiKey: 'a-key',
	enabled: true,
};

interface Call {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

describe('SeerrRequestSource', () => {
	const originalFetch = global.fetch;
	const source = new SeerrRequestSource();

	let calls: Call[];

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	/** One canned answer, and a record of what was asked for to get it. */
	function answer(body: unknown, status = 200): void {
		global.fetch = jest.fn(async (input: string, init?: RequestInit) => {
			calls.push({
				url: new URL(input),
				method: init?.method ?? 'GET',
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
			});

			return {
				ok: status >= 200 && status < 300,
				status,
				headers: new Headers(),
				text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	/** An approved film whose media is available: the shape of a finished ask. */
	function row(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 12,
			status: 2,
			type: 'movie',
			createdAt: '2026-01-01T00:00:00.000Z',
			requestedBy: { displayName: 'Damien', email: 'damien@example.test' },
			media: { id: 340, tmdbId: 1234, mediaType: 'movie', status: 5 },
			...over,
		};
	}

	describe('list', () => {
		it('reads a request, both its identifiers apart, and who asked', async () => {
			answer({ results: [row({ status: 1, media: { id: 340, tmdbId: 1234, mediaType: 'movie', status: 2 } })] });

			const [request] = await source.list(SETTINGS, {});

			expect(request).toEqual({
				id: '12',
				mediaId: '340',
				kind: MediaKind.MOVIE,
				title: null,
				tmdbId: '1234',
				tvdbId: null,
				state: MediaRequestState.PENDING,
				seasons: [],
				requestedBy: 'Damien',
				requestedAt: '2026-01-01T00:00:00.000Z',
			});
			expect(calls[0]?.headers['X-Api-Key']).toBe('a-key');
			expect(calls[0]?.url.pathname).toBe('/api/v1/request');
		});

		it('asks Seerr for everything and decides what is open itself', async () => {
			answer({
				results: [
					row({ id: 1, status: 2 }),
					row({ id: 2, status: 3 }),
					row({ id: 3, status: 1, media: { id: 9, tmdbId: 7, mediaType: 'movie', status: 3 } }),
				],
			});

			const open = await source.list(SETTINGS, {});

			// The available one and the declined one are both closed: nobody has anything
			// left to do about either, and a list that showed them is one nobody can act on.
			expect(open.map((request) => request.id)).toEqual(['3']);
			expect(calls[0]?.url.searchParams.get('filter')).toBe('all');
		});

		it('keeps exactly the state that was asked for', async () => {
			answer({
				results: [row({ id: 1 }), row({ id: 2, status: 1 })],
			});

			const pending = await source.list(SETTINGS, { state: MediaRequestState.PENDING, take: 5 });

			expect(pending.map((request) => request.id)).toEqual(['2']);
			expect(calls[0]?.url.searchParams.get('take')).toBe('5');
		});

		it('reads a show’s seasons, and is a show even when nothing says so', async () => {
			answer({
				results: [
					row({
						type: undefined,
						media: { id: 41, tvdbId: 77, status: 4 },
						seasons: [
							{ seasonNumber: 2, status: 5 },
							{ seasonNumber: 3, status: 3 },
							{ status: 1 },
						],
					}),
				],
			});

			const [request] = await source.list(SETTINGS, {});

			expect(request?.kind).toBe(MediaKind.SERIES);
			expect(request?.state).toBe(MediaRequestState.PARTIAL);
			expect(request?.tvdbId).toBe('77');
			// The unnumbered season is dropped: a coordinate is the only thing it could be
			// matched or searched on.
			expect(request?.seasons).toEqual([
				{ seasonNumber: 2, state: MediaRequestState.AVAILABLE },
				{ seasonNumber: 3, state: MediaRequestState.PROCESSING },
			]);
		});

		it('shows a status this build has no word for rather than guessing at it', async () => {
			answer({ results: [row({ status: 4 }), row({ id: 13, status: 2, media: { id: 1, status: 42 } })] });

			const requests = await source.list(SETTINGS, {});

			expect(requests.map((request) => request.state)).toEqual([
				MediaRequestState.UNKNOWN,
				MediaRequestState.UNKNOWN,
			]);
		});

		it('drops a row it could not address, and survives an answer of the wrong shape', async () => {
			// One row with no request identifier and one with no media row: neither can be
			// addressed by a route, matched to our catalogue, or completed.
			answer({ results: [{ status: 1 }, row({ media: {} })] });

			await expect(source.list(SETTINGS, {})).resolves.toEqual([]);

			// And a 200 that is not the page at all, which is what a misconfigured reverse
			// proxy in front of Seerr answers.
			answer({ error: 'nope' });

			await expect(source.list(SETTINGS, {})).resolves.toEqual([]);
		});

		it('fails rather than answering an empty list when Seerr is down', async () => {
			answer({}, 502);

			await expect(source.list(SETTINGS, {})).rejects.toMatchObject({
				response: { key: ErrorKey.REQUEST_SOURCE_UNREACHABLE },
			});
		});
	});

	describe('find', () => {
		it('answers the one request', async () => {
			answer(row({ status: 2, media: { id: 340, tmdbId: 1234, mediaType: 'movie', status: 2 } }));

			const request = await source.find(SETTINGS, '12');

			expect(request?.state).toBe(MediaRequestState.APPROVED);
			expect(calls[0]?.url.pathname).toBe('/api/v1/request/12');
		});

		it('answers nothing for a request somebody deleted, and still fails on an outage', async () => {
			answer({}, 404);

			await expect(source.find(SETTINGS, '12')).resolves.toBeNull();

			answer({}, 500);

			await expect(source.find(SETTINGS, '12')).rejects.toMatchObject({
				response: { key: ErrorKey.REQUEST_SOURCE_UNREACHABLE },
			});
		});
	});

	describe('markAvailable', () => {
		it('addresses the media row and not the request', async () => {
			answer({ id: 340, status: 5 });

			await source.markAvailable(SETTINGS, '340');

			expect(calls[0]?.url.pathname).toBe('/api/v1/media/340/available');
			expect(calls[0]?.method).toBe('POST');
			// Nothing is said about 4k: this gateway holds no separate 4k catalogue, so
			// claiming that ask is answered would close a request nothing here fulfils.
			expect(calls[0]?.body).toEqual({});
		});
	});

	describe('create', () => {
		it('asks for a film by its TMDB identifier', async () => {
			answer(row({ id: 99 }));

			const created = await source.create(SETTINGS, { kind: MediaKind.MOVIE, tmdbId: '1234' });

			expect(calls[0]?.url.pathname).toBe('/api/v1/request');
			expect(calls[0]?.body).toEqual({ mediaType: 'movie', mediaId: 1234 });
			expect(created?.id).toBe('99');
		});

		it('asks for the seasons named, and for all of them when none is', async () => {
			answer(row({ id: 99, type: 'tv', media: { id: 5, tvdbId: 77, mediaType: 'tv', status: 2 } }));

			await source.create(SETTINGS, { kind: MediaKind.SERIES, tmdbId: '1234', seasons: [2, 3] });

			expect(calls[0]?.body).toEqual({ mediaType: 'tv', mediaId: 1234, seasons: [2, 3] });

			await source.create(SETTINGS, { kind: MediaKind.SERIES, tmdbId: '1234', seasons: [] });

			// Never `[]`, which Seerr accepts as an ask for nothing at all.
			expect(calls[1]?.body).toEqual({ mediaType: 'tv', mediaId: 1234, seasons: 'all' });
		});

		it('treats an ask Seerr already holds open as the success it is', async () => {
			answer({ message: 'Request for this media already exists' }, 409);

			await expect(source.create(SETTINGS, { kind: MediaKind.MOVIE, tmdbId: '1234' })).resolves.toBeNull();
		});

		it('still fails when Seerr refuses for any other reason', async () => {
			answer({}, 500);

			await expect(
				source.create(SETTINGS, { kind: MediaKind.MOVIE, tmdbId: '1234' }),
			).rejects.toMatchObject({ response: { key: ErrorKey.REQUEST_SOURCE_UNREACHABLE } });
		});
	});

	/*
	 * Naming the thing nobody here holds.
	 *
	 * Every shape below was read off a running Seerr 3.4.1 rather than imagined, because
	 * the whole reason this method exists is that the request rows carry **no title** —
	 * confirmed against the real server, whose `/api/v1/request` answers `"title": null`
	 * on both a film and a show. So the listing is a column of numbers until this works,
	 * and a mistake here is invisible: the screen simply stays nameless.
	 */
	/*
	 * An identifier that is not one.
	 *
	 * Seerr answers an explicit `"tvdbId": null` on every film — seen on a running one —
	 * and `String(null)` is the four characters `null`. Carried into a catalogue lookup it
	 * matches nothing and nothing reports a fault, so the request simply reads as unheld
	 * for ever; and the day any item holds that string, it matches the wrong media.
	 */
	describe('identifiers', () => {
		it('reads an absent identifier as absent and never as the word null', async () => {
			answer({
				pageInfo: { results: 1 },
				results: [row({ media: { id: 7, tmdbId: 438631, tvdbId: null, status: 3 } })],
			});

			const [request] = await source.list(SETTINGS, {});

			expect(request?.tmdbId).toBe('438631');
			expect(request?.tvdbId).toBeNull();
		});

		it('reads a zero as absent too, which is what a fork writes for nothing', async () => {
			answer({
				pageInfo: { results: 1 },
				results: [row({ media: { id: 7, tmdbId: 0, tvdbId: 371980, status: 3 } })],
			});

			const [request] = await source.list(SETTINGS, {});

			expect(request?.tmdbId).toBeNull();
			expect(request?.tvdbId).toBe('371980');
		});
	});

	/*
	 * The half of a catalogue no media server can supply.
	 *
	 * The show lookup already reads this provider and only ever took the season numbers
	 * off it, which is why an episode that aired last night appeared nowhere in this
	 * product — no row, nothing counting it as missing, and a season three short reading
	 * as complete.
	 */
	describe('episodes', () => {
		it('lists a season from the route the source already proxies', async () => {
			answer({
				episodes: [
					{ episodeNumber: 1, name: 'First', airDate: '2026-09-04' },
					{ episodeNumber: 2, name: 'Second', airDate: '2026-09-11' },
				],
			});

			await expect(source.episodes(SETTINGS, '95396', 2)).resolves.toEqual([
				{ seasonNumber: 2, episodeNumber: 1, title: 'First', airDate: '2026-09-04' },
				{ seasonNumber: 2, episodeNumber: 2, title: 'Second', airDate: '2026-09-11' },
			]);
			expect(calls[0]?.url.pathname).toBe('/api/v1/tv/95396/season/2');
		});

		it('carries the date through untouched, because deciding what aired is not its job', async () => {
			// The source states a fact; whether a date in the future means "do not offer a
			// search for this" is the manager's decision, in one place.
			answer({ episodes: [{ episodeNumber: 10, name: 'Ten', airDate: '2099-01-01' }] });

			await expect(source.episodes(SETTINGS, '95396', 1)).resolves.toEqual([
				{ seasonNumber: 1, episodeNumber: 10, title: 'Ten', airDate: '2099-01-01' },
			]);
		});

		it('drops a row with no usable number and keeps one with no title', async () => {
			// An episode with no number cannot be filed against anything; one with no title
			// is ordinary, and the manager names it after its number.
			answer({
				episodes: [
					{ name: 'Nameless' },
					{ episodeNumber: 0, name: 'Special' },
					{ episodeNumber: 4, airDate: '2026-01-01' },
				],
			});

			await expect(source.episodes(SETTINGS, '95396', 1)).resolves.toEqual([
				{ seasonNumber: 1, episodeNumber: 4, title: null, airDate: '2026-01-01' },
			]);
		});

		it('answers an empty list when the source will not, rather than raising', async () => {
			// This fills a catalogue in. A metadata provider having a bad afternoon must
			// not turn a media page into an error.
			answer({ message: 'nope' }, 500);

			await expect(source.episodes(SETTINGS, '95396', 1)).resolves.toEqual([]);
		});
	});

	describe('details', () => {
		it('reads a film under title and a show under name, as the source really answers', async () => {
			answer({
				title: 'Dune',
				releaseDate: '2021-09-15',
				overview: 'Paul Atreides.',
				posterPath: '/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg',
			});

			await expect(source.details(SETTINGS, MediaKind.MOVIE, '438631')).resolves.toEqual({
				title: 'Dune',
				year: 2021,
				overview: 'Paul Atreides.',
				artworkUrl:
					'https://image.tmdb.org/t/p/w600_and_h900_bestv2/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg',
				seasonNumbers: [],
			});
			expect(calls[0]?.url.pathname).toBe('/api/v1/movie/438631');
		});

		it('asks the show route for a show, and leaves the specials out of the seasons', async () => {
			answer({
				name: 'Severance',
				firstAirDate: '2022-02-17',
				seasons: [
					{ seasonNumber: 0 },
					{ seasonNumber: 1 },
					{ seasonNumber: 2 },
					{ seasonNumber: 3 },
				],
			});

			const details = await source.details(SETTINGS, MediaKind.SERIES, '95396');

			expect(calls[0]?.url.pathname).toBe('/api/v1/tv/95396');
			expect(details?.title).toBe('Severance');
			expect(details?.year).toBe(2022);
			// Season zero is the behind-the-scenes folder. "The whole show" never means it.
			expect(details?.seasonNumbers).toEqual([1, 2, 3]);
		});

		/*
		 * The poster is a bare path and not a URL.
		 *
		 * This is the trap the field name invites: `artworkUrl` holding
		 * `/v1tRX….jpg` renders an image pointing at the gateway's own origin, so every
		 * card is a broken poster and the only trace is an ordinary 404 on a route nobody
		 * declared. The base is resolved here, where the shape is known.
		 */
		it('turns the provider path into something a browser can actually load', async () => {
			answer({ title: 'Dune', posterPath: 'v1tRX.jpg' });

			await expect(source.details(SETTINGS, MediaKind.MOVIE, '1')).resolves.toMatchObject({
				artworkUrl: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/v1tRX.jpg',
			});
		});

		it('leaves an absolute poster alone rather than gluing two bases together', async () => {
			answer({ title: 'Dune', posterPath: 'https://images.example/dune.jpg' });

			await expect(source.details(SETTINGS, MediaKind.MOVIE, '1')).resolves.toMatchObject({
				artworkUrl: 'https://images.example/dune.jpg',
			});
		});

		it('answers nothing rather than an untitled card', async () => {
			answer({ overview: 'Something, evidently.' });

			await expect(source.details(SETTINGS, MediaKind.MOVIE, '1')).resolves.toBeNull();
		});

		/*
		 * A failure here may not take the listing with it. One request nobody can label is
		 * a bad row; a request screen that will not load is a household unable to see what
		 * anybody asked for, which is the entire point of the screen.
		 */
		it('answers nothing when the provider has withdrawn the entry', async () => {
			answer({}, 404);

			await expect(source.details(SETTINGS, MediaKind.SERIES, '1')).resolves.toBeNull();
		});

		it('answers nothing when the server is down', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(source.details(SETTINGS, MediaKind.MOVIE, '1')).resolves.toBeNull();
		});
	});

	describe('probe', () => {
		it('asks something the key is needed for', async () => {
			answer({ total: 3 });

			await expect(source.probe(SETTINGS)).resolves.toBe(true);
			// Never `/status`, which answers without a key and would go green on a wrong one.
			expect(calls[0]?.url.pathname).toBe('/api/v1/request/count');
		});

		/*
		 * The two failures a person fixes in two different places.
		 *
		 * A wrong address is a container name, a port, a proxy; a wrong key is one field
		 * on one screen. Reported as the same thing, a copy-and-paste slip sends somebody
		 * into the network for twenty minutes. And it is **403** that a real Seerr answers
		 * to a bad key, not 401 — verified against a running one — so both statuses have
		 * to land on the same sentence.
		 */
		it.each([401, 403])('reports a key it refused as a key, not as a bad address', async (status) => {
			answer({}, status);

			await expect(source.probe(SETTINGS)).rejects.toMatchObject({
				response: { key: ErrorKey.REQUEST_SOURCE_UNAUTHORIZED },
			});
		});

		it('reports a server that will not answer as unreachable', async () => {
			answer({}, 502);

			await expect(source.probe(SETTINGS)).rejects.toMatchObject({
				response: { key: ErrorKey.REQUEST_SOURCE_UNREACHABLE },
			});
		});
	});
});
