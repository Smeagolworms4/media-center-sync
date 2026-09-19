import { useApp } from '@/hooks';
import type { App } from 'vue';

export function useRouteGranted(app?: App): (routeName: string) => boolean {
	app = app ?? useApp();
	return (routeName: string) => app.config.globalProperties.$routeGranted(routeName);
}
