/**
 * Defensive readers for payloads we do not own.
 *
 * Jellyfin and Plex both omit fields rather than sending nulls, rename them between
 * versions, and occasionally send a number where the documentation says string. A
 * scan of forty thousand episodes that throws on the one item with no `MediaSources`
 * has failed entirely, which is far worse than that one item being incomplete — so
 * every read here degrades to null instead of raising.
 */

export type Payload = Record<string, unknown>;

export function asRecord(value: unknown): Payload {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Payload)
		: {};
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asRecordArray(value: unknown): Payload[] {
	return asArray(value)
		.filter((entry): entry is Payload => typeof entry === 'object' && entry !== null)
		.map((entry) => entry);
}

/** Empty strings collapse to null: a title of `''` is missing, not a title. */
export function asString(value: unknown): string | null {
	if (typeof value === 'string') {
		return value.trim() === '' ? null : value;
	}

	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}

	return null;
}

/**
 * Numbers arrive as strings all over the Plex API (`size="1234"`), and as `0` where
 * `unknown` was meant. Zero is kept — a zero-byte file is a real, and interesting,
 * thing — but anything unparseable becomes null.
 */
export function asNumber(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}

	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);

		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

export function asBoolean(value: unknown): boolean {
	return value === true || value === 'true' || value === 1 || value === '1';
}

/** Reads a nested field without a chain of guards at every call site. */
export function pick(source: unknown, ...path: string[]): unknown {
	let current: unknown = source;

	for (const key of path) {
		if (typeof current !== 'object' || current === null) {
			return undefined;
		}

		current = (current as Payload)[key];
	}

	return current;
}

/**
 * The first field that carries something, among the spellings a service has used.
 *
 * Jellyfin says `ProviderIds.Tvdb` on one version and `ProviderIds.tvdb` on another;
 * matching depends on those identifiers, so guessing wrong costs a correlation.
 */
export function firstOf(source: unknown, ...keys: string[]): unknown {
	const record = asRecord(source);

	for (const key of keys) {
		if (record[key] !== undefined && record[key] !== null) {
			return record[key];
		}
	}

	return undefined;
}
