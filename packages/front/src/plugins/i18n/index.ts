import { createI18n, type I18n } from 'vue-i18n'
import type { App } from 'vue';

export default function (app: App): I18n {
	const i18n = createI18n({
		legacy: false,
		locale: 'fr',
		fallbackLocale: 'fr',
		messages: {},
	});

	(app as any).$i18n = i18n;
	return i18n as I18n;
};
