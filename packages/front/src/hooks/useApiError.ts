import { hasTranslation, translate } from '@/plugins/i18n';

export interface ParsedApiError {
	mainError: string | null;
	fieldErrors: Record<string, string[]>;
}

export interface ParseOptions {
	/** i18n key used when nothing usable can be extracted. */
	fallback: string;
	/** Fields the form actually renders; anything else has to go to the main error. */
	mappedFields: Set<string>;
}

/**
 * Anything dotted, lowercase and space-free is treated as an error key rather
 * than as prose. `error.auth.invalid_credentials` is a key; `username should not
 * be empty` is a sentence a validator wrote.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

function looksLikeKey (value: string): boolean {
	return KEY_PATTERN.test(value);
}

/**
 * Parses a NestJS error payload into `{ mainError, fieldErrors }` for `useForm`.
 *
 * Two shapes come back from the API and they have to be told apart:
 *
 *  - a validation failure, `{ statusCode, message: string[], error }`, where each
 *    entry is a `class-validator` sentence starting with the property name;
 *  - a business failure, `{ statusCode, message: 'error.some.key', error }`.
 *
 * A key is always translated, and a key the catalogue does not know degrades to
 * the fallback: showing `error.peer.invite_expired` to somebody is worse than
 * showing a generic sentence, and it happens every time the API adds a case the
 * bundled catalogue predates.
 */
export function useApiError () {
	function translateKey (value: string): string | null {
		if (!looksLikeKey(value)) {
			return null;
		}
		return hasTranslation(value) ? translate(value) : null;
	}

	function fallbackMessage (options: ParseOptions): string {
		return hasTranslation(options.fallback) ? translate(options.fallback) : options.fallback;
	}

	/** A key becomes its sentence, an unknown key the fallback, prose stays prose. */
	function toMessage (value: string, options: ParseOptions): string {
		if (looksLikeKey(value)) {
			return translateKey(value) ?? fallbackMessage(options);
		}
		return value;
	}

	/**
	 * Finds which rendered field a `class-validator` sentence belongs to.
	 *
	 * The property name is the first token, and nested DTOs produce a dotted path
	 * (`filter.minYear must be an integer`). A form that renders the whole path as
	 * one control is matched first; otherwise the leaf is tried, since that is
	 * what a flattened form names its input.
	 */
	function matchField (sentence: string, mappedFields: Set<string>): string | null {
		const head = sentence.split(/\s+/, 1)[0] ?? '';
		if (!head) {
			return null;
		}
		if (mappedFields.has(head)) {
			return head;
		}
		const leaf = head.split('.').pop() ?? '';
		return leaf && mappedFields.has(leaf) ? leaf : null;
	}

	/**
	 * Drops the property name the backend put in front of its sentence. Under the
	 * matching input, "username should not be empty" reads as a stutter.
	 */
	function stripFieldPrefix (sentence: string): string {
		const stripped = sentence.replace(/^\S+\s+/, '');
		return stripped.length > 0 ? stripped : sentence;
	}

	function parseMessages (messages: string[], options: ParseOptions): ParsedApiError {
		const fieldErrors: Record<string, string[]> = {};
		const unmapped: string[] = [];

		for (const raw of messages) {
			if (typeof raw !== 'string' || raw.length === 0) {
				continue;
			}
			const field = looksLikeKey(raw) ? null : matchField(raw, options.mappedFields);
			if (field) {
				fieldErrors[field] = [...(fieldErrors[field] ?? []), stripFieldPrefix(raw)];
			} else {
				unmapped.push(toMessage(raw, options));
			}
		}

		if (unmapped.length === 0 && Object.keys(fieldErrors).length === 0) {
			return { mainError: fallbackMessage(options), fieldErrors: {} };
		}

		return {
			mainError: unmapped.length > 0 ? unmapped.join('\n') : null,
			fieldErrors,
		};
	}

	function parseJson (data: unknown, options: ParseOptions): ParsedApiError {
		if (typeof data === 'string') {
			return { mainError: toMessage(data, options), fieldErrors: {} };
		}
		if (data === null || typeof data !== 'object') {
			return { mainError: fallbackMessage(options), fieldErrors: {} };
		}

		const { message } = data as { message?: unknown };

		if (Array.isArray(message)) {
			return parseMessages(message as string[], options);
		}
		if (typeof message === 'string' && message.length > 0) {
			return parseMessages([message], options);
		}

		return { mainError: fallbackMessage(options), fieldErrors: {} };
	}

	async function parseApiError (error: unknown, options: ParseOptions): Promise<ParsedApiError> {
		try {
			if (error instanceof Response) {
				return parseJson(await error.json(), options);
			}
			if (error instanceof Error && error.message) {
				// A thrown Error is ours — a network failure, a bug — never a payload.
				return { mainError: error.message, fieldErrors: {} };
			}
			if (typeof error === 'string' || (error !== null && typeof error === 'object')) {
				return parseJson(error, options);
			}
		} catch {
			// The body was not JSON, or the stream was already consumed.
		}
		return { mainError: fallbackMessage(options), fieldErrors: {} };
	}

	return { parseApiError };
}
