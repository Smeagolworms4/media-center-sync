/**
 * Locale-aware formatting for the four quantities this application repeats on
 * every screen: sizes, rates, durations and "how long ago".
 *
 * Plain functions taking the locale rather than composables reading it, so a
 * component, a store and a test all use exactly the same code path.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Binary multiples with the short names people expect.
 *
 * Media sizes are read against what a filesystem reports, and every media server
 * reports powers of 1024. Using 1000 here would make a file the interface calls
 * 4.3 GB show up as 4.0 GB in the library — a difference nobody can act on but
 * everybody notices.
 */
export function formatBytes (bytes: number | null | undefined, locale = 'en', fractionDigits = 1): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
		return '—';
	}
	const negative = bytes < 0;
	let value = Math.abs(bytes);
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 ? 0 : fractionDigits;
	const formatted = new Intl.NumberFormat(locale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
	return `${negative ? '-' : ''}${formatted} ${BYTE_UNITS[unit]}`;
}

/** A transfer rate. Zero is shown rather than hidden: a stalled source is information. */
export function formatRate (bytesPerSecond: number | null | undefined, locale = 'en'): string {
	if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) {
		return '—';
	}
	return `${formatBytes(bytesPerSecond, locale)}/s`;
}

/**
 * A duration, as coarse as it can be without lying.
 *
 * An estimate of eleven hours does not deserve seconds, and an estimate of forty
 * seconds does not deserve hours. Both are shown to the same person on the same
 * screen, so the unit has to follow the magnitude.
 */
export function formatDuration (seconds: number | null | undefined, locale = 'en'): string {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
		return '—';
	}
	const total = Math.floor(seconds);
	const parts: string[] = [];
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;

	const number = (value: number) => new Intl.NumberFormat(locale).format(value);

	if (days > 0) {
		parts.push(`${number(days)}d`, `${number(hours)}h`);
	} else if (hours > 0) {
		parts.push(`${number(hours)}h`, `${String(minutes).padStart(2, '0')}m`);
	} else if (minutes > 0) {
		parts.push(`${number(minutes)}m`, `${String(secs).padStart(2, '0')}s`);
	} else {
		parts.push(`${number(secs)}s`);
	}
	return parts.join(' ');
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
	['second', 60],
	['minute', 60],
	['hour', 24],
	['day', 7],
	['week', 4.348],
	['month', 12],
	['year', Number.POSITIVE_INFINITY],
];

/**
 * "3 minutes ago", in the viewer's language.
 *
 * `Intl.RelativeTimeFormat` does the wording; the only decision left is which
 * unit, and it is taken by walking up until the number is small enough to read.
 */
export function formatRelativeDate (
	value: string | number | Date | null | undefined,
	locale = 'en',
	now: number = Date.now(),
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (value === '') {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	let delta = (date.getTime() - now) / 1000;
	for (const [unit, span] of RELATIVE_STEPS) {
		if (Math.abs(delta) < span) {
			return formatter.format(Math.round(delta), unit);
		}
		delta /= span;
	}
	return formatter.format(Math.round(delta), 'year');
}

/** Absolute date and time, for the tooltip behind a relative one. */
export function formatDateTime (
	value: string | number | Date | null | undefined,
	locale = 'en',
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (value === '') {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function useFormat () {
	return { formatBytes, formatRate, formatDuration, formatRelativeDate, formatDateTime };
}
