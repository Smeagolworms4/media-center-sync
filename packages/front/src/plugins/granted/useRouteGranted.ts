import type { App } from 'vue';
import { useApp } from '@/hooks/useCommonContext';

/**
 * Accepts an explicit `app` because the router guard runs outside any component,
 * where `getCurrentInstance()` has nothing to offer.
 */
export function useRouteGranted (app?: App): (routeName: string) => boolean {
	const resolved = app ?? useApp();
	return (routeName: string) => resolved.config.globalProperties.$routeGranted(routeName);
}
