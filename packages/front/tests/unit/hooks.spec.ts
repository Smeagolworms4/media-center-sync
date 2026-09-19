import { EventName } from '@mcs/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { cachePromise } from '@/hooks/cachePromise';
import { useAppInit } from '@/hooks/useAppInit';
import { useDebounce } from '@/hooks/useDebounce';
import { useEvents } from '@/hooks/useEvents';
import { useInterval } from '@/hooks/useInterval';
import { useIsMounted } from '@/hooks/useIsMounted';
import { useLoading } from '@/hooks/useLoading';
import { useNativeEvent } from '@/hooks/useNativeEvent';
import { useNotifier } from '@/hooks/useNotifier';
import { useToken, useTokenIsValid } from '@/hooks/useToken';
import { AbortCallerException } from '@/libs/caller';
import { useEventsStore } from '@/stores/events';
import { useLoaderStore } from '@/stores/loader';
import { useNotifierStore } from '@/stores/notifier';
import { useTokenStore } from '@/stores/token';
import { createStoreContext, mountWithApp, stubFetch } from './helpers';

function pair (overrides: Record<string, unknown> = {}) {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		user: { id: 'u1', username: 'ada' },
		rights: [],
		...overrides,
	};
}

describe('useDebounce', () => {
	it('runs only the last call but answers every caller', async () => {
		vi.useFakeTimers();
		const inner = vi.fn(async (value: string) => value.toUpperCase());
		const search = useDebounce(inner, 100);

		const calls = [search('a'), search('ab'), search('abc')];
		await vi.advanceTimersByTimeAsync(100);

		expect(inner).toHaveBeenCalledTimes(1);
		expect(inner).toHaveBeenCalledWith('abc');
		expect(await Promise.all(calls)).toEqual(['ABC', 'ABC', 'ABC']);
	});

	it('rejects every caller when the last call fails', async () => {
		vi.useFakeTimers();
		const search = useDebounce(async () => {
			throw new Error('nope');
		}, 10);

		const first = search().catch((error: Error) => error.message);
		const second = search().catch((error: Error) => error.message);
		await vi.advanceTimersByTimeAsync(10);

		expect(await first).toBe('nope');
		expect(await second).toBe('nope');
	});
});

describe('cachePromise', () => {
	it('shares one in-flight promise between callers', async () => {
		const inner = vi.fn(async () => 'value');
		const once = cachePromise(inner, true);

		const results = await Promise.all([once('k'), once('k'), once('k')]);

		expect(inner).toHaveBeenCalledTimes(1);
		expect(results).toEqual(['value', 'value', 'value']);
	});

	it('allows a new call once the previous one is done, when told to', async () => {
		const inner = vi.fn(async () => 'value');
		const once = cachePromise(inner, true);

		await once('k');
		await once('k');

		expect(inner).toHaveBeenCalledTimes(2);
	});

	it('keeps the result forever when not told to clear', async () => {
		const inner = vi.fn(async () => 'value');
		const cached = cachePromise(inner, false, {});

		await cached('k');
		await cached('k');

		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe('useInterval and useNativeEvent', () => {
	it('starts on mount and stops on unmount', async () => {
		vi.useFakeTimers();
		const tick = vi.fn();
		const Harness = defineComponent({
			setup () {
				useInterval(tick, 50);
				return () => null;
			},
		});

		const { wrapper } = mountWithApp(Harness);
		vi.advanceTimersByTime(120);
		expect(tick).toHaveBeenCalledTimes(2);

		wrapper.unmount();
		vi.advanceTimersByTime(200);
		expect(tick).toHaveBeenCalledTimes(2);
	});

	it('binds a native listener and releases it on unmount', async () => {
		const handler = vi.fn();
		const Harness = defineComponent({
			setup () {
				useNativeEvent(window, 'resize', handler);
				return () => null;
			},
		});

		const { wrapper } = mountWithApp(Harness);
		window.dispatchEvent(new Event('resize'));
		expect(handler).toHaveBeenCalledTimes(1);

		wrapper.unmount();
		window.dispatchEvent(new Event('resize'));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('follows a target held in a ref', async () => {
		const handler = vi.fn();
		const target = ref<EventTarget | null>(null);
		const Harness = defineComponent({
			setup () {
				useNativeEvent(target, 'click', handler);
				return () => null;
			},
		});

		mountWithApp(Harness);
		const button = document.createElement('button');
		target.value = button;
		await nextTick();

		button.dispatchEvent(new Event('click'));
		expect(handler).toHaveBeenCalledTimes(1);
	});
});

describe('useNotifier', () => {
	beforeEach(() => {
		createStoreContext();
	});

	it('translates the key it is given', async () => {
		vi.useFakeTimers();
		const { notify } = useNotifier();

		void notify('error.general', 'error');

		expect(useNotifierStore().notifies[0].message).toBe('Something went wrong. Try again in a moment.');
		await vi.advanceTimersByTimeAsync(5000);
	});

	it('turns a failure into a toast instead of an unhandled rejection', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const onError = vi.fn();
		const { tryCallback } = useNotifier();

		await tryCallback(() => {
			throw new Error('boom');
		}, { onError })();

		expect(onError).toHaveBeenCalled();
		expect(useNotifierStore().notifies).toHaveLength(1);
	});

	it('says nothing about a call the interface cancelled itself', async () => {
		const { tryCallback } = useNotifier();

		await tryCallback(() => {
			throw new AbortCallerException();
		})();

		expect(useNotifierStore().notifies).toHaveLength(0);
	});

	it('runs the completion hook whatever happened', async () => {
		const onComplete = vi.fn();
		const { tryCallback } = useNotifier();

		expect(await tryCallback(async () => 'ok', { onComplete })()).toBe('ok');
		expect(onComplete).toHaveBeenCalled();
	});
});

describe('useLoading and useToken', () => {
	it('mirror the stores they read', () => {
		const Harness = defineComponent({
			setup () {
				return { loading: useLoading(), token: useToken(), valid: useTokenIsValid() };
			},
			render: () => null,
		});

		const { wrapper, pinia } = mountWithApp<any>(Harness);
		expect(wrapper.vm.loading).toBe(false);
		expect(wrapper.vm.token).toBeNull();

		useLoaderStore(pinia).start();
		useTokenStore(pinia).store(pair() as never);

		expect(wrapper.vm.loading).toBe(true);
		expect(wrapper.vm.token?.accessToken).toBe('access-1');
		expect(wrapper.vm.valid).toBe(true);
	});
});

describe('useIsMounted', () => {
	it('runs the logged hooks once a session exists', async () => {
		const onLoggedSpy = vi.fn();
		const Harness = defineComponent({
			setup () {
				const { isMounted, onLogged } = useIsMounted();
				onLogged(onLoggedSpy);
				return { isMounted };
			},
			render: () => null,
		});

		const { wrapper, pinia } = mountWithApp<any>(Harness);
		// The mount hook awaits its callbacks, so the flag lands a microtask later.
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
		expect(wrapper.vm.isMounted).toBe(true);
		expect(onLoggedSpy).not.toHaveBeenCalled();

		useTokenStore(pinia).store(pair() as never);
		await nextTick();

		expect(onLoggedSpy).toHaveBeenCalled();
	});
});

describe('useEvents', () => {
	it('unsubscribes everything when the scope is disposed', () => {
		const handler = vi.fn();
		const Harness = defineComponent({
			setup () {
				const { on } = useEvents();
				on(EventName.QUEUE_STATS, handler);
				return () => null;
			},
		});

		const { wrapper, pinia } = mountWithApp(Harness);
		const eventsStore = useEventsStore(pinia);

		wrapper.unmount();

		// Nothing to dispatch to: the component that asked for it is gone.
		expect(eventsStore.connected).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});

describe('useAppInit', () => {
	beforeEach(() => {
		createStoreContext();
		vi.stubGlobal('WebSocket', class {
			addEventListener () {} close () {}
		} as unknown as typeof WebSocket);
	});

	it('resolves with no session rather than blocking the sign-in page', async () => {
		// The boot asks one public question — whether this gateway has been claimed —
		// and nothing else: the sign-in page must not wait behind a restore that was
		// always going to fail.
		stubFetch([{ body: { required: false, version: '1.2.3' } }]);
		const Harness = defineComponent({
			setup () {
				return useAppInit();
			},
			render: () => null,
		});
		const { wrapper } = mountWithApp<any>(Harness);

		await wrapper.vm.init();

		expect(wrapper.vm.ready).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('loads the settings and opens the stream once a session is restored', async () => {
		const Harness = defineComponent({
			setup () {
				return useAppInit();
			},
			render: () => null,
		});
		const { wrapper, pinia } = mountWithApp<any>(Harness);
		useTokenStore(pinia).store(pair() as never);
		const stub = stubFetch([{ body: { maxParallelTransfers: 2 } }]);

		await wrapper.vm.init();

		expect(stub.mock.calls[0][0]).toBe('/api/settings');
		expect(wrapper.vm.ready).toBe(true);
		expect(useEventsStore(pinia).state).toBe('connecting');
	});

	it('still resolves when the settings cannot be read', async () => {
		const Harness = defineComponent({
			setup () {
				return useAppInit();
			},
			render: () => null,
		});
		const { wrapper, pinia } = mountWithApp<any>(Harness);
		useTokenStore(pinia).store(pair() as never);
		stubFetch([{ status: 500, body: { statusCode: 500, message: 'error.general' } }]);

		await wrapper.vm.init();

		expect(wrapper.vm.ready).toBe(true);
		expect(wrapper.vm.error).toBeTruthy();
	});
});
