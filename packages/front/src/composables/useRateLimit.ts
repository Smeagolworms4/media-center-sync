/**
 * The two ends of the bandwidth cap: what somebody types, and what the API takes.
 *
 * The API speaks bytes per second and people think in megabytes per second, and
 * that gap is exactly where a cap ends up a thousand times too low — a gateway
 * throttled to one kilobyte a second looks like a network problem and nobody
 * suspects the form. So the conversion lives here, in one place, with the unit
 * spelled out next to the field rather than assumed.
 *
 * Binary multiples, because every other size in this interface is binary: a cap
 * shown as `1.0 MB/s` by `formatRate` has to be the same number the field said.
 */

export const RATE_UNITS = ['kb', 'mb'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

export const RATE_UNIT_BYTES: Record<RateUnit, number> = {
	kb: 1024,
	mb: 1024 ** 2,
};

/** Bytes per second, as the API wants it. Anything unreadable means "no cap". */
export function rateToBytes (value: number | string | null | undefined, unit: RateUnit): number {
	if (value === null || value === undefined) {
		return 0;
	}
	const digits = typeof value === 'number'
		? value
		: Number.parseFloat(value.trim().replace(',', '.'));
	if (!Number.isFinite(digits) || digits <= 0) {
		return 0;
	}
	return Math.round(digits * RATE_UNIT_BYTES[unit]);
}

export interface RateInput {
	/** Null when there is no cap, so an empty field means exactly that. */
	value: number | null;
	unit: RateUnit;
}

/**
 * The other direction: a stored byte count as a number and a unit to put back
 * into the form.
 *
 * Megabytes as soon as the cap reaches one, because that is how the presets are
 * worded and a field that says `10240 KB/s` next to a preset that says `10 MB/s`
 * reads as two different settings.
 */
export function bytesToRate (bytes: number | null | undefined): RateInput {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
		return { value: null, unit: 'mb' };
	}
	const unit: RateUnit = bytes >= RATE_UNIT_BYTES.mb ? 'mb' : 'kb';
	const raw = bytes / RATE_UNIT_BYTES[unit];
	// Two decimals: enough to render 1.5 MB/s exactly, short enough that a cap
	// typed in kilobytes does not come back as a number nobody would have typed.
	return { value: Math.round(raw * 100) / 100, unit };
}

/**
 * What a torrent client offers before anybody opens a keyboard.
 *
 * Zero first and on purpose: taking a cap off is the action people look for in a
 * hurry, and it should not be hidden behind clearing a field.
 */
export const RATE_PRESETS: number[] = [
	0,
	512 * 1024,
	1024 ** 2,
	2 * 1024 ** 2,
	5 * 1024 ** 2,
	10 * 1024 ** 2,
	20 * 1024 ** 2,
	50 * 1024 ** 2,
];

export function useRateLimit () {
	return { rateToBytes, bytesToRate, RATE_PRESETS, RATE_UNIT_BYTES };
}
