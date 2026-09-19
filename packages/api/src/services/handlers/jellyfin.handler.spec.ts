import { LibraryKind, MediaKind, MediaServiceType } from '@mcs/shared';
import { JellyfinHandler } from './jellyfin.handler';
import type { NormalisedLibrary, ServiceConnection } from './media-handler.interface';

const connection: ServiceConnection = {
	id: 'service-1',
	type: MediaServiceType.JELLYFIN,
	baseUrl: 'http://jellyfin:8096/',
	token: 'a-token',
	username: null,
	password: null,
};

const library: NormalisedLibrary = {
	externalId: 'folder-1',
	name: 'Shows',
	kind: LibraryKind.SHOWS,
	paths: ['/media/Shows'],
};

/** One episode as Jellyfin actually answers, fields and all. */
const EPISODE = {
	Id: 'item-1',
	Name: 'Back to the Butcher',
	Type: 'Episode',
	SeriesId: 'series-1',
	SeasonId: 'season-1',
	ParentId: 'season-1',
	ParentIndexNumber: 1,
	IndexNumber: 2,
	ProductionYear: 2015,
	Overview: 'The crew looks for answers.',
	DateCreated: '2024-01-02T03:04:05.000Z',
	DateLastSaved: '2024-02-02T03:04:05.000Z',
	ImageTags: { Primary: 'tag' },
	ProviderIds: { Tvdb: '5312341', Imdb: 'tt4192812' },
	RunTimeTicks: 27_000_000_000,
	MediaSources: [
		{
			Path: '/media/Shows/The Expanse/S01E02.mkv',
			Size: 2_147_483_648,
			Container: 'mkv',
			Bitrate: 6_000_000,
			MediaStreams: [
				{ Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080, BitRate: 5_500_000 },
				{ Type: 'Audio', Codec: 'eac3', Channels: 6 },
			],
		},
	],
};

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): jest.Mock {
	const mock = jest.fn(async (input: string | URL, init?: RequestInit) => {
		const body = handler(String(input), init);

		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			text: async () => JSON.stringify(body ?? {}),
		} as unknown as Response;
	});

	global.fetch = mock as unknown as typeof fetch;

	return mock as unknown as jest.Mock;
}

describe('JellyfinHandler', () => {
	const handler = new JellyfinHandler();
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	describe('probe', () => {
		it('reports a reachable, authenticated server with its libraries', async () => {
			stubFetch((url) => {
				if (url.includes('/System/Info')) {
					return { Version: '10.9.6', ServerName: 'Home' };
				}

				return [
					{
						ItemId: 'folder-1',
						Name: 'Shows',
						CollectionType: 'tvshows',
						Locations: ['/media/Shows'],
					},
				];
			});

			const probe = await handler.probe(connection);

			expect(probe).toMatchObject({
				reachable: true,
				authenticated: true,
				version: '10.9.6',
				serverName: 'Home',
				error: null,
			});
			expect(probe.libraries).toEqual([
				{
					externalId: 'folder-1',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					paths: ['/media/Shows'],
				},
			]);
		});

		it('separates a rejected token from an unreachable server', async () => {
			global.fetch = jest.fn(async (input: string | URL) => {
				if (String(input).includes('/System/Info/Public')) {
					return {
						ok: true,
						status: 200,
						headers: new Headers(),
						text: async () => JSON.stringify({ Version: '10.9.6', ServerName: 'Home' }),
					} as unknown as Response;
				}

				return {
					ok: false,
					status: 401,
					headers: new Headers(),
					text: async () => '',
				} as unknown as Response;
			}) as unknown as typeof fetch;

			const probe = await handler.probe(connection);

			expect(probe).toMatchObject({
				reachable: true,
				authenticated: false,
				serverName: 'Home',
				error: 'error.service.unauthorized',
			});
		});

		it('reports an unreachable server rather than throwing', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			expect(await handler.probe(connection)).toMatchObject({
				reachable: false,
				authenticated: false,
				error: 'error.service.unreachable',
			});
		});
	});

	describe('authenticate', () => {
		it('maps the answer onto an external identity', async () => {
			stubFetch(() => ({
				User: { Id: 'user-9', Name: 'sam', PrimaryImageTag: 'tag' },
				AccessToken: 'session-token',
			}));

			expect(await handler.authenticate(connection, 'sam', 'secret')).toEqual({
				externalUserId: 'user-9',
				username: 'sam',
				displayName: 'sam',
				email: null,
				avatarUrl: 'http://jellyfin:8096/Users/user-9/Images/Primary',
				token: 'session-token',
			});
		});

		it('turns a rejected password into a credentials error, not a service one', async () => {
			global.fetch = jest.fn(async () => ({
				ok: false,
				status: 401,
				headers: new Headers(),
				text: async () => '',
			})) as unknown as typeof fetch;

			await expect(handler.authenticate(connection, 'sam', 'wrong')).rejects.toMatchObject({
				response: { key: 'error.auth.invalid_credentials' },
			});
		});
	});

	describe('scanLibrary', () => {
		it('maps a full item onto the normalised shape', async () => {
			stubFetch(() => ({ Items: [EPISODE], TotalRecordCount: 1 }));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library)) {
				items.push(item);
			}

			expect(items).toHaveLength(1);
			expect(items[0]).toEqual({
				externalId: 'item-1',
				parentExternalId: 'season-1',
				kind: MediaKind.EPISODE,
				title: 'Back to the Butcher',
				normalizedTitle: 'back to the butcher',
				year: 2015,
				seasonNumber: 1,
				episodeNumber: 2,
				externalIds: {
					tvdb: '5312341',
					tmdb: undefined,
					imdb: 'tt4192812',
					musicbrainz: undefined,
					provider: 'item-1',
				},
				overview: 'The crew looks for answers.',
				artworkUrl: 'http://jellyfin:8096/Items/item-1/Images/Primary',
				file: {
					path: '/media/Shows/The Expanse/S01E02.mkv',
					size: 2_147_483_648,
					container: 'mkv',
					videoCodec: 'hevc',
					audioCodec: 'eac3',
					width: 1920,
					height: 1080,
					durationMs: 2_700_000,
					bitrate: 6_000_000,
					quickHash: null,
					contentId: null,
					checksum: null,
				},
				addedAt: '2024-01-02T03:04:05.000Z',
			});
		});

		it('degrades every absent field to null instead of throwing', async () => {
			// A scan of forty thousand episodes that dies on the one item with no
			// `MediaSources` has failed for the whole library.
			stubFetch(() => ({ Items: [{ Id: 'bare', Type: 'Movie' }], TotalRecordCount: 1 }));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library)) {
				items.push(item);
			}

			expect(items[0]).toMatchObject({
				externalId: 'bare',
				title: 'bare',
				year: null,
				seasonNumber: null,
				episodeNumber: null,
				overview: null,
				artworkUrl: null,
				file: null,
				addedAt: null,
				parentExternalId: null,
			});
		});

		it('skips a type the gateway does not model', async () => {
			stubFetch(() => ({
				Items: [{ Id: 'photo', Type: 'Photo' }, EPISODE],
				TotalRecordCount: 2,
			}));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library)) {
				items.push(item);
			}

			expect(items.map((item) => item.externalId)).toEqual(['item-1']);
		});

		it('pages until the server runs out of rows', async () => {
			let call = 0;
			const fetchMock = stubFetch(() => {
				call += 1;

				if (call === 1) {
					return {
						Items: Array.from({ length: 20 }, (_, index) => ({
							...EPISODE,
							Id: `page1-${index}`,
						})),
						TotalRecordCount: 25,
					};
				}

				return {
					Items: Array.from({ length: 5 }, (_, index) => ({ ...EPISODE, Id: `page2-${index}` })),
					TotalRecordCount: 25,
				};
			});

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, { pageSize: 20 })) {
				items.push(item);
			}

			expect(items).toHaveLength(25);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('asks only for the types the library can hold', async () => {
			const fetchMock = stubFetch(() => ({ Items: [], TotalRecordCount: 0 }));

			for await (const item of handler.scanLibrary(connection, {
				...library,
				kind: LibraryKind.MOVIES,
			})) {
				void item;
			}

			expect(String(fetchMock.mock.calls[0][0])).toContain('IncludeItemTypes=Movie%2CBoxSet');
		});
	});

	describe('refreshLibrary', () => {
		it('asks for what changed and moves the cursor forward', async () => {
			const fetchMock = stubFetch(() => ({ Items: [EPISODE], TotalRecordCount: 1 }));

			const refresh = await handler.refreshLibrary(connection, library, '2024-01-01T00:00:00Z');

			expect(String(fetchMock.mock.calls[0][0])).toContain('minDateLastSaved=');
			expect(String(fetchMock.mock.calls[0][0])).toContain('sortBy=DateLastSaved');
			expect(refresh.items).toHaveLength(1);
			expect(refresh.cursor).toBe('2024-02-02T03:04:05.000Z');
		});

		it('starts a cursor somewhere rather than re-reading the library forever', async () => {
			stubFetch(() => ({ Items: [], TotalRecordCount: 0 }));

			const refresh = await handler.refreshLibrary(connection, library, null);

			expect(refresh.items).toHaveLength(0);
			expect(refresh.cursor).not.toBeNull();
		});
	});

	describe('getItem and getDownloadUrl', () => {
		it('reads one item by identifier', async () => {
			stubFetch(() => ({ Items: [EPISODE] }));

			expect((await handler.getItem(connection, 'item-1'))?.externalId).toBe('item-1');
		});

		it('answers null for an item the server no longer holds', async () => {
			stubFetch(() => ({ Items: [] }));

			expect(await handler.getItem(connection, 'gone')).toBeNull();
		});

		it('mints a direct URL when it holds a token', async () => {
			expect(await handler.getDownloadUrl(connection, { externalId: 'item-1' })).toBe(
				'http://jellyfin:8096/Items/item-1/Download?api_key=a-token',
			);
		});

		it('answers null rather than a useless URL without a token', async () => {
			expect(
				await handler.getDownloadUrl({ ...connection, token: null }, { externalId: 'item-1' }),
			).toBeNull();
		});
	});
});
