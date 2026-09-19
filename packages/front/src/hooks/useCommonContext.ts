import type { useI18n as useI18nVue } from 'vue-i18n';
import type { Router } from 'vue-router';
import { getActivePinia, type Pinia } from 'pinia';
import { type App, getCurrentInstance } from 'vue';

export function useCommonContext (): {
	app: App;
	i18n: ReturnType<typeof useI18nVue>;
	router: Router;
	pinia: Pinia;
} {
	const instance = getCurrentInstance();
	if (instance) {
		const app = instance.appContext.app;
		const i18n = (instance.appContext.app as any).$i18n.global;
		const router = (instance.appContext.app as any).$router;
		const pinia = (instance.appContext.app as any).$pinia;

		return {
			app,
			i18n,
			router,
			pinia,
		};
	}
	const pinia = getActivePinia();
	if (pinia) {
		return {
			app: (pinia as any).$app,
			i18n: (pinia as any).$i18n.global,
			router: (pinia as any).$router,
			pinia,
		};
	}

	throw new Error('Not in context');
}

export function useApp () {
	return useCommonContext().app;
}
export function useI18n () {
	return useCommonContext().i18n;
}
export function useRouter () {
	return useCommonContext().router;
}
export function usePinia () {
	return useCommonContext().pinia;
}
