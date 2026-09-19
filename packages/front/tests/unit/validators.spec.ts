import { describe, expect, it } from 'vitest';
import { translate } from '@/plugins/i18n';
import rules from '@/plugins/validators/validators';

/**
 * The plugin binds every rule to a proxy exposing `$t`. Binding the catalogue
 * directly here tests the rules themselves, and proves their messages resolve to
 * real sentences rather than to leftover keys.
 */
const context = {
	$t: (key: string, params?: Record<string, unknown>) => translate(key, params),
};

function rule<K extends keyof typeof rules> (name: K, ...args: any[]) {
	return (rules[name] as any).apply(context, args);
}

describe('validators', () => {
	it('required accepts a value and refuses emptiness', () => {
		const check = rule('required');
		expect(check('ada')).toBe(true);
		expect(check(0)).toBe(true);
		expect(check('')).toBe('This field is required.');
		expect(check(null)).toBe('This field is required.');
		expect(check(undefined)).toBe('This field is required.');
		expect(check(false)).toBe('This field is required.');
		expect(check([])).toBe('This field is required.');
	});

	it('required uses a custom message when one is given', () => {
		expect(rule('required', { message: 'Pick a service.' })(null)).toBe('Pick a service.');
	});

	it('notNull only refuses null', () => {
		const check = rule('notNull');
		expect(check('')).toBe(true);
		expect(check(null)).toBe('This field is required.');
	});

	it('email', () => {
		const check = rule('email');
		expect(check('')).toBe(true);
		expect(check('ada@example.org')).toBe(true);
		expect(check('ada.lovelace@sub.example.co.uk')).toBe(true);
		expect(check('ada@')).toBe('Enter a valid email address.');
		expect(check('not an email')).toBe('Enter a valid email address.');
	});

	it('maxlength', () => {
		const check = rule('maxlength', { max: 5 });
		expect(check('12345')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('123456')).toBe('Use at most 5 characters.');
	});

	it('range', () => {
		const check = rule('range', { min: 1, max: 10 });
		expect(check(5)).toBe(true);
		expect(check(1)).toBe(true);
		expect(check(10)).toBe(true);
		expect(check(0)).toBe('Must be at least 1.');
		expect(check(11)).toBe('Must be at most 10.');
	});

	it('regExp', () => {
		const check = rule('regExp', { regExp: /^[a-z]+$/ });
		expect(check('abc')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('ab1')).toContain('does not match');
	});

	it('url', () => {
		const check = rule('url');
		expect(check('https://example.org')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('example.org')).toBe('Enter a valid URL.');
	});

	it('password', () => {
		const check = rule('password');
		expect(check('Passw0rdd')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('short1A')).toContain('at least');
		expect(check('alllowercase1')).toContain('at least');
	});

	it('passwordClass counts character classes', () => {
		expect(rule('passwordClass', { numClasses: 3 })('Abc12345')).toBe(true);
		expect(rule('passwordClass', { numClasses: 3 })('abcdefgh')).toContain('3 different kinds');
	});

	it('repeatField compares against the other control', () => {
		const check = rule('repeatField', { repeat: () => 'secret' });
		expect(check('secret')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('other')).toBe('The two values do not match.');
	});

	it('onlyInteger', () => {
		const check = rule('onlyInteger');
		expect(check('42')).toBe(true);
		expect(check('-42')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('4.2')).toBe('Digits only.');
	});

	it('onlyLetters', () => {
		const check = rule('onlyLetters');
		expect(check('Ada Lovelace')).toBe(true);
		expect(check('Amélie')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('R2D2')).toBe('Letters only.');
	});

	it('object applies nested rules and names the offending key', () => {
		const check = rule('object', { rules: { name: [rule('required')] } });
		expect(check({ name: 'attic' })).toBe(true);
		expect(check(null)).toBe(true);
		expect(check({ name: '' })).toBe('name: This field is required.');
	});

	it('fileSize', () => {
		const check = rule('fileSize', { size: 1024 });
		expect(check([{ size: 512 }])).toBe(true);
		expect(check(null)).toBe(true);
		expect(check([{ size: 4096 }])).toContain('at most');
	});

	it('fileFormats', () => {
		const check = rule('fileFormats', { accepts: ['image/png'] });
		expect(check([{ type: 'image/png' }])).toBe(true);
		expect(check(null)).toBe(true);
		expect(check([{ type: 'application/pdf' }])).toBe('This file type is not accepted.');
	});

	it('urlWithPort accepts a bare address with an explicit port', () => {
		const check = rule('urlWithPort');
		expect(check('http://192.168.0.10:8096')).toBe(true);
		expect(check('https://jellyfin.home.lan:8920')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('http://192.168.0.10')).toContain('192.168.0.10:8096');
		expect(check('ftp://192.168.0.10:21')).toContain('192.168.0.10:8096');
		expect(check('192.168.0.10:8096')).toContain('192.168.0.10:8096');
	});

	it('urlWithPort can let the port be implicit', () => {
		expect(rule('urlWithPort', { requirePort: false })('https://plex.example.org')).toBe(true);
	});

	it('cron', () => {
		const check = rule('cron');
		expect(check('0 4 * * *')).toBe(true);
		expect(check('*/15 * * * 1-5')).toBe(true);
		expect(check('0,30 0-23 1 1 0')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('0 4 * *')).toContain('cron');
		expect(check('0 4 * 13 *')).toContain('cron');
		expect(check('60 4 * * *')).toContain('cron');
		expect(check('5-1 4 * * *')).toContain('cron');
		expect(check('*/0 4 * * *')).toContain('cron');
		expect(check('every night')).toContain('cron');
	});

	it('absolutePath', () => {
		const check = rule('absolutePath');
		expect(check('/media/movies')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('media/movies')).toContain('absolute');
		expect(check('/media/../../etc')).toContain('absolute');
	});

	it('byteSize', () => {
		const check = rule('byteSize');
		expect(check('512M')).toBe(true);
		expect(check('2G')).toBe(true);
		expect(check('4096')).toBe(true);
		expect(check('1.5 GB')).toBe(true);
		expect(check('')).toBe(true);
		expect(check('big')).toContain('512M');
		expect(check('2 petabytes')).toContain('512M');
	});

	it('byteSize enforces its bounds', () => {
		const check = rule('byteSize', { min: 1024, max: 1024 ** 3 });
		expect(check('1K')).toBe(true);
		expect(check('512')).toContain('512M');
		expect(check('2G')).toContain('512M');
	});
});
