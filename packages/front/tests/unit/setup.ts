import ResizeObserver from 'resize-observer-polyfill';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Vuetify measures its own components, and jsdom implements none of the APIs it
 * uses for that. Without these stubs half the library throws on mount and the
 * failures point at the component under test rather than at the environment.
 */
globalThis.ResizeObserver ??= ResizeObserver as unknown as typeof globalThis.ResizeObserver;

if (!globalThis.matchMedia) {
	globalThis.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof globalThis.matchMedia;
}

if (!globalThis.visualViewport) {
	Object.defineProperty(globalThis, 'visualViewport', {
		value: {
			width: 1280,
			height: 800,
			scale: 1,
			addEventListener: () => {},
			removeEventListener: () => {},
		},
		configurable: true,
	});
}

// jsdom has no layout, so it implements neither of these; components that keep a
// list scrolled to the top call them on every update.
Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

globalThis.CSS ??= {} as typeof globalThis.CSS;
globalThis.CSS.supports ??= () => false;

beforeEach(() => {
	// Every suite starts from an empty browser: a token left behind by one test
	// silently authenticates the next one, and that failure is very hard to read.
	window.localStorage.clear();
	window.sessionStorage.clear();
	// Nothing in a unit test may reach the network. A test that needs a call stubs
	// it explicitly; anything else fails loudly instead of hanging.
	globalThis.fetch = vi.fn(() => Promise.reject(new Error('unexpected fetch'))) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
