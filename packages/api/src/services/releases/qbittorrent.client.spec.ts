import { createHash } from 'node:crypto';
import { DownloadClientType, ErrorKey, type DownloadClientSettings } from '@mcs/shared';
import { QbittorrentClient } from './qbittorrent.client';
import type { GrabOrder } from './download-client.interface';

/**
 * Driving qBittorrent, which answers `Ok.` to almost everything.
 *
 * Every trap in this suite has the same shape: the client answers, the answer looks
 * like a success, and what actually happened is not what was asked for. A login that
 * failed answers 200. An add that took nothing answers `Ok.`. A torrent being verified
 * reports a full bar. None of them raise anything, and each of them costs either a file
 * that never gets filed or a season on a disk somebody sized for an episode.
 */

const SETTINGS: DownloadClientSettings = {
	type: DownloadClientType.QBITTORRENT,
	baseUrl: 'http://qbittorrent:8080',
	rootMappings: [{ remoteRoot: '/downloads', localRoot: '/share/torrents' }],
	enabled: true,
};

const WITH_LOGIN: DownloadClientSettings = { ...SETTINGS, username: 'admin', password: 'secret' };

const ORDER: GrabOrder = {
	magnetUrl: 'magnet:?xt=urn:btih:new',
	downloadUrl: null,
	title: 'Show.S01E01.1080p.WEB-DL-GRP',
	savePath: '/downloads/shows',
	category: 'mcs',
};

/** What a route answers, in the three shapes qBittorrent actually uses. */
interface Answer {
	status?: number;
	body?: unknown;
	setCookie?: string;
}

/** One request, unpacked into what a test wants to assert about it. */
interface Call {
	path: string;
	query: URLSearchParams;
	form: URLSearchParams;
	/** The multipart body, when the call carried a file rather than a form. */
	parts: FormData | null;
	headers: Record<string, string>;
}

type Route = Answer | ((call: Call, index: number) => Answer);

/** A real info hash: forty hex characters, which is what both ends speak. */
const HASH = 'bb3e6aa5863c22eb623bb32684d5a73dd377c49a';

describe('QbittorrentClient', () => {
	const originalFetch = global.fetch;
	const client = new QbittorrentClient();

	let calls: Call[];

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	/**
	 * A qBittorrent that answers by path.
	 *
	 * Routed rather than sequenced: several of these operations log in, list, act and
	 * list again, and a queue of canned answers would break on the order rather than on
	 * the behaviour under test.
	 */
	function serve(routes: Record<string, Route>): void {
		const counts = new Map<string, number>();

		global.fetch = jest.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);
			const call: Call = {
				path: url.pathname,
				query: url.searchParams,
				form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
				parts: init?.body instanceof FormData ? init.body : null,
				headers: (init?.headers ?? {}) as Record<string, string>,
			};

			calls.push(call);

			const index = counts.get(call.path) ?? 0;

			counts.set(call.path, index + 1);

			const route = routes[call.path];

			if (route === undefined) {
				return { ok: false, status: 404, headers: new Headers(), text: async () => '' } as unknown as Response;
			}

			const answer = typeof route === 'function' ? route(call, index) : route;
			const status = answer.status ?? 200;
			const headers = new Headers();

			if (answer.setCookie !== undefined) {
				headers.set('set-cookie', answer.setCookie);
			}

			return {
				ok: status >= 200 && status < 300,
				status,
				headers,
				text: async () =>
					typeof answer.body === 'string' || answer.body === undefined
						? ((answer.body as string | undefined) ?? 'Ok.')
						: JSON.stringify(answer.body),
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	function torrent(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			hash: 'hash-old',
			name: 'Show.S01E01.1080p.WEB-DL-GRP',
			size: 2_000_000_000,
			completed: 2_000_000_000,
			dlspeed: 0,
			progress: 1,
			state: 'uploading',
			save_path: '/downloads/shows',
			content_path: '/downloads/shows/Show.S01E01.mkv',
			...over,
		};
	}

	const callsTo = (path: string): Call[] => calls.filter((call) => call.path === path);

	describe('grab', () => {
		/**
		 * `/torrents/add` answers `Ok.` and nothing else — not the hash, not an error that
		 * names the torrent. Diffing the list around it is the only way to learn which one
		 * it took, and without that identifier nothing can ever be tracked or filed.
		 */
		it('learns the hash by diffing the list around the add', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => ({
					body: index === 0 ? [torrent()] : [torrent(), torrent({ hash: 'hash-new' })],
				}),
				'/api/v2/torrents/add': {},
			});

			expect(await client.grab(SETTINGS, ORDER)).toBe('hash-new');
		});

		it('hands the client the magnet, the save path and our own category', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, ORDER);

			const add = callsTo('/api/v2/torrents/add')[0];

			expect(add.form.get('urls')).toBe('magnet:?xt=urn:btih:new');
			expect(add.form.get('savepath')).toBe('/downloads/shows');
			expect(add.form.get('category')).toBe('mcs');
			// Renaming is ours to do when the file is filed; a client that renamed it
			// first would hide the release name the whole list is read by.
			expect(add.form.get('rename')).toBe('');
		});

		it('takes the download URL when there is no magnet', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, { ...ORDER, magnetUrl: null, downloadUrl: 'http://indexer/file.torrent' });

			expect(callsTo('/api/v2/torrents/add')[0].form.get('urls')).toBe('http://indexer/file.torrent');
		});

		/**
		 * A pack that starts downloading before its files can be chosen is the whole season
		 * on the disk, which is what partial grabbing exists to avoid — and asking for a
		 * stopped add instead deadlocks: **a magnet added stopped never fetches its
		 * metadata**, so `/torrents/files` answers an empty list for ever and the selection
		 * waiting on that list never happens. Verified against qBittorrent 5.2.3, which
		 * answers `[]`. The row sits on "sent" and nothing anywhere reports a fault.
		 *
		 * `stopCondition=MetadataReceived` is the client doing exactly what is wanted:
		 * fetch the description, stop before any data.
		 */
		it('asks the client to stop once it has the metadata, not before', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, { ...ORDER, paused: true });

			const add = callsTo('/api/v2/torrents/add')[0];

			expect(add.form.get('stopCondition')).toBe('MetadataReceived');
			// And never the flat pause, which is the deadlock.
			expect(add.form.has('paused')).toBe(false);
			expect(add.form.has('stopped')).toBe(false);
		});

		/*
		 * A file rather than a link, and the client is never asked to fetch anything.
		 *
		 * The link an indexer hands out is built from the `Host` of the request that asked
		 * for it, so a client in its own container resolves `localhost:9696` to itself:
		 * nothing fetched, nothing added, no error. Handing over the bytes removes the
		 * question, and the gateway is the party the link was built for.
		 */
		it('uploads the torrent when it was given one, and asks for no link', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: null,
				downloadUrl: 'http://localhost:9696/1/download?apikey=k',
				torrentFile: new Uint8Array([0x64, 0x38]),
			});

			const add = callsTo('/api/v2/torrents/add')[0];

			expect(add.parts?.get('urls')).toBeNull();
			expect(add.parts?.get('savepath')).toBe(ORDER.savePath);
			expect(add.parts?.get('category')).toBe(ORDER.category);
			expect(add.parts?.get('torrents')).toBeInstanceOf(Blob);
		});

		it('still stops on the metadata when it uploads a file for a partial grab', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: null,
				torrentFile: new Uint8Array([0x64]),
				paused: true,
			});

			expect(callsTo('/api/v2/torrents/add')[0].parts?.get('stopCondition'))
				.toBe('MetadataReceived');
		});

		/*
		 * A torrent the client already holds, which it answers 409 to.
		 *
		 * Reported for a week as "your download client is unreachable", on a client that
		 * was answering perfectly: 409 means the torrent is already there, which is a
		 * success with nothing left to do. The row this grab writes then follows the
		 * download that exists rather than refusing to look at it.
		 */
		it('follows a torrent the client already holds rather than calling it unreachable', async () => {
			serve({
				// Empty when asked beforehand and there when asked after: two grabs made at
				// once, which is the case the 409 is still the only signal for.
				'/api/v2/torrents/info': (_call, index) => ({ body: index === 0 ? [] : [torrent({ hash: HASH })] }),
				'/api/v2/torrents/add': { status: 409, body: 'Torrent is already in the session' },
			});

			// Upper case on the wire and lower case in the client's answer, which is what
			// both really do.
			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: `magnet:?xt=urn:btih:${HASH.toUpperCase()}`,
			})).resolves.toBe(HASH);
		});

		it('still refuses a duplicate it cannot name, because it cannot follow one', async () => {
			// No magnet and no file: nothing says which torrent the client already has, and
			// adopting whatever it happens to be doing is worse than saying so.
			serve({
				'/api/v2/torrents/info': { body: [] },
				'/api/v2/torrents/add': { status: 409, body: 'Torrent is already in the session' },
			});

			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: null,
				downloadUrl: 'http://tracker.example/one.torrent',
			})).rejects.toMatchObject({
				response: { key: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE },
			});
		});

		/*
		 * The identifier is the torrent's own, not a row that appeared in our category.
		 *
		 * A client that files it under another category — somebody's own rule, a default
		 * changed once — showed no new row in ours, and the grab was refused for a
		 * download that had started. By hash there is nothing to miss.
		 */
		it('finds the torrent by its hash, wherever the client filed it', async () => {
			serve({
				'/api/v2/torrents/info': (call) => ({
					// Nothing in our category, ever: this is the client that files elsewhere.
					body: call.query.get('category') !== null ? [] : [torrent({ hash: HASH })],
				}),
				'/api/v2/torrents/add': {},
			});

			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: `magnet:?xt=urn:btih:${HASH}`,
			})).resolves.toBe(HASH);
		});

		it('reads the hash out of a torrent file when there is no magnet', async () => {
			// `d4:infod4:name2:hi6:lengthi1eee` — the info value is what is hashed, exactly
			// as written, which is the only way two parties agree on a torrent's name.
			const bytes = new TextEncoder().encode('d4:infod6:lengthi1e4:name2:hiee');
			const hash = createHash('sha1').update(Buffer.from('d6:lengthi1e4:name2:hie')).digest('hex');

			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash })] },
				'/api/v2/torrents/add': {},
			});

			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: null,
				torrentFile: bytes,
			})).resolves.toBe(hash);
		});

		it('says nothing about stopping when the torrent is meant to run', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, ORDER);

			expect(callsTo('/api/v2/torrents/add')[0].form.has('stopCondition')).toBe(false);
			expect(callsTo('/api/v2/torrents/add')[0].form.has('paused')).toBe(false);
		});

		/**
		 * It answered and took nothing: a magnet it already has, or one it refused without
		 * saying so. Answering a hash that is not there would file somebody else's torrent.
		 */
		it('refuses when the list is unchanged after the add', async () => {
			serve({
				'/api/v2/torrents/info': { body: [torrent()] },
				'/api/v2/torrents/add': {},
			});

			await expect(client.grab(SETTINGS, ORDER)).rejects.toMatchObject({
				response: { key: 'error.download_client.refused' },
			});
		});

		it('refuses an order with nothing to fetch, before it asks the client anything', async () => {
			serve({});

			await expect(client.grab(SETTINGS, { ...ORDER, magnetUrl: null, downloadUrl: null })).rejects.toMatchObject({
				response: { key: 'error.download_client.refused' },
			});
			expect(calls).toHaveLength(0);
		});

		/**
		 * A client somebody also uses for their own downloads must not have those listed,
		 * tracked, or — far worse — filed into a library.
		 */
		it('only ever looks at our own category', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, ORDER);

			expect(callsTo('/api/v2/torrents/info').every((call) => call.query.get('category') === 'mcs')).toBe(true);
		});

		it('ignores a row the client listed without a hash', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => ({
					body: index === 0 ? [] : [torrent({ hash: undefined }), torrent({ hash: 'hash-new' })],
				}),
				'/api/v2/torrents/add': {},
			});

			expect(await client.grab(SETTINGS, ORDER)).toBe('hash-new');
		});

		/*
		 * The state of the torrent on the server, read before anything is handed over.
		 *
		 * Asking first is what makes "it is already downloading" and "it is already
		 * finished" ordinary answers rather than errors: the add is not made at all, and the
		 * grab starts on the download that exists. Relying on the 409 instead means the
		 * client's objection is the only evidence, and it carries no hash and no reason.
		 */
		it('follows a torrent it already holds without adding it a second time', async () => {
			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash: HASH, state: 'downloading', progress: 0.3 })] },
				'/api/v2/torrents/add': {},
			});

			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: `magnet:?xt=urn:btih:${HASH}`,
			})).resolves.toBe(HASH);

			expect(callsTo('/api/v2/torrents/add')).toHaveLength(0);
			// By hash, so a torrent the client filed under another category is found.
			expect(callsTo('/api/v2/torrents/info')[0].query.get('hashes')).toBe(HASH);
		});

		it('follows one it already holds complete, which is a grab with only the filing left', async () => {
			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash: HASH, state: 'uploading', progress: 1 })] },
				'/api/v2/torrents/add': {},
			});

			await expect(client.grab(SETTINGS, {
				...ORDER,
				magnetUrl: `magnet:?xt=urn:btih:${HASH}`,
			})).resolves.toBe(HASH);

			expect(callsTo('/api/v2/torrents/add')).toHaveLength(0);
		});

		it('does not list the category when the hash already names the torrent', async () => {
			// One question rather than two: the listing exists only for the torrent whose
			// hash could not be worked out, and asking for it otherwise is a call per grab
			// on a client holding everything anybody ever downloaded.
			serve({
				'/api/v2/torrents/info': (_call, index) => ({ body: index === 0 ? [] : [torrent({ hash: HASH })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, { ...ORDER, magnetUrl: `magnet:?xt=urn:btih:${HASH}` });

			expect(callsTo('/api/v2/torrents/info').every((call) => call.query.get('hashes') === HASH)).toBe(true);
		});

		it('reads a list of the wrong shape as an empty one rather than throwing', async () => {
			// A reverse proxy in front of the client answers HTML, and a search screen
			// that throws on it reads as this gateway being broken.
			serve({
				'/api/v2/torrents/info': (_call, index) => ({ body: index === 0 ? { error: 'nope' } : [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			expect(await client.grab(SETTINGS, ORDER)).toBe('h');
		});
	});

	describe('statuses', () => {
		it('reports where a download has got to', async () => {
			serve({
				'/api/v2/torrents/info': {
					body: [
						torrent({
							hash: 'h1',
							size: 1000,
							completed: 400,
							dlspeed: 125,
							progress: 0.4,
							state: 'downloading',
						}),
					],
				},
			});

			const [status] = await client.statuses(SETTINGS, 'mcs');

			expect(status).toEqual({
				clientId: 'h1',
				name: 'Show.S01E01.1080p.WEB-DL-GRP',
				bytesDone: 400,
				bytesTotal: 1000,
				rate: 125,
				complete: false,
				state: 'downloading',
				failed: false,
				failedReason: null,
				savePath: '/downloads/shows',
				contentPath: '/downloads/shows/Show.S01E01.mkv',
			});
		});

		/*
		 * A torrent the client has given up on, which nothing used to report.
		 *
		 * A production gateway handed qBittorrent a save path it could not write into. The
		 * client put the torrent in `error` at zero bytes, every screen said the download
		 * was in progress, and the only account of it was in the client's own log. The state
		 * is the client's to interpret, so it is the client that says it failed.
		 */
		it.each(['error', 'missingFiles'])('reports a torrent the client gave up on: %s', async (state) => {
			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash: 'h1', state, progress: 0, completed: 0 })] },
			});

			const [status] = await client.statuses(SETTINGS, 'mcs');

			expect(status.failed).toBe(true);
			// Where it was writing, because that is what the reason nearly always is and
			// qBittorrent's listing carries no message of its own.
			expect(status.failedReason).toContain(state);
			expect(status.failedReason).toContain('/downloads/shows');
		});

		it('does not call a stalled download a failure', async () => {
			// No peers is not the same as given up on: it downloads the moment one appears,
			// and failing the row would throw away a grab that is merely waiting.
			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash: 'h1', state: 'stalledDL', progress: 0 })] },
			});

			const [status] = await client.statuses(SETTINGS, 'mcs');

			expect(status.failed).toBe(false);
			expect(status.failedReason).toBeNull();
		});

		/**
		 * The trap the whole `COMPLETE_STATES` set exists for.
		 *
		 * A torrent being checked reports a full bar over files that are still being
		 * verified, and copying out of it then reads bytes that are about to be rewritten
		 * — a file that lands in a library, plays, and is wrong somewhere in the middle.
		 */
		it('refuses to call a full bar complete while the state says otherwise', async () => {
			serve({
				'/api/v2/torrents/info': {
					body: [
						torrent({ hash: 'a', progress: 1, state: 'downloading' }),
						torrent({ hash: 'b', progress: 1, state: 'checkingDL' }),
						torrent({ hash: 'c', progress: 1, state: 'metaDL' }),
						torrent({ hash: 'd', progress: 1, state: 'error' }),
					],
				},
			});

			const statuses = await client.statuses(SETTINGS, 'mcs');

			expect(statuses.map((status) => status.complete)).toEqual([false, false, false, false]);
		});

		it('refuses to call a seeding state complete while the bar is short', async () => {
			serve({
				'/api/v2/torrents/info': { body: [torrent({ progress: 0.99, state: 'uploading' })] },
			});

			expect((await client.statuses(SETTINGS, 'mcs'))[0].complete).toBe(false);
		});

		it.each(['uploading', 'stalledUP', 'queuedUP', 'pausedUP', 'stoppedUP', 'forcedUP'])(
			'calls a full bar in %s complete',
			async (state) => {
				serve({ '/api/v2/torrents/info': { body: [torrent({ progress: 1, state })] } });

				expect((await client.statuses(SETTINGS, 'mcs'))[0].complete).toBe(true);
			},
		);

		it('drops a row with no hash, which nothing could be tracked by', async () => {
			serve({
				'/api/v2/torrents/info': { body: [torrent({ hash: undefined }), torrent({ hash: 'h' })] },
			});

			const statuses = await client.statuses(SETTINGS, 'mcs');

			expect(statuses.map((status) => status.clientId)).toEqual(['h']);
		});

		it('works out the bytes done from the bar when the client reported neither count', async () => {
			serve({
				'/api/v2/torrents/info': {
					body: [torrent({ completed: undefined, downloaded: undefined, size: 1000, progress: 0.25 })],
				},
			});

			expect((await client.statuses(SETTINGS, 'mcs'))[0].bytesDone).toBe(250);
		});

		it('answers nothing for a client holding nothing of ours', async () => {
			serve({ '/api/v2/torrents/info': { body: [] } });

			expect(await client.statuses(SETTINGS, 'mcs')).toEqual([]);
		});

		/*
		 * A torrent filed under somebody else's category is still one of ours to follow.
		 *
		 * The hash is the identifier; the category is only how a grab is made. A poll that
		 * asked by category never saw an adopted torrent at all, and its row sat on `sent`
		 * while the download finished.
		 */
		it('asks about named torrents by hash rather than by category', async () => {
			serve({ '/api/v2/torrents/info': { body: [torrent({ hash: 'h1', category: 'somebody-else' })] } });

			const [status] = await client.statuses(SETTINGS, 'mcs', ['h1', 'h2']);

			expect(status.clientId).toBe('h1');
			expect(callsTo('/api/v2/torrents/info')[0].query.get('hashes')).toBe('h1|h2');
			expect(callsTo('/api/v2/torrents/info')[0].query.get('category')).toBeNull();
		});

		it('asks nothing at all when named no torrents', async () => {
			// An empty list is not "everything you have": answering the whole client would
			// report on somebody else's downloads and file them into a library.
			serve({ '/api/v2/torrents/info': { body: [torrent()] } });

			expect(await client.statuses(SETTINGS, 'mcs', [])).toEqual([]);
			expect(callsTo('/api/v2/torrents/info')).toHaveLength(0);
		});
	});

	describe('files', () => {
		it('lists what is inside a download', async () => {
			serve({
				'/api/v2/torrents/files': {
					body: [
						{ index: 0, name: 'Show/S01E01.mkv', size: 900, priority: 1 },
						{ index: 1, name: 'Show/S01E02.mkv', size: 800, priority: 1 },
					],
				},
			});

			expect(await client.files(SETTINGS, 'h')).toEqual([
				{ index: 0, name: 'Show/S01E01.mkv', size: 900, priority: 1 },
				{ index: 1, name: 'Show/S01E02.mkv', size: 800, priority: 1 },
			]);
			expect(callsTo('/api/v2/torrents/files')[0].query.get('hash')).toBe('h');
		});

		/**
		 * `index` appeared in a later version; the position is what older ones key
		 * `filePrio` on, and priorities sent against the wrong numbers select the wrong
		 * episodes out of a pack.
		 */
		it('falls back to the position for a client too old to report an index', async () => {
			serve({
				'/api/v2/torrents/files': {
					body: [{ name: 'a.mkv', size: 1 }, { name: 'b.mkv', size: 2 }],
				},
			});

			expect((await client.files(SETTINGS, 'h')).map((file) => file.index)).toEqual([0, 1]);
		});

		/**
		 * An empty list is the ordinary answer for a magnet whose metadata has not arrived
		 * yet, and not a fault: the caller asks again.
		 */
		it('answers an empty list rather than failing before the metadata arrives', async () => {
			serve({ '/api/v2/torrents/files': { body: [] } });

			expect(await client.files(SETTINGS, 'h')).toEqual([]);
		});

		it('reads an answer of the wrong shape as an empty list', async () => {
			serve({ '/api/v2/torrents/files': { body: { error: 'nope' } } });

			expect(await client.files(SETTINGS, 'h')).toEqual([]);
		});
	});

	describe('selectFiles', () => {
		const pack = [
			{ index: 0, name: 'Show/S01E01.mkv', size: 900, priority: 1 },
			{ index: 1, name: 'Show/S01E02.mkv', size: 900, priority: 1 },
			{ index: 2, name: 'Show/S01E03.mkv', size: 900, priority: 1 },
			{ index: 3, name: 'Show/sample.mkv', size: 10, priority: 1 },
		];

		/**
		 * The whole difference between taking two episodes out of a season pack and taking
		 * the season.
		 */
		it('drops everything that was not asked for and raises what was', async () => {
			serve({
				'/api/v2/torrents/files': { body: pack },
				'/api/v2/torrents/filePrio': {},
			});

			await client.selectFiles(SETTINGS, 'h', [1]);

			const prio = callsTo('/api/v2/torrents/filePrio');

			expect(prio).toHaveLength(2);
			expect(prio[0].form.get('priority')).toBe('0');
			expect(prio[0].form.get('id')?.split('|').sort()).toEqual(['0', '2', '3']);
			expect(prio[1].form.get('priority')).toBe('1');
			expect(prio[1].form.get('id')).toBe('1');
			expect(prio.every((call) => call.form.get('hash') === 'h')).toBe(true);
		});

		/**
		 * The order matters and it is not cosmetic: qBittorrent refuses to set every file
		 * of a torrent to zero, so a call that raised first and lowered afterwards would
		 * fail on the lowering and leave the whole pack selected.
		 */
		it('lowers the unwanted before it raises the wanted', async () => {
			serve({
				'/api/v2/torrents/files': { body: pack },
				'/api/v2/torrents/filePrio': {},
			});

			await client.selectFiles(SETTINGS, 'h', [0, 1]);

			expect(callsTo('/api/v2/torrents/filePrio').map((call) => call.form.get('priority'))).toEqual(['0', '1']);
		});

		/**
		 * qBittorrent refuses a torrent with nothing left to download. Sent anyway, the
		 * call fails and the whole pack stays selected — the exact outcome partial
		 * grabbing exists to avoid.
		 */
		it('never sets every file of a torrent to zero', async () => {
			serve({
				'/api/v2/torrents/files': { body: pack },
				'/api/v2/torrents/filePrio': {},
			});

			await client.selectFiles(SETTINGS, 'h', []);

			expect(callsTo('/api/v2/torrents/filePrio')).toHaveLength(0);
		});

		it('says nothing to the client when everything in the download was wanted', async () => {
			serve({
				'/api/v2/torrents/files': { body: pack },
				'/api/v2/torrents/filePrio': {},
			});

			await client.selectFiles(SETTINGS, 'h', [0, 1, 2, 3]);

			const prio = callsTo('/api/v2/torrents/filePrio');

			// Nothing to lower, so only the raise — and never a zero over the whole list.
			expect(prio).toHaveLength(1);
			expect(prio[0].form.get('priority')).toBe('1');
		});

		it('leaves a download whose file list has not arrived alone', async () => {
			serve({
				'/api/v2/torrents/files': { body: [] },
				'/api/v2/torrents/filePrio': {},
			});

			await client.selectFiles(SETTINGS, 'h', []);

			expect(callsTo('/api/v2/torrents/filePrio')).toHaveLength(0);
		});
	});

	describe('start', () => {
		/**
		 * `resume` on qBittorrent 4, `start` on 5. The one it does not know answers 404,
		 * which is not a failure worth propagating when the other has already worked.
		 */
		it('uses the spelling this version knows and stops there', async () => {
			serve({ '/api/v2/torrents/start': {} });

			await client.start(SETTINGS, 'h');

			expect(callsTo('/api/v2/torrents/start')).toHaveLength(1);
			expect(callsTo('/api/v2/torrents/resume')).toHaveLength(0);
			expect(callsTo('/api/v2/torrents/start')[0].form.get('hashes')).toBe('h');
		});

		it('falls back to the older spelling when the newer one is not there', async () => {
			serve({ '/api/v2/torrents/resume': {} });

			await client.start(SETTINGS, 'h');

			expect(callsTo('/api/v2/torrents/start')).toHaveLength(1);
			expect(callsTo('/api/v2/torrents/resume')).toHaveLength(1);
		});

		it('reports an unreachable client as unreachable rather than as a refusal', async () => {
			// Both spellings fail because nothing is answering, and blaming the client
			// sends somebody to its own interface when the fault is its address. Only a
			// 404 — "this version has no such route" — is worth a second question.
			serve({});

			await expect(client.start(SETTINGS, 'h')).rejects.toMatchObject({
				response: { key: 'error.download_client.unreachable' },
			});
		});

		it('gives up on the first failure that is not a missing route', async () => {
			serve({ '/api/v2/torrents/start': { status: 500 } });

			await expect(client.start(SETTINGS, 'h')).rejects.toMatchObject({
				response: { key: 'error.download_client.unreachable' },
			});
			expect(callsTo('/api/v2/torrents/resume')).toHaveLength(0);
		});
	});

	describe('the session', () => {
		/**
		 * qBittorrent bypasses authentication for local subnets, and asking it to log in
		 * then answers `Fails.` for credentials it does not want. So a login is only
		 * attempted when a username is configured.
		 */
		it('never logs in when no username is configured', async () => {
			serve({ '/api/v2/torrents/info': { body: [] } });

			await client.statuses(SETTINGS, 'mcs');

			expect(callsTo('/api/v2/auth/login')).toHaveLength(0);
			expect(callsTo('/api/v2/torrents/info')[0].headers.Cookie).toBeUndefined();
		});

		it('carries the session cookie on the call it logged in for', async () => {
			serve({
				'/api/v2/auth/login': { body: 'Ok.', setCookie: 'SID=abc123; HttpOnly; path=/' },
				'/api/v2/torrents/info': { body: [] },
			});

			await client.statuses(WITH_LOGIN, 'mcs');

			const login = callsTo('/api/v2/auth/login')[0];

			expect(login.form.get('username')).toBe('admin');
			expect(login.form.get('password')).toBe('secret');
			// qBittorrent refuses a login whose Referer is not its own address.
			expect(login.headers.Referer).toBe('http://qbittorrent:8080');
			expect(callsTo('/api/v2/torrents/info')[0].headers.Cookie).toBe('SID=abc123');
		});

		/**
		 * The refusal that answers 200.
		 *
		 * A status check alone would take it for a success, and every later call would
		 * come back as an empty torrent list — a client that looks configured, answers,
		 * and shows nothing, with no error anywhere to explain it.
		 */
		it('raises on a refusal that came back as a success', async () => {
			serve({
				'/api/v2/auth/login': { status: 200, body: 'Fails.' },
				'/api/v2/torrents/info': { body: [] },
			});

			// A refusal and not an unreachable address: the server answered, promptly and
			// correctly, to say no. Calling that unreachable sends somebody to check a
			// hostname that was never the problem.
			await expect(client.statuses(WITH_LOGIN, 'mcs')).rejects.toMatchObject({
				response: { key: 'error.download_client.refused' },
			});
			// And nothing was asked of it afterwards, so no empty list can be mistaken
			// for an answer.
			expect(callsTo('/api/v2/torrents/info')).toHaveLength(0);
		});

		it('raises when the login answers a page rather than a word', async () => {
			serve({ '/api/v2/auth/login': { status: 200, body: '<html>sign in</html>' } });

			await expect(client.statuses(WITH_LOGIN, 'mcs')).rejects.toMatchObject({
				response: { key: 'error.download_client.refused' },
			});
		});

		/**
		 * A login that succeeded and set no cookie means authentication is off for this
		 * address, which is the ordinary local-subnet case: carry on without one.
		 */
		it('carries on without a cookie when the login set none', async () => {
			serve({
				'/api/v2/auth/login': { body: 'Ok.' },
				'/api/v2/torrents/info': { body: [torrent({ hash: 'h' })] },
			});

			const statuses = await client.statuses(WITH_LOGIN, 'mcs');

			expect(statuses).toHaveLength(1);
			expect(callsTo('/api/v2/torrents/info')[0].headers.Cookie).toBeUndefined();
		});

		it('logs in for a grab as well, and carries the cookie through the add', async () => {
			serve({
				'/api/v2/auth/login': { body: 'Ok.', setCookie: 'SID=xyz; path=/' },
				'/api/v2/torrents/info': (_call, index) => ({ body: index === 0 ? [] : [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(WITH_LOGIN, ORDER);

			expect(callsTo('/api/v2/torrents/add')[0].headers.Cookie).toBe('SID=xyz');
		});
	});

	describe('probe', () => {
		it('asks the version, which is the cheapest call that needs a session', async () => {
			serve({ '/api/v2/app/version': { body: '"v4.6.2"' } });

			expect(await client.probe(SETTINGS)).toBe(true);
			expect(callsTo('/api/v2/app/version')).toHaveLength(1);
		});

		it('fails on an address that answers nothing this understands', async () => {
			serve({});

			await expect(client.probe(SETTINGS)).rejects.toMatchObject({
				response: { key: 'error.download_client.unreachable' },
			});
		});

		it('fails on credentials the client refuses', async () => {
			serve({ '/api/v2/auth/login': { status: 200, body: 'Fails.' } });

			await expect(client.probe(WITH_LOGIN)).rejects.toMatchObject({
				response: { key: 'error.download_client.refused' },
			});
		});
	});
});
