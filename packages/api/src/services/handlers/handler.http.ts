import { Readable } from 'node:stream';
import { ErrorKey } from '@mcs/shared';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ByteRange, MediaStream } from './media-handler.interface';

/**
 * Default ceiling for one request to a media service.
 *
 * Long enough for a Jellyfin that is busy transcoding, short enough that a probe
 * from the settings screen answers before the person assumes the page is broken.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Streams get their own ceiling: the first byte can take a while, the rest cannot. */
export const STREAM_TIMEOUT_MS = 60_000;

export interface HttpRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	query?: Record<string, string | number | boolean | null | undefined>;
	body?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Join a base URL and a path without producing a double slash or eating one.
 *
 * People type `http://jellyfin:8096/` as often as `http://jellyfin:8096`, and a
 * gateway that answers `404` because of a trailing slash looks broken rather than
 * picky.
 */
export function buildUrl(
	baseUrl: string,
	path: string,
	query?: HttpRequestOptions['query'],
): string {
	const base = baseUrl.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	const url = new URL(base + suffix);

	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === null || value === undefined || value === '') {
			continue;
		}

		url.searchParams.set(key, String(value));
	}

	return url.toString();
}

/**
 * Combine the caller's cancellation with our own deadline.
 *
 * `AbortSignal.any` keeps both alive: a scan that is cancelled halfway stops at
 * once instead of waiting out the timeout, and a hung server still gives up on its
 * own.
 */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);

	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * One JSON request against a media service.
 *
 * Every transport failure becomes `SERVICE_UNREACHABLE` and every 401/403 becomes
 * `SERVICE_UNAUTHORIZED`, because those are the two things the interface can offer
 * to act on. Anything else keeps its status in the message and stays unreachable:
 * a 500 from Plex is, from here, a server we cannot use.
 */
export async function requestJson<T>(
	baseUrl: string,
	path: string,
	options: HttpRequestOptions = {},
): Promise<T> {
	const url = buildUrl(baseUrl, path, options.query);
	const hasBody = options.body !== undefined;
	let response: Response;

	try {
		response = await fetch(url, {
			method: options.method ?? 'GET',
			headers: {
				Accept: 'application/json',
				...(hasBody ? { 'Content-Type': 'application/json' } : {}),
				...(options.headers ?? {}),
			},
			body: hasBody ? JSON.stringify(options.body) : undefined,
			signal: requestSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal),
		});
	} catch (cause) {
		throw new ServiceUnavailableException({
			key: ErrorKey.SERVICE_UNREACHABLE,
			detail: cause instanceof Error ? cause.message : String(cause),
		});
	}

	if (response.status === 401 || response.status === 403) {
		throw new UnauthorizedException({ key: ErrorKey.SERVICE_UNAUTHORIZED });
	}

	if (!response.ok) {
		throw new ServiceUnavailableException({
			key: ErrorKey.SERVICE_UNREACHABLE,
			detail: `HTTP ${response.status}`,
		});
	}

	// A 204, or a server that answers `text/html` to a JSON request, must degrade to
	// an empty object rather than throw: the callers all read fields defensively, and
	// an empty object walks through them producing nulls.
	const text = await response.text();

	if (!text) {
		return {} as T;
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return {} as T;
	}
}

/**
 * Open a byte stream, optionally ranged.
 *
 * The answer reports whether the range was honoured rather than assuming it: a
 * server that replies `200` to a `Range` request is sending the whole file from
 * zero, and writing that into the slot reserved for chunk seventeen would corrupt
 * the file in a way no checksum could explain afterwards.
 */
export async function requestStream(
	baseUrl: string,
	path: string,
	options: HttpRequestOptions & { range?: ByteRange } = {},
): Promise<MediaStream> {
	const url = buildUrl(baseUrl, path, options.query);
	const headers: Record<string, string> = { ...(options.headers ?? {}) };

	if (options.range) {
		headers.Range = `bytes=${options.range.start}-${options.range.end}`;
	}

	let response: Response;

	try {
		response = await fetch(url, {
			method: options.method ?? 'GET',
			headers,
			signal: requestSignal(options.timeoutMs ?? STREAM_TIMEOUT_MS, options.signal),
		});
	} catch (cause) {
		throw new ServiceUnavailableException({
			key: ErrorKey.SERVICE_UNREACHABLE,
			detail: cause instanceof Error ? cause.message : String(cause),
		});
	}

	if (response.status === 401 || response.status === 403) {
		throw new UnauthorizedException({ key: ErrorKey.SERVICE_UNAUTHORIZED });
	}

	if (!response.ok || !response.body) {
		throw new ServiceUnavailableException({
			key: ErrorKey.SERVICE_UNREACHABLE,
			detail: `HTTP ${response.status}`,
		});
	}

	const contentRange = response.headers.get('content-range');
	const acceptRanges = response.headers.get('accept-ranges');

	return {
		// `Readable.fromWeb` is what lets the rest of the transfer layer stay in Node
		// streams, where backpressure against a file handle actually works.
		stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
		contentLength: parseNumber(response.headers.get('content-length')),
		totalLength: parseTotalLength(contentRange),
		// A 206 proves the range was honoured. Without a range asked for, we fall back
		// to what the server advertises, which is the best we can know before trying.
		acceptsRanges: options.range
			? response.status === 206
			: acceptRanges !== null && acceptRanges !== 'none',
		contentType: response.headers.get('content-type'),
	};
}

function parseNumber(raw: string | null): number | null {
	if (raw === null) {
		return null;
	}

	const value = Number(raw);

	return Number.isFinite(value) ? value : null;
}

/** `bytes 0-1023/204800` — the part after the slash, when it is not `*`. */
function parseTotalLength(contentRange: string | null): number | null {
	if (!contentRange) {
		return null;
	}

	const match = /\/(\d+)\s*$/.exec(contentRange);

	return match ? Number(match[1]) : null;
}

/**
 * The path part of a URL a handler produced, relative to its service.
 *
 * Item artwork is stored as an absolute URL because that is what the interface would
 * need if it could fetch it directly — it cannot, since an `<img>` carries no
 * credential — so the handler has to turn it back into something it can sign. A URL
 * that does not belong to this service is returned untouched and will simply fail to
 * resolve, which is better than silently fetching somebody else's host with our token.
 */
export const relativeTo = (baseUrl: string, url: string): string => {
	const base = baseUrl.replace(/\/+$/, '');

	return url.startsWith(base) ? (url.slice(base.length) || '/') : url;
};
