import { ErrorKey } from '@mcs/shared';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { buildUrl, type HttpRequestOptions } from '../handlers/handler.http';

/**
 * Talking to an indexer or a download client, which are not media services.
 *
 * `handler.http` exists and is deliberately not reused: every failure it raises is a
 * `SERVICE_*` key, and those are read all over the interface as "one of your media
 * servers is unreachable". A Prowlarr that is down is not a media server being down —
 * it is a search that cannot run — and telling somebody their Jellyfin is unreachable
 * because a tracker timed out sends them to the wrong screen entirely.
 *
 * The caller passes the key its own failure should carry, so the two consumers here
 * stay distinguishable: an indexer that will not answer and a torrent client that will
 * not answer are two different mornings.
 */

/**
 * Long enough for an aggregator to poll a dozen trackers, short enough that somebody
 * pressing search does not conclude the page has died. Prowlarr fans a search out and
 * waits for the slowest of them, which is routinely several seconds.
 */
export const INDEXER_TIMEOUT_MS = 30_000;

/** A client on the same machine answers in milliseconds or not at all. */
export const CLIENT_TIMEOUT_MS = 10_000;

export interface ReleaseHttpOptions extends HttpRequestOptions {
	/** What a transport failure or a bad status is reported as. */
	unreachable: string;
	/** What a 401 or 403 is reported as. Falls back to `unreachable`. */
	unauthorized?: string;
	/** Sent as a form body rather than JSON, which is what qBittorrent speaks. */
	form?: Record<string, string>;
}

const send = async (
	baseUrl: string,
	path: string,
	options: ReleaseHttpOptions,
): Promise<Response> => {
	const url = buildUrl(baseUrl, path, options.query);
	const hasJson = options.body !== undefined;
	const hasForm = options.form !== undefined;

	try {
		return await fetch(url, {
			method: options.method ?? (hasJson || hasForm ? 'POST' : 'GET'),
			headers: {
				Accept: 'application/json',
				...(hasJson ? { 'Content-Type': 'application/json' } : {}),
				...(hasForm ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
				...(options.headers ?? {}),
			},
			body: hasJson
				? JSON.stringify(options.body)
				: hasForm
					? new URLSearchParams(options.form).toString()
					: undefined,
			signal: AbortSignal.timeout(options.timeoutMs ?? CLIENT_TIMEOUT_MS),
			// Never followed automatically: qBittorrent answers a failed login with a
			// redirect to its own interface, and following it turns a refusal into a
			// page of HTML that parses as nothing and reports as a transport fault.
			redirect: 'manual',
		});
	} catch (cause) {
		throw new ServiceUnavailableException({
			key: options.unreachable,
			detail: cause instanceof Error ? cause.message : String(cause),
		});
	}
};

const check = (response: Response, options: ReleaseHttpOptions): void => {
	if (response.status === 401 || response.status === 403) {
		throw new UnauthorizedException({ key: options.unauthorized ?? options.unreachable });
	}

	if (!response.ok) {
		throw new ServiceUnavailableException({
			key: options.unreachable,
			detail: `HTTP ${response.status}`,
		});
	}
};

/** One JSON request, with the caller's own vocabulary for what went wrong. */
export const releaseJson = async <T>(
	baseUrl: string,
	path: string,
	options: ReleaseHttpOptions,
): Promise<T> => {
	const response = await send(baseUrl, path, options);

	check(response, options);

	const text = await response.text();

	// An empty body is a perfectly good answer to a command — qBittorrent answers
	// `Ok.` to most of them — and `JSON.parse('')` would turn a success into a fault.
	return (text.trim() === '' ? {} : JSON.parse(text)) as T;
};

/** One request whose answer is read as text, and the headers it came back with. */
export const releaseText = async (
	baseUrl: string,
	path: string,
	options: ReleaseHttpOptions,
): Promise<{ body: string; headers: Headers }> => {
	const response = await send(baseUrl, path, options);

	check(response, options);

	return { body: await response.text(), headers: response.headers };
};

/**
 * Follow an indexer's download link far enough to find the magnet behind it.
 *
 * **The reason this exists is a failure that reports success.** Prowlarr does not hand
 * out a tracker's own link: it hands out one back to itself, built from the `Host` of
 * the request that asked — so a search made from the gateway yields
 * `http://localhost:9696/1/download?apikey=…`. Give that to a torrent client running in
 * its own container and `localhost` is the *client*: it fetches nothing, adds nothing,
 * and answers no error at all. The download simply never exists, and every screen says
 * it was handed over.
 *
 * So the gateway follows the link itself, from where the link makes sense, and passes
 * on what it finds. One hop and no more: an indexer answering a redirect chain is an
 * indexer doing something this has no business following, and a bounded walk cannot
 * become a request loop.
 *
 * A link that does not lead to a magnet is answered unchanged. That is honest rather
 * than defeatist — some trackers really do serve `.torrent` bytes at a URL the client
 * can fetch for itself — and the caller can still try it.
 */
export const followToMagnet = async (url: string): Promise<string | null> => {
	try {
		const response = await fetch(url, {
			// Never followed automatically: the whole point is to read the `Location`
			// ourselves rather than to end up holding whatever it pointed at.
			redirect: 'manual',
			signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
		});
		const location = response.headers.get('location');

		return location !== null && location.startsWith('magnet:') ? location : null;
	} catch {
		// The indexer is unreachable from here, which the caller is about to find out
		// anyway when it tries the link. Answering null lets it try.
		return null;
	}
};

/** So a caller can name the general failure without importing the key everywhere. */
export const RELEASE_GENERAL = ErrorKey.GENERAL;
