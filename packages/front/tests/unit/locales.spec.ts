import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ErrorKey } from '@mcs/shared';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';
import deMessages from '@/locales/de.json';
import enMessages from '@/locales/en.json';
import esMessages from '@/locales/es.json';
import frMessages from '@/locales/fr.json';
import itMessages from '@/locales/it.json';
import ptMessages from '@/locales/pt.json';
import ruMessages from '@/locales/ru.json';
import zhMessages from '@/locales/zh.json';
import { i18n, loadLocaleMessages, SUPPORTED_LOCALES, type SupportedLocale } from '@/plugins/i18n';

/**
 * The guard rail for eight catalogues.
 *
 * TypeScript already refuses a catalogue that has lost a key — every loader in
 * `plugins/i18n` is declared to return the shape of the English one. It cannot see
 * the other three ways a catalogue goes wrong: a key nobody removed from a
 * translation after English dropped it, a `{count}` that did not survive being
 * rephrased, and a plural entry written with the wrong number of forms, which renders
 * an empty string or the wrong noun for half the numbers a user will ever see.
 */
const CATALOGUES: Record<SupportedLocale, Record<string, unknown>> = {
	en: enMessages,
	fr: frMessages,
	es: esMessages,
	pt: ptMessages,
	ru: ruMessages,
	de: deMessages,
	it: itMessages,
	zh: zhMessages,
};

type Flat = Record<string, string>;

function flatten (value: Record<string, unknown>, prefix = '', out: Flat = {}): Flat {
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (child !== null && typeof child === 'object') {
			flatten(child as Record<string, unknown>, path, out);
		} else {
			out[path] = String(child);
		}
	}
	return out;
}

/**
 * Which placeholders a message carries, not how many times.
 *
 * A message with plural forms repeats `{count}` once per form, and the number of
 * forms is a property of the language rather than of the translation — Chinese
 * writes one form where English writes three, and would fail a count comparison
 * while being perfectly correct.
 */
function placeholders (message: string): Set<string> {
	return new Set([...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
}

/**
 * How many plural forms a locale writes where English writes `expected`.
 *
 * Russian agrees with the last digit and needs one form more than English everywhere
 * English inflects at all; Chinese does not inflect and writes one form for any count.
 * See the plural rules in `plugins/i18n`.
 */
function expectedForms (locale: SupportedLocale, english: number): number {
	if (english === 1) {
		return 1;
	}
	if (locale === 'zh') {
		return 1;
	}
	return locale === 'ru' ? english + 1 : english;
}

/** A plural form as vue-i18n renders it for `count`. */
function fill (form: string, count: number): string {
	return form.trim().replaceAll('{count}', String(count));
}

const english = flatten(enMessages);
const translated = SUPPORTED_LOCALES.filter(locale => locale !== 'en');

describe('locales', () => {
	it('ships a catalogue for every locale the picker offers', () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(CATALOGUES[locale], locale).toBeTruthy();
		}
	});

	it.each(translated)('%s has exactly the keys English has', locale => {
		const keys = Object.keys(flatten(CATALOGUES[locale]));
		const expected = Object.keys(english);

		// Reported as two lists rather than as a set comparison: a failure then names
		// the keys to write and the keys to drop, which is the whole answer.
		expect(expected.filter(key => !keys.includes(key)), `missing from ${locale}`).toEqual([]);
		expect(keys.filter(key => !expected.includes(key)), `in ${locale} but not in English`).toEqual([]);
	});

	/*
	 * Every key the interface asks for exists, which nothing checked.
	 *
	 * The catalogues were compared with each other and never with the code, so a key
	 * spelled in a component and written in no catalogue passed every test — and vue-i18n
	 * renders the key itself, so the screen said `transfer.retarget.into` where it meant
	 * "Into /share/SeriesTV5". It sat there unnoticed because the line only appears when
	 * there is a destination to announce, and until recently there never was one during a
	 * download.
	 *
	 * Only literal keys are read, because only those can be checked: a key built from a
	 * variable — `release.state.${row.state}` — is checked by the tests of the thing that
	 * builds it. The literal ones are the overwhelming majority and every one of them is
	 * a one-character typo away from this.
	 */
	it('uses no key that no catalogue defines', async () => {
		const sources = await glob('src/**/*.{vue,ts}', { cwd: resolve(__dirname, '../..') });
		const known = new Set(Object.keys(english));
		const missing: string[] = [];

		for (const file of sources) {
			const text = await readFile(resolve(__dirname, '../..', file), 'utf8');

			for (const [, key] of text.matchAll(/\$?\bt\(\s*'([a-z][\w.]*)'/g)) {
				if (!known.has(key) && !missing.includes(key)) {
					missing.push(`${key} (${file})`);
				}
			}
		}

		expect(missing, 'asked for by the interface and written in no catalogue').toEqual([]);
	});

	it.each(translated)('%s keeps every interpolation placeholder', locale => {
		const messages = flatten(CATALOGUES[locale]);

		for (const [key, message] of Object.entries(english)) {
			expect(placeholders(messages[key]), `${locale}: ${key}`).toEqual(placeholders(message));
		}
	});

	it.each(translated)('%s writes the plural forms its grammar takes', locale => {
		const messages = flatten(CATALOGUES[locale]);

		for (const [key, message] of Object.entries(english)) {
			const forms = messages[key].split('|').length;

			expect(forms, `${locale}: ${key} — "${messages[key]}"`)
				.toBe(expectedForms(locale, message.split('|').length));
		}
	});

	it.each(SUPPORTED_LOCALES)('%s names every language in its own language', locale => {
		const messages = flatten(CATALOGUES[locale]);

		for (const other of SUPPORTED_LOCALES) {
			expect(messages[`locale.${other}`], `${locale}: locale.${other}`).toBeTruthy();
		}
		expect(messages['locale.ru']).toBe('Русский');
		expect(messages['locale.zh']).toBe('中文');
	});

	/**
	 * The API answers with keys and never with sentences, so a key with no entry is a
	 * screen that says "something went wrong" where the gateway knew exactly what did.
	 */
	it.each(SUPPORTED_LOCALES)('%s has wording for every error the API can answer', locale => {
		const messages = flatten(CATALOGUES[locale]);

		for (const key of Object.values(ErrorKey)) {
			expect(messages[key], `${locale}: ${key}`).toBeTruthy();
		}
	});
});

describe('plural rules', () => {
	it('picks the Russian form from the last digit', async () => {
		await loadLocaleMessages('ru');
		const t = i18n.global.t as (key: string, count: number) => string;
		const locale = i18n.global.locale as { value: string };
		const previous = locale.value;
		locale.value = 'ru';

		try {
			// Four forms, because English opens this one with a phrase for nothing.
			const [zero, one, few, many] = flatten(ruMessages)['transfer.sources'].split('|');
			expect(t('transfer.sources', 0)).toBe(fill(zero, 0));
			expect(t('transfer.sources', 1)).toBe(fill(one, 1));
			expect(t('transfer.sources', 3)).toBe(fill(few, 3));
			expect(t('transfer.sources', 5)).toBe(fill(many, 5));
			// 11 to 14 end in a one and take the many form; 21 ends in one and does not.
			expect(t('transfer.sources', 11)).toBe(fill(many, 11));
			expect(t('transfer.sources', 21)).toBe(fill(one, 21));
			expect(t('transfer.sources', 22)).toBe(fill(few, 22));

			// Three forms, where English has two and no phrase for nothing.
			const [single, couple, plenty] = flatten(ruMessages)['quality.summary'].split('|');
			expect(t('quality.summary', 1)).toBe(fill(single, 1));
			expect(t('quality.summary', 2)).toBe(fill(couple, 2));
			expect(t('quality.summary', 0)).toBe(fill(plenty, 0));
			expect(t('quality.summary', 14)).toBe(fill(plenty, 14));
		} finally {
			locale.value = previous;
		}
	});

	it('uses the one Chinese form for every count', async () => {
		await loadLocaleMessages('zh');
		const t = i18n.global.t as (key: string, count: number) => string;
		const locale = i18n.global.locale as { value: string };
		const previous = locale.value;
		locale.value = 'zh';

		try {
			const form = flatten(zhMessages)['transfer.sources'];
			for (const count of [0, 1, 2, 5, 11, 21]) {
				expect(t('transfer.sources', count)).toBe(fill(form, count));
			}
		} finally {
			locale.value = previous;
		}
	});
});
