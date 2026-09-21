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
	/** Direct link to a peer's gateway, dialled or reached after an introduction. */
	PEER_DIRECT = 'peer_direct',
	/**
	 * Carried by the friend who introduced the two ends, when neither can be dialled.
	 *
	 * Their upload, not ours and not the far end's, which is why it is the last rung
	 * of the ladder and never a first choice.
	 */
	PEER_RELAY = 'peer_relay',
	/**
	 * Encapsulated BitTorrent. Several peers holding the same file feed the same
	 * transfer, which is what makes a friend-of-a-friend's bandwidth usable.
	 */
	SWARM = 'swarm',
}

/**
 * Which step of the placement rule decided where a file went.
 *
 * Recorded because three of these mean nobody chose: the file is not lost, the
 * transfer did not fail, and nothing anywhere would ever say a word — the library
 * simply grows a folder somebody did not plan, and it is found months later. A
 * screen can only offer to file those properly if it can tell them from the ones
 * that landed where they were meant to.
 *
 * Three separate values say "somebody decided", and they are not interchangeable
 * because the thing to do about each is different. A plan's preference is a standing
 * decision and the place to change it is the plan; a one-off run's request died with
 * that run; a file moved by hand is a correction somebody made to this file alone and
 * the rules underneath it were not touched. Folding them into one value would make
 * "why is this here" unanswerable on exactly the files somebody went out of their way
 * to place.
 */
export enum PlacedBy {
	/** The run said so, for this run only. */
	REQUESTED = 'requested',
	/**
	 * The plan's standing preferred library.
	 *
	 * Distinct from `REQUESTED` because it outlives the run: the next run of the same
	 * plan will decide the same way, and the plan is where somebody changes it.
	 */
	PLAN_PREFERENCE = 'plan_preference',
	/**
	 * Somebody sent this one file here, on the queue screen.
	 *
	 * A correction to this file and to nothing else — no rule was learned, no setting
	 * changed — which is exactly why it must not read as `PLAN_PREFERENCE`: the next
	 * episode of the same show will still go wherever the rules send it.
	 */
	CHOSEN_BY_HAND = 'chosen_by_hand',
	/** Beside our own copies of the same show. The rule that always wins. */
	EXISTING_COPY = 'existing_copy',
	/** The library the category names. */
	CATEGORY = 'category',
	/** The global destination library. Nobody named this category. */
	DEFAULT_LIBRARY = 'default_library',
	/** The fixed path, while that setting still exists. */
	FIXED_PATH = 'fixed_path',
	/** The fallback folder. Nobody named this category and there is no default. */
	FALLBACK_PATH = 'fallback_path',
	/** Whatever could take it. Nothing above answered, and the file had to land. */
	ANY_WRITABLE = 'any_writable',
}

/**
 * The steps that mean nobody chose, and which a screen offers to correct.
 *
 * Kept beside the enum rather than spelled out in each caller: the interface, the
 * notifier and the dashboard all ask the same question, and three copies of this
 * list would disagree the day a step is added.
 */
export const UNCONFIGURED_PLACEMENTS: PlacedBy[] = [
	PlacedBy.DEFAULT_LIBRARY,
	PlacedBy.FALLBACK_PATH,
	PlacedBy.ANY_WRITABLE,
];

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

/**
 * The states a transfer never leaves again.
 *
 * One list, read by the retention, by the list filter and by the queue screen, so
 * that "finished" means the same thing in all three. `PAUSED` is deliberately not
 * here: somebody stopped it and it will move again when they say so, which is exactly
 * the row that must never be cleaned up or hidden as history.
 */
export const FINISHED_TRANSFER_STATES: TransferState[] = [
	TransferState.DONE,
	TransferState.FAILED,
	TransferState.CANCELLED,
];

/**
 * The finished states that carry information nobody else has.
 *
 * A success leaves the file in the library, which says everything the row said. A
 * failure or a cancellation leaves nothing at all — the row is the only record that
 * the file was ever attempted — which is why retention gives these two their own,
 * longer window.
 */
export const KEPT_LONGER_TRANSFER_STATES: TransferState[] = [
	TransferState.FAILED,
	TransferState.CANCELLED,
];

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
	/**
	 * Stopped by the gateway because the service it was coming from was removed.
	 *
	 * Not `CANCELLED`, which says somebody pressed cancel on this transfer: they
	 * removed a service, and a queue reporting that they stopped a download they never
	 * touched sends them looking for a mistake they did not make. Not a failure
	 * either — nothing went wrong, the source was taken away on purpose.
	 */
	SERVICE_REMOVED = 'service_removed',
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
	/**
	 * The library that path belongs to, or null for a folder no service indexes.
	 *
	 * Carried beside the path because a path alone cannot be turned back into a
	 * library: two libraries can nest, a fallback folder belongs to none of them, and
	 * the interface has to name where a file went before it can offer to move it.
	 */
	targetLibraryId: string | null;
	/**
	 * Which step of the placement rule chose that path.
	 *
	 * Null only on rows written before this was recorded. Everything else in the
	 * application reads it through `UNCONFIGURED_PLACEMENTS` rather than comparing
	 * against individual values.
	 */
	placedBy: PlacedBy | null;
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

/**
 * One file that landed on a step nobody configured, and what could be done about it.
 *
 * Assembled rather than stored: the category a library belongs to is a merge of
 * library names that changes when somebody renames a shelf, so a name frozen into a
 * transfer row would go on naming a category that no longer exists. The transfer
 * carries the decision; the names are resolved when somebody looks.
 */
export interface UnconfiguredPlacement {
	transferId: string;
	itemId: string;
	title: string;
	kind: string;
	state: TransferState;
	/** Where it went, or where it is going — see `state`. */
	targetPath: string;
	targetLibraryId: string | null;
	/** Null for a fallback folder, which belongs to no library by definition. */
	targetLibraryName: string | null;
	placedBy: PlacedBy;
	/**
	 * The category whose destination is unset, which is the thing to go and fix.
	 *
	 * Null when the item's own library belongs to no category at all: there is then
	 * nothing to configure per category, and the answer is the global destination.
	 */
	categoryKey: string | null;
	categoryName: string | null;
	/** When it landed, or when it was queued while it still has not. */
	placedAt: string;
}

/** Sending a transfer somewhere else, before it lands or after. */
export interface ChangeDestinationRequest {
	/**
	 * A library, never a path.
	 *
	 * A library is a directory this gateway has probed for write access and one of our
	 * own media servers is known to scan. A raw path is a string somebody typed, and a
	 * file written where no server ever looks is the failure this whole area exists to
	 * prevent — it reports success and produces nothing.
	 */
	libraryId: string;
}
