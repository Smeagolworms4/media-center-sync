import type { Pinia } from 'pinia';
import { Caller, type CallerOptions } from '@/libs/caller/Caller';
import { SimpleObserver } from '@/libs/observer';

const callers: Record<string, { factory: (pinia: Pinia) => Caller, instance?: Caller }> = {};
const _startObserver = new SimpleObserver();
const _beforeObserver = new SimpleObserver();
const _errorObserver = new SimpleObserver();
const _successObserver = new SimpleObserver();
const _completeObserver = new SimpleObserver();

export function registerCaller(name: string, factory: (pinia: Pinia) => Caller): void {
	callers[name] = { factory }
}

export function getCaller(name: string, pinia: Pinia): Caller {
	const entry = callers[name]
	if (!entry) {
		throw new Error(`Caller "${name}" is not registered`)
	}
	if (!entry.instance) {
		entry.instance = entry.factory(pinia)
		entry.instance.startObserver.subscribe((event: any) => _startObserver.trigger(event));
		entry.instance.beforeObserver.subscribe((event: any) => _beforeObserver.trigger(event));
		entry.instance.successObserver.subscribe((event: any) => _successObserver.trigger(event));
		entry.instance.errorObserver.subscribe((event: any) => _errorObserver.trigger(event));
		entry.instance.completeObserver.subscribe((event: any) => _completeObserver.trigger(event));
	}
	return entry.instance
}


export function subscribeCallerStartObserver(cb: (event: { url: string, options: CallerOptions }) => void): () => void {
	const s = _startObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerBeforeObserver(cb: (event: { url: string, options: CallerOptions }) => void): () => void {
	const s = _beforeObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerSuccessObserver(cb: (event: { url: string, options: CallerOptions, result: any }) => void): () => void {
	const s = _successObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerErrorObserver(cb: (error: any) => void): () => void {
	const s = _errorObserver.subscribe(cb);
	return () => s.unsubscribe();
}

export function subscribeCallerCompleteObserver(cb: () => void): () => void {
	const s = _completeObserver.subscribe(cb);
	return () => s.unsubscribe();
}
