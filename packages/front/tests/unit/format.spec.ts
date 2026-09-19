import { describe, expect, it } from 'vitest';
import {
	formatBytes,
	formatDateTime,
	formatDuration,
	formatRelativeDate,
	formatRate,
} from '@/composables/useFormat';

describe('formatBytes', () => {
	it('uses binary multiples, like every media server reports', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
		expect(formatBytes(1_500_000_000)).toBe('1.4 GB');
		expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
	});

	it('shows no decimals for a plain byte count', () => {
		expect(formatBytes(999)).toBe('999 B');
	});

	it('honours the requested precision', () => {
		expect(formatBytes(1024 ** 3 * 1.25, 'en', 2)).toBe('1.25 GB');
	});

	it('follows the locale for the decimal separator', () => {
		expect(formatBytes(1536, 'fr')).toBe('1,5 KB');
	});

	it('keeps a negative size readable', () => {
		expect(formatBytes(-2048)).toBe('-2.0 KB');
	});

	it('says nothing rather than NaN when there is no value', () => {
		expect(formatBytes(null)).toBe('—');
		expect(formatBytes(undefined)).toBe('—');
		expect(formatBytes(Number.NaN)).toBe('—');
	});
});

describe('formatRate', () => {
	it('is a size per second', () => {
		expect(formatRate(1024)).toBe('1.0 KB/s');
		expect(formatRate(0)).toBe('0 B/s');
	});

	it('shows a stalled source as nothing rather than as zero when unknown', () => {
		expect(formatRate(null)).toBe('—');
	});
});

describe('formatDuration', () => {
	it('picks the unit that suits the magnitude', () => {
		expect(formatDuration(45)).toBe('45s');
		expect(formatDuration(90)).toBe('1m 30s');
		expect(formatDuration(3700)).toBe('1h 01m');
		expect(formatDuration(90_000)).toBe('1d 1h');
	});

	it('has nothing to say about a missing or impossible duration', () => {
		expect(formatDuration(null)).toBe('—');
		expect(formatDuration(-5)).toBe('—');
	});
});

describe('formatRelativeDate', () => {
	const now = new Date('2026-09-19T12:00:00.000Z').getTime();

	it('reads as a sentence in the viewer language', () => {
		expect(formatRelativeDate('2026-09-19T11:58:00.000Z', 'en', now)).toBe('2 minutes ago');
		expect(formatRelativeDate('2026-09-19T11:58:00.000Z', 'fr', now)).toContain('2 minutes');
	});

	it('climbs to the unit that keeps the number small', () => {
		expect(formatRelativeDate('2026-09-19T11:59:30.000Z', 'en', now)).toBe('30 seconds ago');
		expect(formatRelativeDate('2026-09-19T09:00:00.000Z', 'en', now)).toBe('3 hours ago');
		expect(formatRelativeDate('2026-09-12T12:00:00.000Z', 'en', now)).toBe('last week');
		expect(formatRelativeDate('2024-09-19T12:00:00.000Z', 'en', now)).toBe('2 years ago');
	});

	it('handles a date in the future', () => {
		expect(formatRelativeDate('2026-09-19T12:30:00.000Z', 'en', now)).toBe('in 30 minutes');
	});

	it('returns nothing for a missing or unreadable date', () => {
		expect(formatRelativeDate(null, 'en', now)).toBeNull();
		expect(formatRelativeDate('', 'en', now)).toBeNull();
		expect(formatRelativeDate('not a date', 'en', now)).toBeNull();
	});
});

describe('formatDateTime', () => {
	it('gives an absolute date for the tooltip', () => {
		expect(formatDateTime('2026-09-19T12:00:00.000Z', 'en')).toContain('2026');
	});

	it('returns nothing for a missing or unreadable date', () => {
		expect(formatDateTime(null)).toBeNull();
		expect(formatDateTime('')).toBeNull();
		expect(formatDateTime('nope')).toBeNull();
	});
});
