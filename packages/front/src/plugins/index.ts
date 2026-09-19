import type { App } from 'vue';
import { createPinia } from 'pinia';
import FormMainError from '@/components/FormMainError.vue';
import { vForm } from '@/composables/vForm';
import { createAppRouter, registerRouterGuards } from '@/router';
import granted from './granted';
import installI18n from './i18n';
import piniaExtra from './piniaExtra';
import validators from './validators';
import { createAppVuetify } from './vuetify';

import '@/libs/caller/callers';

/**
 * Everything the application needs, in the only order that works.
 *
 * Pinia first, because every other plugin ends up reading a store. Then i18n and
 * the router, because `piniaExtra` hands both of them to every store — that is
 * what lets a store translate an error or redirect after a sign-out without being
 * inside a component. The guards go on last, once the auth store can be resolved.
 */
export function registerPlugins (app: App) {
	const pinia = createPinia();
	app.use(pinia);

	const i18n = installI18n(app);
	const router = createAppRouter();

	app.use(piniaExtra, { pinia, router, i18n });
	app.use(router);
	app.use(createAppVuetify());
	app.use(validators);
	app.use(granted, { pinia, router });

	app.directive('form', vForm);
	// Registered globally because every form in the application renders one, and
	// importing it in each of them is the kind of boilerplate people forget.
	app.component('FormMainError', FormMainError);

	registerRouterGuards(router, { app, pinia });

	return { pinia, router, i18n };
}

export default registerPlugins;
