import { LibraryKind, MediaKind, MediaServiceType } from '@mcs/shared';
import { CacheService } from '../cache.service';
import type { NormalisedLibrary, ServiceConnection } from './media-handler.interface';
import { PlexHandler } from './plex.handler';

const connection: ServiceConnection = {
	id: 'service-plex',
	type: MediaServiceType.PLEX,
	baseUrl: 'http://plex:32400',
	token: 'plex-token',
	username: null,
	password: null,
};

const library: NormalisedLibrary = {
	externalId: '2',
	name: 'TV Shows',
	kind: LibraryKind.SHOWS,
	paths: ['/data/shows'],
};

/** One episode as a current Plex answers, `MediaContainer` and all. */
const EPISODE = {
	ratingKey: '45231',
	key: '/library/metadata/45231',
	type: 'episode',
	title: 'Back to the Butcher',
	grandparentTitle: 'The Expanse',
	parentRatingKey: '45230',
	grandparentRatingKey: '45000',
	index: 2,
	parentIndex: 1,
	year: 2015,
	summary: 'The crew looks for answers.',
	thumb: '/library/metadata/45231/thumb/1700000000',
	addedAt: 1_700_000_000,
	updatedAt: 1_700_500_000,
	Guid: [{ id: 'tvdb://5312341' }, { id: 'imdb://tt4192812' }],
	Media: [
		{
			container: 'mkv',
			videoCodec: 'hevc',
			audioCodec: 'eac3',
			width: 1920,
			height: 1080,
			duration: 2_700_000,
			// Plex counts in kilobits per second where Jellyfin counts in bits.
			bitrate: 6_000,
			Part: [
				{
					key: '/library/parts/98765/1700000000/file.mkv',
					file: '/data/shows/The Expanse/S01E02.mkv',
					size: 2_147_483_648,
					container: 'mkv',
				},
			],
		},
	],
};

function stubFetch(handler: (url: string) => unknown): jest.Mock {
	const mock = jest.fn(async (input: string | URL) => {
		const body = handler(String(input));

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

describe('PlexHandler', () => {
	const originalFetch = global.fetch;
	let cache: CacheService;
	let handler: PlexHandler;

	beforeEach(() => {
		delete process.env.REDIS_HOST;
		delete process.env.REDIS_SOCKET;
		cache = new CacheService();
		handler = new PlexHandler(cache);
	});

	afterEach(async () => {
		await cache.onModuleDestroy();
		global.fetch = originalFetch;
	});

	describe('probe', () => {
		it('reads the identity without a token and the name with one', async () => {
			stubFetch((url) => {
				if (url.includes('/identity')) {
					return { MediaContainer: { machineIdentifier: 'abc', version: '1.40.0' } };
				}

				if (url.includes('/library/sections')) {
					return {
						MediaContainer: {
							Directory: [
								{ key: '2', title: 'TV Shows', type: 'show', Location: [{ path: '/data/shows' }] },
								{ key: '1', title: 'Films', type: 'movie', Location: [{ path: '/data/films' }] },
							],
						},
					};
				}

				return { MediaContainer: { friendlyName: 'Living Room', version: '1.40.0' } };
			});

			const probe = await handler.probe(connection);

			expect(probe).toMatchObject({
				reachable: true,
				authenticated: true,
				serverName: 'Living Room',
				version: '1.40.0',
			});
			expect(probe.libraries).toEqual([
				{ externalId: '2', name: 'TV Shows', kind: LibraryKind.SHOWS, paths: ['/data/shows'] },
				{ externalId: '1', name: 'Films', kind: LibraryKind.MOVIES, paths: ['/data/films'] },
			]);
		});

		it('says reachable but unauthenticated when the token is rejected', async () => {
			global.fetch = jest.fn(async (input: string | URL) => {
				if (String(input).includes('/identity')) {
					return {
						ok: true,
						status: 200,
						headers: new Headers(),
						text: async () => JSON.stringify({ MediaContainer: { version: '1.40.0' } }),
					} as unknown as Response;
				}

				return {
					ok: false,
					status: 401,
					headers: new Headers(),
					text: async () => '',
				} as unknown as Response;
			}) as unknown as typeof fetch;

			expect(await handler.probe(connection)).toMatchObject({
				reachable: true,
				authenticated: false,
				version: '1.40.0',
				error: 'error.service.unauthorized',
			});
		});

		it('reports an unreachable server rather than throwing', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			expect(await handler.probe(connection)).toMatchObject({
				reachable: false,
				error: 'error.service.unreachable',
			});
		});
	});

	describe('scanLibrary', () => {
		it('maps an episode onto the normalised shape', async () => {
			stubFetch((url) =>
				url.includes('type=4')
					? { MediaContainer: { Metadata: [EPISODE], totalSize: 1 } }
					: { MediaContainer: { Metadata: [], totalSize: 0 } },
			);

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.EPISODE],
			})) {
				items.push(item);
			}

			expect(items[0]).toEqual({
				externalId: '45231',
				parentExternalId: '45230',
				kind: MediaKind.EPISODE,
				title: 'Back to the Butcher',
				// The show, not the episode. Plex names an unmatched episode
				// `Episode 1`, so normalising on the episode's own title would make
				// every first episode in a library look like every other.
				normalizedTitle: 'expanse',
				year: 2015,
				seasonNumber: 1,
				episodeNumber: 2,
				externalIds: {
					tvdb: '5312341',
					tmdb: undefined,
					imdb: 'tt4192812',
					musicbrainz: undefined,
					provider: '45231',
				},
				overview: 'The crew looks for answers.',
				artworkUrl: 'http://plex:32400/library/metadata/45231/thumb/1700000000',
				file: {
					path: '/data/shows/The Expanse/S01E02.mkv',
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
					// Plex names the cut when the library has several; this episode has
					// one, and null is what "the server has no opinion" looks like.
					edition: null,
				},
				addedAt: new Date(1_700_000_000_000).toISOString(),
			});
		});

		it('takes the edition Plex names, because nothing else can tell two cuts apart', async () => {
			// Two files under one title are two versions, and the label is what a
			// disambiguated filename carries so the second one stops landing on the
			// first. Plex is the only service either handler talks to that reports it.
			stubFetch(() => ({
				MediaContainer: {
					Metadata: [{ ...EPISODE, editionTitle: 'Director’s Cut' }],
					totalSize: 1,
				},
			}));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library)) {
				items.push(item);
			}

			expect(items[0]?.file?.edition).toBe('Director’s Cut');
		});

		it('reads the legacy agent identifier when there is no Guid array', async () => {
			const legacy = {
				...EPISODE,
				Guid: undefined,
				guid: 'com.plexapp.agents.thetvdb://121361/1/2?lang=en',
			};

			stubFetch((url) =>
				url.includes('type=4')
					? { MediaContainer: { Metadata: [legacy], totalSize: 1 } }
					: { MediaContainer: { Metadata: [] } },
			);

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.EPISODE],
			})) {
				items.push(item);
			}

			expect(items[0].externalIds.tvdb).toBe('121361');
		});

		it('degrades every absent field to null instead of throwing', async () => {
			stubFetch(() => ({
				MediaContainer: { Metadata: [{ ratingKey: '1', type: 'movie' }], totalSize: 1 },
			}));

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.MOVIE],
			})) {
				items.push(item);
			}

			expect(items[0]).toMatchObject({
				externalId: '1',
				title: '1',
				year: null,
				overview: null,
				artworkUrl: null,
				file: null,
				addedAt: null,
				parentExternalId: null,
			});
		});

		it('walks show to season to episode when the flat listing comes back empty', async () => {
			// Older servers answer an empty container rather than an error, so the
			// fallback is what keeps them usable at all.
			const season = { ratingKey: '45230', type: 'season', title: 'Season 1', index: 1 };
			const show = { ratingKey: '45000', type: 'show', title: 'The Expanse', year: 2015 };

			stubFetch((url) => {
				if (url.includes('/children') && url.includes('45230')) {
					return { MediaContainer: { Metadata: [EPISODE] } };
				}

				if (url.includes('/children') && url.includes('45000')) {
					return { MediaContainer: { Metadata: [season] } };
				}

				if (url.includes('type=2')) {
					return { MediaContainer: { Metadata: [show], totalSize: 1 } };
				}

				return { MediaContainer: { Metadata: [], totalSize: 0 } };
			});

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.EPISODE],
			})) {
				items.push(item);
			}

			expect(items.map((item) => item.externalId)).toEqual(['45231']);
		});
	});

	describe('refreshLibrary', () => {
		it('filters on the update time and moves the cursor forward', async () => {
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [EPISODE] } }));

			const refresh = await handler.refreshLibrary(connection, library, '1699000000');

			expect(String(fetchMock.mock.calls[0][0])).toContain('updatedAt%3E%3D=1699000000');
			expect(refresh.cursor).toBe('1700500000');
			expect(refresh.items.length).toBeGreaterThan(0);
		});

		it('asks for the newest items when there is no cursor yet', async () => {
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [] } }));

			const refresh = await handler.refreshLibrary(connection, library, null);

			expect(String(fetchMock.mock.calls[0][0])).toContain('/newest');
			expect(refresh.cursor).not.toBeNull();
		});
	});

	describe('bytes', () => {
		it('resolves the part key and caches it across calls', async () => {
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [EPISODE] } }));

			const url = await handler.getDownloadUrl(connection, { externalId: '45231' });

			expect(url).toBe(
				'http://plex:32400/library/parts/98765/1700000000/file.mkv?download=1&X-Plex-Token=plex-token',
			);

			await handler.getDownloadUrl(connection, { externalId: '45231' });

			// The key costs a metadata request, and a multi-connection transfer asks for
			// it once per connection.
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('answers null without a token rather than a URL that cannot work', async () => {
			expect(
				await handler.getDownloadUrl({ ...connection, token: null }, { externalId: '45231' }),
			).toBeNull();
		});
	});

	describe('openArtwork', () => {
		it('signs the request, which Plex requires and Jellyfin does not', async () => {
			// Fetched without the token, every Plex poster comes back 401 and the
			// interface shows a broken image with nothing anywhere saying it was a
			// credential rather than a missing file. That is the failure this asserts
			// against, and it is invisible from any test that only checks the URL.
			const fetched = jest.fn(
				async () =>
					new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
						status: 200,
						headers: { 'content-type': 'image/jpeg' },
					}),
			);

			global.fetch = fetched as unknown as typeof fetch;

			await handler.openArtwork(connection, {
				externalId: '45231',
				artworkUrl: `${connection.baseUrl}/library/metadata/45231/thumb/1700000000`,
			});

			const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];

			expect(String(url)).toContain('/library/metadata/45231/thumb/');
			expect((init.headers as Record<string, string>)['X-Plex-Token']).toBe(connection.token);
		});
	});

	describe('getItem', () => {
		it('reads one item by rating key', async () => {
			stubFetch(() => ({ MediaContainer: { Metadata: [EPISODE] } }));

			expect((await handler.getItem(connection, '45231'))?.title).toBe('Back to the Butcher');
		});

		it('answers null for an item the server no longer holds', async () => {
			stubFetch(() => ({ MediaContainer: {} }));

			expect(await handler.getItem(connection, 'gone')).toBeNull();
		});

		it('answers null when Plex 404s the rating key', async () => {
			// Plex 404s a deleted item rather than answering an empty container, so
			// both shapes have to mean the same thing.
			global.fetch = jest.fn(async () => ({
				ok: false,
				status: 404,
				headers: new Headers(),
				text: async () => '',
			}) as unknown as Response) as unknown as typeof fetch;

			expect(await handler.getItem(connection, 'deleted')).toBeNull();
		});

		it('lets a server that cannot be reached stay a failure', async () => {
			/*
			 * The expensive half of the bug this replaced.
			 *
			 * `getItem` used to end in `.catch(() => null)`, so a Plex that was
			 * rebooting answered "I no longer hold that item" — and revalidation, told
			 * the source was gone, abandoned a transfer whose source was fine and came
			 * back thirty seconds later.
			 */
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(handler.getItem(connection, '45231')).rejects.toMatchObject({
				response: { key: 'error.service.unreachable' },
			});
		});
	});
	describe('authenticate', () => {
		it('reads an identity out of what plex.tv answers', async () => {
			// The gateway does not want to be one more password to remember, so a
			// sign-in is forwarded to the media service the person already has an
			// account on. What comes back is an identity and never a right.
			const fetchMock = stubFetch(() => ({
				user: {
					id: 4211,
					username: 'somebody',
					title: 'Somebody',
					email: 'somebody@example.test',
					thumb: 'https://plex.tv/users/abc/avatar',
					authToken: 'a-session-token',
				},
			}));

			const identity = await handler.authenticate(connection, 'somebody', 'secret');

			expect(identity).toEqual({
				externalUserId: '4211',
				username: 'somebody',
				displayName: 'Somebody',
				email: 'somebody@example.test',
				avatarUrl: 'https://plex.tv/users/abc/avatar',
				token: 'a-session-token',
			});
			// Against plex.tv rather than against the server: a Plex account is not the
			// server's to check, and the server's own token is not the person's.
			expect(String(fetchMock.mock.calls[0][0])).toContain('https://plex.tv/api/v2/users/signin');
		});

		it('names the credentials rather than the service when the sign-in is refused', async () => {
			// `error.service.unauthorized` on a login form reads as "the gateway cannot
			// reach Plex", which sends somebody to check their network instead of their
			// password.
			global.fetch = jest.fn(async () => ({
				ok: false,
				status: 401,
				headers: new Headers(),
				text: async () => '',
			}) as unknown as Response) as unknown as typeof fetch;

			await expect(handler.authenticate(connection, 'somebody', 'wrong')).rejects.toMatchObject({
				response: { key: 'error.auth.invalid_credentials' },
			});
		});

		it('lets an unreachable plex.tv stay unreachable', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(handler.authenticate(connection, 'somebody', 'secret')).rejects.toMatchObject(
				{ response: { key: 'error.service.unreachable' } },
			);
		});

		it('refuses an answer that names nobody', async () => {
			// A 200 with no identifier in it is not a successful sign-in, and treating
			// it as one would create a local account tied to nothing.
			stubFetch(() => ({ user: { username: 'somebody' } }));

			await expect(handler.authenticate(connection, 'somebody', 'secret')).rejects.toMatchObject(
				{ response: { key: 'error.auth.invalid_credentials' } },
			);
		});
	});

	describe('listLibraries', () => {
		it('skips a section the server gave no key for', async () => {
			// Without a key there is nothing to scan and nothing to store it under, and
			// a library row with an empty external identifier collides with the next one.
			stubFetch(() => ({
				MediaContainer: {
					Directory: [
						{ title: 'Nameless', type: 'movie' },
						{ key: '1', title: 'Films', type: 'movie', Location: [{ path: '/data/films' }] },
					],
				},
			}));

			const libraries = await handler.listLibraries(connection);

			expect(libraries).toEqual([
				{ externalId: '1', name: 'Films', kind: LibraryKind.MOVIES, paths: ['/data/films'] },
			]);
		});

		it('calls a section it has no kind for what it is: something else', async () => {
			stubFetch(() => ({
				MediaContainer: { Directory: [{ key: '9', title: 'Holidays', type: 'photo' }] },
			}));

			await expect(handler.listLibraries(connection)).resolves.toMatchObject([
				{ kind: LibraryKind.OTHER, paths: [] },
			]);
		});
	});

	describe('openStream', () => {
		it('asks for the original file rather than a transcode of it', async () => {
			// `download=1` is the difference between the bytes we checksummed and a new
			// encode of them, which would fail verification for a reason nothing names.
			const calls: string[] = [];

			global.fetch = jest.fn(async (input: string | URL) => {
				calls.push(String(input));

				if (String(input).includes('/library/metadata/')) {
					return {
						ok: true,
						status: 200,
						headers: new Headers({ 'content-type': 'application/json' }),
						text: async () => JSON.stringify({ MediaContainer: { Metadata: [EPISODE] } }),
					} as unknown as Response;
				}

				return new Response(new Uint8Array([1, 2, 3]), {
					status: 206,
					headers: { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-2/2048' },
				});
			}) as unknown as typeof fetch;

			const stream = await handler.openStream(
				connection,
				{ externalId: '45231' },
				{ start: 0, end: 2 },
			);

			expect(calls.at(-1)).toContain('/library/parts/98765/1700000000/file.mkv');
			expect(calls.at(-1)).toContain('download=1');
			expect(stream.totalLength).toBe(2048);

			stream.stream.destroy();
		});

		it('refuses to open an item whose part Plex will not name', async () => {
			stubFetch(() => ({ MediaContainer: { Metadata: [] } }));

			await expect(handler.openStream(connection, { externalId: 'gone' })).rejects.toMatchObject(
				{ response: { key: 'error.media.not_found' } },
			);
		});

		it('treats a metadata request that failed as an item with no part', async () => {
			// A server that is rebooting has not said the item is gone, but it has not
			// given us a part key either, and guessing one is worse than saying so.
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(
				handler.getDownloadUrl(connection, { externalId: '45231' }),
			).resolves.toBeNull();
		});
	});

	describe('which kinds a library is walked for', () => {
		/** The `type` query Plex is asked for, in the order it was asked. */
		function typesAskedFor(fetchMock: jest.Mock): string[] {
			return fetchMock.mock.calls
				.map(([url]) => /type=(\d+)/.exec(String(url))?.[1])
				.filter((type): type is string => type !== undefined);
		}

		it('asks a films library for films and nothing else', async () => {
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [], totalSize: 0 } }));

			for await (const _item of handler.scanLibrary(
				connection,
				{ ...library, kind: LibraryKind.MOVIES },
				{},
			)) {
				// The listing is empty; only the questions asked are under test.
			}

			expect([...new Set(typesAskedFor(fetchMock))]).toEqual(['1']);
		});

		it('asks a shows library for parents before children', async () => {
			// The indexing layer resolves a parent reference against something it has
			// already stored, so an episode arriving before its series lands orphaned.
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [], totalSize: 0 } }));

			for await (const _item of handler.scanLibrary(connection, library, {})) {
				// As above.
			}

			expect([...new Set(typesAskedFor(fetchMock))]).toEqual(['2', '3', '4']);
		});

		it('asks a library it cannot classify for everything it understands', async () => {
			const fetchMock = stubFetch(() => ({ MediaContainer: { Metadata: [], totalSize: 0 } }));

			for await (const _item of handler.scanLibrary(
				connection,
				{ ...library, kind: LibraryKind.OTHER },
				{},
			)) {
				// As above.
			}

			expect([...new Set(typesAskedFor(fetchMock))]).toEqual(['1', '2', '3', '4']);
		});

		it('yields the seasons themselves when that is the kind asked for', async () => {
			const season = { ratingKey: '45230', type: 'season', title: 'Season 1', index: 1 };
			const show = { ratingKey: '45000', type: 'show', title: 'The Expanse', year: 2015 };

			stubFetch((url) => {
				if (url.includes('/children')) {
					return { MediaContainer: { Metadata: [season] } };
				}

				if (url.includes('type=2')) {
					return { MediaContainer: { Metadata: [show], totalSize: 1 } };
				}

				return { MediaContainer: { Metadata: [], totalSize: 0 } };
			});

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.SEASON],
			})) {
				items.push(item);
			}

			expect(items.map((item) => item.externalId)).toEqual(['45230']);
		});

		it('passes over a row whose type means nothing to this model', async () => {
			// A Plex holding music answers `artist` and `track`, and an item with no
			// kind cannot be stored — the column is not nullable and would be a lie.
			stubFetch((url) =>
				url.includes('type=1')
					? {
						MediaContainer: {
							Metadata: [
								{ ratingKey: '1', type: 'artist', title: 'Someone' },
								{ ratingKey: '2', type: 'movie', title: 'Arrival' },
							],
							totalSize: 2,
						},
					}
					: { MediaContainer: { Metadata: [], totalSize: 0 } },
			);

			const items = [];

			for await (const item of handler.scanLibrary(
				connection,
				{ ...library, kind: LibraryKind.MOVIES },
				{},
			)) {
				items.push(item);
			}

			expect(items.map((item) => item.externalId)).toEqual(['2']);
		});
		it('stops once it has seen everything the server said there was', async () => {
			// A full page is not the end of the listing, so the loop keeps asking — and
			// a server that answers the same page for a start past its total would keep
			// it asking for ever. The count is the other half of the stop condition.
			const page = Array.from({ length: 20 }, (_, index) => ({
				ratingKey: String(index),
				type: 'movie',
				title: `Film ${index}`,
			}));
			const fetchMock = stubFetch(() => ({
				MediaContainer: { Metadata: page, totalSize: 20 },
			}));

			const items = [];

			for await (const item of handler.scanLibrary(
				connection,
				{ ...library, kind: LibraryKind.MOVIES },
				{ pageSize: 20 },
			)) {
				items.push(item);
			}

			expect(items).toHaveLength(20);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('passes over a season the server gave no key for, and a show it will not open', async () => {
			// One unreadable show must not end the walk: the rest of the library is
			// still there, and a scan that stopped at the first awkward row would index
			// a fraction of it with nothing saying so.
			const show = { ratingKey: '45000', type: 'show', title: 'The Expanse' };
			const other = { ratingKey: '46000', type: 'show', title: 'Severance' };

			const answer = (body: unknown) =>
				({
					ok: true,
					status: 200,
					headers: new Headers({ 'content-type': 'application/json' }),
					text: async () => JSON.stringify(body),
				}) as unknown as Response;

			global.fetch = jest.fn(async (input: string | URL) => {
				const url = String(input);

				if (url.includes('/children') && url.includes('45000')) {
					return answer({
						MediaContainer: {
							Metadata: [{ type: 'season', title: 'Season with no key', index: 1 }],
						},
					});
				}

				if (url.includes('/children') && url.includes('46000')) {
					// The show is there and the request for its children is not answered,
					// which is what a server under load does rather than saying so.
					throw new Error('ECONNRESET');
				}

				if (url.includes('type=2')) {
					return answer({ MediaContainer: { Metadata: [show, other], totalSize: 2 } });
				}

				return answer({ MediaContainer: { Metadata: [], totalSize: 0 } });
			}) as unknown as typeof fetch;

			const items = [];

			for await (const item of handler.scanLibrary(connection, library, {
				kinds: [MediaKind.EPISODE],
			})) {
				items.push(item);
			}

			expect(items).toEqual([]);
		});
	});

	describe('requestRescan', () => {
		it('asks the section to re-read itself, over GET as Plex expects', async () => {
			const fetchMock = stubFetch(() => ({}));

			await expect(handler.requestRescan(connection, library)).resolves.toBe('library');
			expect(String(fetchMock.mock.calls[0][0])).toContain('/library/sections/2/refresh');
		});

		it('says it cannot aim a refresh at a file outside every section', async () => {
			// Answering `unsupported` rather than walking every section of the server:
			// a file in the fallback folder belongs to no section, so a full sweep would
			// re-read terabytes to find something none of them contains.
			const fetchMock = stubFetch(() => ({}));

			await expect(handler.requestRescan(connection, null)).resolves.toBe('unsupported');
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
