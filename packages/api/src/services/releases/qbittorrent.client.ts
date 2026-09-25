import {
	DownloadClientType,
	ErrorKey,
	type DownloadClientSettings,
} from '@mcs/shared';
import { createHash } from 'node:crypto';
import {
	HttpException,
	HttpStatus,
	Injectable,
	Logger,
	ServiceUnavailableException,
} from '@nestjs/common';
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

/**
 * The HTTP status behind a failure, when the far end gave one.
 *
 * Read from the payload's `detail` for the reason `isMissingRoute` gives above: a Nest
 * exception's message is its own class name, and the status the client answered is only
 * ever in the detail this layer put there.
 */
const statusOf = (error: unknown): number | null => {
	if (!(error instanceof HttpException)) {
		return null;
	}

	const payload = error.getResponse();
	const detail = typeof payload === 'object' && payload !== null
		? String((payload as { detail?: unknown }).detail ?? '')
		: '';
	const found = /^HTTP (\d{3})$/.exec(detail);

	return found === null ? null : Number(found[1]);
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
/**
 * The states in which the client has stopped trying.
 *
 * `error` is nearly always the save path: the folder it was told to write into is not one
 * it may write into, which nothing validates when the download client is configured — and
 * a torrent it cannot write sits at zero bytes with every screen saying "downloading".
 * `missingFiles` is the same sentence after the fact: the files it had are gone.
 */
const FAILED_STATES = new Set(['error', 'missingFiles']);

/**
 * The states a torrent is in when somebody stopped it.
 *
 * Both spellings, because both are current: qBittorrent 4 says `paused*` and 5 says
 * `stopped*`, and a gateway that knew one of them would report the other's idle torrents
 * as downloading at zero bytes for ever.
 */
const PAUSED_STATES = new Set([
	'pausedDL',
	'pausedUP',
	'stoppedDL',
	'stoppedUP',
]);

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
/**
 * How long to give a client to show a torrent it has just taken.
 *
 * `add` answers before the row exists, and a client on a busy disk takes a beat to write
 * it. Half a second, four times: long enough for the slowest lab client seen here, short
 * enough that a genuine refusal is still reported while somebody is watching.
 */
const ADD_ATTEMPTS = 4;
const ADD_RETRY_MS = 500;

/**
 * The info hash a magnet names, or null when it names none.
 *
 * `xt=urn:btih:` carries it in hex or in base32, and both are seen in the wild — a
 * tracker that answers base32 is not exotic, it is just older.
 */
const hashOfMagnet = (magnet: string): string | null => {
	const found = /xt=urn:btih:([a-z\d]+)/i.exec(magnet);
	const value = found?.[1];

	if (value === undefined) {
		return null;
	}

	if (value.length === 40) {
		return value.toLowerCase();
	}

	if (value.length !== 32) {
		return null;
	}

	// Base32, which qBittorrent answers back in hex: decoded here so the two can be
	// compared at all.
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';

	for (const character of value.toUpperCase()) {
		const index = alphabet.indexOf(character);

		if (index === -1) {
			return null;
		}

		bits += index.toString(2).padStart(5, '0');
	}

	return (bits.match(/.{8}/g) ?? [])
		.map((byte) => Number.parseInt(byte, 2).toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 40);
};

/**
 * The info hash of a `.torrent`, which is the SHA-1 of its `info` value exactly as
 * written.
 *
 * Exactly as written matters: the hash is over the bencoded bytes, so decoding and
 * re-encoding would answer a different torrent for anything whose keys are not in the
 * order this parser would have chosen. The value is found by walking the bencoding from
 * the `4:info` key, which is the only way to know where it ends.
 */
const hashOfTorrent = (bytes: Uint8Array): string | null => {
	const text = Buffer.from(bytes).toString('latin1');
	const key = text.indexOf('4:info');

	if (key === -1) {
		return null;
	}

	const start = key + '4:info'.length;
	const end = endOfBencodedValue(text, start);

	return end === null
		? null
		: createHash('sha1').update(Buffer.from(bytes).subarray(start, end)).digest('hex');
};

/** Where the bencoded value starting at `from` ends, or null on anything malformed. */
const endOfBencodedValue = (text: string, from: number): number | null => {
	const marker = text[from];

	if (marker === 'd' || marker === 'l') {
		let at = from + 1;

		while (text[at] !== 'e') {
			if (at >= text.length) {
				return null;
			}

			const next = endOfBencodedValue(text, at);

			if (next === null) {
				return null;
			}

			at = next;
		}

		return at + 1;
	}

	if (marker === 'i') {
		const end = text.indexOf('e', from);

		return end === -1 ? null : end + 1;
	}

	const colon = text.indexOf(':', from);
	const length = colon === -1 ? Number.NaN : Number(text.slice(from, colon));

	return Number.isFinite(length) ? colon + 1 + length : null;
};

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

		/*
		 * What this torrent is called, worked out before it is handed over.
		 *
		 * `/torrents/add` answers `Ok.` and nothing else — not the hash, not an error that
		 * names the torrent — so something has to say which row belongs to this grab. The
		 * info hash is that something, and it is knowable in advance: a magnet carries it,
		 * and a `.torrent` is the SHA-1 of its own `info` value.
		 *
		 * This used to be a before-and-after diff of our own category, which is wrong in
		 * two ordinary cases and was wrong in production in both: a client that files the
		 * torrent under another category shows no new row and the grab is "refused", and a
		 * client that already holds it answers **409** and the grab is reported as an
		 * unreachable client. Neither is what happened, and neither sends anybody anywhere
		 * useful.
		 */
		const wanted = order.torrentFile
			? hashOfTorrent(order.torrentFile)
			: (order.magnetUrl === null ? null : hashOfMagnet(order.magnetUrl));
		/*
		 * Does it already hold this one, before anything is handed over.
		 *
		 * Asked first because the answer changes what there is to do, and asking costs one
		 * call: a torrent the client already has needs no add at all, and its state —
		 * downloading, complete, or given up on — is the state this grab starts in. Adding
		 * it blind instead means relying on the client to object, and what it answers is a
		 * bare **409** that carries neither the hash nor a reason.
		 *
		 * The 409 path below is still there, and still needed: the hash is unknown for a
		 * link this gateway could not fetch, and two grabs made at once can both pass this
		 * check. Before when we can, after when we cannot.
		 */
		const held = wanted === null ? null : await this._held(settings, cookie, wanted);

		if (held !== null) {
			this._logger.log(
				`${settings.baseUrl} already holds ${order.title} as ${wanted}`
				+ ` (${held.state ?? 'no state'}, ${Math.round((held.progress ?? 0) * 100)}%);`
				+ ' following it rather than adding it again',
			);

			return wanted as string;
		}

		// Only for the torrent whose hash we could not work out, which is the one case the
		// identification below has to diff the list to name. Listing costs a call and the
		// known-hash path has no use for it.
		const before = wanted !== null
			? new Set<string | undefined>()
			: new Set((await this._list(settings, cookie, order.category)).map((one) => one.hash));

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

		/*
		 * A client that already holds it answers 409, and that is a success with nothing
		 * left to do: the torrent is there, it is the one that was asked for, and the row
		 * this grab writes is about to follow it. Refusing here is what produced
		 * "unreachable, HTTP 409" on a gateway whose client was working perfectly.
		 *
		 * Only when the hash is known, because adopting a torrent we cannot identify would
		 * be adopting whatever the client happened to be doing.
		 */
		const duplicate = (error: unknown): boolean =>
			wanted !== null && statusOf(error) === HttpStatus.CONFLICT;

		try {
			await this._add(settings, cookie, order, url, parts);
		} catch (error: unknown) {
			if (!duplicate(error)) {
				throw error;
			}

			this._logger.log(`${settings.baseUrl} already holds ${order.title}; following it`);
		}

		return await this._identify(settings, cookie, order, url, wanted, before);
	}

	/** That one torrent as the client holds it, or null when the client does not. */
	private async _held(
		settings: DownloadClientSettings,
		cookie: string | null,
		wanted: string,
	): Promise<QbTorrent | null> {
		const rows = await releaseJson<QbTorrent[]>(settings.baseUrl, '/api/v2/torrents/info', {
			// By hash and not by category, so a torrent the client filed under somebody
			// else's category is still found — it is the same torrent, and adding it a
			// second time would not produce a second one.
			query: { hashes: wanted },
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		return Array.isArray(rows) && rows.length > 0 ? (rows[0] as QbTorrent) : null;
	}

	/** The add itself: a file when we fetched one, a link when we did not. */
	private async _add(
		settings: DownloadClientSettings,
		cookie: string | null,
		order: GrabOrder,
		url: string | null,
		parts: FormData | null,
	): Promise<void> {
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

		return;
	}

	/**
	 * Which row in the client is this grab's, once it has taken it.
	 *
	 * By hash when the hash is known, and it usually is. Falling back to "the row in our
	 * category that was not there before" only for the client that answered no hash and no
	 * magnet — and that fallback is what used to be the whole of this.
	 *
	 * Given a moment, because `add` returns before the torrent appears in the listing: a
	 * client on a busy disk takes a beat to write it, and answering "it took nothing" in
	 * that beat is a refusal for a download that is about to start.
	 */
	private async _identify(
		settings: DownloadClientSettings,
		cookie: string | null,
		order: GrabOrder,
		url: string | null,
		wanted: string | null,
		before: Set<string | undefined>,
	): Promise<string> {
		for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt += 1) {
			if (wanted !== null) {
				const rows = await releaseJson<QbTorrent[]>(settings.baseUrl, '/api/v2/torrents/info', {
					// By hash and not by category: a client that filed it elsewhere still
					// holds the torrent that was asked for, and it is still ours to follow.
					query: { hashes: wanted },
					headers: cookie === null ? {} : { Cookie: cookie },
					unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
				});

				if (Array.isArray(rows) && rows.length > 0) {
					return wanted;
				}
			} else {
				const after = await this._list(settings, cookie, order.category);
				const added = after.find((one) => one.hash !== undefined && !before.has(one.hash));

				if (added?.hash !== undefined) {
					return added.hash;
				}
			}

			await new Promise((resolve) => setTimeout(resolve, ADD_RETRY_MS));
		}

		{
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
				detail: wanted === null
					? `handed ${handed}, and no new torrent appeared in ${order.category}`
					: `handed ${handed}, and ${wanted} is not in the client`,
			});
		}
	}

	public async statuses(
		settings: DownloadClientSettings,
		category: string,
		hashes?: string[],
	): Promise<DownloadStatus[]> {
		// Asked for nothing, so nothing is asked. An empty list of hashes is not "every
		// torrent you have": answering the whole client here would report on somebody
		// else's downloads and file them into a library.
		if (hashes !== undefined && hashes.length === 0) {
			return [];
		}

		const cookie = await this._login(settings);

		return (await this._list(settings, cookie, category, hashes))
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
					failed: FAILED_STATES.has(row.state ?? ''),
					paused: PAUSED_STATES.has(row.state ?? ''),
					// qBittorrent's listing carries no message — the reason is in its own log
					// — so the one fact worth carrying is where it was writing, because that
					// is what the reason nearly always is.
					failedReason: FAILED_STATES.has(row.state ?? '')
						? `the client reports ${row.state} for this torrent, writing into ${row.save_path ?? 'its default folder'}`
						: null,
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

	/**
	 * Stop a torrent, keeping what it has already fetched.
	 *
	 * `stop` on qBittorrent 5 and `pause` on 4, tried in that order for the reason
	 * `start` documents: the version that does not know a route answers 404, and only a
	 * 404 is worth asking the same server a second question about.
	 */
	public async pause(settings: DownloadClientSettings, clientId: string): Promise<void> {
		const cookie = await this._login(settings);
		let last: unknown = null;

		for (const path of ['/api/v2/torrents/stop', '/api/v2/torrents/pause']) {
			try {
				await releaseText(settings.baseUrl, path, {
					form: { hashes: clientId },
					headers: cookie === null ? {} : { Cookie: cookie },
					unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
				});

				return;
			} catch (error: unknown) {
				last = error;

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
	 * The folder qBittorrent writes into when nothing else says otherwise.
	 *
	 * `/app/preferences` rather than anything computed here: it is the answer the client
	 * would give itself, in its own container's spelling, and it is by construction a
	 * folder it can write.
	 *
	 * Null rather than a throw whenever it does not answer, is empty, or is not there:
	 * this is consulted while sending a download, and a client whose preferences route is
	 * missing must still be able to take one. The caller has a fallback and this is not
	 * the place to refuse.
	 */
	public async defaultSavePath(settings: DownloadClientSettings): Promise<string | null> {
		try {
			const cookie = await this._login(settings);
			const preferences = await releaseJson<{ save_path?: unknown }>(
				settings.baseUrl,
				'/api/v2/app/preferences',
				{
					headers: cookie === null ? {} : { Cookie: cookie },
					unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
				},
			);
			const path = typeof preferences?.save_path === 'string' ? preferences.save_path.trim() : '';

			return path === '' ? null : path;
		} catch (error: unknown) {
			this._logger.warn(`${settings.baseUrl} would not say where it writes: ${String(error)}`);

			return null;
		}
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
		hashes?: string[],
	): Promise<QbTorrent[]> {
		const rows = await releaseJson<QbTorrent[]>(settings.baseUrl, '/api/v2/torrents/info', {
			// Named torrents when the caller named them, and only ours otherwise. A client
			// somebody also uses for their own downloads must not have those listed,
			// tracked, or — far worse — filed into a library; a hash the caller already
			// holds is a torrent it is already following, whatever the client filed it as.
			query: hashes === undefined ? { category } : { hashes: hashes.join('|') },
			headers: cookie === null ? {} : { Cookie: cookie },
			unreachable: ErrorKey.DOWNLOAD_CLIENT_UNREACHABLE,
		});

		return Array.isArray(rows) ? rows : [];
	}
}
