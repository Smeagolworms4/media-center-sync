import { Right, UserRole } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import { nextTick } from 'vue';
import App from '@/App.vue';
import Dashboard from '@/pages/Dashboard.vue';
import Library from '@/pages/Library.vue';
import LibraryItem from '@/pages/LibraryItem.vue';
import NotFound from '@/pages/NotFound.vue';
import Peer from '@/pages/Peer.vue';
import Peers from '@/pages/Peers.vue';
import Service from '@/pages/Service.vue';
import Services from '@/pages/Services.vue';
import Settings from '@/pages/Settings.vue';
import SettingsShares from '@/pages/SettingsShares.vue';
import SettingsUsers from '@/pages/SettingsUsers.vue';
import Sync from '@/pages/Sync.vue';
import SyncPlan from '@/pages/SyncPlan.vue';
import Transfers from '@/pages/Transfers.vue';
import { useAuthStore } from '@/stores/auth';
import { useTokenStore } from '@/stores/token';
import { mountWithApp, stubFetch } from './helpers';

async function settle (times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => { setTimeout(resolve, 0); });
	}
}

/** Waits for a navigation to land; a lazy page takes as long as its import does. */
async function untilRoute (router: Router, name: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (router.currentRoute.value.name === name) {
			return;
		}
		await nextTick();
		await new Promise(resolve => { setTimeout(resolve, 5); });
	}
}

/**
 * Every placeholder page still has to render: another agent fills the bodies in,
 * and a page that throws on mount would only be found once that work starts.
 */
const placeholders: [string, any, string][] = [
	['Dashboard', Dashboard, 'Dashboard'],
	['Library', Library, 'Library'],
	['LibraryItem', LibraryItem, 'Media'],
	['Services', Services, 'Media services'],
	['Service', Service, 'Service'],
	['Peers', Peers, 'Peers'],
	['Peer', Peer, 'Peer'],
	['Sync', Sync, 'Sync'],
	['SyncPlan', SyncPlan, 'Sync plan'],
	['Transfers', Transfers, 'Transfers'],
	['Settings', Settings, 'Settings'],
	['SettingsShares', SettingsShares, 'Shares'],
	['SettingsUsers', SettingsUsers, 'Users'],
];

describe('placeholder pages', () => {
	it.each(placeholders)('%s renders its own title', (_name, component, title) => {
		const { wrapper } = mountWithApp(component);

		expect(wrapper.find('.page-header_title').text()).toBe(title);
		expect(wrapper.find('.v-card').exists()).toBe(true);
	});
});

describe('pages/NotFound', () => {
	it('offers the sign-in page to a visitor with no session', async () => {
		const { wrapper, router } = mountWithApp(NotFound);

		expect(wrapper.text()).toContain('Page not found');
		await wrapper.find('.empty-state button').trigger('click');
		await untilRoute(router, 'login');

		expect(router.currentRoute.value.name).toBe('login');
	});

	it('offers the dashboard to somebody already signed in', async () => {
		const { wrapper, pinia, router } = mountWithApp(NotFound);
		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', role: UserRole.ADMIN }, rights: [Right.LIBRARY_READ],
		} as never);
		await nextTick();

		expect(wrapper.text()).toContain('Back to the dashboard');
		await wrapper.find('.empty-state button').trigger('click');
		await untilRoute(router, 'dashboard');

		expect(router.currentRoute.value.name).toBe('dashboard');
	});
});

describe('App', () => {
	const flush = settle;

	it('holds a progress state until the boot restore answers', async () => {
		stubFetch([]);
		const { wrapper } = mountWithApp(App);

		expect(wrapper.find('.app_boot').exists()).toBe(true);

		await flush();
		expect(wrapper.find('.app_boot').exists()).toBe(false);
	});

	it('shows no shell at all to a visitor with no session', async () => {
		const { wrapper } = mountWithApp(App);
		await flush();

		expect(wrapper.find('.v-navigation-drawer').exists()).toBe(false);
		expect(wrapper.find('.v-app-bar').exists()).toBe(false);
	});

	it('shows only the sections the viewer may open', async () => {
		vi.stubGlobal('WebSocket', class { addEventListener () {} close () {} } as unknown as typeof WebSocket);
		stubFetch([{ body: {} }]);
		const { wrapper, pinia, router } = mountWithApp(App);
		await router.push({ name: 'dashboard' });

		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', displayName: 'Ada', role: UserRole.USER },
			rights: [Right.LIBRARY_READ, Right.TRANSFER_READ],
		} as never);
		useAuthStore(pinia).ready = true;
		await flush();

		const entries = wrapper.findAll('.app_nav .v-list-item-title').map(node => node.text());
		expect(entries).toContain('Dashboard');
		expect(entries).toContain('Library');
		expect(entries).toContain('Transfers');
		expect(entries).not.toContain('Settings');
		expect(entries).not.toContain('Users');
	});

	it('names the gateway, the account and the connection state in the bar', async () => {
		vi.stubGlobal('WebSocket', class { addEventListener () {} close () {} } as unknown as typeof WebSocket);
		stubFetch([{ body: {} }]);
		const { wrapper, pinia, router } = mountWithApp(App);
		await router.push({ name: 'dashboard' });

		useTokenStore(pinia).store({
			accessToken: 'a', refreshToken: 'r', expiresIn: 900,
			user: { id: 'u1', username: 'ada', displayName: 'Ada Lovelace', role: UserRole.ADMIN },
			rights: Object.values(Right),
		} as never);
		useAuthStore(pinia).ready = true;
		await flush();

		expect(wrapper.find('.v-app-bar').text()).toContain('Media Center Sync');
		expect(wrapper.find('.app_account').text()).toContain('Ada Lovelace');
		expect(wrapper.find('.app_connection').exists()).toBe(true);
	});
});
