import type { App } from 'vue';
import { createI18n, type I18n } from 'vue-i18n';
import en from '@/locales/en';
import fr from '@/locales/fr';

/**
 * The catalogues are bundled with the application rather than fetched.
 *
 * A gateway is often reached before its API is healthy — the sign-in page, an
 * error screen, the "service unreachable" message — and a catalogue that has to
 * be downloaded first turns every one of those into a screen of raw keys.
 */
export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

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
 * stay type-checked against each other through `locales/fr.ts`.
 */
export const i18n = createI18n({
	legacy: false,
	locale: detectLocale(),
	fallbackLocale: DEFAULT_LOCALE,
	messages: { en, fr },
}) as unknown as I18n;

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

export function setI18nLocale (locale: SupportedLocale): void {
	(i18n.global.locale as { value: string }).value = locale;
	storeLocale(locale);
}

export default function installI18n (app: App): typeof i18n {
	app.use(i18n);
	// `useCommonContext` reaches the composer through the application instance, so
	// that a store can translate without being inside a component.
	(app as App & { $i18n?: unknown }).$i18n = i18n;
	return i18n;
}
