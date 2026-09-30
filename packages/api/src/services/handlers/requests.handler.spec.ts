import {
	ErrorKey,
	LibraryKind,
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
	details: jest.Mock;
	episodes: jest.Mock;
	probe: jest.Mock;
}

const build = (source: RequestSourceSettings | null = SOURCE) => {
	const fakes: Fakes = {
		list: jest.fn().mockResolvedValue([request()]),
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

const scan = async (handler: RequestsHandler): Promise<NormalisedMediaItem[]> => {
	const items: NormalisedMediaItem[] = [];

	for await (const item of handler.scanLibrary(connection(), (await handler.listLibraries())[0])) {
		items.push(item);
	}

	return items;
};

describe('RequestsHandler', () => {
	it('answers one library, with no path at all', async () => {
		const { handler } = build();
		const [library] = await handler.listLibraries();

		expect(library).toMatchObject({ kind: LibraryKind.MIXED, paths: [] });
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

		const items = await scan(handler);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe(MediaKind.MOVIE);
		expect(fakes.episodes).not.toHaveBeenCalled();
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

		expect(() => handler.openArtwork()).toThrow(NotFoundException);
		expect(await handler.getDownloadUrl()).toBeNull();
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
