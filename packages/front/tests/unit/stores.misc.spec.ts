import { NamingScheme, PlacementStrategy } from '@mcs/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/plugins/i18n';
import { useI18nStore } from '@/stores/i18n';
import { useLoaderStore } from '@/stores/loader';
import { useNotifierStore } from '@/stores/notifier';
import { useSettingsStore } from '@/stores/settings';
import { createStoreContext, stubFetch } from './helpers';

const settings = {
	placement: PlacementStrategy.BESIDE_EXISTING,
	fixedPath: null,
	naming: NamingScheme.STANDARD,
	pullMetadata: true,
	preferSourceMetadata: false,
	maxParallelTransfers: 2,
	maxConnectionsPerSource: 4,
	chunkSize: 4_194_304,
	downloadRateLimit: 0,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	allowFriendsOfFriends: true,
	allowSwarm: true,
	rendezvousUrl: null,
	transferHistoryDays: 30,
	refreshIntervalMinutes: 15,
	fullScanCron: '0 4 * * *',
	cacheTtlSeconds: 60,
};

describe('stores/loader', () => {
	beforeEach(() => { createStoreContext(); });

	it('stays loading until every pending call has finished', () => {
		const loader = useLoaderStore();
		expect(loader.loading).toBe(false);

		loader.push();
		loader.push();
		expect(loader.loading).toBe(true);

		loader.pop();
		expect(loader.loading).toBe(true);
		loader.pop();
		expect(loader.loading).toBe(false);
	});

	it('never goes negative when something pops twice', () => {
		const loader = useLoaderStore();
		loader.pop();
		loader.pop();
		loader.push();

		expect(loader.loading).toBe(true);
	});
});

describe('stores/notifier', () => {
	beforeEach(() => { createStoreContext(); });

	it('shows a notification and removes it when its time is up', async () => {
		vi.useFakeTimers();
		const notifier = useNotifierStore();

		const pending = notifier.notify({ message: 'saved', timeout: 1000 });
		expect(notifier.notifies).toHaveLength(1);
		expect(notifier.notifies[0].type).toBe('success');

		await vi.advanceTimersByTimeAsync(1000);
		await pending;

		expect(notifier.notifies).toHaveLength(0);
	});
});

describe('stores/i18n', () => {
	beforeEach(() => { createStoreContext(); });

	it('switches the catalogue and remembers the choice', () => {
		const i18nStore = useI18nStore();
		expect(i18nStore.locale).toBe('en');

		i18nStore.setLocale('fr');

		expect(i18nStore.locale).toBe('fr');
		expect((i18n.global.locale as { value: string }).value).toBe('fr');
		expect(window.localStorage.getItem('mcs.locale')).toBe('fr');

		i18nStore.setLocale('en');
	});

	it('ignores a locale this build does not ship', () => {
		const i18nStore = useI18nStore();
		i18nStore.setLocale('de' as never);

		expect(i18nStore.locale).toBe('en');
	});
});

describe('stores/settings', () => {
	beforeEach(() => { createStoreContext(); });

	it('reads the gateway settings once', async () => {
		const stub = stubFetch([{ body: settings }]);
		const store = useSettingsStore();

		await store.load();

		expect(stub.mock.calls[0][0]).toBe('/api/settings');
		expect(store.loaded).toBe(true);
		expect(store.settings?.fullScanCron).toBe('0 4 * * *');
	});

	it('patches what changed and keeps the answer', async () => {
		const stub = stubFetch([{ body: { ...settings, maxParallelTransfers: 4 } }]);
		const store = useSettingsStore();

		await store.save({ maxParallelTransfers: 4 });

		expect((stub.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
		expect(store.settings?.maxParallelTransfers).toBe(4);
	});
});
