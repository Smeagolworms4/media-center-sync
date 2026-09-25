import { LibraryKind, MediaKind, MediaServiceType } from '@mcs/shared';
import { JellyfinHandler, libraryKindFor } from './jellyfin.handler';
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
	SeriesName: 'The Expanse',
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
		it('gives a series no file, although Jellyfin reports its directory as a path', async () => {
			stubFetch(() => ({
				Items: [
					{
						Id: 'series-1',
						Name: 'The Expanse',
						Type: 'Series',
						IsFolder: true,
						Path: '/media/Shows/The Expanse',
						ProductionYear: 2015,
					},
				],
				TotalRecordCount: 1,
			}));

			const items = [];
			for await (const item of handler.scanLibrary(connection, library)) {
				items.push(item);
			}

			// A phantom file here is not harmless: the quality summary counts files, so
			// every series and every season would contribute a variant with no codec
			// and a size of zero, and a season whose episodes all share one encoding
			// would be reported as mixed. Nothing fails; the chip simply lies.
			expect(items).toHaveLength(1);
			expect(items[0].kind).toBe(MediaKind.SERIES);
			expect(items[0].file).toBeNull();
		});

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
				// The show, not the episode. See `_toItem`: correlation joins on this
				// plus the season and episode numbers, and two libraries agree about
				// the name of a show far more often than about the name of an episode.
				normalizedTitle: 'expanse',
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

	describe('openArtwork and openStream', () => {
		it('opens the poster against the server the item came from', async () => {
			// Jellyfin serves images to anyone, but the URL is relative to the base the
			// service is registered under — not to whatever host the row happens to
			// carry from a peer's catalogue.
			const fetched = jest.fn(
				async () =>
					new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
						status: 200,
						headers: { 'content-type': 'image/jpeg' },
					}),
			);

			global.fetch = fetched as unknown as typeof fetch;

			const artwork = await handler.openArtwork(connection, {
				externalId: 'item-1',
				artworkUrl: 'http://jellyfin:8096/Items/item-1/Images/Primary?tag=tag',
			});

			expect(String((fetched.mock.calls as unknown as [string][])[0][0])).toBe(
				'http://jellyfin:8096/Items/item-1/Images/Primary?tag=tag',
			);
			expect(artwork.contentType).toBe('image/jpeg');

			artwork.stream.destroy();
		});

		it('asks for a range of the original file', async () => {
			const fetched = jest.fn(
				async () =>
					new Response(new Uint8Array([1, 2, 3]), {
						status: 206,
						headers: { 'content-range': 'bytes 0-2/2048', 'accept-ranges': 'bytes' },
					}),
			);

			global.fetch = fetched as unknown as typeof fetch;

			const stream = await handler.openStream(
				connection,
				{ externalId: 'item-1' },
				{ start: 0, end: 2 },
			);

			const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];

			expect(String(url)).toContain('/Items/item-1/Download');
			expect((init.headers as Record<string, string>).Range).toBe('bytes=0-2');
			expect(stream.acceptsRanges).toBe(true);
			expect(stream.totalLength).toBe(2048);

			stream.stream.destroy();
		});

		it('falls back to the static stream when downloads are disabled', async () => {
			// `/Download` is refused when the server disables it and absent on older
			// versions; the stream route serves the same bytes by a longer name, and
			// without this a transfer from such a server fails for no visible reason.
			const asked: string[] = [];

			global.fetch = jest.fn(async (input: string | URL) => {
				asked.push(String(input));

				if (String(input).includes('/Download')) {
					return {
						ok: false,
						status: 403,
						headers: new Headers(),
						text: async () => '',
					} as unknown as Response;
				}

				return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
			}) as unknown as typeof fetch;

			const stream = await handler.openStream(connection, { externalId: 'item-1' });

			expect(asked.at(-1)).toContain('/Videos/item-1/stream');

			stream.stream.destroy();
		});
	});

	describe('describing itself', () => {
		it('asks for exactly the kinds a caller named', async () => {
			// A refresh asks for one kind at a time; asking for episodes in a film
			// library makes Jellyfin walk a tree that is not there.
			const fetchMock = stubFetch(() => ({ Items: [], TotalRecordCount: 0 }));

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.EPISODE],
			})) {
				void item;
			}

			expect(String(fetchMock.mock.calls[0][0])).toContain('IncludeItemTypes=Episode');
		});

		it('still names the server when the token is wrong', async () => {
			// The settings screen has to be able to say "this is your server and this is
			// not your key", which it cannot do if a rejected token erases the name.
			global.fetch = jest.fn(async (input: string | URL) => {
				if (String(input).includes('/System/Info/Public')) {
					throw new Error('ECONNRESET');
				}

				return {
					ok: false,
					status: 401,
					headers: new Headers(),
					text: async () => '',
				} as unknown as Response;
			}) as unknown as typeof fetch;

			// And when even the public endpoint will not answer, the probe is still an
			// answer rather than an exception: it simply knows less.
			await expect(handler.probe(connection)).resolves.toMatchObject({
				reachable: true,
				authenticated: false,
				serverName: null,
				version: null,
			});
		});

		it('refuses a sign-in the server answered with no user in it', async () => {
			stubFetch(() => ({ User: {} }));

			await expect(handler.authenticate(connection, 'sam', 'secret')).rejects.toMatchObject({
				response: { key: 'error.auth.invalid_credentials' },
			});
		});

		it('lets an unreachable server stay unreachable on a sign-in', async () => {
			// Told the credentials were wrong, a person retypes a password that was
			// right; told the server is down, they look at the server.
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(handler.authenticate(connection, 'sam', 'secret')).rejects.toMatchObject({
				response: { key: 'error.service.unreachable' },
			});
		});

		it('skips a folder the server gave no identifier for', async () => {
			// Falling back to the name would make two libraries called `Video` one
			// library nobody can explain.
			stubFetch((url) => {
				if (url.includes('/Library/VirtualFolders')) {
					return [
						{ Name: 'Nameless', CollectionType: 'movies' },
						{ ItemId: 'folder-2', Name: 'Films', CollectionType: 'movies', Locations: ['/media/Films'] },
					];
				}

				return { Version: '10.9.6', ServerName: 'Home' };
			});

			await expect(handler.listLibraries(connection)).resolves.toEqual([
				{
					externalId: 'folder-2',
					name: 'Films',
					kind: LibraryKind.MOVIES,
					paths: ['/media/Films'],
				},
			]);
		});

		it('reads the paths a newer server nests under its library options', async () => {
			// Older versions answer a flat `Locations`; newer ones nest them, and a
			// library with no paths is one nothing can ever be filed into.
			stubFetch((url) => {
				if (url.includes('/Library/VirtualFolders')) {
					return [
						{
							ItemId: 'folder-3',
							Name: 'Concerts',
							CollectionType: 'homevideos',
							LibraryOptions: {
								PathInfos: [{ Path: '/media/Concerts' }, { NetworkPath: '//nas/Concerts' }],
							},
						},
					];
				}

				return { Version: '10.9.6', ServerName: 'Home' };
			});

			await expect(handler.listLibraries(connection)).resolves.toEqual([
				{
					externalId: 'folder-3',
					name: 'Concerts',
					kind: LibraryKind.OTHER,
					paths: ['/media/Concerts'],
				},
			]);
		});

		it('reads a library that declared no content type as one that may hold either', async () => {
			/*
			 * The ordinary case, and the one this was measured on: every one of the
			 * owner's seven Jellyfin libraries answers `CollectionType: None`, because
			 * he never told Jellyfin what any of those folders were for. Reading that as
			 * `OTHER` put an "other" chip on every category on his gateway and ranked
			 * the only libraries that could hold a film behind the ones that could not.
			 */
			stubFetch((url) =>
				url.includes('/Library/VirtualFolders')
					? [
						{ ItemId: 'folder-4', Name: 'Video', CollectionType: 'None', Locations: ['/media'] },
						{ ItemId: 'folder-5', Name: 'Autres', Locations: ['/other'] },
					]
					: { Version: '10.9.6', ServerName: 'Home' },
			);

			await expect(handler.listLibraries(connection)).resolves.toMatchObject([
				{ externalId: 'folder-4', kind: LibraryKind.MIXED },
				{ externalId: 'folder-5', kind: LibraryKind.MIXED },
			]);
		});

		it('asks a library that may hold either for films and shows alike', async () => {
			// Not a fallback here, an accurate question: the server said the library is
			// not narrowed to one, so both are what it may hold.
			const fetchMock = stubFetch(() => ({ Items: [], TotalRecordCount: 0 }));

			for await (const item of handler.scanLibrary(connection, {
				...library,
				kind: LibraryKind.MIXED,
			})) {
				void item;
			}

			expect(String(fetchMock.mock.calls[0][0])).toContain(
				'IncludeItemTypes=Movie%2CSeries%2CSeason%2CEpisode%2CBoxSet',
			);
		});

		it('asks a library it cannot classify for everything it understands', async () => {
			const fetchMock = stubFetch(() => ({ Items: [], TotalRecordCount: 0 }));

			for await (const item of handler.scanLibrary(connection, {
				...library,
				kind: LibraryKind.OTHER,
			})) {
				void item;
			}

			expect(String(fetchMock.mock.calls[0][0])).toContain(
				'IncludeItemTypes=Movie%2CSeries%2CSeason%2CEpisode%2CBoxSet',
			);
		});

		it('stops once it has seen everything the server said there was', async () => {
			// A full page is not the end of a listing, so the loop asks again — and the
			// count is the only thing that stops it asking for ever when a server keeps
			// answering the same page past its own total.
			const page = Array.from({ length: 20 }, (_, index) => ({
				...EPISODE,
				Id: `item-${index}`,
			}));
			const fetchMock = stubFetch(() => ({ Items: page, TotalRecordCount: 20 }));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, { pageSize: 20 })) {
				items.push(item);
			}

			expect(items).toHaveLength(20);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('requestRescan', () => {
		it('asks the one library to re-read itself, recursively', async () => {
			// Recursive is the load-bearing parameter: without it Jellyfin re-reads the
			// library node's own metadata and never descends, so the episode that just
			// landed three directories down is not seen and the refresh looks like a
			// call that did nothing.
			const fetchMock = stubFetch(() => ({}));

			await expect(handler.requestRescan(connection, library)).resolves.toBe('library');

			const [url, init] = fetchMock.mock.calls[0];

			expect(String(url)).toContain('/Items/folder-1/Refresh');
			expect(String(url)).toContain('Recursive=true');
			expect((init as RequestInit).method).toBe('POST');
		});

		/*
		 * The four values are one sentence: ask the providers, replace nothing.
		 *
		 * It used to say `ImageRefreshMode=None` and `MetadataRefreshMode=Default`, which
		 * indexes new files and asks for nothing else — so a torrent filed into a library
		 * appeared there as a bare file name with no artwork, for ever, because the one
		 * moment anybody would have asked for it had gone by.
		 */
		it('asks for the metadata and the images it does not have, and replaces neither', async () => {
			const fetchMock = stubFetch(() => ({}));

			await handler.requestRescan(connection, library);

			const url = String(fetchMock.mock.calls[0][0]);

			expect(url).toContain('MetadataRefreshMode=FullRefresh');
			expect(url).toContain('ImageRefreshMode=FullRefresh');
			// Replacing is what would undo somebody's own corrections and re-download
			// artwork that is already right.
			expect(url).toContain('ReplaceAllMetadata=false');
			expect(url).toContain('ReplaceAllImages=false');
		});

		it('falls back to the whole server when no library can be named', async () => {
			const fetchMock = stubFetch(() => ({}));

			await expect(handler.requestRescan(connection, null)).resolves.toBe('server');
			expect(String(fetchMock.mock.calls[0][0])).toContain('/Library/Refresh');
		});
	});

	describe('listServerDirectories', () => {
		it('names the folders the server declares for its libraries', async () => {
			// The authoritative half of the mapping: what the picker puts at the top as
			// what the server says, against which somebody browses our own disk.
			stubFetch((url) => {
				if (url.includes('/Library/VirtualFolders')) {
					return [
						{
							ItemId: 'folder-1',
							Name: 'Shows',
							CollectionType: 'tvshows',
							Locations: ['/data/media/shows', '/data/media/anime'],
						},
						{
							ItemId: 'folder-2',
							Name: 'Films',
							CollectionType: 'movies',
							Locations: ['/data/media/films'],
						},
					];
				}

				return {};
			});

			await expect(handler.listServerDirectories(connection)).resolves.toEqual({
				support: 'reported',
				path: null,
				parent: null,
				entries: [
					{
						path: '/data/media/shows',
						name: 'shows',
						root: true,
						libraryExternalId: 'folder-1',
						libraryName: 'Shows',
						directory: true,
					},
					{
						path: '/data/media/anime',
						name: 'anime',
						root: true,
						libraryExternalId: 'folder-1',
						libraryName: 'Shows',
						directory: true,
					},
					{
						path: '/data/media/films',
						name: 'films',
						root: true,
						libraryExternalId: 'folder-2',
						libraryName: 'Films',
						directory: true,
					},
				],
			});
		});

		it('keeps only the asked library when one is named', async () => {
			stubFetch((url) =>
				url.includes('/Library/VirtualFolders')
					? [
						{ ItemId: 'folder-1', Name: 'Shows', Locations: ['/data/shows'] },
						{ ItemId: 'folder-2', Name: 'Films', Locations: ['/data/films'] },
					]
					: {},
			);

			const structure = await handler.listServerDirectories(connection, {
				libraryExternalId: 'folder-2',
			});

			expect(structure.entries.map((entry) => entry.path)).toEqual(['/data/films']);
		});

		it('walks into a folder and tells a file from a directory', async () => {
			const fetchMock = stubFetch((url) =>
				url.includes('/Environment/DirectoryContents')
					? [
						{ Name: 'The Expanse', Path: '/data/media/shows/The Expanse', Type: 'Directory' },
						{ Name: 'readme.txt', Path: '/data/media/shows/readme.txt', Type: 'File' },
					]
					: {},
			);

			const structure = await handler.listServerDirectories(connection, {
				path: '/data/media/shows',
				includeFiles: true,
			});

			expect(String(fetchMock.mock.calls[0][0])).toContain('includeFiles=true');
			expect(structure).toEqual({
				support: 'reported',
				path: '/data/media/shows',
				parent: '/data/media',
				entries: [
					{
						path: '/data/media/shows/The Expanse',
						name: 'The Expanse',
						root: false,
						libraryExternalId: null,
						libraryName: null,
						directory: true,
					},
					{
						path: '/data/media/shows/readme.txt',
						name: 'readme.txt',
						root: false,
						libraryExternalId: null,
						libraryName: null,
						directory: false,
					},
				],
			});
		});

		it('reports that it cannot say when the server has no browse route', async () => {
			// A build without `/Environment/DirectoryContents` is a quiet server, not a
			// broken one: turning its 404 into a failure would put an error on screen
			// for a Jellyfin that is answering everything else perfectly well.
			global.fetch = jest.fn(async () => ({
				ok: false,
				status: 404,
				headers: new Headers(),
				text: async () => '',
			})) as unknown as typeof fetch;

			await expect(
				handler.listServerDirectories(connection, { path: '/data/media/shows' }),
			).resolves.toEqual({
				support: 'unsupported',
				path: '/data/media/shows',
				parent: '/data/media',
				entries: [],
			});
		});
	});
});

/**
 * Every collection type Jellyfin can report, asked directly.
 *
 * Through a fetch stub this would be one table-driven rule tested once; the rule is
 * what decides where a pull lands and what chip a category carries, so each answer is
 * pinned down on its own. The distinction being protected is between a type the
 * server named and no type at all: the first is an answer, the second is silence, and
 * silence is "films or shows, we were not told" rather than "something else".
 */
describe('libraryKindFor', () => {
	it.each([
		['movies', LibraryKind.MOVIES],
		['tvshows', LibraryKind.SHOWS],
		['music', LibraryKind.MUSIC],
		['mixed', LibraryKind.MIXED],
		// Types Jellyfin names and this model carries no media for. `boxsets` is the
		// one worth noticing: it holds collections of films and is still not a place a
		// film can be filed, because Jellyfin builds it from the film libraries.
		['musicvideos', LibraryKind.OTHER],
		['homevideos', LibraryKind.OTHER],
		['boxsets', LibraryKind.OTHER],
		['books', LibraryKind.OTHER],
		['photos', LibraryKind.OTHER],
		['livetv', LibraryKind.OTHER],
		['playlists', LibraryKind.OTHER],
		['folders', LibraryKind.OTHER],
		// Casing changes between Jellyfin releases and neither spelling is wrong.
		['TvShows', LibraryKind.SHOWS],
		['Movies', LibraryKind.MOVIES],
	])('reads %s as %s', (collectionType, expected) => {
		expect(libraryKindFor(collectionType)).toBe(expected);
	});

	it('reads a library that declared nothing as one that may hold either', () => {
		// Jellyfin serialises an unset content type three different ways depending on
		// the build and the route, and all three are the same statement.
		expect(libraryKindFor(null)).toBe(LibraryKind.MIXED);
		expect(libraryKindFor(undefined)).toBe(LibraryKind.MIXED);
		expect(libraryKindFor('')).toBe(LibraryKind.MIXED);
		expect(libraryKindFor('None')).toBe(LibraryKind.MIXED);
	});
});
