import { describe, expect, it, vi } from 'vitest';
import { SimpleObserver } from '@/libs/observer';
import {
	byte2Human,
	fromCaretDate,
	HTMLHelper,
	human2Byte,
	Native,
	capitalize,
	slugify,
	toCaretDate,
	toDateTime,
	toShortDate,
	toTime,
	UriHelper,
	Uuid,
} from '@/libs/utils';

describe('ByteHelper', () => {
	it('renders a byte count with binary multiples', () => {
		expect(byte2Human(512)).toBe('512.00 B');
		expect(byte2Human(1024)).toBe('1.00 KB');
		expect(byte2Human(1024 ** 4)).toBe('1.00 TB');
		expect(byte2Human(1024, 'o')).toBe('1.00 Ko');
	});

	it('reads a size typed by a human', () => {
		expect(human2Byte(4096)).toBe(4096);
		expect(human2Byte('4096')).toBe(4096);
		expect(human2Byte('2K')).toBe(2048);
		expect(human2Byte('2MB')).toBe(2 * 1024 ** 2);
		expect(human2Byte('1 g')).toBe(1024 ** 3);
		expect(human2Byte('1T')).toBe(1024 ** 4);
		expect(human2Byte('nonsense')).toBeNaN();
	});
});

describe('DateHelper', () => {
	it('formats a date for a locale', () => {
		expect(toShortDate('2026-09-19T12:00:00.000Z', 'fr')).toBe('19/09/2026');
		expect(toShortDate('', 'fr', 'never')).toBe('never');
		expect(toShortDate('not a date', 'fr', 'never')).toBe('never');
	});

	it('formats a date and a time', () => {
		expect(toDateTime('2026-09-19T12:00:00.000Z', 'fr', { timeZone: 'UTC' })).toContain('19/09/2026');
		expect(toDateTime(null, 'fr')).toBe('');
		expect(toTime(null, 'fr')).toBe('');
	});

	it('round-trips the input-friendly date format', () => {
		const date = fromCaretDate('2026-09-19');
		expect(date).toBeInstanceOf(Date);
		expect(toCaretDate(date as Date)).toBe('2026-09-19');
		expect(fromCaretDate(null)).toBeNull();
		expect(fromCaretDate('nonsense')).toBeNull();
	});
});

describe('Native', () => {
	it('tells emptiness from falsiness', () => {
		expect(Native.empty(null)).toBe(true);
		expect(Native.empty(undefined)).toBe(true);
		expect(Native.empty('')).toBe(true);
		expect(Native.empty(0)).toBe(false);
		expect(Native.empty(false)).toBe(false);
	});

	it('converts', () => {
		expect(Native.toInt('42')).toBe(42);
		expect(Native.toInt(null)).toBeNull();
		expect(Native.toFloat('4.2')).toBe(4.2);
		expect(Native.toFloat(null)).toBeNull();
		expect(Native.toBoolean('false')).toBe(false);
		expect(Native.toBoolean('0')).toBe(false);
		expect(Native.toBoolean('yes')).toBe(true);
		expect(Native.isInt('42')).toBe(true);
		expect(Native.isInt('abc')).toBe(false);
		expect(Native.isBoolean(false)).toBe(true);
		expect(Native.defined(undefined)).toBe(false);
	});
});

describe('StringHelper', () => {
	it('slugifies a media title', () => {
		expect(slugify('  Les Révoltés  de l’an 2000 ')).toBe('les-revoltes-de-l-an-2000');
	});

	it('capitalises each word', () => {
		expect(capitalize('ada lovelace')).toBe('Ada Lovelace');
		expect(capitalize(null)).toBe('');
	});
});

describe('UriHelper', () => {
	it('builds a query string, repeating array values', () => {
		expect(UriHelper.queries({ page: 1, states: ['missing', 'outdated'] }))
			.toBe('?page=1&states[]=missing&states[]=outdated');
	});

	it('produces nothing at all for an empty set of parameters', () => {
		expect(UriHelper.queries({})).toBe('');
	});

	it('reads a parameter out of a URL', () => {
		expect(UriHelper.getParameterByName('page', 'https://x/y?page=3')).toBe('3');
		expect(UriHelper.getParameterByName('missing', 'https://x/y?page=3')).toBeNull();
		expect(UriHelper.getParameterByName('empty', 'https://x/y?empty')).toBe('');
	});
});

describe('Uuid', () => {
	it('produces distinct identifiers of the expected shape', () => {
		const first = Uuid.generate();
		expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]+$/);
		expect(first).not.toBe(Uuid.generate());
	});
});

describe('HTMLHelper', () => {
	it('walks up to the nearest ancestor of a given tag', () => {
		document.body.innerHTML = '<table><tbody><tr><td id="cell">x</td></tr></tbody></table>';
		const cell = document.querySelector('#cell') as HTMLElement;

		expect(HTMLHelper.findParentByTag(cell, 'tbody')?.tagName).toBe('TBODY');
		expect(HTMLHelper.findParentByTag(cell, 'form')).toBeNull();
	});
});

describe('SimpleObserver', () => {
	it('calls every subscriber and stops once one unsubscribes', async () => {
		const observer = new SimpleObserver();
		const first = vi.fn();
		const second = vi.fn();
		const subscription = observer.subscribe(first);
		observer.subscribe(second);

		await observer.trigger('a');
		expect(first).toHaveBeenCalledWith('a');

		subscription.unsubscribe();
		await observer.trigger('b');

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it('swallows a failing subscriber rather than breaking the trigger', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const observer = new SimpleObserver();
		observer.subscribe(() => { throw new Error('boom'); });

		await expect(observer.trigger()).resolves.toBeUndefined();
	});
});
