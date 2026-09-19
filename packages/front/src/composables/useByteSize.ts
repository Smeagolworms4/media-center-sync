const PATTERN = /^(\d+(?:[.,]\d+)?)\s*([kmgt]?)b?$/i;

const MULTIPLIERS: Record<string, number> = {
	'': 1,
	'k': 1024,
	'm': 1024 ** 2,
	'g': 1024 ** 3,
	't': 1024 ** 4,
};

/**
 * Reads a size the way people type it — `512M`, `2G`, `4096`.
 *
 * The API takes a byte count, and asking somebody to write 4294967296 in a form
 * is how a rate limit ends up an order of magnitude out. Binary multiples,
 * because every media server reports powers of 1024 and the two would otherwise
 * disagree by four percent on the same file.
 */
export function parseByteSize (value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	const text = value.trim();
	if (text.length === 0) {
		return null;
	}
	const match = PATTERN.exec(text);
	if (!match) {
		return null;
	}
	const digits = Number.parseFloat(match[1].replace(',', '.'));
	return Math.round(digits * MULTIPLIERS[match[2].toLowerCase()]);
}

/** The shortest exact form of a byte count, for putting back into a text field. */
export function toByteSizeInput (bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
		return '';
	}
	const units: [string, number][] = [['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]];
	for (const [suffix, multiplier] of units) {
		if (bytes % multiplier === 0) {
			return `${bytes / multiplier}${suffix}`;
		}
	}
	return String(bytes);
}

export function useByteSize () {
	return { parseByteSize, toByteSizeInput };
}
