import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
	DEFAULT_LOCALE,
	detectLocale,
	setI18nLocale,
	SUPPORTED_LOCALES,
	type SupportedLocale,
} from '@/plugins/i18n';

/**
 * The locale the whole application agrees on.
 *
 * The catalogues themselves live in `plugins/i18n`, which loads them; this store
 * only holds the current choice, because three unrelated consumers need it: vue-i18n,
 * the Vuetify locale, and the `X-Locale` header the caller sends so the API can
 * answer in the same language when it has to produce prose of its own.
 */
export const useI18nStore = defineStore('i18n', () => {
	const locale = ref<SupportedLocale>(detectLocale());
	const availableLocales = ref<SupportedLocale[]>([...SUPPORTED_LOCALES]);
	const defaultLocale = ref<SupportedLocale>(DEFAULT_LOCALE);

	function setLocale (value: SupportedLocale): void {
		if (!availableLocales.value.includes(value)) {
			return;
		}
		locale.value = value;
		setI18nLocale(value);
	}

	return {
		locale,
		availableLocales,
		defaultLocale,
		setLocale,
	};
});
