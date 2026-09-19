/**
 * What the icon next to a media item means.
 *
 * This is the single vocabulary the whole interface uses — a list, a series page
 * and a season row all render the same seven states, so that a glance means the
 * same thing everywhere.
 */
export enum SyncState {
	/** Present here and nowhere else we know of. */
	LOCAL_ONLY = 'local_only',
	/** Known on another service, missing here. This is what a sync fills in. */
	MISSING = 'missing',
	/** Present on both sides, same version. */
	IN_SYNC = 'in_sync',
	/** Present here, but a better version exists elsewhere. */
	OUTDATED = 'outdated',
	/** Two versions that cannot be ordered — different cuts, different languages. */
	CONFLICT = 'conflict',
	/** A transfer is running for this item. */
	SYNCING = 'syncing',
	/** Not correlated yet. */
	UNKNOWN = 'unknown',
}

/** How two items were matched. Kept so a wrong match can be explained and undone. */
export enum MatchStrategy {
	CHECKSUM = 'checksum',
	EXTERNAL_ID = 'external_id',
	SEASON_EPISODE = 'season_episode',
	NORMALIZED_TITLE = 'normalized_title',
	PATH = 'path',
	MANUAL = 'manual',
}

/** One correlation between an item we hold and the same item on another service. */
export interface MediaMatch {
	id: string;
	localItemId: string | null;
	remoteItemId: string;
	remoteServiceId: string;
	remotePeerId: string | null;
	strategy: MatchStrategy;
	/** 0 to 1. Below the settings threshold the match is proposed, not applied. */
	confidence: number;
	state: SyncState;
	/** Why the remote version wins, when it does. */
	reason: string | null;
	confirmedAt: string | null;
	createdAt: string;
}

export enum SyncTrigger {
	MANUAL = 'manual',
	SCHEDULE = 'schedule',
	/** Runs whenever a source announces something new that matches the filter. */
	ON_NEW = 'on_new',
}

export enum SyncJobState {
	PENDING = 'pending',
	RUNNING = 'running',
	PAUSED = 'paused',
	DONE = 'done',
	FAILED = 'failed',
	CANCELLED = 'cancelled',
}

/**
 * A standing intent: what to pull, from where, to where.
 *
 * `sourceServiceIds` is ordered. Left empty, the plan follows the service priority
 * set in the administration screen — which is what most people want, and what the
 * interface shows as "default order".
 */
export interface SyncPlan {
	id: string;
	name: string;
	enabled: boolean;
	trigger: SyncTrigger;
	/** Cron expression, when the trigger is a schedule. */
	schedule: string | null;
	sourceServiceIds: string[];
	/** Where the media lands. Empty means: next to our own copy, or the default. */
	targetLibraryId: string | null;
	/** Restrict to a subtree — one series, one collection. */
	rootItemId: string | null;
	filter: SyncFilter;
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SyncFilter {
	kinds?: string[];
	/** Only pull what is missing, never replace an existing file. */
	missingOnly?: boolean;
	/** Also replace a local file when the remote one is better. */
	replaceOutdated?: boolean;
	minYear?: number;
	maxBytes?: number;
	titleMatches?: string;
}

export interface CreateSyncPlanRequest {
	name: string;
	trigger: SyncTrigger;
	schedule?: string | null;
	sourceServiceIds?: string[];
	targetLibraryId?: string | null;
	rootItemId?: string | null;
	filter?: SyncFilter;
	enabled?: boolean;
}

export type UpdateSyncPlanRequest = Partial<CreateSyncPlanRequest>;

/** One execution. A plan has many; a manual run has one with no plan behind it. */
export interface SyncJob {
	id: string;
	planId: string | null;
	planName: string | null;
	state: SyncJobState;
	trigger: SyncTrigger;
	startedAt: string | null;
	finishedAt: string | null;
	itemsPlanned: number;
	itemsDone: number;
	itemsFailed: number;
	bytesPlanned: number;
	bytesDone: number;
	error: string | null;
	createdAt: string;
}

/** What a plan would do, without doing it. The interface shows this before running. */
export interface SyncPreview {
	itemsPlanned: number;
	bytesPlanned: number;
	items: {
		itemId: string;
		title: string;
		kind: string;
		sourceServiceId: string;
		sourceServiceName: string;
		targetPath: string;
		bytes: number;
		state: SyncState;
	}[];
}

/** Ask for a one-off sync of a subtree or a handful of items. */
export interface RunSyncRequest {
	planId?: string;
	itemIds?: string[];
	rootItemId?: string;
	sourceServiceIds?: string[];
	targetLibraryId?: string | null;
	filter?: SyncFilter;
}
