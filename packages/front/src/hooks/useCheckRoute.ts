import type { RouteLocationNormalized } from 'vue-router';
import { usePinia } from '@/hooks/useCommonContext';
import { useUserStore } from '@/stores/user';
import { useRouteGranted } from '@/plugins/granted';
import type { Pinia } from 'pinia';
import type { App } from 'vue';

export function useCheckRoute(
	{
		app,
		pinia,
	}: {
		app?: App,
		pinia?: Pinia
	} = {}
) {
	pinia = pinia ?? usePinia();
	const routeGranted = useRouteGranted(app);
	return (route: RouteLocationNormalized) => {
		const userStore = useUserStore(pinia);
		if (!route.name) {
			return null;
		}
		const me = userStore.me;
		if ((route as any).name && !(routeGranted((route as any).name))) {
			return me ? { name: 'home' } : { name: 'login' };
		}
		if (!me && !route.meta['publicPage']) {
			return { name: 'login' };
		}
		if (me && route.meta['disconnectPage']) {
			return { name: 'home' };
		}
		return null;
	};
}
