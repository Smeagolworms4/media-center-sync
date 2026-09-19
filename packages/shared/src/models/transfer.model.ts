/**
 * How the bytes travel.
 *
 * All three end up writing the same file in the same place; they differ in how the
 * connection is obtained and how many peers feed it.
 */
export enum TransferTransport {
	/** Ranged HTTP against the source service. One host, several connections. */
	HTTP_RANGE = 'http_range',
	/** Direct link to a peer's gateway, negotiated through the rendezvous. */
	PEER_DIRECT = 'peer_direct',
	/** Relayed through the rendezvous when no direct link can be established. */
	PEER_RELAY = 'peer_relay',
	/**
	 * Encapsulated BitTorrent. Several peers holding the same file feed the same
	 * transfer, which is what makes a friend-of-a-friend's bandwidth usable.
	 */
	SWARM = 'swarm',
}

export enum TransferState {
	QUEUED = 'queued',
	CONNECTING = 'connecting',
	DOWNLOADING = 'downloading',
	PAUSED = 'paused',
	/** Checksum being compared before the file is moved into the library. */
	VERIFYING = 'verifying',
	/** Moving the finished file to its final path and writing the metadata. */
	PLACING = 'placing',
	DONE = 'done',
	FAILED = 'failed',
	CANCELLED = 'cancelled',
}

export enum ChunkState {
	PENDING = 'pending',
	ACTIVE = 'active',
	DONE = 'done',
	FAILED = 'failed',
}

/** One host feeding a transfer. A transfer can have several at once. */
export interface TransferSource {
	serviceId: string;
	serviceName: string;
	peerId: string | null;
	peerName: string | null;
	transport: TransferTransport;
	/** Bytes per second measured over the last window. */
	rate: number;
	bytesDone: number;
	connections: number;
	healthy: boolean;
}

export interface TransferChunk {
	index: number;
	start: number;
	end: number;
	state: ChunkState;
	bytesDone: number;
	sourceServiceId: string | null;
	attempts: number;
}

export interface Transfer {
	id: string;
	jobId: string | null;
	itemId: string;
	title: string;
	kind: string;
	state: TransferState;
	targetPath: string;
	bytesTotal: number;
	bytesDone: number;
	/** Aggregated over every source. */
	rate: number;
	etaSeconds: number | null;
	sources: TransferSource[];
	chunkSize: number;
	chunksTotal: number;
	chunksDone: number;
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The compact shape pushed on the progress stream, many times a second. */
export interface TransferProgress {
	id: string;
	state: TransferState;
	bytesDone: number;
	bytesTotal: number;
	rate: number;
	etaSeconds: number | null;
	chunksDone: number;
	chunksTotal: number;
	sourceCount: number;
}

export interface TransferQueueStats {
	active: number;
	queued: number;
	paused: number;
	failed: number;
	/** Sum of the rates of every running transfer. */
	rate: number;
	bytesRemaining: number;
}
