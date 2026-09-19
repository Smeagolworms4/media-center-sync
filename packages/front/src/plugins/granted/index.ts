import type { App } from 'vue';
import { useTokenStore } from '@/stores/token';
import type { Token } from '@/models';
import type { Pinia } from 'pinia';
import type { Router, RouteRecordRaw } from 'vue-router';
import { useCheckRoute } from '@/hooks';
import { useUserStore } from '@/stores/user';

export * from './useIsGranted';
export * from './useRouteGranted';


const simpleRightHandler = (right: string, token: Token) => {
	return token.rights.indexOf(right) !== -1;
};

export default {
	install(app: App, {
		pinia,
		router,
		handlers = [],
	}: {
		pinia: Pinia,
		router: Router,
		handlers?: ((right: string, token: Token) => boolean)[],
	}) {

		const _grantedHandlers: ((right: string, token: Token) => boolean)[] = [
			simpleRightHandler,
			...handlers,
		];

		function isGranted(rights: string | string[]) {
			const tokenStore = useTokenStore(pinia);
			const token = tokenStore.token;
			if (typeof rights === 'string') {
				rights = [ rights ];
			}
			if (token) {
				for (const right of rights) {
					let success = false;
					for (const handler of _grantedHandlers) {
						if (handler(right, token)) {
							success = true;
						}
					}
					if (!success) {
						return false;
					}
				}
				return true;
			}
			return false;
		}
		function routeGranted(routeName: string) {
			const searchRoutes = (routeName: string, routes: readonly RouteRecordRaw[]): any => {
				for (const route of routes) {
					if (route.name === routeName) {
						return route;
					}
					// Si la route a des enfants, les parcourir également
					if (route.children) {
						const foundRoute: any = searchRoutes(routeName, route.children);
						if (foundRoute) {
							return {
								...foundRoute,
								meta: {
									granted: [
										...((route.meta as any)?.granted ?? []),
										...((foundRoute.meta as any)?.granted ?? []),
									]
								}
							};
						}
					}
				}
				return null;
			};
			const route = searchRoutes(routeName, router.options.routes);
			return !route || (!route?.meta?.granted || isGranted(route.meta.granted));
		}

		app.config.globalProperties.$isGranted = isGranted;
		app.config.globalProperties.$routeGranted = routeGranted;


		router.beforeEach((to) => {
			const checkRoute = useCheckRoute({
				app,
				pinia
			});
			const useStore = useUserStore(pinia);
			if (useStore.firstCalled) {
				const guard = checkRoute(to);
				if (guard) {
					console.log('Error access to route:', to.name)
					return guard;
				}
			}
		});
	}
};
