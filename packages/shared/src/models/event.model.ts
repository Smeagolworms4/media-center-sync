import type { Peer } from './peer.model';
import type { MediaService } from './service.model';
import type { SyncJob } from './sync.model';
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
	[EventName.PEER_STATUS]: Pick<Peer, 'id' | 'status' | 'linkMode' | 'lastSeenAt'>;
	[EventName.SCAN_PROGRESS]: ScanProgress;
	[EventName.TRANSFER_VERIFIED]: TransferVerification;
	[EventName.TRANSFER_REVALIDATED]: Revalidation;
}

export interface ServerEvent<K extends EventNameValue = EventNameValue> {
	event: K;
	payload: EventPayloads[K];
	at: string;
}
