import { ErrorKey } from '@mcs/shared';

/**
 * The error key behind an exception, whatever shape it was thrown in.
 *
 * Extracted because two places now need it: a peer answering a far gateway, and a
 * release search saying which of three failures an indexer hit. A second copy of this
 * would be a second place for the fallback to drift.
 *
 * Three shapes reach here and all three are used in this code base:
 * `new NotFoundException({ key })`, where the object is returned verbatim, and
 * `new NotFoundException(key)`, where Nest wraps the string into `{ message, ... }`
 * before anybody sees it. Reading only the first was enough to turn every
 * `error.media.not_found` into `error.general` on the wire, and the far end acted on
 * it: a source that no longer holds an item is decisive, and "something went wrong"
 * is not.
 */
export const errorKeyOf = (error: unknown): string => {
	const response = (error as { getResponse?: () => unknown }).getResponse?.();

	if (typeof response === 'string') {
		return response;
	}

	const body = response as { key?: unknown; message?: unknown } | undefined;

	if (typeof body?.key === 'string') {
		return body.key;
	}

	return typeof body?.message === 'string' ? body.message : ErrorKey.GENERAL;
};
