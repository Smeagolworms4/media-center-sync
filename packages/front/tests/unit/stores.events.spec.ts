import { EventName, TransferState } from '@mcs/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventsStore } from '@/stores/events';
import { useTokenStore } from '@/stores/token';
import { createStoreContext } from './helpers';

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	public readonly listeners: Record<string, ((event: any) => void)[]> = {};
	public closed = false;

	constructor (public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener (name: string, handler: (event: any) => void): void {
		(this.listeners[name] ??= []).push(handler);
	}

	close (): void {
		this.closed = true;
		this.emit('close', {});
	}

	emit (name: string, event: any): void {
		for (const handler of this.listeners[name] ?? []) {
			handler(event);
		}
	}

	receive (payload: unknown): void {
		this.emit('message', { data: JSON.stringify(payload) });
	}
}

const progress = {
	id: 't1',
	state: TransferState.DOWNLOADING,
	bytesDone: 10,
	bytesTotal: 100,
	rate: 5,
	etaSeconds: 18,
	chunksDone: 1,
	chunksTotal: 10,
	sourceCount: 2,
};

/**
 * Connecting asks the token store for a bearer before it opens anything, and that is a
 * promise: the socket exists one microtask later than the call that wanted it. Every
 * test here therefore lets the pending work run before looking.
 *
 * The refresh is the point of that indirection — a stream opened with the token as it
 * was stored is refused fifteen minutes after signing in, and the backoff then offers
 * the same expired token for ever.
 */
async function settled (): Promise<void> {
	// Microtasks and not a timer: half of these tests run on fake timers, where a real
	// `setTimeout` never fires and the test simply times out. Asking the token store is
	// a promise that resolves without waiting for anything, so letting the queue drain
	// a few times is exactly enough.
	for (let tick = 0; tick < 4; tick += 1) {
		await Promise.resolve();
	}
}

describe('stores/events', () => {
	beforeEach(() => {
		createStoreContext();
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
	});

	it('opens one socket on /api/events and carries the bearer', async () => {
		useTokenStore().store({
			accessToken: 'access-1', refreshToken: 'r', expiresIn: 900, user: {}, rights: [],
		} as never);
		const eventsStore = useEventsStore();

		eventsStore.connect();
		await settled();

		expect(FakeWebSocket.instances).toHaveLength(1);
		const url = new URL(FakeWebSocket.instances[0].url);
		expect(url.protocol).toBe('ws:');
		expect(url.pathname).toBe('/api/events');
		expect(url.searchParams.get('token')).toBe('access-1');
		expect(eventsStore.state).toBe('connecting');
	});

	it('reports itself connected once the socket opens', async () => {
		const eventsStore = useEventsStore();
		eventsStore.connect();
		await settled();

		FakeWebSocket.instances[0].emit('open', {});

		expect(eventsStore.connected).toBe(true);
		expect(eventsStore.state).toBe('open');
	});

	it('fans a frame out to the handlers of that event only', async () => {
		const eventsStore = useEventsStore();
		const onProgress = vi.fn();
		const onQueue = vi.fn();
		eventsStore.on(EventName.TRANSFER_PROGRESS, onProgress);
		eventsStore.on(EventName.QUEUE_STATS, onQueue);
		eventsStore.connect();
		await settled();

		FakeWebSocket.instances[0].receive({
			event: EventName.TRANSFER_PROGRESS,
			payload: [progress],
			at: '2026-09-19T10:00:00.000Z',
		});

		expect(onProgress).toHaveBeenCalledWith([progress]);
		expect(onQueue).not.toHaveBeenCalled();
		expect(eventsStore.lastEventAt).toBe('2026-09-19T10:00:00.000Z');
	});

	it('stops calling a handler once it unsubscribes', async () => {
		const eventsStore = useEventsStore();
		const handler = vi.fn();
		const off = eventsStore.on(EventName.QUEUE_STATS, handler);
		eventsStore.connect();
		await settled();

		off();
		FakeWebSocket.instances[0].receive({ event: EventName.QUEUE_STATS, payload: {}, at: 'now' });

		expect(handler).not.toHaveBeenCalled();
	});

	it('survives a frame it cannot parse', async () => {
		const eventsStore = useEventsStore();
		const handler = vi.fn();
		eventsStore.on(EventName.QUEUE_STATS, handler);
		eventsStore.connect();
		await settled();

		expect(() => FakeWebSocket.instances[0].emit('message', { data: 'not json' })).not.toThrow();
		expect(handler).not.toHaveBeenCalled();
	});

	it('survives a handler that throws, and still calls the others', async () => {
		const eventsStore = useEventsStore();
		const second = vi.fn();
		eventsStore.on(EventName.QUEUE_STATS, () => {
			throw new Error('boom');
		});
		eventsStore.on(EventName.QUEUE_STATS, second);
		eventsStore.connect();
		await settled();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		FakeWebSocket.instances[0].receive({ event: EventName.QUEUE_STATS, payload: {}, at: 'now' });

		expect(second).toHaveBeenCalled();
	});

	/*
	 * Fifteen minutes in, which is where this broke.
	 *
	 * The gateway checks the session on the handshake as it does on every request, so a
	 * stream opened with the token exactly as it was stored is refused — and the backoff
	 * then offered the same expired token again, for ever. Nothing reports it: the socket
	 * is not a screen, it is what makes the screens move, and what somebody sees is
	 * progress bars that stopped.
	 */
	it('renews an expired token before opening the stream', async () => {
		const tokenStore = useTokenStore();

		tokenStore.store({
			accessToken: 'stale', refreshToken: 'r', expiresIn: -60, user: {}, rights: [],
		} as never);
		globalThis.fetch = vi.fn(() => Promise.resolve(Response.json(
			{ accessToken: 'fresh', refreshToken: 'r2', expiresIn: 900, user: {}, rights: [] },
			{ status: 200 },
		))) as unknown as typeof fetch;

		const eventsStore = useEventsStore();

		eventsStore.connect();
		// The refresh is a call of its own, so this one waits for a task rather than for
		// a handful of microtasks.
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(new URL(FakeWebSocket.instances[0].url).searchParams.get('token')).toBe('fresh');
	});

	it('opens one socket even when two connections are asked for at once', async () => {
		// Asking the token store is a promise, and between the decision to open a socket
		// and the socket existing there is a window. Two sockets deliver every event
		// twice, which on a progress stream is a bar that jitters.
		useTokenStore().store({
			accessToken: 'access-1', refreshToken: 'r', expiresIn: 900, user: {}, rights: [],
		} as never);
		const eventsStore = useEventsStore();

		eventsStore.connect();
		eventsStore.connect();
		await settled();

		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('reconnects with a growing delay after a drop', async () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();
		await settled();

		FakeWebSocket.instances[0].emit('close', {});
		expect(eventsStore.attempts).toBe(1);
		vi.advanceTimersByTime(500);
		await settled();
		expect(FakeWebSocket.instances).toHaveLength(2);

		FakeWebSocket.instances[1].emit('close', {});
		expect(eventsStore.attempts).toBe(2);
		vi.advanceTimersByTime(999);
		await settled();
		expect(FakeWebSocket.instances).toHaveLength(2);
		vi.advanceTimersByTime(1);
		await settled();
		expect(FakeWebSocket.instances).toHaveLength(3);
	});

	it('resets the backoff once a connection succeeds', async () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();
		await settled();

		FakeWebSocket.instances[0].emit('close', {});
		vi.advanceTimersByTime(500);
		await settled();
		FakeWebSocket.instances[1].emit('open', {});

		expect(eventsStore.attempts).toBe(0);
	});

	it('does not reconnect after an explicit disconnect', async () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();
		await settled();

		eventsStore.disconnect();
		vi.advanceTimersByTime(60_000);
		await settled();

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(FakeWebSocket.instances[0].closed).toBe(true);
		expect(eventsStore.state).toBe('closed');
	});

	it('never opens a second socket for the same store', async () => {
		const eventsStore = useEventsStore();
		eventsStore.connect();
		await settled();
		eventsStore.connect();
		await settled();

		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});
