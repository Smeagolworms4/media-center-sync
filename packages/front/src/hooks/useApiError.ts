import { useI18n } from '@/hooks';

interface ParsedApiError {
	mainError: string | null;
	fieldErrors: Record<string, string[]>;
}

interface ParseOptions {
	fallback: string;
	mappedFields: Set<string>;
}

/**
 * Parse une erreur backend (Response / Error / payload Symfony rest-bundle) en
 * `{ mainError, fieldErrors }` pour useForm. Port à l'identique de la logique
 * `OForm.fromError` / `fromJsonError` historique :
 *
 *  - `Response` → `.json()` puis `parseJson`
 *  - `Error` avec message    → message brut en mainError (pas de traduction)
 *  - Payload string          → mainError, traduit via `t()` si `te()` reconnaît la clé
 *  - Payload exception Symfony `{class,code,file,message,stack}` → message brut en mainError
 *  - Payload `{message, code?}` simple                            → message brut en mainError
 *  - Payload validation `{field: 'msg' | ['msg1','msg2']}` :
 *      • `field` ∈ `mappedFields` → fieldErrors[field]
 *      • sinon                    → repli en mainError (jointure `\n`)
 *  - Sinon                       → fallback (key i18n, traduit via `t()`).
 *
 * Le backend renvoie déjà des messages traduits côté Symfony — on ne re-traduit
 * pas les payloads, seulement le fallback (qui est une clé) et la string brute
 * (ancien comportement, rare en pratique).
 */
export function useApiError() {
	const { t, te } = useI18n();
	const tet = (m: string): string => (te(m) ? t(m) : m);

	async function parseApiError(error: unknown, options: ParseOptions): Promise<ParsedApiError> {
		try {
			if (error instanceof Response) {
				const data = await error.json();
				return parseJson(data, options);
			}
			if (error instanceof Error && error.message) {
				return { mainError: error.message, fieldErrors: {} };
			}
		} catch {
			// payload non-JSON ou parsing KO → fallback
		}
		return { mainError: tet(options.fallback), fieldErrors: {} };
	}

	function parseJson(data: unknown, options: ParseOptions): ParsedApiError {
		if (typeof data === 'string') {
			return { mainError: tet(data), fieldErrors: {} };
		}
		if (data === null || typeof data !== 'object') {
			return { mainError: tet(options.fallback), fieldErrors: {} };
		}

		const obj = data as Record<string, unknown>;

		// Exception Symfony complète (présent en dev, masqué en prod)
		if (typeof obj.class !== 'undefined' && typeof obj.code !== 'undefined'
			&& typeof obj.file !== 'undefined' && typeof obj.message === 'string'
			&& typeof obj.stack !== 'undefined') {
			return { mainError: obj.message, fieldErrors: {} };
		}

		// Payload simple `{message: '...'}` (éventuellement avec code)
		if (typeof obj.message === 'string' && Object.keys(obj).length <= 2) {
			return { mainError: obj.message, fieldErrors: {} };
		}

		// Validation rest-bundle : `{field: 'msg' | ['msg1', 'msg2']}`
		const fieldErrors: Record<string, string[]> = {};
		const unmapped: string[] = [];
		let hasFound = false;

		for (const [name, raw] of Object.entries(obj)) {
			if (name === 'message' || name === 'code') continue;

			const messages = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [])
				.filter((m): m is string => typeof m === 'string');
			if (messages.length === 0) continue;

			if (options.mappedFields.has(name)) {
				fieldErrors[name] = [...(fieldErrors[name] ?? []), ...messages];
			} else {
				unmapped.push(...messages);
			}
			hasFound = true;
		}

		if (hasFound) {
			return {
				mainError: unmapped.length > 0 ? unmapped.join('\n') : null,
				fieldErrors,
			};
		}

		return { mainError: tet(options.fallback), fieldErrors: {} };
	}

	return { parseApiError };
}
