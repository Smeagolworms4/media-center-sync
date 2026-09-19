import type { Right } from '@mcs/shared';
import type { Pinia } from 'pinia';
import type { App } from 'vue';
import type { Router, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export * from './useIsGranted';
export * from './useRouteGranted';

export type GrantedHandler = (right: Right, rights: Right[]) => boolean;

/** The rule that covers everything the API models today: the right is held, or it is not. */
const simpleRightHandler: GrantedHandler = (right, rights) => rights.includes(right);

/**
 * Rights, for the template and for the router.
 *
 * Everything is decided on rights and never on a role, exactly as the API does:
 * `hasRight(Right.SERVICE_MANAGE)` keeps meaning the same thing when the role
 * bundles change, `role === 'admin'` does not.
 *
 * Extra handlers exist for the rules that cannot be expressed as set membership —
 * "this peer, but only while it is linked", say — without every caller learning
 * about them.
 */
export default {
	install (app: App, {
		pinia,
		router,
		handlers = [],
	}: {
		pinia: Pinia;
		router: Router;
		handlers?: GrantedHandler[];
	}) {
		const grantedHandlers: GrantedHandler[] = [simpleRightHandler, ...handlers];

		function isGranted (rights: Right | Right[]): boolean {
			const authStore = useAuthStore(pinia);
			if (!authStore.authenticated) {
				return false;
			}
			const held = authStore.rights;
			const needed = Array.isArray(rights) ? rights : [rights];
			return needed.every(right => grantedHandlers.some(handler => handler(right, held)));
		}

		/**
		 * Walks the route tree collecting the rights of every ancestor, because a
		 * child of a guarded section inherits its guard — declaring the right once on
		 * the parent has to be enough.
		 */
		function routeGranted (routeName: string): boolean {
			const search = (
				name: string,
				routes: readonly RouteRecordRaw[],
			): { granted: Right[] } | null => {
				for (const route of routes) {
					const own = (route.meta?.granted ?? []) as Right[];
					if (route.name === name) {
						return { granted: own };
					}
					if (route.children) {
						const found = search(name, route.children);
						if (found) {
							return { granted: [...own, ...found.granted] };
						}
					}
				}
				return null;
			};

			const found = search(routeName, router.options.routes);
			return !found || found.granted.length === 0 || isGranted(found.granted);
		}

		app.config.globalProperties.$isGranted = isGranted;
		app.config.globalProperties.$routeGranted = routeGranted;
	},
};
