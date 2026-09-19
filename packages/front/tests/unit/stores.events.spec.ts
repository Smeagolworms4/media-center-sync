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

describe('stores/events', () => {
	beforeEach(() => {
		createStoreContext();
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
	});

	it('opens one socket on /api/events and carries the bearer', () => {
		useTokenStore().store({
			accessToken: 'access-1', refreshToken: 'r', expiresIn: 900, user: {}, rights: [],
		} as never);
		const eventsStore = useEventsStore();

		eventsStore.connect();

		expect(FakeWebSocket.instances).toHaveLength(1);
		const url = new URL(FakeWebSocket.instances[0].url);
		expect(url.protocol).toBe('ws:');
		expect(url.pathname).toBe('/api/events');
		expect(url.searchParams.get('token')).toBe('access-1');
		expect(eventsStore.state).toBe('connecting');
	});

	it('reports itself connected once the socket opens', () => {
		const eventsStore = useEventsStore();
		eventsStore.connect();

		FakeWebSocket.instances[0].emit('open', {});

		expect(eventsStore.connected).toBe(true);
		expect(eventsStore.state).toBe('open');
	});

	it('fans a frame out to the handlers of that event only', () => {
		const eventsStore = useEventsStore();
		const onProgress = vi.fn();
		const onQueue = vi.fn();
		eventsStore.on(EventName.TRANSFER_PROGRESS, onProgress);
		eventsStore.on(EventName.QUEUE_STATS, onQueue);
		eventsStore.connect();

		FakeWebSocket.instances[0].receive({
			event: EventName.TRANSFER_PROGRESS,
			payload: [progress],
			at: '2026-09-19T10:00:00.000Z',
		});

		expect(onProgress).toHaveBeenCalledWith([progress]);
		expect(onQueue).not.toHaveBeenCalled();
		expect(eventsStore.lastEventAt).toBe('2026-09-19T10:00:00.000Z');
	});

	it('stops calling a handler once it unsubscribes', () => {
		const eventsStore = useEventsStore();
		const handler = vi.fn();
		const off = eventsStore.on(EventName.QUEUE_STATS, handler);
		eventsStore.connect();

		off();
		FakeWebSocket.instances[0].receive({ event: EventName.QUEUE_STATS, payload: {}, at: 'now' });

		expect(handler).not.toHaveBeenCalled();
	});

	it('survives a frame it cannot parse', () => {
		const eventsStore = useEventsStore();
		const handler = vi.fn();
		eventsStore.on(EventName.QUEUE_STATS, handler);
		eventsStore.connect();

		expect(() => FakeWebSocket.instances[0].emit('message', { data: 'not json' })).not.toThrow();
		expect(handler).not.toHaveBeenCalled();
	});

	it('survives a handler that throws, and still calls the others', () => {
		const eventsStore = useEventsStore();
		const second = vi.fn();
		eventsStore.on(EventName.QUEUE_STATS, () => {
			throw new Error('boom');
		});
		eventsStore.on(EventName.QUEUE_STATS, second);
		eventsStore.connect();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		FakeWebSocket.instances[0].receive({ event: EventName.QUEUE_STATS, payload: {}, at: 'now' });

		expect(second).toHaveBeenCalled();
	});

	it('reconnects with a growing delay after a drop', () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();

		FakeWebSocket.instances[0].emit('close', {});
		expect(eventsStore.attempts).toBe(1);
		vi.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(2);

		FakeWebSocket.instances[1].emit('close', {});
		expect(eventsStore.attempts).toBe(2);
		vi.advanceTimersByTime(999);
		expect(FakeWebSocket.instances).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(FakeWebSocket.instances).toHaveLength(3);
	});

	it('resets the backoff once a connection succeeds', () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();

		FakeWebSocket.instances[0].emit('close', {});
		vi.advanceTimersByTime(500);
		FakeWebSocket.instances[1].emit('open', {});

		expect(eventsStore.attempts).toBe(0);
	});

	it('does not reconnect after an explicit disconnect', () => {
		vi.useFakeTimers();
		const eventsStore = useEventsStore();
		eventsStore.connect();

		eventsStore.disconnect();
		vi.advanceTimersByTime(60_000);

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(FakeWebSocket.instances[0].closed).toBe(true);
		expect(eventsStore.state).toBe('closed');
	});

	it('never opens a second socket for the same store', () => {
		const eventsStore = useEventsStore();
		eventsStore.connect();
		eventsStore.connect();

		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});
