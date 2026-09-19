import { Right, UserRole } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { useCheckRoute } from '@/hooks/useCheckRoute';
import { useIsGranted } from '@/plugins/granted';
import { registerRouterGuards, routes } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { createStoreContext } from './helpers';

function signIn (rights: Right[]): void {
	useTokenStore().store({
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		user: { id: 'u1', username: 'ada', role: UserRole.USER },
		rights,
	} as never);
	useAuthStore().ready = true;
}

describe('router', () => {
	let context: ReturnType<typeof createStoreContext>;

	beforeEach(() => {
		context = createStoreContext();
		useAuthStore().ready = true;
	});

	it('declares every screen the product promises', () => {
		const paths = routes.map(route => route.path);

		expect(paths).toEqual([
			'/login', '/', '/library', '/library/:itemId',
			'/services', '/services/:id', '/peers', '/peers/:id',
			'/sync', '/sync/plans/:id', '/transfers',
			'/settings', '/settings/shares', '/settings/users',
			'/:pathMatch(.*)*',
		]);
	});

	it('guards each screen with the right the API checks', () => {
		const granted = Object.fromEntries(routes.map(route => [route.name, route.meta?.granted]));

		expect(granted.library).toEqual([Right.LIBRARY_READ]);
		expect(granted.services).toEqual([Right.SERVICE_READ]);
		expect(granted.peers).toEqual([Right.PEER_READ]);
		expect(granted.sync).toEqual([Right.SYNC_READ]);
		expect(granted.transfers).toEqual([Right.TRANSFER_READ]);
		expect(granted.settings).toEqual([Right.SETTINGS_MANAGE]);
		expect(granted['settings-shares']).toEqual([Right.SHARE_MANAGE]);
		expect(granted['settings-users']).toEqual([Right.USER_MANAGE]);
	});

	it('loads every page on demand', () => {
		for (const route of routes) {
			expect(typeof route.component).toBe('function');
		}
	});

	it('sends a visitor with no session to the sign-in page', async () => {
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });
		const to = context.router.resolve({ name: 'library' });

		expect(check(to as never)).toEqual({ name: 'login' });
	});

	it('lets a visitor with no session reach the public pages', () => {
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });

		expect(check(context.router.resolve({ name: 'login' }) as never)).toBeNull();
		expect(check(context.router.resolve('/nowhere') as never)).toBeNull();
	});

	it('keeps a signed-in viewer away from the sign-in page', () => {
		signIn([Right.LIBRARY_READ]);
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });

		expect(check(context.router.resolve({ name: 'login' }) as never)).toEqual({ name: 'dashboard' });
	});

	it('refuses a route whose rights the viewer lacks', () => {
		signIn([Right.LIBRARY_READ]);
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });

		expect(check(context.router.resolve({ name: 'library' }) as never)).toBeNull();
		expect(check(context.router.resolve({ name: 'settings' }) as never)).toEqual({ name: 'dashboard' });
	});

	it('lets an administrator everywhere', () => {
		signIn(Object.values(Right));
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });

		const params = { itemId: 'm1', id: 's1', pathMatch: ['nowhere'] };
		for (const route of routes) {
			if (route.name === 'login') {
				continue;
			}
			const to = context.router.resolve({ name: route.name, params });
			expect(check(to as never), String(route.name)).toBeNull();
		}
	});

	it('never guards the dashboard, which everybody with a session can open', () => {
		signIn([]);
		const check = useCheckRoute({ app: context.app, pinia: context.pinia });

		expect(check(context.router.resolve({ name: 'dashboard' }) as never)).toBeNull();
	});

	it('the installed guard waits for the boot restore before deciding', async () => {
		const fresh = createStoreContext();
		registerRouterGuards(fresh.router as never, { app: fresh.app, pinia: fresh.pinia });

		await fresh.router.push('/services');

		expect(useAuthStore(fresh.pinia).ready).toBe(true);
		expect(fresh.router.currentRoute.value.name).toBe('login');
	});
});

describe('plugins/granted', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('answers false for everything while nobody is signed in', () => {
		const app = createApp({ render: () => null });
		const context = createStoreContext();
		context.install(app);

		expect(app.config.globalProperties.$isGranted(Right.LIBRARY_READ)).toBe(false);
		expect(app.config.globalProperties.$routeGranted('library')).toBe(false);
	});

	it('requires every right of a list, not just one', () => {
		const app = createApp({ render: () => null });
		const context = createStoreContext();
		context.install(app);
		signIn([Right.LIBRARY_READ]);

		expect(app.config.globalProperties.$isGranted([Right.LIBRARY_READ])).toBe(true);
		expect(app.config.globalProperties.$isGranted([Right.LIBRARY_READ, Right.USER_MANAGE])).toBe(false);
	});

	it('allows a route that asks for no right in particular', () => {
		const app = createApp({ render: () => null });
		const context = createStoreContext();
		context.install(app);
		signIn([]);

		expect(app.config.globalProperties.$routeGranted('dashboard')).toBe(true);
		expect(app.config.globalProperties.$routeGranted('a-route-that-does-not-exist')).toBe(true);
	});

	it('exposes the same answer to a composable', () => {
		const app = createApp({
			setup () {
				const isGranted = useIsGranted();
				expect(isGranted(Right.LIBRARY_READ)).toBe(true);
				return () => null;
			},
		});
		const context = createStoreContext();
		context.install(app);
		signIn([Right.LIBRARY_READ]);
		app.mount(document.createElement('div'));
	});
});
