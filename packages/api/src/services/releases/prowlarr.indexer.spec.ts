import { IndexerType, ReleaseKind, ReleaseSearchKind, type IndexerSettings } from '@mcs/shared';
import { ProwlarrIndexer } from './prowlarr.indexer';
import type { IndexerQuery } from './indexer.interface';

/**
 * Reading somebody else's JSON, over a version nobody pins.
 *
 * Two things are being pinned here and they pull in opposite directions. A search has to
 * survive whatever Prowlarr hands back — a field that moved, a proxy's HTML error page —
 * because a crash on the search screen reads as this gateway being broken. And it has to
 * refuse a row it cannot do anything with, because a release with no magnet and no
 * download URL is a line somebody clicks and nothing happens.
 *
 * Failing to reach it at all is the third answer and is deliberately not an empty list:
 * "nothing found" sends somebody hunting for a better search term while their key is
 * wrong.
 */

const SETTINGS: IndexerSettings = {
	type: IndexerType.PROWLARR,
	baseUrl: 'http://prowlarr:9696',
	apiKey: 'a-key',
	enabled: true,
};

interface Call {
	url: URL;
	headers: Record<string, string>;
}

describe('ProwlarrIndexer', () => {
	const originalFetch = global.fetch;
	const indexer = new ProwlarrIndexer();

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
				headers: (init?.headers ?? {}) as Record<string, string>,
			});

			return {
				ok: status >= 200 && status < 300,
				status,
				headers: new Headers(),
				text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	function row(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			guid: 'guid-1',
			title: 'Spartacus.S02E09.1080p.WEB-DL.MULTI-GRP',
			indexer: 'YGG',
			indexerId: 7,
			size: 2_000_000_000,
			seeders: 42,
			leechers: 3,
			publishDate: '2024-03-01T10:00:00Z',
			magnetUrl: 'magnet:?xt=urn:btih:abc',
			...over,
		};
	}

	const episodeQuery: IndexerQuery = {
		term: 'Spartacus',
		seasonNumber: 2,
		episodeNumber: 9,
		kind: ReleaseSearchKind.SHOW,
	};

	/** Routes by path: the indexer list, then whatever the searches ask for. */
	function answerRouted(indexers: unknown, rowsByCall: Record<string, unknown>): void {
		global.fetch = jest.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);

			calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });

			const body = url.pathname.endsWith('/indexer')
				? indexers
				: rowsByCall[url.searchParams.get('indexerIds') ?? ''] ?? [];

			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => JSON.stringify(body),
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	/**
	 * Asking a tracker by identifier, which only some of them can be asked by.
	 *
	 * Measured on a live Prowlarr before any of this was written: six of nine trackers
	 * declare `imdbId`/`tmdbId`/`tvdbId`, the words alone found 282 releases for Breaking
	 * Bad and the pair found 332.
	 */
	describe('searching by identifier', () => {
		/*
		 * Its own indexer per test, because the tracker list is cached for five minutes on
		 * the instance — which is the point of it in production and a shared fixture here:
		 * the test below about a list that cannot be read would otherwise pass on the list
		 * the test above it had just cached.
		 */
		let indexer: ProwlarrIndexer;

		beforeEach(() => {
			indexer = new ProwlarrIndexer();
		});

		const capable = {
			id: 3,
			enable: true,
			capabilities: { tvSearchParams: ['q', 'season', 'ep', 'tvdbId'], movieSearchParams: ['q', 'tmdbId'] },
		};
		const wordsOnly = {
			id: 8,
			enable: true,
			capabilities: { tvSearchParams: ['q', 'season', 'ep'], movieSearchParams: ['q'] },
		};
		const withIds: IndexerQuery = { ...episodeQuery, externalIds: { tvdb: '81189', imdb: 'tt0903747' } };

		it('never sends an identifier to a tracker that does not declare it', async () => {
			/*
			 * The defect this exists to prevent, measured rather than imagined: an
			 * identifier a tracker ignores is not a narrower search, it is a *blank* one.
			 * The parameter is dropped and back comes whatever that tracker answers for an
			 * empty query — an identifier-only search for Breaking Bad returned Formula 1
			 * and Jason Bourne on a real deployment.
			 */
			answerRouted([capable, wordsOnly], { '3': [row({ guid: 'a' })], '8': [row({ guid: 'b' })] });

			await indexer.search(SETTINGS, withIds);

			const searches = calls.filter(one => one.url.pathname.endsWith('/search'));
			const byId = searches.find(one => one.url.searchParams.get('indexerIds') === '3');
			const byWords = searches.find(one => one.url.searchParams.get('indexerIds') === '8');

			expect(byId?.url.searchParams.get('tvdbId')).toBe('81189');
			expect(byWords?.url.searchParams.get('tvdbId')).toBeNull();
			// And the words go out on both, so the tracker that takes `tvdbId` but not
			// `imdbId` still has something to answer.
			expect(byId?.url.searchParams.get('query')).toContain('Spartacus');
			expect(byWords?.url.searchParams.get('query')).toContain('Spartacus');
		});

		it('merges the two answers on the release’s own identity', async () => {
			// A tracker in neither half would be missed; one answering in both would be
			// counted twice. The identity already carries which tracker it came from.
			answerRouted([capable, wordsOnly], {
				'3': [row({ guid: 'shared' }), row({ guid: 'only-here' })],
				'8': [row({ guid: 'shared' })],
			});

			const releases = await indexer.search(SETTINGS, withIds);

			expect(releases).toHaveLength(2);
			expect(new Set(releases.map(one => one.id)).size).toBe(2);
		});

		it('asks the type that carries the identifier, and the plain one otherwise', async () => {
			// `tvsearch` and `movie` are what carry them; `search` ignores them silently.
			answerRouted([capable, wordsOnly], {});

			await indexer.search(SETTINGS, withIds);

			const searches = calls.filter(one => one.url.pathname.endsWith('/search'));

			expect(searches.find(one => one.url.searchParams.get('indexerIds') === '3')
				?.url.searchParams.get('type')).toBe('tvsearch');
			expect(searches.find(one => one.url.searchParams.get('indexerIds') === '8')
				?.url.searchParams.get('type')).toBe('search');
		});

		it('falls back to one plain search when the query carries no identifier', async () => {
			// Words somebody typed, about nothing in the catalogue. Nothing to read an
			// identifier off, and no reason to ask Prowlarr what its trackers support.
			answer([row()]);

			await indexer.search(SETTINGS, episodeQuery);

			expect(calls).toHaveLength(1);
			expect(calls[0].url.searchParams.get('type')).toBe('search');
			expect(calls[0].url.searchParams.get('indexerIds')).toBeNull();
		});

		it('falls back to one plain search when the list cannot be read', async () => {
			// Degraded, never broken: a Prowlarr that will not say what its trackers
			// support costs precision, not results.
			global.fetch = jest.fn(async (input: string) => {
				const url = new URL(input);

				calls.push({ url, headers: {} });

				return {
					ok: !url.pathname.endsWith('/indexer'),
					status: url.pathname.endsWith('/indexer') ? 500 : 200,
					headers: new Headers(),
					text: async () => (url.pathname.endsWith('/indexer') ? 'nope' : JSON.stringify([row()])),
				} as unknown as Response;
			}) as unknown as typeof fetch;

			const releases = await indexer.search(SETTINGS, withIds);

			expect(releases).toHaveLength(1);
			expect(calls.filter(one => one.url.pathname.endsWith('/search'))).toHaveLength(1);
		});
	});

	describe('the terms it searches for', () => {
		/**
		 * The coordinate goes in the query rather than in Prowlarr's own `season` and
		 * `episode` parameters: those only apply to indexers that declare the tv-search
		 * capability, and the ones that do not ignore them and return the whole show.
		 */
		it('spells the coordinate into the words, because that is what release names hold', async () => {
			answer([]);

			await indexer.search(SETTINGS, episodeQuery);

			expect(calls[0].url.searchParams.get('query')).toBe('Spartacus S02E09');
		});

		it('pads a single-digit coordinate the way release names do', async () => {
			answer([]);

			await indexer.search(SETTINGS, { term: 'Scrubs', seasonNumber: 1, episodeNumber: 4, kind: ReleaseSearchKind.SHOW });

			expect(calls[0].url.searchParams.get('query')).toBe('Scrubs S01E04');
		});

		/**
		 * Asking for `S02E09` and hoping a pack comes back is how somebody looking for the
		 * rest of a season finds one episode of it.
		 */
		it('asks for the season alone when a pack is wanted, episode number or not', async () => {
			answer([]);

			await indexer.search(SETTINGS, { ...episodeQuery, seasonPack: true });

			expect(calls[0].url.searchParams.get('query')).toBe('Spartacus S02');
		});

		it('asks for the season alone when no episode was named', async () => {
			answer([]);

			await indexer.search(SETTINGS, { term: 'Spartacus', seasonNumber: 2, kind: ReleaseSearchKind.SHOW });

			expect(calls[0].url.searchParams.get('query')).toBe('Spartacus S02');
		});

		it('asks for the title alone for a film', async () => {
			answer([]);

			await indexer.search(SETTINGS, { term: 'Blade Runner 2049', kind: ReleaseSearchKind.MOVIE });

			expect(calls[0].url.searchParams.get('query')).toBe('Blade Runner 2049');
		});

		/**
		 * Newznab categories are the vocabulary Prowlarr normalises every tracker into, and
		 * asking with them is what makes a film search stop returning the soundtrack.
		 */
		it.each([
			[ReleaseSearchKind.MOVIE, '2000'],
			[ReleaseSearchKind.SHOW, '5000'],
		])('narrows a %s search to its own category', async (kind, category) => {
			answer([]);

			await indexer.search(SETTINGS, { term: 'Anything', kind });

			expect(calls[0].url.searchParams.get('categories')).toBe(category);
		});

		it('sends the key as the header Prowlarr reads it from', async () => {
			answer([]);

			await indexer.search(SETTINGS, episodeQuery);

			expect(calls[0].headers['X-Api-Key']).toBe('a-key');
			expect(calls[0].url.pathname).toBe('/api/v1/search');
		});
	});

	describe('what it makes of a row', () => {
		it('labels a release from its own name rather than from the indexer fields', async () => {
			// The tracker's category says `TV/HD` for a pack and for one episode alike,
			// and its quality field is filled in by whoever uploaded it.
			answer([row()]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.kind).toBe(ReleaseKind.EPISODE);
			expect(found.seasonNumber).toBe(2);
			expect(found.episodeNumber).toBe(9);
			expect(found.quality).toBe('1080p');
			expect(found.source).toBe('WEB-DL');
			expect(found.languages).toContain('MULTI');
			expect(found.coverage.episodeNumbers).toEqual([9]);
		});

		it('carries across what only the indexer knows', async () => {
			answer([row()]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.size).toBe(2_000_000_000);
			expect(found.seeders).toBe(42);
			expect(found.leechers).toBe(3);
			expect(found.publishedAt).toBe('2024-03-01T10:00:00Z');
			expect(found.magnetUrl).toBe('magnet:?xt=urn:btih:abc');
			expect(found.indexer).toBe('YGG');
		});

		/*
		 * What a release costs on the tracker's ratio, which on a private one decides
		 * whether somebody can take it at all.
		 *
		 * Prowlarr normalises every tracker's own vocabulary into `indexerFlags`, a list of
		 * strings — verified against a running one, which also has no
		 * `downloadVolumeFactor` beside it to fall back on. An empty list is the ordinary
		 * answer from a public tracker and says nothing at all, so it must not be read as
		 * "this costs full ratio".
		 */
		describe('what the tracker says it costs', () => {
			it('carries the flags across, lower-cased', async () => {
				answer([row({ indexerFlags: ['FreeLeech', 'Internal'] })]);

				const [found] = await indexer.search(SETTINGS, episodeQuery);

				expect(found.flags).toEqual(['freeleech', 'internal']);
			});

			it('answers an empty list when the indexer said nothing', async () => {
				answer([row({ indexerFlags: [] })]);

				const [found] = await indexer.search(SETTINGS, episodeQuery);

				expect(found.flags).toEqual([]);
			});

			it('answers an empty list rather than throwing on a shape it did not expect', async () => {
				// Somebody else's API over a version nobody pins: a fork answering a string
				// or a table here must cost one unreadable chip, never the whole search.
				answer([row({ indexerFlags: 'freeleech' })]);

				const [found] = await indexer.search(SETTINGS, episodeQuery);

				expect(found.flags).toEqual([]);
			});

			it('drops the entries that are not strings and keeps the ones that are', async () => {
				answer([row({ indexerFlags: ['freeleech', 3, null, '  ', 'scene'] })]);

				const [found] = await indexer.search(SETTINGS, episodeQuery);

				expect(found.flags).toEqual(['freeleech', 'scene']);
			});
		});

		it('leaves what we hold to the layer that knows it', async () => {
			answer([row()]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.heldAlready).toBe(false);
		});

		/**
		 * A fresh identifier per search would redraw the whole list on every re-search and
		 * lose the line somebody had their pointer on.
		 */
		it('gives a row the same identifier across two searches', async () => {
			answer([row()]);

			const first = await indexer.search(SETTINGS, episodeQuery);

			answer([row({ seeders: 43 })]);

			const second = await indexer.search(SETTINGS, episodeQuery);

			expect(second[0].id).toBe(first[0].id);
		});

		it('prefixes the identifier with the indexer, because trackers reuse guids', async () => {
			answer([row({ indexerId: 7 }), row({ indexerId: 9 })]);

			const found = await indexer.search(SETTINGS, episodeQuery);

			expect(found[0].id).not.toBe(found[1].id);
		});

		it('says nothing rather than guessing at the fields a row left out', async () => {
			answer([{ title: 'Some.Upload.1080p', downloadUrl: 'http://prowlarr/download/1' }]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.size).toBeNull();
			expect(found.seeders).toBeNull();
			expect(found.leechers).toBeNull();
			expect(found.publishedAt).toBeNull();
			expect(found.magnetUrl).toBeNull();
			expect(found.indexer).toBe('Prowlarr');
		});

		it('reads a size of zero as nothing reported', async () => {
			answer([row({ size: 0 })]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.size).toBeNull();
		});

		it('keeps a genuine zero seeders, which is not the same as no answer', async () => {
			// Zero seeders is a download that will never finish and is worth showing as
			// such; "the tracker did not say" is not that answer.
			answer([row({ seeders: 0 })]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.seeders).toBe(0);
		});

		/**
		 * A film's name is full of numbers and none of them are coordinates, so a title
		 * nothing could be read off is still a film when a film is what was searched for —
		 * whereas for a show it stays unknown and is shown as such.
		 */
		it('reads an unreadable name as a film when a film was searched for', async () => {
			answer([row({ title: 'Some.Untagged.Upload' })]);

			const [found] = await indexer.search(SETTINGS, { term: 'Some Upload', kind: ReleaseSearchKind.MOVIE });

			expect(found.kind).toBe(ReleaseKind.MOVIE);
		});

		it('leaves an unreadable name unknown when a show was searched for', async () => {
			answer([row({ title: 'Some.Untagged.Upload' })]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.kind).toBe(ReleaseKind.UNKNOWN);
		});
	});

	describe('the rows it refuses', () => {
		/**
		 * A row with no magnet and no download URL can be neither shown usefully nor
		 * grabbed: it is a line somebody clicks and nothing happens.
		 */
		it('drops a row with no way to fetch it', async () => {
			answer([
				row({ guid: 'keep', magnetUrl: 'magnet:?xt=urn:btih:keep' }),
				row({ guid: 'drop', magnetUrl: undefined, downloadUrl: undefined }),
			]);

			const found = await indexer.search(SETTINGS, episodeQuery);

			expect(found).toHaveLength(1);
			expect(found[0].magnetUrl).toBe('magnet:?xt=urn:btih:keep');
		});

		it('keeps a row that carries a download URL instead of a magnet', async () => {
			answer([row({ magnetUrl: undefined, downloadUrl: 'http://prowlarr/download/1' })]);

			const found = await indexer.search(SETTINGS, episodeQuery);

			expect(found).toHaveLength(1);
			expect(found[0].downloadUrl).toBe('http://prowlarr/download/1');
			expect(found[0].magnetUrl).toBeNull();
		});

		it.each([
			['no title at all', { title: undefined }],
			['a title of nothing but spaces', { title: '   ' }],
		])('drops a row with %s', async (_label, over) => {
			answer([row(over)]);

			expect(await indexer.search(SETTINGS, episodeQuery)).toEqual([]);
		});

		it('trims the title it keeps', async () => {
			answer([row({ title: '  Spartacus.S02E09.1080p.WEB-DL-GRP  ' })]);

			const [found] = await indexer.search(SETTINGS, episodeQuery);

			expect(found.title).toBe('Spartacus.S02E09.1080p.WEB-DL-GRP');
		});
	});

	describe('an answer of the wrong shape', () => {
		/**
		 * A proxy error page is a perfectly ordinary thing to get back from a URL somebody
		 * typed, and it must cost an empty search rather than a screen that throws.
		 */
		it.each([
			['an object where a list was expected', { error: 'nope' }],
			['a bare string', '"unauthorised"'],
			['null', null],
		])('reads %s as an empty search', async (_label, body) => {
			answer(body);

			expect(await indexer.search(SETTINGS, episodeQuery)).toEqual([]);
		});

		it('reads an empty body as an empty search', async () => {
			answer('');

			expect(await indexer.search(SETTINGS, episodeQuery)).toEqual([]);
		});
	});

	describe('when it cannot be reached', () => {
		/**
		 * "Nothing found" and "nobody answered" are opposite answers, and a search screen
		 * that shows the first for the second sends somebody hunting for a better search
		 * term while their key is wrong.
		 */
		it('raises rather than answering an empty list when the transport fails', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(indexer.search(SETTINGS, episodeQuery)).rejects.toMatchObject({
				response: { key: 'error.indexer.unreachable' },
			});
		});

		it('raises its own key rather than one of the media-server ones', async () => {
			// `error.service.*` is read all over the interface as "one of your media
			// servers is down", which sends somebody to entirely the wrong screen.
			answer({}, 500);

			await expect(indexer.search(SETTINGS, episodeQuery)).rejects.toMatchObject({
				response: { key: 'error.indexer.unreachable' },
			});
		});

		it('raises on a refused key rather than looking like an empty catalogue', async () => {
			answer({}, 401);

			await expect(indexer.search(SETTINGS, episodeQuery)).rejects.toMatchObject({
				response: { key: 'error.indexer.unreachable' },
			});
		});
	});

	describe('probe', () => {
		/**
		 * The indexer list rather than a search: it is the cheapest call that needs the
		 * key, so a wrong key fails here rather than looking like an empty catalogue.
		 */
		it('asks the one call that needs the key', async () => {
			answer([]);

			expect(await indexer.probe(SETTINGS)).toBe(true);
			expect(calls[0].url.pathname).toBe('/api/v1/indexer');
			expect(calls[0].headers['X-Api-Key']).toBe('a-key');
		});

		it('fails on a key the server refuses', async () => {
			answer({}, 401);

			await expect(indexer.probe(SETTINGS)).rejects.toMatchObject({
				response: { key: 'error.indexer.unreachable' },
			});
		});
	});
});
