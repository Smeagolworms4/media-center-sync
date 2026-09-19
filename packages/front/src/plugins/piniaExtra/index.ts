import type { Pinia } from 'pinia';
import type { App } from 'vue';
import type { Router } from 'vue-router';
import type { I18n } from 'vue-i18n';

export default {
	install(app: App, {
		pinia,
		router,
		i18n,
	}: {
		pinia: Pinia,
		router: Router,
		i18n: I18n,
	}) {

		(pinia as any).$app = app;
		(pinia as any).$i18n = i18n;
		(pinia as any).$router = router;
		(pinia as any).$registeredStores ??= {};
		(app as any).$pinia = pinia;

		pinia.use(function({ store }) {
			store.$app = app;
			store.$router = router;
			store.$i18n = i18n;
			(pinia as any).$registeredStores[store.$id] = store;
		});
	}
}
