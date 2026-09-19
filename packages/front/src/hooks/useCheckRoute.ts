import type { Pinia } from 'pinia';
import type { App } from 'vue';
import type { RouteLocationNormalized } from 'vue-router';
import { usePinia } from '@/hooks/useCommonContext';
import { useRouteGranted } from '@/plugins/granted/useRouteGranted';
import { useAuthStore } from '@/stores/auth';

/**
 * The single answer to "may this navigation happen?".
 *
 * Returning a location rather than calling the router keeps it testable and lets
 * the caller decide whether to redirect or to render something else.
 */
export function useCheckRoute (
	{ app, pinia }: { app?: App; pinia?: Pinia } = {},
) {
	const resolvedPinia = pinia ?? usePinia();
	const routeGranted = useRouteGranted(app);

	return (route: RouteLocationNormalized) => {
		if (!route.name) {
			return null;
		}
		const authStore = useAuthStore(resolvedPinia);
		const signedIn = authStore.authenticated;

		/*
		 * A gateway with no account at all has one thing to offer, so every address
		 * leads to it — a bookmark, a shared link, the address bar. And once it has
		 * been claimed the screen disappears entirely: the route that creates the
		 * first administrator is open, and what makes that safe is that it refuses
		 * the moment an account exists. Leaving its page reachable would only give
		 * somebody a form whose submit can no longer succeed.
		 */
		if (authStore.setupRequired) {
			return route.name === 'setup' ? null : { name: 'setup' };
		}
		if (route.name === 'setup') {
			return signedIn ? { name: 'dashboard' } : { name: 'login' };
		}

		if (!signedIn && !route.meta.publicPage) {
			return { name: 'login' };
		}
		if (signedIn && route.meta.disconnectPage) {
			return { name: 'dashboard' };
		}
		// A page whose rights are missing is not merely hidden from the menu: it has
		// to be unreachable, or a bookmark walks straight past the navigation.
		if (!routeGranted(String(route.name))) {
			return signedIn ? { name: 'dashboard' } : { name: 'login' };
		}
		return null;
	};
}
