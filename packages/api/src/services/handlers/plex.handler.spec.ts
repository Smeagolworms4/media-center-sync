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
				normalizedTitle: 'back to the butcher',
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
				},
				addedAt: new Date(1_700_000_000_000).toISOString(),
			});
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

	describe('getItem', () => {
		it('reads one item by rating key', async () => {
			stubFetch(() => ({ MediaContainer: { Metadata: [EPISODE] } }));

			expect((await handler.getItem(connection, '45231'))?.title).toBe('Back to the Butcher');
		});

		it('answers null for an item the server no longer holds', async () => {
			stubFetch(() => ({ MediaContainer: {} }));

			expect(await handler.getItem(connection, 'gone')).toBeNull();
		});
	});
});
