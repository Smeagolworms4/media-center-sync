import type { Readable } from 'node:stream';
import type { TransferTransport } from '@mcs/shared';
import type { ByteRange, ServiceConnection } from '../handlers/media-handler.interface';
import type { ContentHolder } from '../peer-catalogue.service';

/**
 * One host that can feed a transfer.
 *
 * Carries everything the transports need and nothing they should decide: which
 * source to prefer, how many to run at once and when to give up on one are the
 * engine's business. A source is a way to get bytes, not a choice.
 */
export interface TransferSourceRef {
	serviceId: string;
	serviceName: string;
	peerId: string | null;
	peerName?: string | null;
	transport: TransferTransport;
	/** Set for a service we reach over HTTP ourselves. */
	connection?: ServiceConnection;
	/** Identifier of the item inside that service. */
	externalId: string;
	/** Swarm identifier, which is how peers advertise what they hold. */
	contentId?: string | null;
	/** Expected size, so a transport can tell a truncated answer from a short one. */
	sizeHint?: number | null;
	/**
	 * Everybody known to hold this file, for the swarm.
	 *
	 * Resolved above the transport because who counts as a usable peer is a policy
	 * question — friends only, or friends of friends too — and policy does not belong
	 * in something whose job is moving bytes.
	 */
	holders?: ContentHolder[];
}

/**
 * What a source turns out to be capable of, once asked.
 *
 * `resumable` is the one that changes behaviour rather than reporting: a source
 * that cannot serve ranges has to be driven by a single sequential connection, and
 * a transfer against it cannot be paused and picked up later. The engine says so on
 * screen instead of discovering it after a restart.
 */
export interface TransportCapabilities {
	resumable: boolean;
	totalBytes: number | null;
	/** Ceiling this transport imposes, before the settings cap is applied. */
	maxConnections: number;
	/**
	 * Per-piece hashes, when the far end can produce them.
	 *
	 * Their absence is why whole-file verification exists at all: without them a bad
	 * byte is only found at the end, and nothing says which piece to fetch again.
	 */
	pieceChecksums?: ReadonlyMap<number, string> | null;
	/**
	 * How many bytes each of those hashes was computed over.
	 *
	 * Load-bearing rather than informational, and it has to travel with the hashes:
	 * they are indexed by piece number, the piece number is a function of the far
	 * end's chunk size, and our own chunk size is a local setting. Applying piece
	 * seventeen's hash to our chunk seventeen when the two sides cut the file
	 * differently does not fail loudly — it condemns a piece that arrived perfectly
	 * well, and sends the transfer into repair passes it can never win.
	 */
	pieceSize?: number | null;
}

export interface TransportFetchOptions {
	signal?: AbortSignal;
	/** Index of the piece, for the transports that address pieces rather than bytes. */
	chunkIndex?: number;
}

export interface TransportChunk {
	stream: Readable;
	/**
	 * True when the transport could not honour the range and is sending from zero.
	 *
	 * The caller must then treat the stream as the whole file rather than as the
	 * piece it asked for. Writing it at the piece's offset is the failure mode this
	 * flag exists to make impossible.
	 */
	wholeFile: boolean;
	/** Bytes this response carries, when the far end said. */
	length: number | null;
}

/**
 * How bytes are obtained. Three ways, one contract.
 *
 * Each transport answers the same three questions — what can you do, give me this
 * range, let go — so the engine's scheduling, accounting and repair logic is
 * written once. A fourth way to move bytes is a fourth class and a line in the
 * providers list.
 */
export interface ByteTransport {
	readonly transport: TransferTransport;

	/** Cheap enough to call per transfer, not per chunk. */
	prepare(source: TransferSourceRef, signal?: AbortSignal): Promise<TransportCapabilities>;

	fetch(
		source: TransferSourceRef,
		range: ByteRange,
		options?: TransportFetchOptions,
	): Promise<TransportChunk>;

	/** Drop whatever was held for this source — a link, a peer set, a lock. */
	release?(source: TransferSourceRef): Promise<void>;
}
