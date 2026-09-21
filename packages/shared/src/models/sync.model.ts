import type { PlacedBy } from './transfer.model';

/**
 * What the icon next to a media item means.
 *
 * This is the single vocabulary the whole interface uses — a list, a series page
 * and a season row all render the same states, so that a glance means the same
 * thing everywhere.
 */
export enum SyncState {
	/** Present here and nowhere else we know of. */
	LOCAL_ONLY = 'local_only',
	/** Known on another service, missing here. This is what a sync fills in. */
	MISSING = 'missing',
	/**
	 * The bytes are on our disk; the media server has not indexed them yet.
	 *
	 * Neither `missing` nor present, and both of those would be a lie in a way people
	 * act on. Calling it missing is the bug this state was added for: a pull finished,
	 * the file is in the right folder, and every screen still offered to fetch it again
	 * — so it was fetched again. Calling it present is the opposite mistake: nothing can
	 * be played, because the media server has no row for it and the interface that
	 * reads our index would be promising something the server cannot serve.
	 *
	 * It is transient by construction, and what ends it is our own scan finding a real
	 * item for that file. See `NOT_INDEXED` for what happens when that never comes.
	 */
	AWAITING_INDEX = 'awaiting_index',
	/**
	 * On our disk, and the media server never took it — long past the point where it
	 * should have.
	 *
	 * The terminal half of `AWAITING_INDEX`, and the reason that one is allowed to be
	 * bounded. Something is wrong and it is never the download: the library path the
	 * gateway writes into is not the directory the server scans, the server's scanner is
	 * off, or the file is in a form it refuses. None of that produces an error anywhere
	 * — the transfer succeeded — so it needs a state or it is invisible.
	 *
	 * Still not `missing`: pulling it again would land the same bytes in the same folder
	 * and change nothing. It clears if the server ever does index it, and if the file
	 * leaves the disk.
	 */
	NOT_INDEXED = 'not_indexed',
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

/**
 * The bytes are on our disk, whatever the index says about them.
 *
 * The one vocabulary for "there is nothing left to fetch here", read by the screens
 * that group media and by the planner that decides what a run pulls. Both have to
 * agree or the disagreement is visible: a media the library screen shows as
 * downloaded, offered for download again by every plan that covers it.
 */
export const LANDED_SYNC_STATES: SyncState[] = [
	SyncState.AWAITING_INDEX,
	SyncState.NOT_INDEXED,
];

/**
 * Where a file the gateway put on the disk has got to.
 *
 * Only two values, and neither of them is "indexed": a landing that has been indexed
 * has nothing left to say and its row is gone. Keeping a resolved row would mean every
 * reader having to remember to exclude it, and the media item the scan created is
 * already the record that the file arrived.
 */
export enum MediaLandingState {
	/** Written, announced to the media server, waiting for it to appear in a scan. */
	WAITING = 'waiting',
	/** The grace period ran out with nothing indexed. Surfaced, not forgotten. */
	STALE = 'stale',
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

/** The states a run never leaves again. The counterpart of `FINISHED_TRANSFER_STATES`. */
export const FINISHED_SYNC_JOB_STATES: SyncJobState[] = [
	SyncJobState.DONE,
	SyncJobState.FAILED,
	SyncJobState.CANCELLED,
];

/** A failed or cancelled run is why a series has a hole in it, so it is kept longer. */
export const KEPT_LONGER_SYNC_JOB_STATES: SyncJobState[] = [
	SyncJobState.FAILED,
	SyncJobState.CANCELLED,
];

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
	/**
	 * The library this plan would rather its files went to. A preference, not a target.
	 *
	 * It sits inside the placement rules and not above them: a series we already hold
	 * still keeps its own folder, because a season split across two shelves is worse
	 * than one landing somewhere unexpected. Everything the plan pulls that is genuinely
	 * new goes here, ahead of the category's library and the global default.
	 *
	 * It lives on the plan and not on a run because a run is one execution of a standing
	 * intent: a destination attached to a single run is a decision with nowhere to live
	 * afterwards, and the next run would quietly go back to the old place with nothing
	 * connecting the two. A one-off different destination is a re-pointed transfer.
	 *
	 * Null means the rules decide on their own, which is the ordinary case.
	 */
	preferredLibraryId: string | null;
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
	/** See `SyncPlan.preferredLibraryId`: a standing preference, refused if unwritable. */
	preferredLibraryId?: string | null;
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

/**
 * Create a plan from the media it is about, rather than from a blank form.
 *
 * The one thing somebody actually meant to say — *this show* — is the only field with
 * no default: `itemId` becomes `scope.rootItemIds`, and everything else below either
 * has a defensible default or is asked for at the moment of creation.
 *
 * `trigger` is deliberately required although a plan has one by default. A schedule
 * nobody chose is a gateway that starts downloading at four in the morning, and a
 * default buried in a request shape is exactly how that gets chosen for somebody.
 */
export interface CreateSyncPlanForItemRequest {
	/** The series, season or collection the plan is about. Becomes the scope. */
	itemId: string;
	trigger: SyncTrigger;
	/** Required when the trigger is a schedule: a plan with neither never runs. */
	schedule?: string | null;
	/**
	 * Left empty, which means "wherever it turns up".
	 *
	 * See `SyncPlan.sourceServiceIds`: a standing intent outlives the list of servers
	 * that happen to hold the show today, and pinning them turns a friend re-adding
	 * their server into a plan that quietly stops finding anything.
	 */
	sourceServiceIds?: string[];
	preferredLibraryId?: string | null;
	/** Defaults to `{ missingOnly: true }` — fill the holes, never replace a file. */
	filter?: SyncFilter;
	maxItemsPerRun?: number | null;
	maxBytesPerRun?: number | null;
	enabled?: boolean;
	/**
	 * Add this subtree to a plan that already exists instead of creating a second one.
	 *
	 * `SyncScope.rootItemIds` is plural for this: two plans covering the same show
	 * are two schedules pulling the same episodes into the same folder, and whichever
	 * loses the race finds the other's half-written file.
	 */
	extendPlanId?: string;
	/** Overrides the name derived from the media, which is what the interface offers. */
	name?: string;
}

/** A plan that already covers a media, and which node of the tree it names. */
export interface SyncPlanCoverage {
	plan: SyncPlan;
	/**
	 * The node the plan's scope actually names: the media itself, or an ancestor.
	 *
	 * A plan on a series covers every season under it, and somebody standing on the
	 * season has to be told *which* plan to go and edit — "already covered" without
	 * saying by what is a dead end.
	 */
	coveredItemId: string;
	/** False when what covers it is something above it, a series over a season. */
	exact: boolean;
}

/**
 * What the interface needs before offering to keep a media in sync.
 *
 * Answered by the gateway rather than worked out by the screen, because both halves
 * are rules and not display: which plans cover a media takes the parent chain, and
 * which plans may be extended takes the reading of a scope. A second implementation
 * of either would disagree with this one the first time a scope grew a field.
 */
export interface ItemSyncPlans {
	/** The name a plan created from this media would take, so the field can show it. */
	suggestedName: string;
	covering: SyncPlanCoverage[];
	/**
	 * Plans this media could be added to.
	 *
	 * Only plans whose scope is subtrees and nothing else: adding a root to a plan that
	 * says "everything, nightly" would narrow it to one show, and adding one to a plan
	 * scoped by category would intersect the two. Both are silent changes of meaning to
	 * somebody else's plan, so they are refused rather than offered.
	 */
	extendable: SyncPlan[];
}

/** Ask what a scope comes to before anything has been saved. */
export interface EstimateSyncRequest {
	scope?: SyncScope;
	sourceServiceIds?: string[];
	filter?: SyncFilter;
}

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
	/**
	 * Which step of the placement rule chose that path, recorded when the run planned it.
	 *
	 * Kept on the line as well as on the transfer because the two outlive each other:
	 * a transfer is deleted when its history is pruned and never exists at all for an
	 * item a ceiling dropped, and a run opened next month would otherwise be unable to
	 * say where its files were sent or why.
	 */
	placedBy: PlacedBy | null;
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
	/**
	 * A destination for this run and no other, overriding the plan's preference.
	 *
	 * Deliberately not stored anywhere afterwards — it is recorded on each item as
	 * `PlacedBy.REQUESTED` and nothing else remembers it — because a run is an
	 * execution and not an intent. Somebody who wants the change to stick edits the
	 * plan's `preferredLibraryId`; somebody who wants this file elsewhere re-points
	 * the transfer.
	 */
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
