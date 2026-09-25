import {
	DownloadClientType,
	ErrorKey,
	type DownloadClientSettings,
} from '@mcs/shared';
import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DownloadClientFor } from './download-client.decorator';
import { CLIENT_TIMEOUT_MS, releaseJson, releaseText } from './release-http';
import type {
	DownloadClient,
	DownloadFile,
	DownloadStatus,
	GrabOrder,
} from './download-client.interface';

/**
 * Whether a failure was this version simply not having that route.
 *
 * The only failure worth asking the same server a second question about: everything
 * else — it is down, it refused us, it answered nonsense — is answered by the first
 * call and repeating it teaches nothing.
 */
const isMissingRoute = (error: unknown): boolean => {
	// The status lives in the payload rather than in the message: a Nest exception's
	// `message` is its own class name, and reading that instead would make every
	// failure look like a missing route — which is how a client that is down would be
	// asked the same question twice and then blamed for refusing.
	if (!(error instanceof HttpException)) {
		return false;
	}

	const payload = error.getResponse();

	return (
		typeof payload === 'object' &&
		payload !== null &&
		String((payload as { detail?: string }).detail ?? '').includes('404')
	);
};

/** qBittorrent's torrent list entry, partial and all optional. See `ProwlarrRelease`. */
interface QbTorrent {
	hash?: string;
	name?: string;
	size?: number;
	completed?: number;
	downloaded?: number;
	dlspeed?: number;
	progress?: number;
	state?: string;
	save_path?: string;
	content_path?: string;
}

/**
 * The states qBittorrent uses for "every byte is here".
 *
 * `progress === 1` is not enough on its own and that is the trap: a torrent being
 * checked reports full progress while the files are still being verified, and copying
 * out of it then reads bytes that are about to be rewritten. Both have to agree.
 */
const COMPLETE_STATES = new Set([
	'uploading',
	'stalledUP',
	'queuedUP',
	'pausedUP',
	'stoppedUP',
	'forcedUP',
	// `checkingUP` is deliberately absent, though it is a "finished" state: it is
	// qBittorrent rechecking a completed torrent, and its data is being rewritten while
	// it says so. Copying out of it then reads bytes that are about to change — which is
	// the precise case this set was built to exclude, so including it would have undone
	// the reason for having it.
]);

/**
 * Driving qBittorrent over its Web API.
 *
 * The session is a cookie and it is fetched per call rather than kept. A long-lived one
 * is the obvious optimisation and it was rejected: qBittorrent drops sessions when it
 * restarts, when its own settings change and after an idle window nobody configures,
 * and every one of those turns into "the client refused" hours later with nothing
 * saying why. A login costs one request against an operation that moves gigabytes.
 *
 * Anonymous access is supported and is the ordinary case on a home network: qBittorrent
 * bypasses authentication for local subnets, and asking it to log in then answers
 * `Fails.` for credentials it does not want. So a login is only attempted when a
 * username is configured.
 */
@Injectable()
@DownloadClientFor(DownloadClientType.QBITTORRENT)
export class QbittorrentClient implements DownloadClient {
	private readonly _logger = new Logger(QbittorrentClient.name);

	public async grab(settings: DownloadClientSettings, order: GrabOrder): Promise<string> {
		const cookie = await this._login(settings);
		const url = order.magnetUrl ?? order.downloadUrl;

		// Nothing to hand over at all. Carrying the bytes counts: a release whose only
		// address is a link this gateway already resolved has no URL left to pass on, and
		// refusing it here would refuse exactly the case the fetching was added for.
		if (url === null && !order.torrentFile) {
			throw new ServiceUnavailableException({ key: ErrorKey.DOWNLOAD_CLIENT_REFUSED });
		}

		// The hashes before and after, because `/torrents/add` answers `Ok.` and nothing
		// else — not the hash, not an error that names the torrent. Diffing the list is
		// the only way to learn which one it just took, and without that identifier
		// nothing can ever be tracked or filed.
		const before = new Set((await this._list(settings, cookie, order.category)).map((one) => one.hash));

		/*
		 * The file itself when we have it, and a link only when we do not.
		 *
		 * A client asked to fetch an indexer's link resolves it from *its* network, where
		 * the `localhost` the link was built with is the client — so it fetches nothing,
		 * adds nothing and answers no error. The bytes are fetched by the gateway, which
		 * is the party the link was built for, and handed over as a file.
		 */
		const parts = order.torrentFile ? new FormData() : null;

		if (parts !== null && order.torrentFile) {
			parts.set(
				'torrents',
				new Blob([order.torrentFile as unknown as BlobPart], { type: 'application/x-bittorrent' }),
				`${order.title}.torrent`,
			);
			parts.set('savepath', order.savePath);
			parts.set('category', order.category);
			parts.set('rename', '');

			if (order.paused === true) {
				parts.set('stopCondition', 'MetadataReceived');
			}
		}

		await releaseText(settings.baseUrl, '/api/v2/torrents/add', {
			...(parts === null ? {} : { multipart: parts }),
			form: parts !== null ? undefined : {
				urls: url ?? '',
				savepath: order.savePath,
				category: order.category,
				/*
				 * Stopped **once the metadata is in**, and not stopped outright.
				 *
				 * Adding a pack that runs before its files can be chosen puts the whole
				 * season on the disk, which is what partial grabbing exists to avoid — so
				 * this used to send `paused`. It deadlocks: a magnet added stopped never
				 * fetches its metadata, `/torrents/files` answers an empty list for ever,
				 * and the file selection that was waiting for that list never happens. The
				 * row sits on "sent", nothing downloads, and nothing anywhere reports a
				 * fault. Verified against qBittorrent 5.2.3, which answers `[]`.
				 *
				 * `stopCondition=MetadataReceived` is the client doing exactly what is
				 * wanted: fetch the torrent's description, stop before any data. A client
				 * too old to know it ignores it and starts downloading, and the selection a
				 * moment later stops the files nobody asked for — some wasted traffic
				 * rather than a grab that never moves.
				 */
				...(order.paused === true ? { stopCondition: 'MetadataReceived' } : {}),
				// Renaming is ours to do when the file is filed, and a client that renamed
				// it first would hide the release name the whole list is read by.
				rename: '',
			},
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
			unauthorized: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		const after = await this._list(settings, cookie, order.category);
		const added = after.find((one) => one.hash !== undefined && !before.has(one.hash));

		if (added?.hash === undefined) {
			/*
			 * It answered and took nothing: a torrent it already has, or one it refused
			 * without saying so. Its own key, because the remedy is in the client rather
			 * than in its address.
			 *
			 * Said out loud, because it was not: this refusal reached a production screen
			 * with the logs carrying no trace of it at all, and working out which of the
			 * three causes it was took a reproduction in a lab. What it was handed is the
			 * one fact that separates them.
			 */
			const handed = order.torrentFile
				? `a ${order.torrentFile.length}-byte file`
				: (order.magnetUrl === null ? `the link ${url}` : 'a magnet');

			this._logger.warn(`${settings.baseUrl} took nothing when handed ${handed} for ${order.title}`);

			throw new ServiceUnavailableException({
				key: ErrorKey.DOWNLOAD_CLIENT_REFUSED,
				detail: `handed ${handed}, and no new torrent appeared in ${order.category}`,
			});
		}

		return added.hash;
	}

	public async statuses(
		settings: DownloadClientSettings,
		category: string,
	): Promise<DownloadStatus[]> {
		const cookie = await this._login(settings);

		return (await this._list(settings, cookie, category))
			.filter((row): row is QbTorrent & { hash: string } => typeof row.hash === 'string')
			.map((row) => {
				const total = row.size ?? 0;
				const done = row.completed ?? row.downloaded ?? Math.round(total * (row.progress ?? 0));

				return {
					clientId: row.hash,
					name: row.name ?? '',
					bytesDone: done,
					bytesTotal: total,
					rate: row.dlspeed ?? 0,
					// Both, never `progress` alone: a torrent being checked reports a full
					// bar over files that are still being verified.
					complete: (row.progress ?? 0) >= 1 && COMPLETE_STATES.has(row.state ?? ''),
					state: row.state ?? '',
					savePath: row.save_path ?? null,
					contentPath: row.content_path ?? null,
				};
			});
	}

	public async files(
		settings: DownloadClientSettings,
		clientId: string,
	): Promise<DownloadFile[]> {
		return this._files(settings, await this._login(settings), clientId);
	}

	/** The listing, with a session the caller already holds. */
	private async _files(
		settings: DownloadClientSettings,
		cookie: string | null,
		clientId: string,
	): Promise<DownloadFile[]> {
		const rows = await releaseJson<
			{ index?: number; name?: string; size?: number; priority?: number }[]
		>(settings.baseUrl, '/api/v2/torrents/files', {
			query: { hash: clientId },
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		// An empty list is the ordinary answer for a magnet whose metadata has not
		// arrived yet, and not a fault: the caller asks again.
		return Array.isArray(rows)
			? rows.map((row, position) => ({
				// `index` appeared in a later version; the position is what older ones
				// key `filePrio` on, and they agree wherever both exist.
				index: row.index ?? position,
				name: row.name ?? '',
				size: row.size ?? 0,
				priority: row.priority ?? 0,
			}))
			: [];
	}

	public async selectFiles(
		settings: DownloadClientSettings,
		clientId: string,
		wantedIndices: number[],
	): Promise<void> {
		const cookie = await this._login(settings);
		const all = await this._files(settings, cookie, clientId);

		// Nothing to choose between. A magnet whose metadata has not arrived lists no
		// files, and raising indices against it is asking a server about files neither
		// side has seen — the caller comes back when there is a list to read.
		if (all.length === 0) {
			return;
		}

		const known = new Set(all.map((file) => file.index));
		const wanted = new Set(wantedIndices.filter((index) => known.has(index)));
		const unwanted = all.filter((file) => !wanted.has(file.index)).map((file) => file.index);

		/*
		 * The unwanted are dropped before the wanted are raised, and the order matters.
		 *
		 * qBittorrent refuses to set every file of a torrent to zero — there would be
		 * nothing to download — so a call that lowered them all at once fails and leaves
		 * the whole pack selected. Lowering the rest first means the failure case is a
		 * torrent that fetches too much rather than one that fetches everything.
		 */
		if (unwanted.length > 0 && unwanted.length < all.length) {
			await this._prio(settings, cookie, clientId, unwanted, 0);
		}

		if (wanted.size > 0) {
			await this._prio(settings, cookie, clientId, [...wanted], 1);
		}
	}

	public async start(settings: DownloadClientSettings, clientId: string): Promise<void> {
		const cookie = await this._login(settings);

		/*
		 * `resume` on qBittorrent 4, `start` on 5, and the one it does not know answers
		 * 404 — not a failure worth propagating when the other works.
		 *
		 * Only a 404 is retried, and that is the correction: catching everything meant a
		 * client that was simply down failed both calls and was then reported as having
		 * *refused*, which sends somebody to the client's own interface when the fault is
		 * its address. The last failure is re-thrown as it came.
		 */
		let last: unknown = null;

		for (const path of ['/api/v2/torrents/start', '/api/v2/torrents/resume']) {
			try {
				await releaseText(settings.baseUrl, path, {
					form: { hashes: clientId },
					headers: cookie === null ? {} : { Cookie: cookie },
					unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
				});

				return;
			} catch (error: unknown) {
				last = error;

				// Anything but "this version has no such route" is a real failure and is
				// not worth asking the same server a second question about.
				if (!isMissingRoute(error)) {
					throw error;
				}
			}
		}

		throw last ?? new ServiceUnavailableException({ key: ErrorKey.DOWNLOAD_CLIENT_REFUSED });
	}

	private async _prio(
		settings: DownloadClientSettings,
		cookie: string | null,
		clientId: string,
		indices: number[],
		priority: number,
	): Promise<void> {
		await releaseText(settings.baseUrl, '/api/v2/torrents/filePrio', {
			form: { hash: clientId, id: indices.join('|'), priority: String(priority) },
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});
	}

	public async probe(settings: DownloadClientSettings): Promise<boolean> {
		const cookie = await this._login(settings);

		await releaseJson<unknown>(settings.baseUrl, '/api/v2/app/version', {
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		return true;
	}

	/**
	 * A session cookie, or none when no username is configured.
	 *
	 * qBittorrent answers `Fails.` with a 200 for wrong credentials rather than a 403,
	 * so the body is what has to be read: a status check alone would take a refusal for
	 * a success and every later call would come back as an empty torrent list — a
	 * client that looks configured, answers, and shows nothing.
	 */
	private async _login(settings: DownloadClientSettings): Promise<string | null> {
		if (!settings.username) {
			return null;
		}

		const { body, headers } = await releaseText(settings.baseUrl, '/api/v2/auth/login', {
			form: { username: settings.username, password: settings.password ?? '' },
			// Its own interface is what a browser would go to next, and qBittorrent
			// refuses a login whose Referer is not its own address.
			headers: { Referer: settings.baseUrl },
			timeoutMs: CLIENT_TIMEOUT_MS,
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
			// A 401 is the client saying no, not an address that does not answer — see
			// the refusal below for why the two must not be confused.
			unauthorized: ErrorKey.DOWNLOAD_CLIENT_REFUSED,
		});

		const cookie = headers.get('set-cookie');

		/*
		 * The session cookie is the answer, and the body is only a second opinion.
		 *
		 * qBittorrent 4 answers a successful login with `200 Ok.` and a refusal with
		 * `200 Fails.`; version 5 answers `204` and an empty body, and refuses with a
		 * `401`. Requiring the word `Ok.` therefore rejected every successful login
		 * against a current client — the gateway reported its own torrent client as
		 * unreachable while it was answering perfectly — and the lab found it on the
		 * first real connection, which is the whole reason the lab runs real servers.
		 *
		 * So: a cookie means a session, whatever was said around it.
		 */
		if (cookie !== null) {
			return cookie.split(';')[0];
		}

		if (body.trim() === 'Ok.') {
			// Authenticated, and no cookie: authentication is off for this address, which
			// is the ordinary local-subnet case. Carry on without one.
			return null;
		}

		// No session and no word of success. A refusal and not an unreachable address:
		// the server answered, promptly and correctly, to say no. Reporting it as
		// unreachable sends somebody to check a hostname that was never the problem.
		throw new ServiceUnavailableException({ key: ErrorKey.DOWNLOAD_CLIENT_REFUSED });
	}

	private async _list(
		settings: DownloadClientSettings,
		cookie: string | null,
		category: string,
	): Promise<QbTorrent[]> {
		const rows = await releaseJson<QbTorrent[]>(settings.baseUrl, '/api/v2/torrents/info', {
			// Only ours. A client somebody also uses for their own downloads must not
			// have those listed, tracked, or — far worse — filed into a library.
			query: { category },
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		return Array.isArray(rows) ? rows : [];
	}
}
