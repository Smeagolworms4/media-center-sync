import type { Caller, CallerOptions } from '@/libs/caller/Caller';
import type { Pinia } from 'pinia';
import { SimpleObserver } from '@/libs/observer';

const factories: Record<string, (pinia: Pinia) => Caller> = {};

/**
 * One instance per named caller *per pinia*.
 *
 * A caller reads the session and the locale from stores, so it is bound to the
 * pinia it was built against. Caching by name alone would hand a second
 * application — and every test after the first — a caller still wired to the
 * first one's stores, which fails in the least obvious way possible: calls that
 * succeed, without a bearer.
 */
const instances = new WeakMap<Pinia, Record<string, Caller>>();

const _startObserver = new SimpleObserver();
const _beforeObserver = new SimpleObserver();
const _errorObserver = new SimpleObserver();
const _successObserver = new SimpleObserver();
const _completeObserver = new SimpleObserver();

export function registerCaller (name: string, factory: (pinia: Pinia) => Caller): void {
	factories[name] = factory;
}

export function getCaller (name: string, pinia: Pinia): Caller {
	const factory = factories[name];
	if (!factory) {
		throw new Error(`Caller "${name}" is not registered`);
	}

	const built = instances.get(pinia) ?? {};
	instances.set(pinia, built);

	if (!built[name]) {
		const caller = factory(pinia);
		caller.startObserver.subscribe((event: any) => _startObserver.trigger(event));
		caller.beforeObserver.subscribe((event: any) => _beforeObserver.trigger(event));
		caller.successObserver.subscribe((event: any) => _successObserver.trigger(event));
		caller.errorObserver.subscribe((event: any) => _errorObserver.trigger(event));
		caller.completeObserver.subscribe((event: any) => _completeObserver.trigger(event));
		built[name] = caller;
	}
	return built[name];
}

export function subscribeCallerStartObserver (cb: (event: { url: string; options: CallerOptions }) => void): () => void {
	const s = _startObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerBeforeObserver (cb: (event: { url: string; options: CallerOptions }) => void): () => void {
	const s = _beforeObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerSuccessObserver (cb: (event: { url: string; options: CallerOptions; result: any }) => void): () => void {
	const s = _successObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerErrorObserver (cb: (error: any) => void): () => void {
	const s = _errorObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerCompleteObserver (cb: () => void): () => void {
	const s = _completeObserver.subscribe(cb);
	return () => s.unsubscribe();
}
