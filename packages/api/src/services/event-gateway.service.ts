import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
	EventName,
	type EventNameValue,
	type EventPayloads,
	type ServerEvent,
	type TransferProgress,
} from '@mcs/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';

/** Where the interface connects. */
export const EVENTS_PATH = '/api/events';

/**
 * How often batched progress is flushed.
 *
 * Half a second is below what anybody perceives as lag on a progress bar and far
 * above the rate at which chunks complete. The alternative — a frame per chunk —
 * means a single transfer at forty megabytes a second sending five frames a second
 * per connection, times four connections, times three transfers, to every open tab:
 * sixty frames a second of JSON for a bar that moves one pixel. The interface
 * reconciles by identifier, so batching costs nothing and a missed frame costs
 * nothing either.
 */
export const PROGRESS_FLUSH_MS = 500;

/**
 * Pushes what the gateway is doing to every open interface.
 *
 * Progress is pushed and never polled: a transfer moves several times a second, and
 * asking for it on a timer either lags visibly or hammers the API for answers that
 * have not changed. Everything else on the stream — a service going offline, a job
 * finishing — is rare enough to send as it happens.
 */
@Injectable()
export class EventGatewayService implements OnModuleDestroy {
	private readonly _logger = new Logger(EventGatewayService.name);
	private readonly _server: WebSocketServer;
	private readonly _clients = new Set<WebSocket>();

	/**
	 * Progress waiting to be sent, one entry per transfer.
	 *
	 * A map rather than a list, keyed by transfer: only the latest state of each
	 * matters, so a transfer that reported forty times in half a second is sent once.
	 */
	private readonly _pendingProgress = new Map<string, TransferProgress>();

	private _flushTimer: NodeJS.Timeout | null = null;

	public constructor() {
		// `noServer` because the gateway already has an HTTP server and the interface
		// is served from the same origin: a second listening port would need its own
		// certificate, its own firewall rule and its own reverse-proxy entry.
		this._server = new WebSocketServer({ noServer: true });
	}

	/**
	 * Wire the upgrade handler onto the application's HTTP server.
	 *
	 * Called from the bootstrap once Nest has created the server. Anything else on
	 * another path is left alone rather than rejected, so a second gateway — the peer
	 * link's own endpoint — can share the port.
	 */
	public attach(server: Server): void {
		server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			const { pathname } = new URL(request.url ?? '/', 'http://localhost');

			if (pathname !== EVENTS_PATH) {
				return;
			}

			this._server.handleUpgrade(request, socket, head, (client) => {
				this._register(client);
			});
		});

		this._logger.log(`Event stream listening on ${EVENTS_PATH}`);
	}

	/** Anything that is not progress: a state change, a status, a job. */
	public emit<K extends EventNameValue>(event: K, payload: EventPayloads[K]): void {
		this._send({ event, payload, at: new Date().toISOString() } as ServerEvent);
	}

	/**
	 * Report a transfer's progress. Coalesced, then sent as one frame.
	 *
	 * Deliberately not an `emit` overload: the batching is the point, and a caller
	 * that could choose to bypass it would, on the day the bar looked sluggish.
	 */
	public publishProgress(progress: TransferProgress): void {
		this._pendingProgress.set(progress.id, progress);

		if (this._flushTimer) {
			return;
		}

		this._flushTimer = setTimeout(() => this._flush(), PROGRESS_FLUSH_MS);
		this._flushTimer.unref?.();
	}

	/** Sends whatever is pending immediately — on a state change worth seeing at once. */
	public flushProgress(): void {
		this._flush();
	}

	public get clientCount(): number {
		return this._clients.size;
	}

	public onModuleDestroy(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = null;
		}

		for (const client of this._clients) {
			client.close();
		}

		this._clients.clear();
		this._server.close();
	}

	private _register(client: WebSocket): void {
		this._clients.add(client);

		client.on('close', () => this._clients.delete(client));
		client.on('error', () => this._clients.delete(client));

		// Nothing is replayed on connect. The interface asks the REST API for the
		// current state when it opens a screen and then follows the stream, which is
		// the only arrangement where a missed frame cannot leave it permanently wrong.
	}

	private _flush(): void {
		this._flushTimer = null;

		if (this._pendingProgress.size === 0) {
			return;
		}

		const payload = [...this._pendingProgress.values()];

		this._pendingProgress.clear();
		this._send({
			event: EventName.TRANSFER_PROGRESS,
			payload,
			at: new Date().toISOString(),
		} as ServerEvent);
	}

	private _send(event: ServerEvent): void {
		if (this._clients.size === 0) {
			return;
		}

		// Serialised once for every client rather than per client: with six tabs open
		// this is six times less JSON encoding, twice a second, forever.
		const frame = JSON.stringify(event);

		for (const client of this._clients) {
			if (client.readyState !== WebSocket.OPEN) {
				continue;
			}

			try {
				client.send(frame);
			} catch (error) {
				// A client that cannot be written to is gone; dropping it here stops the
				// set from growing with sockets nobody closed properly.
				this._logger.debug(`Dropping an event client: ${String(error)}`);
				this._clients.delete(client);
			}
		}
	}
}
