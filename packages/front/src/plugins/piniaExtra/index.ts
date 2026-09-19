import type { Pinia } from 'pinia';
import type { App } from 'vue';
import type { I18n } from 'vue-i18n';
import type { Router } from 'vue-router';

/**
 * Gives stores the three things they cannot reach on their own.
 *
 * A store is not a component, so `useRouter()` and `useI18n()` do not work inside
 * one — yet a store is exactly where "sign out, then go to the sign-in page" and
 * "turn this error key into a sentence" belong. Hanging the application, the
 * router and the i18n instance on both the app and the pinia instance is what
 * lets `useCommonContext` find them from either side.
 */
export default {
	install (app: App, {
		pinia,
		router,
		i18n,
	}: {
		pinia: Pinia;
		router: Router;
		i18n: I18n;
	}) {
		const taggedPinia = pinia as Pinia & Record<string, unknown>;
		const taggedApp = app as App & Record<string, unknown>;

		taggedPinia.$app = app;
		taggedPinia.$i18n = i18n;
		taggedPinia.$router = router;
		taggedPinia.$registeredStores ??= {};

		taggedApp.$pinia = pinia;
		taggedApp.$i18n = i18n;
		taggedApp.$router = router;

		pinia.use(({ store }) => {
			store.$app = app;
			store.$router = router;
			store.$i18n = i18n;
			(taggedPinia.$registeredStores as Record<string, unknown>)[store.$id] = store;
		});
	},
};
