import type { Peer } from './peer.model';
import type { ReleaseGrab } from './release.model';
import type { MediaService } from './service.model';
import type { MediaLandingState, SyncJob } from './sync.model';
import type {
	Revalidation,
	Transfer,
	TransferProgress,
	TransferQueueStats,
	TransferVerification,
} from './transfer.model';

/**
 * What the gateway pushes to open interfaces.
 *
 * Progress is pushed, never polled: a transfer moves several times a second, and
 * asking for it on a timer would either lag visibly or hammer the API for nothing.
 * The interface reconciles by identifier, so a missed frame costs nothing.
 */
export const EventName = {
	TRANSFER_PROGRESS: 'transfer.progress',
	TRANSFER_STATE: 'transfer.state',
	QUEUE_STATS: 'queue.stats',
	JOB_STATE: 'job.state',
	SERVICE_STATUS: 'service.status',
	/**
	 * A service was registered, edited or removed — by anybody, from anywhere.
	 *
	 * It carries the identifier and nothing else, on purpose: every connected session
	 * receives it, and a registration's name and address are for whoever may list the
	 * services. A session that holds the list asks the API again, which applies the
	 * rights. Without it, a server registered in another tab showed on every open plan
	 * as a raw identifier until somebody reloaded the page.
	 */
	SERVICE_CHANGED: 'service.changed',
	PEER_STATUS: 'peer.status',
	SCAN_PROGRESS: 'scan.progress',
	/**
	 * A verification pass finished, with what it found.
	 *
	 * Separate from the transfer state because the answer is interesting even when
	 * the state does not change: a file that verifies clean tells you the source was
	 * fine and the problem is elsewhere, and that is invisible if the only signal is
	 * the transfer going back to `done`.
	 */
	TRANSFER_VERIFIED: 'transfer.verified',
	/** The far end answered a revalidation, and what was decided as a result. */
	TRANSFER_REVALIDATED: 'transfer.revalidated',
	/**
	 * A grabbed release moved, or finished, or was filed.
	 *
	 * Its own event rather than `TRANSFER_PROGRESS`: a torrent is not one of our
	 * transfers — nothing about it has chunks, sources or a revalidation — and folding
	 * it in would put rows in the queue screen that half of that screen's buttons
	 * cannot act on.
	 */
	RELEASE_GRAB: 'release.grab',
	/**
	 * A file's landing changed, which is the one thing nothing else can announce.
	 *
	 * The state moves on a timer rather than in answer to anything anybody did: a file
	 * written to a disk no media server looks at is declared lost minutes after the last
	 * event on its transfer. Without this the queue learns it on the next reload, so the
	 * state that most needs to arrive on its own would be the only one that never does.
	 */
	TRANSFER_LANDING: 'transfer.landing',
	/**
	 * A row was taken off the queue, and every screen showing it has to drop it.
	 *
	 * Its own event because it is the one change no state can carry: a transfer that is
	 * gone cannot be announced as a transfer in some new state, and a queue that learnt it
	 * on the next reload would go on offering buttons for a row the gateway no longer has.
	 */
	TRANSFER_REMOVED: 'transfer.removed',
	/** A torrent was taken off the queue, and every screen showing it has to drop it. */
	RELEASE_GRAB_REMOVED: 'release.grab.removed',
	/**
	 * The catalogue's shared projections are being rebuilt, or have finished being.
	 *
	 * Sent so a screen can say so rather than freeze. The rebuild happens after a scan,
	 * away from anybody's request, and until it lands the answers are the previous ones —
	 * correct, just one pass behind. A spinner over a list that still works is honest;
	 * the alternative we shipped was a page that took nine seconds and looked broken.
	 */
	CACHE_STATE: 'cache.state',
	/**
	 * The catalogue changed underneath every open screen, and they should ask again.
	 *
	 * It carries a version and nothing else. The payload would have to be the whole
	 * catalogue to be useful — megabytes, to every tab, for a change that affects four
	 * rows — and a screen knows what it is showing far better than this does. So it says
	 * "what you have is stale" and each screen re-reads what it needs.
	 */
	CATALOGUE_CHANGED: 'catalogue.changed',
} as const;

export type EventNameValue = (typeof EventName)[keyof typeof EventName];

export interface ScanProgress {
	serviceId: string;
	libraryId: string | null;
	itemsSeen: number;
	itemsTotal: number | null;
	done: boolean;
}

export interface EventPayloads {
	[EventName.TRANSFER_PROGRESS]: TransferProgress[];
	[EventName.TRANSFER_STATE]: Transfer;
	[EventName.QUEUE_STATS]: TransferQueueStats;
	[EventName.JOB_STATE]: SyncJob;
	[EventName.SERVICE_STATUS]: Pick<MediaService, 'id' | 'status' | 'lastProbeAt'>;
	[EventName.SERVICE_CHANGED]: Pick<MediaService, 'id'>;
	[EventName.PEER_STATUS]: Pick<Peer, 'id' | 'status' | 'linkMode' | 'lastSeenAt'>;
	[EventName.SCAN_PROGRESS]: ScanProgress;
	[EventName.TRANSFER_VERIFIED]: TransferVerification;
	[EventName.TRANSFER_REMOVED]: { id: string };
	[EventName.RELEASE_GRAB_REMOVED]: { id: string };
	[EventName.TRANSFER_REVALIDATED]: Revalidation;
	[EventName.RELEASE_GRAB]: ReleaseGrab;
	[EventName.TRANSFER_LANDING]: { transferId: string; landing: MediaLandingState };
	[EventName.CACHE_STATE]: CacheState;
	[EventName.CATALOGUE_CHANGED]: { version: string };
}

/**
 * What the background refresh is doing, for whoever wants to draw it.
 *
 * `reason` is carried because the interface shows it: "analyse terminée" after a scan
 * and "réglage modifié" after the threshold moved are the same spinner to the code and
 * two different things to somebody watching it, and the second one is how you find out
 * a slider you touched is actually doing something.
 */
export interface CacheState {
	refreshing: boolean;
	reason: CacheRefreshReasonValue;
	startedAt: string | null;
	/** How long the pass that just ended took, in milliseconds. Null while one runs. */
	tookMs: number | null;
}

export const CacheRefreshReason = {
	SCAN: 'scan',
	SETTINGS: 'settings',
	MANUAL: 'manual',
	BOOT: 'boot',
} as const;

export type CacheRefreshReasonValue = (typeof CacheRefreshReason)[keyof typeof CacheRefreshReason];

export interface ServerEvent<K extends EventNameValue = EventNameValue> {
	event: K;
	payload: EventPayloads[K];
	at: string;
}
