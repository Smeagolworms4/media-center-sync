import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { useCaller, useI18n, useApp } from '@/hooks';
import { cachePromise } from '@/hooks';
import type { AvailableLocale, ResultList, Translation } from '@/models';
import { usePageStore } from '@/stores/page.ts';

const FORCE_LOCALE_KEY = 'force-locale';

/**
 * Store i18n :
 * - Charge les locales disponibles depuis GET /api/locales
 * - Charge les traductions (front + indications) depuis GET /api/translations/{domain}/{locale}
 * - Détecte la locale depuis : localStorage > navigateur > default API
 * - Injecte les messages dans vue-i18n et synchronise Vuetify
 */
export const useI18nStore = defineStore('i18n', () => {
	const { caller } = useCaller();

	const i18n = useI18n();
	const pageStore = usePageStore();
	const domains = ['front', 'indications'];
	const loaded = ref(false);
	const locale = ref('fr');
	const availableLocales = ref<AvailableLocale[]>([]);

	const availableCodes = computed(() =>
		availableLocales.value.map(l => l.code),
	);

	const defaultLocale = computed(() =>
		availableLocales.value.find(l => l.default)?.code ?? 'fr',
	);

	const localeByCode = (code: string) => availableLocales.value.find(l => l.code === code) ?? null;

	/**
	 * Charge les locales disponibles depuis l'API.
	 */
	const loadAvailableLocales = (): Promise<AvailableLocale[]> => {
		return cachePromise(async () => {
			const result = await caller('api').get<ResultList<AvailableLocale>>('/locales', { useAuth: false });
			availableLocales.value = result.data;
			return availableLocales.value;
		})('i18n|locales');
	};

	/**
	 * Détecte la meilleure locale :
	 * 1. localStorage 'force-locale' si valide
	 * 2. Langue du navigateur si dispo
	 * 3. Locale par défaut de l'API
	 */
	const detectLocale = (): string => {
		const codes = availableCodes.value;

		// 1. Force locale sauvegardée
		const saved = window.localStorage.getItem(FORCE_LOCALE_KEY);
		if (saved && codes.includes(saved)) {
			return saved;
		}

		// 2. Langue du navigateur
		const languages = navigator.languages ? navigator.languages : [navigator.language];
		for (const language of languages.map(l => l.split('-')[0].toLowerCase())) {
			if (codes.includes(language)) {
				return language;
			}
		}

		// 3. Default API
		return defaultLocale.value;
	};

	const loadLocale = async (lang: string) => {
		await cachePromise(async () => {
			const results = await Promise.all(
				domains.map(domain =>
					caller('api').get<Translation>(`/translations/${domain}/${lang}`, { useAuth: false }),
				),
			)
			const messages: Record<string, string> = {};
			for (const result of results) {
				for (const [key, value] of Object.entries(result.messages)) {
					messages[`${result.domain}.${key}`] = value;
				}
			}
			i18n.setLocaleMessage(lang!, messages);
		})(`i18n|locales|${lang}`);
	};

	/**
	 * Charge les traductions pour une locale et les injecte dans vue-i18n.
	 */
	const load = async (lang?: string): Promise<void> => {
		if (!lang) {
			await loadAvailableLocales();
			(i18n.fallbackLocale as any).value = defaultLocale.value as string;
			lang = detectLocale();
		}


		await Promise.all([
			loadLocale(lang),
			loadLocale(defaultLocale.value),
		]);

		i18n.locale.value = lang! as any;
		locale.value = lang!;

		// Synchronise la locale Vuetify
		try {
			const app = useApp();
			const vuetify = (app as any).$vuetify;
			if (vuetify?.locale) {
				vuetify.locale.current.value = lang!;
			}
		} catch {
			// Vuetify pas encore dispo au premier load
		}
		pageStore.refresh();

		loaded.value = true;
	};

	/**
	 * Change la locale courante, recharge les traductions et persiste le choix.
	 */
	const setLocale = async (lang: string): Promise<void> => {
		window.localStorage.setItem(FORCE_LOCALE_KEY, lang);
		await load(lang);
	};

	return {
		loaded,
		locale,
		availableLocales,
		availableCodes,
		localeByCode,
		defaultLocale,
		loadAvailableLocales,
		load,
		setLocale,
	};
});
