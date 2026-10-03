import {
	ErrorKey,
	LibraryKind,
	RequestLibrary,
	MediaKind,
	MediaRequestState,
	MediaServiceType,
	RequestSourceType,
	ServerStructureSupport,
	type MediaRequest,
	type RequestDetails,
	type RequestEpisode,
	type RequestSourceSettings,
} from '@mcs/shared';
import { Readable } from 'node:stream';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { RequestSourceRegistry } from '../requests/request-source.registry';
import type { SettingsService } from '../settings.service';
import type { NormalisedMediaItem, ServiceConnection } from './media-handler.interface';
import { RequestsHandler } from './requests.handler';

/**
 * What the household has asked for, read as a media service.
 *
 * The complaint behind this file, in the owner's words: requests and the shows he follows
 * should come up like the rest, like a local series, the only difference being that there
 * is no local file. So what is pinned here is that the rows coming out are ordinary media
 * — a show with seasons and episodes — and that none of them carries a file.
 */

const SOURCE: RequestSourceSettings = {
	type: RequestSourceType.SEERR,
	baseUrl: 'http://seerr.local',
	apiKey: 'key',
	enabled: true,
};

const connection = (): ServiceConnection => ({
	id: 'service-requests',
	type: MediaServiceType.REQUESTS,
	baseUrl: SOURCE.baseUrl,
	token: null,
	username: null,
	password: null,
});

const request = (overrides: Partial<MediaRequest> = {}): MediaRequest => ({
	id: 'r-1',
	mediaId: 'm-1',
	kind: MediaKind.SERIES,
	title: 'Les Schtroumpfs',
	tmdbId: '1234',
	tvdbId: null,
	state: MediaRequestState.PENDING,
	seasons: [],
	requestedBy: 'Smeagol',
	requestedAt: '2026-09-01T00:00:00.000Z',
	...overrides,
});

const details = (overrides: Partial<RequestDetails> = {}): RequestDetails => ({
	title: 'Les Schtroumpfs',
	year: 1961,
	overview: 'Des petits bonshommes bleus.',
	artworkUrl: 'http://seerr.local/poster.jpg',
	seasonNumbers: [1, 2],
	...overrides,
});

const episode = (number: number, airDate: string | null): RequestEpisode => ({
	seasonNumber: 1,
	episodeNumber: number,
	title: `Episode ${number}`,
	airDate,
});

interface Fakes {
	list: jest.Mock;
	watchlist: jest.Mock;
	details: jest.Mock;
	episodes: jest.Mock;
	probe: jest.Mock;
}

const build = (source: RequestSourceSettings | null = SOURCE) => {
	const fakes: Fakes = {
		list: jest.fn().mockResolvedValue([request()]),
		// The other list the source keeps: what the household follows, which is never
		// answered the way a request is.
		watchlist: jest.fn().mockResolvedValue([
			{ kind: MediaKind.SERIES, tmdbId: '777', title: 'Sonic X' },
		]),
		details: jest.fn().mockResolvedValue(details()),
		episodes: jest.fn().mockResolvedValue([
			episode(1, '2026-01-01T00:00:00.000Z'),
			// Not out yet: a row for it would send somebody searching for something that
			// has not been made.
			episode(2, '2099-01-01T00:00:00.000Z'),
			// A provider that has not filled the date in is not evidence that it exists.
			episode(3, null),
		]),
		probe: jest.fn().mockResolvedValue(true),
	};

	const handler = new RequestsHandler(
		{ get: jest.fn().mockResolvedValue({ requestSource: source }) } as unknown as SettingsService,
		{ get: jest.fn().mockReturnValue(fakes) } as unknown as RequestSourceRegistry,
	);

	return { handler, fakes };
};

const scan = async (
	handler: RequestsHandler,
	list: RequestLibrary = RequestLibrary.REQUESTS_SHOWS,
): Promise<NormalisedMediaItem[]> => {
	const items: NormalisedMediaItem[] = [];
	const library = (await handler.listLibraries()).find(one => one.externalId === list);

	for await (const item of handler.scanLibrary(connection(), library as never)) {
		items.push(item);
	}

	return items;
};

describe('RequestsHandler', () => {
	it('answers libraries with no path at all', async () => {
		const { handler } = build();
		const [library] = await handler.listLibraries();

		expect(library).toMatchObject({ kind: LibraryKind.MOVIES, paths: [] });
		// No path is what keeps it out of every placement: a destination has to be a
		// directory this gateway can write into, and there is none here.
		expect(library.paths).toEqual([]);
	});

	it('reads a requested show as a show: seasons, and the episodes that have aired', async () => {
		const { handler } = build();
		const items = await scan(handler);

		expect(items.map(one => [one.kind, one.title])).toEqual([
			[MediaKind.SERIES, 'Les Schtroumpfs'],
			[MediaKind.SEASON, 'Season 1'],
			[MediaKind.EPISODE, 'Episode 1'],
			[MediaKind.SEASON, 'Season 2'],
			[MediaKind.EPISODE, 'Episode 1'],
		]);

		// The whole point: no file anywhere, which is what makes every one of them read
		// as missing wherever a state is read.
		expect(items.every(one => one.file === null)).toBe(true);
	});

	it('hangs each row under the one above it, so the show opens', async () => {
		const { handler } = build();
		const items = await scan(handler);
		const [series, season, first] = items;

		expect(series.parentExternalId).toBeNull();
		expect(season.parentExternalId).toBe(series.externalId);
		expect(first.parentExternalId).toBe(season.externalId);
		// Under the show's name, as every handler normalises an episode.
		expect(first.normalizedTitle).toBe(series.normalizedTitle);
	});

	it('keeps the metadata identifiers, which is the only thing a local copy matches on', async () => {
		const { handler, fakes } = build();

		fakes.list.mockResolvedValue([request({ tvdbId: '99' })]);

		const [series] = await scan(handler);

		expect(series.externalIds).toEqual({ tmdb: '1234', tvdb: '99' });
	});

	it('takes only the seasons that were asked for, when any were named', async () => {
		// A request for season two must not fill the library with season one: nobody asked
		// for it, and it would read as missing from then on.
		const { handler, fakes } = build();

		fakes.list.mockResolvedValue([
			request({ seasons: [{ seasonNumber: 2, state: MediaRequestState.PENDING }] }),
		]);

		const items = await scan(handler);

		expect(items.filter(one => one.kind === MediaKind.SEASON).map(one => one.seasonNumber))
			.toEqual([2]);
	});

	it('skips a request with no identifier rather than writing a row nothing can match', async () => {
		const { handler, fakes } = build();

		fakes.list.mockResolvedValue([request({ tmdbId: null })]);

		expect(await scan(handler)).toEqual([]);
		expect(fakes.details).not.toHaveBeenCalled();
	});

	it('skips a request the source cannot name', async () => {
		// A wall of "Unknown" posters is worse than a wall that is one show short, and the
		// next scan picks it up once the provider answers again.
		const { handler, fakes } = build();

		fakes.details.mockResolvedValue(null);

		expect(await scan(handler)).toEqual([]);
	});

	it('reads a requested film as one row, and asks for no episodes', async () => {
		const { handler, fakes } = build();

		fakes.list.mockResolvedValue([request({ kind: MediaKind.MOVIE, title: 'Casper' })]);
		fakes.details.mockResolvedValue(details({ title: 'Casper', seasonNumbers: [] }));

		// The films' shelf, because each list is split by what the source already says a
		// row is. A film asked for on the shows' shelf is not filtered out by accident —
		// it is what that shelf is for.
		const items = await scan(handler, RequestLibrary.REQUESTS_MOVIES);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe(MediaKind.MOVIE);
		expect(fakes.episodes).not.toHaveBeenCalled();
	});

	/**
	 * Two lists, and they are not the same statement.
	 *
	 * "Fetch me this" is answered once and done with. "Tell me when there is more of this"
	 * never is, and it is the one the new releases screen is built on — a series requested
	 * last year produces nothing new, while one that is followed keeps producing episodes.
	 */
	describe('the two lists', () => {
		it('answers one library per list, neither of them a place to write into', async () => {
			const { handler } = build();

			// Four, not two: the source says `movie` or `tv` on every row, so each list is
			// split by it. A mixed shelf is what no category could sort and no default
			// destination could be set on.
			expect((await handler.listLibraries()).map(one => one.externalId))
				.toEqual(['requests-movies', 'requests-shows', 'watchlist-movies', 'watchlist-shows']);
			expect((await handler.listLibraries()).map(one => one.kind))
				.toEqual([LibraryKind.MOVIES, LibraryKind.SHOWS, LibraryKind.MOVIES, LibraryKind.SHOWS]);
			expect((await handler.listLibraries()).every(one => one.paths.length === 0)).toBe(true);
		});

		it('reads the watchlist for the watchlist library, and the requests for the other',
			async () => {
				const { handler, fakes } = build();

				const followed = await scan(handler, RequestLibrary.WATCHLIST_SHOWS);

				expect(followed[0].title).toBe('Les Schtroumpfs');
				expect(fakes.watchlist).toHaveBeenCalled();

				const asked = await scan(handler, RequestLibrary.REQUESTS_SHOWS);

				expect(asked.length).toBeGreaterThan(0);
				expect(fakes.list).toHaveBeenCalled();
			});

		it('keeps the two apart under identifiers of their own', async () => {
			/*
			 * A show can be on both lists, and the gateway keys a row on what the service
			 * called it: one identifier across two libraries would collide into a single row
			 * that changed library on every scan and belonged properly to neither.
			 */
			const { handler } = build();
			const asked = await scan(handler, RequestLibrary.REQUESTS_SHOWS);
			const followed = await scan(handler, RequestLibrary.WATCHLIST_SHOWS);

			expect(asked[0].externalId.startsWith('requests-shows:')).toBe(true);
			expect(followed[0].externalId.startsWith('watchlist-shows:')).toBe(true);
		});

		it('follows a whole show, because that is what following one means', async () => {
			// A request may name seasons; a watchlist entry never does.
			const { handler, fakes } = build();

			fakes.details.mockResolvedValue(details({ seasonNumbers: [1, 2, 3] }));

			const followed = await scan(handler, RequestLibrary.WATCHLIST_SHOWS);

			expect(followed.filter(one => one.kind === MediaKind.SEASON).map(one => one.seasonNumber))
				.toEqual([1, 2, 3]);
		});
	});

	it('refuses everything when no request source is configured', async () => {
		const { handler } = build(null);

		await expect(scan(handler)).rejects.toThrow(ConflictException);
	});

	it('says it cannot receive files rather than offering an empty directory list', async () => {
		// Asked by the screen that picks a destination, of every service: a refusal there
		// would be an error dialog over a question with a perfectly good answer.
		const { handler } = build();

		expect(await handler.listServerDirectories()).toMatchObject({
			support: ServerStructureSupport.UNSUPPORTED,
			entries: [],
		});
	});

	it('refuses to serve bytes, rather than answering nothing', async () => {
		/*
		 * An empty stream would be read one level up as a file that exists and is zero
		 * bytes long, which is how an empty file gets written into a library and indexed
		 * as real.
		 */
		const { handler } = build();

		// The poster is not bytes of the media, and it is now served — see below. A row
		// carrying no url still refuses, which is the honest answer for a season or an
		// episode: the series above them is what has the picture.
		expect(() => handler.openArtwork(connection(), { externalId: 'watchlist:tv:1399' }))
			.toThrow(NotFoundException);
		expect(await handler.getDownloadUrl()).toBeNull();
	});

	it('serves the poster the source named, from the provider that hosts it', async () => {
		/*
		 * Refused on principle at first — "this service holds no bytes" — and the
		 * principle is right about files and was wrong about this. A wall of requests
		 * with no posters is not austere, it is a wall of grey rectangles with two
		 * letters on them, which is what a household saw.
		 *
		 * The image is TMDB's, public, and its url was stored when the row was written.
		 * Nothing of the source's travels with this request: no token, no base, no
		 * connection.
		 */
		const { handler } = build();
		const calls: string[] = [];

		global.fetch = jest.fn(async (input: string) => {
			calls.push(String(input));

			return {
				ok: true,
				status: 200,
				headers: new Headers({ 'content-type': 'image/jpeg' }),
				body: Readable.toWeb(Readable.from([Buffer.from('jpeg')])),
			} as unknown as Response;
		}) as unknown as typeof fetch;

		const artwork = await handler.openArtwork(connection(), {
			externalId: 'watchlist:tv:1399',
			artworkUrl: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/poster.jpg',
		});

		expect(artwork.contentType).toBe('image/jpeg');
		expect(calls[0]).toBe('https://image.tmdb.org/t/p/w600_and_h900_bestv2/poster.jpg');
		// The provider's host, not the request source's.
		expect(calls[0]).not.toContain('seerr');
	});

	it('reports itself unreachable with a key rather than a silence', async () => {
		const { handler, fakes } = build();

		fakes.probe.mockResolvedValue(false);

		expect(await handler.probe(connection())).toMatchObject({
			reachable: false,
			error: ErrorKey.REQUEST_SOURCE_UNREACHABLE,
		});
	});
});
