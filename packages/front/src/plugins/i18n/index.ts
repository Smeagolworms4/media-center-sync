import type { App } from 'vue';
import { createI18n, type I18n, type PluralizationRule } from 'vue-i18n';
import en from '@/locales/en.json';

/**
 * The catalogues are JSON files, and English is the one compiled into the shape.
 *
 * `MessageSchema` is the type of the English catalogue, which every loader below is
 * declared to return: a catalogue that has lost a key, or spelled one differently,
 * fails the type-check rather than falling back silently at runtime for whoever
 * happens to be reading in that language. `tests/unit/locales.spec.ts` closes the
 * other half — TypeScript accepts a catalogue with an extra key, a test does not.
 */
export type MessageSchema = typeof en;

export const SUPPORTED_LOCALES = ['en', 'fr', 'es', 'pt', 'ru', 'de', 'it', 'zh'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * English is bundled; the other seven are fetched when they are chosen.
 *
 * English has to be in the initial bundle: a gateway is often reached before its API
 * is healthy — the sign-in page, an error screen, the "service unreachable" message —
 * and a fallback catalogue that has to be downloaded first turns every one of those
 * into a screen of raw keys. That argument covers exactly one catalogue, and shipping
 * the eight of them would put seven catalogues nobody is reading into every first
 * paint. The other seven are chunks served from the same origin as the application
 * itself, so a viewer who can load the interface can load its catalogue; if that
 * request fails anyway, the fallback is English rather than nothing.
 */
const CATALOGUES: Record<Exclude<SupportedLocale, 'en'>, () => Promise<{ default: MessageSchema }>> = {
	fr: () => import('@/locales/fr.json'),
	es: () => import('@/locales/es.json'),
	pt: () => import('@/locales/pt.json'),
	ru: () => import('@/locales/ru.json'),
	de: () => import('@/locales/de.json'),
	it: () => import('@/locales/it.json'),
	zh: () => import('@/locales/zh.json'),
};

/**
 * Russian counts in three, and the default rule cannot say so.
 *
 * vue-i18n's built-in rule picks by "zero, one, many", which is English. Russian
 * agrees the noun with the last digit: 1, 21, 31 take one form, 2–4 and 22–24 take
 * another, everything else — including 11 to 14, which look like ones and are not —
 * takes a third. Getting it wrong is not subtle: every list header in the interface
 * reads as broken grammar to a Russian speaker.
 *
 * The catalogue writes three forms (`one | few | many`) where English writes two, and
 * four (`zero | one | few | many`) where English opens with a phrase for nothing, so
 * the count of forms is what says whether index 0 is the zero phrase.
 */
const russianPlural: PluralizationRule = (choice, choicesLength) => {
	const offset = choicesLength >= 4 ? 1 : 0;
	if (offset === 1 && choice === 0) {
		return 0;
	}
	const lastDigit = choice % 10;
	const lastTwo = choice % 100;
	if (lastDigit === 1 && lastTwo !== 11) {
		return offset;
	}
	if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) {
		return offset + 1;
	}
	return offset + 2;
};

/** Chinese does not inflect for number: every entry is written once, and used for any count. */
const chinesePlural: PluralizationRule = () => 0;

const LOCALE_STORAGE_KEY = 'mcs.locale';

function isSupported (value: string | null | undefined): value is SupportedLocale {
	return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Storage throws in a private window and in an iframe with cookies blocked. */
export function readStoredLocale (): SupportedLocale | null {
	try {
		const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
		return isSupported(stored) ? stored : null;
	} catch {
		return null;
	}
}

export function storeLocale (locale: SupportedLocale): void {
	try {
		window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	} catch {
		// A viewer who cannot persist the choice still gets it for this session.
	}
}

/** Remembered choice first, then what the browser asks for, then English. */
export function detectLocale (): SupportedLocale {
	const stored = readStoredLocale();
	if (stored) {
		return stored;
	}
	const candidates = typeof navigator === 'undefined'
		? []
		: (navigator.languages?.length ? [...navigator.languages] : [navigator.language]);
	for (const candidate of candidates) {
		const short = candidate?.split('-', 1)[0]?.toLowerCase();
		if (isSupported(short)) {
			return short;
		}
	}
	return DEFAULT_LOCALE;
}

/**
 * Widened to the plain `I18n` type on purpose.
 *
 * Inferring the schema from the catalogues makes every key a literal type, which
 * then refuses any computed key — and this interface builds keys from enum values
 * all the time (`sync.state.${state}`, `transfer.state.${state}`). The catalogues
 * stay type-checked against each other through `CATALOGUES` above.
 */
export const i18n = createI18n({
	legacy: false,
	locale: detectLocale(),
	fallbackLocale: DEFAULT_LOCALE,
	messages: { en },
	pluralRules: { ru: russianPlural, zh: chinesePlural },
}) as unknown as I18n;

const loaded = new Set<SupportedLocale>([DEFAULT_LOCALE]);

/**
 * Brings a catalogue in, once, and never rejects.
 *
 * A chunk that does not arrive leaves the locale selected and its messages missing,
 * which vue-i18n answers from the English fallback. Rejecting instead would make the
 * caller — the language menu, the boot — responsible for a failure whose only sane
 * handling is exactly that.
 */
export async function loadLocaleMessages (locale: SupportedLocale): Promise<void> {
	if (loaded.has(locale)) {
		return;
	}
	try {
		const catalogue = await CATALOGUES[locale as Exclude<SupportedLocale, 'en'>]();
		(i18n.global.setLocaleMessage as (l: string, m: MessageSchema) => void)(locale, catalogue.default);
		loaded.add(locale);
	} catch {
		// English remains, which is the fallback anyway.
	}
}

/**
 * Resolves once the locale chosen at boot can be rendered.
 *
 * `main.ts` waits on this before mounting: mounting first would paint the whole
 * interface in English and swap it a moment later, which reads as a bug on every
 * reload for anybody not using the default language.
 */
export function whenLocaleReady (): Promise<void> {
	return loadLocaleMessages(detectLocale());
}

/**
 * Translation outside a component.
 *
 * Stores and plain modules — the API error parser above all — need the catalogue
 * before any component exists, so they go through the instance rather than
 * through `useI18n()`, which requires an active component.
 */
export function translate (key: string, params?: Record<string, unknown>): string {
	return params === undefined
		? (i18n.global.t as (k: string) => string)(key)
		: (i18n.global.t as (k: string, p: Record<string, unknown>) => string)(key, params);
}

/** True when the key resolves in the current locale or in the fallback one. */
export function hasTranslation (key: string): boolean {
	const te = i18n.global.te as (k: string, locale?: string) => boolean;
	return te(key) || te(key, DEFAULT_LOCALE);
}

/**
 * The switch is immediate and the catalogue may lag by a chunk request.
 *
 * Waiting for the fetch before moving would leave the menu looking stuck on a slow
 * line; switching first shows a few English strings for an instant instead, and only
 * the first time a language is picked.
 */
export function setI18nLocale (locale: SupportedLocale): void {
	(i18n.global.locale as { value: string }).value = locale;
	storeLocale(locale);
	void loadLocaleMessages(locale);
}

export default function installI18n (app: App): typeof i18n {
	app.use(i18n);
	// `useCommonContext` reaches the composer through the application instance, so
	// that a store can translate without being inside a component.
	(app as App & { $i18n?: unknown }).$i18n = i18n;
	return i18n;
}
