import { ErrorKey, TransferTransport as TransportKind } from '@mcs/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HandlerRegistry } from '../handlers/handler.registry';
import type { ByteRange, ServiceConnection } from '../handlers/media-handler.interface';
import { Transport } from './transport.decorator';
import type {
	ByteTransport,
	TransferSourceRef,
	TransportCapabilities,
	TransportChunk,
	TransportFetchOptions,
} from './transport.interface';

/**
 * How many connections one media server is asked to serve at once.
 *
 * Four is the ceiling the transport imposes before the settings cap applies, and it
 * is a politeness limit rather than a technical one: the source is somebody's media
 * server, very possibly transcoding for somebody watching television, and a
 * gateway that opens sixteen sockets to pull a season faster is a gateway that gets
 * switched off.
 */
const MAX_CONNECTIONS = 4;

/**
 * Ranged HTTP against a media service.
 *
 * The ordinary case, and the one that has to degrade well. A server that ignores
 * `Range` is not rare — a reverse proxy in front of Jellyfin, a Plex behind a
 * transcoding URL — and the failure it causes is silent and total: every parallel
 * connection receives the whole file from byte zero and writes it at a different
 * offset. So the capability is probed before anything is written, and a source that
 * cannot serve ranges is driven by one sequential connection instead, with the cost
 * stated plainly: no parallelism, and no resume after a restart.
 */
@Injectable()
@Transport(TransportKind.HTTP_RANGE)
export class HttpRangeTransport implements ByteTransport {
	public readonly transport = TransportKind.HTTP_RANGE;

	private readonly _logger = new Logger(HttpRangeTransport.name);

	public constructor(private readonly _handlers: HandlerRegistry) {}

	public async prepare(
		source: TransferSourceRef,
		signal?: AbortSignal,
	): Promise<TransportCapabilities> {
		const connection = this._connection(source);
		const handler = this._handlers.get(connection.type);

		// One tiny ranged request rather than a `HEAD`: plenty of servers answer a
		// `HEAD` with `Accept-Ranges: bytes` out of habit and then ignore the header on
		// the real request. Asking for two bytes and looking at the status is the only
		// answer that is worth anything.
		const probe = await handler.openStream(
			connection,
			{ externalId: source.externalId },
			{ start: 0, end: 1 },
		);

		// The body is never read; destroying it releases the socket instead of leaving
		// the server streaming a file into a buffer nobody drains.
		probe.stream.destroy();

		if (!probe.acceptsRanges) {
			this._logger.warn(
				`${source.serviceName} ignores byte ranges: this transfer runs on a single connection and cannot be resumed after a restart`,
			);
		}

		void signal;

		return {
			resumable: probe.acceptsRanges,
			totalBytes: probe.totalLength ?? source.sizeHint ?? null,
			maxConnections: probe.acceptsRanges ? MAX_CONNECTIONS : 1,
			// A media server has no idea what pieces we cut the file into, so there is
			// nothing to verify against until the whole file is hashed.
			pieceChecksums: null,
		};
	}

	public async fetch(
		source: TransferSourceRef,
		range: ByteRange,
		options: TransportFetchOptions = {},
	): Promise<TransportChunk> {
		const connection = this._connection(source);
		const handler = this._handlers.get(connection.type);
		const answer = await handler.openStream(
			connection,
			{ externalId: source.externalId },
			range,
		);

		void options.signal;

		// Reported rather than worked around. The engine decides what to do with a
		// whole-file answer — for the first chunk it can simply keep reading, for any
		// other it has to give up on parallelism — and hiding it here would mean
		// writing the file's head into the middle of itself.
		return {
			stream: answer.stream,
			wholeFile: !answer.acceptsRanges,
			length: answer.contentLength,
		};
	}

	private _connection(source: TransferSourceRef): ServiceConnection {
		if (!source.connection) {
			throw new BadRequestException({
				key: ErrorKey.SERVICE_NOT_FOUND,
				detail: `no connection for source ${source.serviceId}`,
			});
		}

		return source.connection;
	}
}
