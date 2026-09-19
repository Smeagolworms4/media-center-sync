import type { EventNameValue, EventPayloads, ServerEvent } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useTokenStore } from '@/stores/token';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export type EventHandler<K extends EventNameValue> = (payload: EventPayloads[K]) => void;

/** First retry is almost immediate; a gateway that is really down is asked once every half minute. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

function buildEventsUrl (token: string | null): string {
	const base = import.meta.env.VITE_API_BASE_URL ?? '';
	const origin = base || (typeof window === 'undefined' ? '' : window.location.origin);
	const url = new URL('/api/events', origin || 'http://localhost');
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	if (token) {
		// A browser cannot set a header on a WebSocket handshake, so the bearer
		// travels as a query parameter. It is the same short-lived access token the
		// calls carry, and the connection is over the same origin.
		url.searchParams.set('token', token);
	}
	return url.toString();
}

/**
 * The one connection to the gateway's event stream.
 *
 * Progress is pushed rather than polled on purpose. A transfer moves several
 * times a second across several sources; a timer fast enough to look live would
 * ask the API hundreds of times a minute for rows that mostly did not change,
 * and a timer slow enough to be polite would show bars that visibly lag the
 * download. Pushing also means the interface hears about a state change — a
 * source dropping, a repair starting — at the moment it happens rather than up
 * to one interval later.
 *
 * There is exactly one socket for the whole application: stores subscribe to it,
 * components subscribe to stores, and nothing else opens a connection. Ten open
 * panels therefore cost one connection, and every one of them sees the same
 * frame at the same time.
 */
export const useEventsStore = defineStore('events', () => {
	const tokenStore = useTokenStore();

	const state = ref<ConnectionState>('idle');
	const lastEventAt = ref<string | null>(null);
	const attempts = ref(0);

	const connected = computed(() => state.value === 'open');

	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let wanted = false;

	function dispatch (raw: string): void {
		let event: ServerEvent;
		try {
			event = JSON.parse(raw) as ServerEvent;
		} catch {
			// A frame we cannot read is a frame we skip; the stream is not transactional.
			return;
		}
		if (!event?.event) {
			return;
		}
		lastEventAt.value = event.at ?? new Date().toISOString();
		for (const handler of handlers.get(event.event) ?? []) {
			try {
				handler(event.payload);
			} catch (error) {
				// One bad subscriber must not take the others down with it.
				console.error(error);
			}
		}
	}

	function scheduleRetry (): void {
		if (!wanted || retryTimer) {
			return;
		}
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts.value);
		attempts.value += 1;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			open();
		}, delay);
	}

	function open (): void {
		if (typeof WebSocket === 'undefined' || socket) {
			return;
		}
		state.value = 'connecting';
		const next = new WebSocket(buildEventsUrl(tokenStore.accessToken));
		socket = next;

		next.addEventListener('open', () => {
			state.value = 'open';
			attempts.value = 0;
		});
		next.addEventListener('message', message => dispatch(String(message.data)));
		// No error listener on purpose: a socket error is always followed by a close,
		// and close is where reconnection is decided.
		next.addEventListener('close', () => {
			socket = null;
			state.value = wanted ? 'connecting' : 'closed';
			scheduleRetry();
		});
	}

	function connect (): void {
		wanted = true;
		open();
	}

	function disconnect (): void {
		wanted = false;
		attempts.value = 0;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		const current = socket;
		socket = null;
		state.value = 'closed';
		current?.close();
	}

	/** Returns the unsubscribe function, which is what makes this safe in a component. */
	function on<K extends EventNameValue> (event: K, handler: EventHandler<K>): () => void {
		const set = handlers.get(event) ?? new Set();
		handlers.set(event, set);
		set.add(handler as (payload: unknown) => void);
		return () => {
			set.delete(handler as (payload: unknown) => void);
		};
	}

	return {
		state,
		connected,
		attempts,
		lastEventAt,
		connect,
		disconnect,
		on,
	};
});
