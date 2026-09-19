import type { MediaFileInfo } from './media.model';

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
	/**
	 * Re-fetching only the pieces that failed verification.
	 *
	 * A transfer that fails its checksum is almost never wrong everywhere: one source
	 * served a bad range, or a connection dropped mid-piece. Throwing away thirty
	 * gigabytes because two megabytes are wrong is what makes people give up on a
	 * sync — so the pieces are verified individually and only the bad ones come back,
	 * preferably from a different source.
	 */
	REPAIRING = 'repairing',
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
	/** The source failed or dropped. Retried, possibly against another source. */
	FAILED = 'failed',
	/** Arrived complete but did not match its hash. Re-fetched from elsewhere. */
	CORRUPT = 'corrupt',
}

/**
 * Why a transfer stopped.
 *
 * Kept apart from the message because the interface acts on it: a missing source
 * offers "look for another one", a full disk offers "choose another library, and
 * neither is a retry button that will fail the same way.
 */
export enum TransferErrorKind {
	SOURCE_GONE = 'source_gone',
	SOURCE_UNAUTHORIZED = 'source_unauthorized',
	NETWORK = 'network',
	CHECKSUM_MISMATCH = 'checksum_mismatch',
	DISK_FULL = 'disk_full',
	PERMISSION_DENIED = 'permission_denied',
	TARGET_MISSING = 'target_missing',
	CANCELLED = 'cancelled',
	UNKNOWN = 'unknown',
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
	/**
	 * Expected SHA-256 of this piece, when the source could tell us one.
	 *
	 * Without it a bad byte is only discovered at the end, on the whole-file hash,
	 * and nothing says which part to fetch again. With it, verification is local to
	 * the piece and repair is a few megabytes.
	 */
	checksum: string | null;
}

export interface Transfer {
	id: string;
	jobId: string | null;
	itemId: string;
	/**
	 * Swarm identifier of the file being pulled. Peers advertise what they hold by
	 * this value, so a transfer can pick up sources nobody told it about.
	 */
	contentId: string | null;
	title: string;
	/**
	 * The item's kind, resolved when the transfer is created.
	 *
	 * It is not on the transfer row: the item already carries it, and a copy would
	 * be one more thing to keep in step. The manager fills it on the way out.
	 */
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
	/** Error key, for the message. */
	error: string | null;
	/** What kind of failure it was, for what the interface offers to do about it. */
	errorKind: TransferErrorKind | null;
	/** Pieces re-fetched since the transfer started, across every repair pass. */
	chunksRepaired: number;
	lastVerifiedAt: string | null;
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

/**
 * What a verification pass found.
 *
 * Also produced by a rescan of the destination: a file that was fine on arrival can
 * be truncated later by a full disk or a half-written move, and the gateway is the
 * only thing that still knows what it should contain.
 */
export interface TransferVerification {
	transferId: string;
	ok: boolean;
	chunksChecked: number;
	chunksCorrupt: number;
	/** Bytes that have to come back. Compare with `bytesTotal` before repairing. */
	bytesToRepair: number;
	checkedAt: string;
}

/**
 * What the far end says when we ask it to check itself.
 *
 * A failed range is ambiguous from here: the file may have been moved by a library
 * cleanup, re-encoded overnight, deleted, or served badly by a flaky disk. Guessing
 * costs either a pointless re-download or a source dropped for nothing — so we ask.
 * The remote gateway re-reads that one item, answers with what it actually holds
 * now, and only then do we decide.
 */
export enum RevalidationOutcome {
	/** Still held, same fingerprint. Their copy is fine, so ours is the broken one. */
	CONFIRMED = 'confirmed',
	/** Same content at a new path — a library reorganisation. Resume against it. */
	MOVED = 'moved',
	/** Different fingerprint: it was re-encoded. This is another version now. */
	CHANGED = 'changed',
	/** No longer there. Drop this source and look for another. */
	GONE = 'gone',
	/** No answer. Nothing is decided; the transfer waits and asks again later. */
	UNREACHABLE = 'unreachable',
}

/** What we do once the far end has answered. */
export enum RevalidationAction {
	/** Continue where we stopped; the source is good. */
	RESUME = 'resume',
	/** Our own file is wrong: re-fetch the failing pieces. */
	REPAIR_LOCAL = 'repair_local',
	/** Follow the file to its new path. */
	FOLLOW_MOVE = 'follow_move',
	/** Start over against another source holding the version we asked for. */
	SWITCH_SOURCE = 'switch_source',
	/** Put it back in the queue and try again later. */
	REQUEUE = 'requeue',
	/** Nothing holds it any more. The item goes back to missing. */
	ABANDON = 'abandon',
}

export interface Revalidation {
	id: string;
	transferId: string;
	sourceServiceId: string;
	sourceServiceName: string;
	/** What made us ask. */
	cause: TransferErrorKind;
	requestedAt: string;
	answeredAt: string | null;
	outcome: RevalidationOutcome | null;
	/** What the far end reports holding now — null when it reports nothing. */
	remoteFile: MediaFileInfo | null;
	action: RevalidationAction | null;
	note: string | null;
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
