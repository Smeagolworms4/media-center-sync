import { DownloadClientType, type DownloadClientSettings } from '@mcs/shared';
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
	headers: Record<string, string>;
}

type Route = Answer | ((call: Call, index: number) => Answer);

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
		 * Both spellings, because they changed with qBittorrent 5 and a client of either
		 * version ignores the one it does not know. A pack that starts downloading before
		 * its files can be chosen is the whole season on the disk, which is precisely what
		 * partial grabbing exists to avoid.
		 */
		it('asks for a paused add in both spellings of the word', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, { ...ORDER, paused: true });

			const add = callsTo('/api/v2/torrents/add')[0];

			expect(add.form.get('paused')).toBe('true');
			expect(add.form.get('stopped')).toBe('true');
		});

		it('says nothing about pausing when the torrent is meant to run', async () => {
			serve({
				'/api/v2/torrents/info': (_call, index) => (index === 0 ? { body: [] } : { body: [torrent({ hash: 'h' })] }),
				'/api/v2/torrents/add': {},
			});

			await client.grab(SETTINGS, ORDER);

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
				savePath: '/downloads/shows',
				contentPath: '/downloads/shows/Show.S01E01.mkv',
			});
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
