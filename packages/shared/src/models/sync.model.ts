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
	/** What this plan covers. See `SyncScope` for why it is not left to the filter. */
	scope: SyncScope;
	filter: SyncFilter;
	/**
	 * A ceiling on one run, so a schedule cannot run away.
	 *
	 * This is not the same thing as the scope being small. A scope that was three
	 * episodes in January is a season by June, and a schedule nobody is watching will
	 * happily start it at four in the morning. Null means no ceiling, which is a
	 * choice somebody has to make rather than the default.
	 */
	maxItemsPerRun: number | null;
	maxBytesPerRun: number | null;
	/**
	 * What the scope currently comes to. Recomputed, never trusted from storage.
	 *
	 * Null when it has not been worked out yet, which the interface shows as such —
	 * an estimate of zero and an estimate nobody has taken are different answers.
	 */
	estimate: SyncEstimate | null;
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * What a sync covers — stated, never implied.
 *
 * A schedule that says only "synchronise" is a schedule nobody dares enable, because
 * the honest reading of it is "move an entire media library", and that is measured in
 * terabytes. So the scope is a first-class part of a plan rather than something
 * reconstructed from a filter: it is what the plan screen prints in words, what the
 * estimate below is computed from, and what somebody reads six months later when they
 * wonder why the disk filled up on a Sunday night.
 *
 * The fields narrow, and an empty scope is deliberately not "everything" — see
 * `unbounded` on the estimate. They combine as an intersection of the ones that are
 * set: naming both a category and a subtree means the part of that subtree in that
 * category, which is the reading somebody filling a form expects.
 */
export interface SyncScope {
	/**
	 * Merged categories, which is the unit people actually think in.
	 *
	 * "Keep my Shows in step" is one intent, and naming the four libraries called
	 * Shows across three servers is not the same thing — it stops being true the
	 * moment somebody adds a fourth server.
	 */
	categoryKeys?: string[];
	/** Exactly one library, for the cases where which server holds it is the point. */
	libraryIds?: string[];
	/**
	 * Subtrees: a show, a season, a collection.
	 *
	 * Plural because "these three shows" is an ordinary standing intent, and one plan
	 * per show is three schedules to keep in step.
	 */
	rootItemIds?: string[];
	/** A named handful. Mostly a one-off, but a plan may pin a watchlist this way. */
	itemIds?: string[];
}

/**
 * What a scope currently comes to, so nobody enables a plan blind.
 *
 * Recomputed rather than stored against the plan for long: a library grows, a friend
 * links a server, and a number from last month would be worse than none — it would be
 * believed.
 */
export interface SyncEstimate {
	itemCount: number;
	bytes: number;
	/**
	 * The scope names nothing, so it means every item on every source.
	 *
	 * Kept as its own flag rather than left to be inferred from a large count,
	 * because the interface refuses to enable an unbounded schedule without an
	 * explicit acknowledgement and a cap — and "large" is not a decidable test.
	 */
	unbounded: boolean;
	/** The count is a floor: the scope was larger than the walk was allowed to go. */
	truncated: boolean;
	computedAt: string;
}

/** How a destination's free space compares with what would be written into it. */
export enum SpaceVerdict {
	/** It fits, with the reserve still intact afterwards. */
	FITS = 'fits',
	/** It fits, but eats into the reserve. Allowed, and said out loud. */
	TIGHT = 'tight',
	/** It does not fit. The run is refused rather than started and abandoned. */
	INSUFFICIENT = 'insufficient',
	/** No local path, or the path could not be probed. Never read as "fits". */
	UNKNOWN = 'unknown',
}

/**
 * One destination, what it has, and what this would put in it.
 *
 * Filling a disk is not an error that reports itself: the transfer fails at ninety
 * per cent with `ENOSPC`, the media server has a truncated file it will happily index,
 * and the person finds out days later. Both numbers are known before a byte moves —
 * every source announces its size and every library is probed for free space — so the
 * only reason not to compare them is that nobody wrote the comparison down.
 */
export interface TargetSpace {
	libraryId: string;
	libraryName: string;
	localPath: string | null;
	/** What the filesystem reports, or null when there is nothing to probe. */
	freeBytes: number | null;
	/** What this plan or run would write here. */
	requiredBytes: number;
	/** Free minus required, which is the number worth showing. */
	remainingBytes: number | null;
	/** The floor the gateway will not knowingly cross. From the settings. */
	reserveBytes: number;
	verdict: SpaceVerdict;
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
	scope?: SyncScope;
	filter?: SyncFilter;
	maxItemsPerRun?: number | null;
	maxBytesPerRun?: number | null;
	enabled?: boolean;
	/**
	 * Enable a plan whose scope names nothing, knowingly.
	 *
	 * Refused without it, because "synchronise everything, every night" is almost
	 * never what somebody meant to build and always what an empty form produces.
	 */
	acknowledgeUnbounded?: boolean;
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
	/** The scope it actually ran with, kept so a finished job can still explain itself. */
	scope: SyncScope;
	/** Where it wrote, and how much room was left. Recorded at planning time. */
	targets: TargetSpace[];
	/** Set when a ceiling or the free space stopped it short of its own scope. */
	stoppedBy: SyncStopReason | null;
	error: string | null;
	createdAt: string;
}

/** Why a job planned less than its scope, or stopped before finishing it. */
export enum SyncStopReason {
	MAX_ITEMS = 'max_items',
	MAX_BYTES = 'max_bytes',
	/** A destination could not take it. The run is refused, not half-done. */
	NOT_ENOUGH_SPACE = 'not_enough_space',
	CANCELLED = 'cancelled',
}

/**
 * One line of a running job, so a progress bar can be opened.
 *
 * A job that reports "412 of 900" and nothing else is a number to watch, not
 * something to act on: the two questions anybody actually has are which one is stuck
 * and where it is being written, and neither is answerable from a total. Each line
 * carries its own transfer, so opening a progress reaches the bytes.
 */
export interface SyncJobItem {
	id: string;
	jobId: string;
	itemId: string;
	title: string;
	kind: string;
	sourceServiceId: string;
	sourceServiceName: string;
	targetLibraryId: string | null;
	/** Where it will land, resolved at planning time rather than at write time. */
	targetPath: string;
	bytes: number;
	bytesDone: number;
	state: SyncJobItemState;
	/** The transfer moving it, when one is running. Null while queued or skipped. */
	transferId: string | null;
	/** An `ErrorKey`, never a sentence. */
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export enum SyncJobItemState {
	PENDING = 'pending',
	RUNNING = 'running',
	DONE = 'done',
	FAILED = 'failed',
	/** Planned, then dropped: a ceiling, no room, or it arrived some other way. */
	SKIPPED = 'skipped',
}

/** What a plan would do, without doing it. The interface shows this before running. */
export interface SyncPreview {
	itemsPlanned: number;
	bytesPlanned: number;
	/** What was asked for, echoed back, so the preview can be read on its own. */
	scope: SyncScope;
	/**
	 * Every destination this would write into, with the room left after it.
	 *
	 * The reason a preview exists at all: "12.4 GB into a library with 3.1 GB free"
	 * is the sentence somebody needs before pressing run, and neither half of it is
	 * visible from the item list.
	 */
	targets: TargetSpace[];
	/** Set when a ceiling or a destination cut the plan short of its scope. */
	stoppedBy: SyncStopReason | null;
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
	scope?: SyncScope;
	sourceServiceIds?: string[];
	targetLibraryId?: string | null;
	filter?: SyncFilter;
	maxItemsPerRun?: number | null;
	maxBytesPerRun?: number | null;
	/**
	 * Start it although a destination is tight or cannot be probed.
	 *
	 * Never lets an `INSUFFICIENT` verdict through: that one is arithmetic, and
	 * starting anyway buys a truncated file the media server will index as real.
	 */
	acknowledgeSpace?: boolean;
}
