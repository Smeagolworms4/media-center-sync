import type { EventNameValue } from '@mcs/shared';
import { getCurrentScope, onScopeDispose } from 'vue';
import { type EventHandler, useEventsStore } from '@/stores/events';

/**
 * Subscribing to the gateway's event stream from a component or a store.
 *
 * Nothing here opens a socket — `stores/events` owns the only one. What this adds
 * is the half everybody forgets: unsubscribing. A handler left behind by an
 * unmounted component keeps writing into refs nobody renders, and on a screen
 * that receives progress frames several times a second that leak is visible
 * within minutes.
 */
export function useEvents () {
	const eventsStore = useEventsStore();
	const disposers: (() => void)[] = [];

	function on<K extends EventNameValue> (event: K, handler: EventHandler<K>): () => void {
		const off = eventsStore.on(event, handler);
		disposers.push(off);
		return off;
	}

	function offAll (): void {
		while (disposers.length > 0) {
			disposers.pop()?.();
		}
	}

	if (getCurrentScope()) {
		onScopeDispose(offAll);
	}

	return {
		on,
		offAll,
		connected: () => eventsStore.connected,
		store: eventsStore,
	};
}
