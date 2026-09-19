import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { EventName, TransferState, type ServerEvent } from '@mcs/shared';
import { WebSocket } from 'ws';
import { EVENTS_PATH, EventGatewayService, PROGRESS_FLUSH_MS } from './event-gateway.service';

function progress(id: string, bytesDone: number) {
	return {
		id,
		state: TransferState.DOWNLOADING,
		bytesDone,
		bytesTotal: 1_000,
		rate: 100,
		etaSeconds: 9,
		chunksDone: 1,
		chunksTotal: 10,
		sourceCount: 1,
	};
}

describe('EventGatewayService', () => {
	let server: Server;
	let gateway: EventGatewayService;
	let client: WebSocket;
	let received: ServerEvent[];

	beforeEach(async () => {
		gateway = new EventGatewayService();
		server = createServer();
		gateway.attach(server);

		await new Promise<void>((resolve) => server.listen(0, resolve));

		const { port } = server.address() as AddressInfo;

		received = [];
		client = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
		client.on('message', (data: Buffer) => {
			received.push(JSON.parse(data.toString('utf8')) as ServerEvent);
		});

		await new Promise<void>((resolve, reject) => {
			client.once('open', resolve);
			client.once('error', reject);
		});
	});

	afterEach(async () => {
		client.close();
		gateway.onModuleDestroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	/** Waits for frames to arrive without racing the event loop. */
	async function settle(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	it('accepts a client on the events path', () => {
		expect(gateway.clientCount).toBe(1);
	});

	it('pushes a state change as it happens', async () => {
		gateway.emit(EventName.SERVICE_STATUS, {
			id: 'service-1',
			status: 'online',
			lastProbeAt: null,
		} as never);

		await settle(50);

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			event: EventName.SERVICE_STATUS,
			payload: { id: 'service-1' },
		});
		expect(typeof received[0].at).toBe('string');
	});

	it('batches a burst of progress into one frame', async () => {
		// A frame per chunk means sixty frames a second of JSON to every open tab, for
		// a bar that moves one pixel.
		for (let index = 0; index < 20; index += 1) {
			gateway.publishProgress(progress('t1', index * 10));
		}

		await settle(PROGRESS_FLUSH_MS + 100);

		expect(received).toHaveLength(1);
		expect(received[0].event).toBe(EventName.TRANSFER_PROGRESS);
		expect(received[0].payload).toEqual([expect.objectContaining({ id: 't1', bytesDone: 190 })]);
	});

	it('carries every transfer in the same frame', async () => {
		gateway.publishProgress(progress('t1', 10));
		gateway.publishProgress(progress('t2', 20));

		await settle(PROGRESS_FLUSH_MS + 100);

		expect(received).toHaveLength(1);
		expect((received[0].payload as unknown[]).length).toBe(2);
	});

	it('sends immediately when something worth seeing at once happened', async () => {
		gateway.publishProgress(progress('t1', 10));
		gateway.flushProgress();

		await settle(50);

		expect(received).toHaveLength(1);
	});

	it('sends nothing when there is nothing pending', async () => {
		gateway.flushProgress();

		await settle(50);

		expect(received).toHaveLength(0);
	});

	it('replays nothing on connect', async () => {
		// The interface asks the REST API for the current state when it opens a screen
		// and then follows the stream; a replay would only ever be a second source of
		// truth to disagree with.
		await settle(50);

		expect(received).toHaveLength(0);
	});

	it('forgets a client that goes away', async () => {
		client.close();

		await settle(100);

		expect(gateway.clientCount).toBe(0);

		// And publishing afterwards must not throw.
		gateway.emit(EventName.QUEUE_STATS, {
			active: 0,
			queued: 0,
			paused: 0,
			failed: 0,
			rate: 0,
			bytesRemaining: 0,
		});
	});
});
