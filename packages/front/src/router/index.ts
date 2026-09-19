import type { Pinia } from 'pinia';
import type { App } from 'vue';
import { Right } from '@mcs/shared';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useCheckRoute } from '@/hooks/useCheckRoute';
import { useAuthStore } from '@/stores/auth';

/**
 * Pages are loaded on demand.
 *
 * Somebody who only ever looks at their library should not download the settings
 * screens, and the sign-in page — the one screen every visitor loads, often over
 * a slow link from outside the house — should not carry the rest of the
 * application with it.
 */
export const routes: RouteRecordRaw[] = [
	{
		path: '/login',
		name: 'login',
		component: () => import('@/pages/Login.vue'),
		meta: { publicPage: true, disconnectPage: true, title: 'auth.title' },
	},
	{
		path: '/',
		name: 'dashboard',
		component: () => import('@/pages/Dashboard.vue'),
		meta: { title: 'pages.dashboard', icon: 'mdi-view-dashboard-outline', nav: true },
	},
	{
		path: '/library',
		name: 'library',
		component: () => import('@/pages/Library.vue'),
		meta: {
			title: 'pages.library',
			icon: 'mdi-bookshelf',
			nav: true,
			granted: [Right.LIBRARY_READ],
		},
	},
	{
		path: '/library/:itemId',
		name: 'library-item',
		component: () => import('@/pages/LibraryItem.vue'),
		props: true,
		meta: { title: 'pages.library_item', granted: [Right.MEDIA_READ] },
	},
	{
		path: '/services',
		name: 'services',
		component: () => import('@/pages/Services.vue'),
		meta: {
			title: 'pages.services',
			icon: 'mdi-server-network',
			nav: true,
			granted: [Right.SERVICE_READ],
		},
	},
	{
		path: '/services/:id',
		name: 'service',
		component: () => import('@/pages/Service.vue'),
		props: true,
		meta: { title: 'pages.service', granted: [Right.SERVICE_READ] },
	},
	{
		path: '/peers',
		name: 'peers',
		component: () => import('@/pages/Peers.vue'),
		meta: {
			title: 'pages.peers',
			icon: 'mdi-account-network-outline',
			nav: true,
			granted: [Right.PEER_READ],
		},
	},
	{
		path: '/peers/:id',
		name: 'peer',
		component: () => import('@/pages/Peer.vue'),
		props: true,
		meta: { title: 'pages.peer', granted: [Right.PEER_READ] },
	},
	{
		path: '/sync',
		name: 'sync',
		component: () => import('@/pages/Sync.vue'),
		meta: {
			title: 'pages.sync',
			icon: 'mdi-sync',
			nav: true,
			granted: [Right.SYNC_READ],
		},
	},
	{
		path: '/sync/plans/:id',
		name: 'sync-plan',
		component: () => import('@/pages/SyncPlan.vue'),
		props: true,
		meta: { title: 'pages.sync_plan', granted: [Right.SYNC_READ] },
	},
	{
		path: '/transfers',
		name: 'transfers',
		component: () => import('@/pages/Transfers.vue'),
		meta: {
			title: 'pages.transfers',
			icon: 'mdi-transfer-down',
			nav: true,
			granted: [Right.TRANSFER_READ],
		},
	},
	{
		path: '/settings',
		name: 'settings',
		component: () => import('@/pages/Settings.vue'),
		meta: {
			title: 'pages.settings',
			icon: 'mdi-cog-outline',
			nav: true,
			granted: [Right.SETTINGS_MANAGE],
		},
	},
	{
		path: '/settings/shares',
		name: 'settings-shares',
		component: () => import('@/pages/SettingsShares.vue'),
		meta: {
			title: 'pages.settings_shares',
			icon: 'mdi-share-variant-outline',
			nav: true,
			granted: [Right.SHARE_MANAGE],
		},
	},
	{
		path: '/settings/users',
		name: 'settings-users',
		component: () => import('@/pages/SettingsUsers.vue'),
		meta: {
			title: 'pages.settings_users',
			icon: 'mdi-account-multiple-outline',
			nav: true,
			granted: [Right.USER_MANAGE],
		},
	},
	{
		path: '/:pathMatch(.*)*',
		name: 'not-found',
		component: () => import('@/pages/NotFound.vue'),
		meta: { publicPage: true, title: 'pages.not_found' },
	},
];

export function createAppRouter () {
	return createRouter({
		history: createWebHistory(),
		routes,
		scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
	});
}

/**
 * The guard has to wait for the boot-time restore.
 *
 * Deciding before the stored session has been proven sends a signed-in viewer to
 * the sign-in page on every page reload, and then bounces them back — a flicker
 * that reads as a bug and loses the address they typed.
 */
export function registerRouterGuards (
	router: ReturnType<typeof createAppRouter>,
	{ app, pinia }: { app: App; pinia: Pinia },
): void {
	const checkRoute = useCheckRoute({ app, pinia });

	router.beforeEach(async to => {
		await useAuthStore(pinia).whenReady();
		return checkRoute(to) ?? true;
	});
}

export default createAppRouter;
