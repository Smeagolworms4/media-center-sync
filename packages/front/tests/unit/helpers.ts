import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia, setActivePinia } from 'pinia';
import { type App, type Component, createApp } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import FormMainError from '@/components/FormMainError.vue';
import { vForm } from '@/composables/vForm';
import granted from '@/plugins/granted';
import installI18n from '@/plugins/i18n';
import piniaExtra from '@/plugins/piniaExtra';
import validators from '@/plugins/validators';
import { createAppVuetify } from '@/plugins/vuetify';
import { routes } from '@/router';
import { useEventsStore } from '@/stores/events';

import '@/libs/caller/callers';

export interface TestContext {
	pinia: Pinia;
	router: Router;
	install: (app: App) => void;
}

/**
 * The same plugin wiring `plugins/index.ts` performs, over a memory history.
 *
 * Tests mount against the real plugins rather than stubs so that a component
 * breaking against Vuetify, the router or the translation catalogue fails here
 * and not only in a browser.
 */
export function createTestContext (): TestContext {
	const pinia = createPinia();
	const router = createRouter({ history: createMemoryHistory(), routes });
	const vuetify = createAppVuetify();

	const install = (app: App): void => {
		app.use(pinia);
		const i18n = installI18n(app);
		app.use(piniaExtra, { pinia, router, i18n });
		app.use(router);
		app.use(vuetify);
		app.use(validators);
		app.use(granted, { pinia, router });
		app.directive('form', vForm);
		app.component('FormMainError', FormMainError);
	};

	return { pinia, router, install };
}

/**
 * An application with every plugin installed but nothing mounted, for testing
 * stores. Mounting would start the router, which would load a page component and
 * pull half of Vuetify into a test that only wanted a store.
 */
export function createStoreContext (): TestContext & { app: App } {
	const context = createTestContext();
	const app = createApp({ render: () => null });
	context.install(app);
	setActivePinia(context.pinia);
	return { ...context, app };
}

export interface MountResult<T> {
	wrapper: VueWrapper<T>;
	pinia: Pinia;
	router: Router;
}

export function mountWithApp<T> (
	component: Component,
	options: Record<string, any> = {},
): MountResult<T> {
	const context = createTestContext();
	const { global: globalOptions = {}, ...rest } = options;

	const wrapper = mount(component as any, {
		...rest,
		global: {
			...globalOptions,
			plugins: [{ install: context.install }, ...(globalOptions.plugins ?? [])],
			stubs: { teleport: true, ...globalOptions.stubs },
		},
	}) as VueWrapper<T>;

	setActivePinia(context.pinia);

	return { wrapper, pinia: context.pinia, router: context.router };
}

/**
 * A `v-tooltip` that renders both of its slots.
 *
 * The real one only builds its content once it is opened, which no unit test can
 * do meaningfully; stubbing it is the only way to assert on what a tooltip says.
 */
export const tooltipStub = {
	VTooltip: {
		props: ['text'],
		template: '<div class="tooltip-stub"><slot name="activator" :props="{}" /><slot>{{ text }}</slot></div>',
	},
};

/**
 * A `v-dialog` that renders its content inline.
 *
 * The real one only builds its body once an overlay is open and attached, which
 * jsdom cannot lay out; stubbing it keeps the assertions on our own markup.
 */
export const dialogStub = {
	VDialog: { template: '<div class="dialog-stub"><slot /></div>' },
};

/** A `fetch` that answers one queued response per call, in order. */
export function stubFetch (
	responses: { status?: number; body?: unknown; ok?: boolean }[],
): ReturnType<typeof vi.fn> {
	const queue = [...responses];
	const stub = vi.fn(() => {
		const next = queue.shift() ?? { status: 200, body: null };
		const status = next.status ?? 200;
		return Promise.resolve(new Response(
			next.body === undefined || next.body === null ? '' : JSON.stringify(next.body),
			{ status, headers: { 'Content-Type': 'application/json' } },
		));
	});
	globalThis.fetch = stub as unknown as typeof fetch;
	return stub;
}

/**
 * A WebSocket that never connects to anything.
 *
 * The stores reconcile their lists from the event stream, and that behaviour is
 * only testable if a frame can be pushed on demand. Every suite that emits one
 * installs this, opens the store's connection, and calls `emitServerEvent`.
 */
export class FakeWebSocket {
	public static instances: FakeWebSocket[] = [];

	public readonly listeners: Record<string, ((event: any) => void)[]> = {};

	constructor (public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener (name: string, handler: (event: any) => void): void {
		(this.listeners[name] ??= []).push(handler);
	}

	close (): void {
		this.emit('close', {});
	}

	emit (name: string, event: any): void {
		for (const handler of this.listeners[name] ?? []) {
			handler(event);
		}
	}
}

/** Installs the fake socket and connects the events store. Returns nothing useful. */
export function connectFakeSocket (pinia: Pinia): void {
	FakeWebSocket.instances = [];
	vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
	useEventsStore(pinia).connect();
}

/** Pushes one frame to every open fake socket, as the gateway would. */
export function emitServerEvent (event: string, payload: unknown): void {
	for (const socket of FakeWebSocket.instances) {
		socket.emit('message', { data: JSON.stringify({ event, payload, at: new Date().toISOString() }) });
	}
}

/**
 * A `fetch` that answers by path rather than in order.
 *
 * A page fires several calls at once and the order they resolve in is an
 * implementation detail; keying the answers by path keeps a test about what the
 * page shows rather than about how many calls it happened to make first. The
 * longest matching key wins, so `/transfers/stats` can differ from `/transfers`.
 */
export function stubFetchRoutes (
	routeMap: Record<string, { status?: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
	// Longest first, so a specific path is preferred over the prefix it shares
	// with a broader one. `Object.keys` already hands back a fresh array.
	// eslint-disable-next-line unicorn/no-array-sort
	const keys = Object.keys(routeMap).sort((a, b) => b.length - a.length);
	const stub = vi.fn((input: any) => {
		const url = String(typeof input === 'string' ? input : input?.url ?? '');
		const key = keys.find(one => url.includes(one));
		const answer = key ? routeMap[key] : { status: 404, body: { message: 'error.general' } };
		const status = answer.status ?? 200;
		return Promise.resolve(new Response(
			answer.body === undefined || answer.body === null ? '' : JSON.stringify(answer.body),
			{ status, headers: { 'Content-Type': 'application/json' } },
		));
	});
	globalThis.fetch = stub as unknown as typeof fetch;
	return stub;
}
