import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
	ErrorKey,
	EventName,
	LANDED_SYNC_STATES,
	MediaKind,
	MediaServiceMode,
	NotificationEvent,
	PlacedBy,
	SyncJobItemState,
	SyncJobState,
	SyncState,
	SyncStopReason,
	SyncTrigger,
	TransferState,
	TransferTransport,
	UNCONFIGURED_PLACEMENTS,
	type CompanionPullResult,
	type CreateSyncPlanForItemRequest,
	type CreateSyncPlanRequest,
	type EstimateSyncRequest,
	type HistoryView,
	type ItemSyncPlans,
	type ResultList,
	type RunSyncRequest,
	type SyncEstimate,
	type SyncFilter,
	type Settings,
	type SyncJob,
	type SyncJobItem,
	type SyncPlan,
	type SyncPlanCoverage,
	type SyncPreview,
	type SyncScope,
	type TargetSpace,
	type UpdateSyncPlanRequest,
} from '@mcs/shared';
import {
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	OnApplicationBootstrap,
	OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In, type FindOptionsWhere } from 'typeorm';
import type { MediaConfig } from '@/config';
import type {
	Library as LibraryEntity,
	MediaItem,
	MediaMatch as MediaMatchEntity,
	MediaService as MediaServiceEntity,
	SyncJob as SyncJobEntity,
	SyncJobItem as SyncJobItemEntity,
	SyncPlan as SyncPlanEntity,
	Transfer as TransferEntity,
} from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	SyncJobItemRepository,
	SyncJobRepository,
	SyncPlanRepository,
	TransferRepository,
} from '@/repositories';
import {
	EventGatewayService,
	MetadataService,
	NamingService,
	PlacementService,
	QualityService,
	SchedulerService,
	SettingsService,
	TransferEngineService,
	applyCeilings,
	editionOf,
	needsAcknowledgement,
	refusesRun,
	sameContent,
	serviceMode,
	targetSpace,
	toLocalPath,
	versionIdOf,
	type PlacementLibrary,
	type RunCeilings,
	type TransferSourceRef,
} from '@/services';
import { LibraryManager } from './library.manager';
import { NotificationManager } from './notification.manager';
import { pageBounds, paginate, toSyncJob, toSyncJobItem, toSyncPlan } from './mappers';

/**
 * How many items one plan may carry.
 *
 * A preview of forty thousand rows is a page nobody can read and a run nobody can
 * supervise, and the placement of every one of them is a directory probe. The ceiling
 * applies to the preview and the run identically — that symmetry is the whole point
 * of this manager, and a limit on only one of them would break it in the one place it
 * matters.
 */
export const MAX_PLANNED_ITEMS = 500;

/**
 * How far up a parent chain is walked before it is called a cycle.
 *
 * Episode, season, series, collection is four, so this is generous. It is a bound and
 * not a depth: a row whose parent points back at it is something a scanner wrote, and
 * a walk with no ceiling over one hangs the request instead of reporting anything.
 */
const MAX_LINEAGE_DEPTH = 8;

/** One thing a run would do, before anything has been created. */
export interface PlannedItem {
	/** The remote item the bytes come from. */
	itemId: string;
	/** Our own copy, when this is a replacement rather than something missing. */
	localItemId: string | null;
	title: string;
	kind: MediaKind;
	sourceServiceId: string;
	sourceServiceName: string;
	targetLibraryId: string;
	targetLibraryName: string;
	targetPath: string;
	/**
	 * Which step of the placement rule chose that path.
	 *
	 * Carried from the placement service rather than worked out again here: three of
	 * its seven steps mean nobody chose, and the difference between them and the four
	 * that did is not recoverable from the strategy alone.
	 */
	placedBy: PlacedBy;
	bytes: number;
	contentId: string | null;
	state: SyncState;
}

export interface SyncPlanning {
	/** What the run will do, once the ceilings have had their say. */
	items: PlannedItem[];
	itemsPlanned: number;
	bytesPlanned: number;
	/** Planned, then cut by a ceiling. Recorded as skipped lines, never silently lost. */
	dropped: PlannedItem[];
	/** What was asked for, resolved and echoed back. */
	scope: SyncScope;
	/** What the scope comes to, before any ceiling. Not the same number as above. */
	estimate: SyncEstimate;
	targets: TargetSpace[];
	stoppedBy: SyncStopReason | null;
}

/** A run request with the plan behind it already folded in. */
/** One piece of media a plan would fetch, with our own copy of it if we hold one. */
interface WantedItem {
	item: MediaItem;
	local: MediaItem | null;
	state: SyncState;
}

interface EffectiveRequest {
	planId: string | null;
	scope: SyncScope;
	sourceServiceIds: string[];
	/** The plan's preference, or what this one run asked for instead. May be neither. */
	preferredLibraryId: string | null;
	/**
	 * Which of those two it was, so the line can record it as itself.
	 *
	 * A plan's preference and a run's request send somebody to two different screens
	 * when they ask why a file is where it is, so they are not the same answer.
	 */
	preferredBy: PlacedBy.PLAN_PREFERENCE | PlacedBy.REQUESTED;
	filter: SyncFilter;
	ceilings: RunCeilings;
}

/**
 * Plans, previews and runs.
 *
 * The rule the whole class is built around: **preview and run compute the same thing
 * with the same code**. `plan()` is that code, and both entry points call it. Anything
 * else — a preview that approximates, a run that re-derives — produces the failure
 * this design exists to prevent, which is somebody being shown twelve episodes and
 * getting nine, with nothing anywhere able to explain the difference.
 *
 * Two decisions follow from the documents rather than from the code:
 *
 * - **Sources follow the plan's ordered list**, and the configured service priority
 *   when that list is empty. Empty is not an oversight; it means "follow the order set
 *   once in the administration screen", so that the day a friend's server moves,
 *   nobody has to edit every plan.
 * - **The destination is resolved, never guessed.** When nothing is writable the
 *   placement service throws, and that is the intended outcome: a file written
 *   "somewhere" is forty gigabytes found in a container's overlay filesystem a week
 *   later, with the media server none the wiser.
 */
@Injectable()
export class SyncManager implements OnModuleInit, OnApplicationBootstrap {
	private readonly _logger = new Logger(SyncManager.name);

	private readonly _transferRoot: string;

	public constructor(
		private readonly _plans: SyncPlanRepository,
		private readonly _jobs: SyncJobRepository,
		private readonly _lines: SyncJobItemRepository,
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _libraries: LibraryRepository,
		/**
		 * Asked which libraries a merged category stands for, and how a path probes.
		 *
		 * A manager rather than a repository because both answers are decisions and
		 * neither belongs to this one: `Shows` is four libraries across three servers
		 * today and five tomorrow, and re-deriving that here would leave two versions of
		 * the merging rule to disagree with each other.
		 */
		private readonly _libraryManager: LibraryManager,
		private readonly _transfers: TransferRepository,
		private readonly _settings: SettingsService,
		private readonly _naming: NamingService,
		/**
		 * Asked two things: what to call a copy that has to sit beside another, and
		 * whether two copies are different cuts.
		 *
		 * The resolution band is the suffix both media servers read as a version name,
		 * and re-deriving it from a height here would be a second set of thresholds to
		 * disagree with the one the comparator ranks on. The cut is the same argument:
		 * `isConflicting` is the rule a `conflict` state is derived from, and a planner
		 * with its own idea of a different cut would hold what the screen says it lacks.
		 */
		private readonly _quality: QualityService,
		private readonly _metadata: MetadataService,
		private readonly _placement: PlacementService,
		private readonly _engine: TransferEngineService,
		private readonly _scheduler: SchedulerService,
		private readonly _events: EventGatewayService,
		/**
		 * Told what happened, and never allowed to make it worse.
		 *
		 * Every call below is fire-and-forget on purpose: `notify` resolves whatever a
		 * channel does, and a run must not be abandoned because a mail server was slow.
		 * A notification that breaks a transfer is worse than no notification.
		 */
		private readonly _notifications: NotificationManager,
		config: ConfigService,
	) {
		this._transferRoot = config.getOrThrow<MediaConfig>('media').transferRoot;
	}

	/**
	 * Hand the engine its source resolver, before anything can be rebuilt.
	 *
	 * A queue restored from the database after a restart carries rows and no sources:
	 * which services may feed a transfer is a decision, and the engine refuses to
	 * guess. Registering this in `onModuleInit` rather than at bootstrap is deliberate
	 * — the engine rebuilds its queue in `onApplicationBootstrap`, and a resolver
	 * registered then would arrive after the first transfers had already failed with
	 * `SYNC_NO_SOURCE` and nothing saying why.
	 */
	public onModuleInit(): void {
		this._engine.setSourceResolver((transfer) => this.resolveSources(transfer));
		// Pushed by the engine rather than polled from here. A timer over the transfers
		// of every live job is a query every second for rows that change twice an hour,
		// and it still shows a stale line for as long as its interval.
		this._engine.onTransferState((transfer) => this._recordTransferState(transfer));
		this._scheduler.onPlan(async (planId) => {
			await this.run({ planId }, SyncTrigger.SCHEDULE);
		});
	}

	public async onApplicationBootstrap(): Promise<void> {
		const plans = await this._plans.find().catch(() => [] as SyncPlanEntity[]);

		this._scheduler.registerPlans(plans);
	}

	public async listPlans(): Promise<SyncPlan[]> {
		const plans = await this._plans.find({ order: { name: 'ASC' } });

		return plans.map((plan) => toSyncPlan(plan));
	}

	public async readPlan(id: string): Promise<SyncPlan> {
		return toSyncPlan(await this._requirePlan(id));
	}

	public async createPlan(request: CreateSyncPlanRequest): Promise<SyncPlan> {
		const scope = request.scope ?? {};
		const enabled = request.enabled ?? true;

		this._refuseBlindSchedule(scope, enabled, request.acknowledgeUnbounded === true);
		this._refuseEmptySchedule(request.trigger, request.schedule ?? null);
		await this._checkPreferred(request.preferredLibraryId ?? null);

		const plan = await this._plans.save(
			this._plans.create({
				name: request.name,
				trigger: request.trigger,
				schedule: request.schedule ?? null,
				sourceServiceIds: request.sourceServiceIds ?? [],
				preferredLibraryId: request.preferredLibraryId ?? null,
				scope,
				filter: request.filter ?? {},
				maxItemsPerRun: request.maxItemsPerRun ?? null,
				maxBytesPerRun: request.maxBytesPerRun ?? null,
				enabled,
			}),
		);

		await this._reschedule();

		return toSyncPlan(plan);
	}

	public async updatePlan(id: string, patch: UpdateSyncPlanRequest): Promise<SyncPlan> {
		const plan = await this._requirePlan(id);

		plan.name = patch.name ?? plan.name;
		plan.trigger = patch.trigger ?? plan.trigger;
		plan.schedule = patch.schedule === undefined ? plan.schedule : patch.schedule;
		plan.sourceServiceIds = patch.sourceServiceIds ?? plan.sourceServiceIds;

		if (patch.preferredLibraryId !== undefined) {
			await this._checkPreferred(patch.preferredLibraryId);

			plan.preferredLibraryId = patch.preferredLibraryId;
		}

		plan.scope = patch.scope ?? plan.scope;
		plan.filter = patch.filter ?? plan.filter;
		plan.maxItemsPerRun =
			patch.maxItemsPerRun === undefined ? plan.maxItemsPerRun : patch.maxItemsPerRun;
		plan.maxBytesPerRun =
			patch.maxBytesPerRun === undefined ? plan.maxBytesPerRun : patch.maxBytesPerRun;
		plan.enabled = patch.enabled ?? plan.enabled;

		// Tested against the plan as it will be, not against the patch. Enabling an
		// existing unbounded plan sends `{ enabled: true }` and nothing else, and a
		// check that only read the body would let exactly that through.
		this._refuseBlindSchedule(plan.scope, plan.enabled, patch.acknowledgeUnbounded === true);
		this._refuseEmptySchedule(plan.trigger, plan.schedule);

		const saved = await this._plans.save(plan);

		await this._reschedule();

		return toSyncPlan(saved);
	}

	/**
	 * What this plan's scope currently comes to, recomputed on the spot.
	 *
	 * A route of its own rather than a field filled in on every read, for two reasons
	 * that point the same way. It costs a walk of every source and a comparison of each
	 * item with what we hold, which is not something a list of six plans should pay
	 * for. Like `estimateScope`, it needs no destination. And an estimate
	 * is only worth anything at the moment it is taken — a library grows, a friend links
	 * a server — so one stored against the plan would be believed long after it stopped
	 * being true. `SyncPlan.estimate` is therefore null everywhere except in the answer
	 * to this call.
	 */
	public async estimatePlan(id: string): Promise<SyncEstimate> {
		const plan = await this._requirePlan(id);

		return (await this._select({ planId: plan.id })).estimate;
	}

	/**
	 * What a scope would come to, for a plan nobody has saved yet.
	 *
	 * The counterpart of `estimatePlan` for the moment before there is a plan to
	 * address. Somebody creating one from a season is shown two episodes and somebody
	 * creating one from a series a whole show, and that number is the difference
	 * between a standing intent and a surprise — asking for it afterwards, from the
	 * edit screen, is asking after the decision was taken.
	 *
	 * It goes through the same selection `plan()` starts with, so the count offered at
	 * creation and the count the first run reports are the same arithmetic rather than
	 * two readings that drift apart.
	 *
	 * **It asks for no destination**, and that is a decision rather than a shortcut.
	 * The estimate is a count and a size: which items the scope covers that nothing
	 * local holds, and how many bytes they weigh. Neither depends on where the files
	 * would land — placement only decides a path per item, and the figure was always
	 * taken before placement ran. Going through the whole of `plan()` made placement
	 * a precondition anyway, so a gateway with no library it can write into (a clean
	 * install, or a household that only reads a friend's server) was answered 409
	 * `path_not_writable` for a question that has nothing to do with writing, and the
	 * dialog asking it could only say that nobody had worked the figure out. Somebody
	 * deciding whether a show is worth keeping in step is owed the size of it before
	 * being told to set up a library; the refusal belongs to the run and the preview,
	 * which do need a destination and still go through placement.
	 */
	public async estimateScope(request: EstimateSyncRequest): Promise<SyncEstimate> {
		return (await this._select(request)).estimate;
	}

	/**
	 * Which plans already speak for this media, and what a new one would be called.
	 *
	 * Answered here rather than left to the interface because both halves are rules.
	 * Coverage takes the parent chain — a plan on a series covers every season under it,
	 * and somebody standing on the season needs to be sent to *that* plan rather than
	 * told to make a second one. What may be extended takes the reading of a scope,
	 * which is this class's own and nobody else's.
	 *
	 * Only `rootItemIds` counts as coverage. A plan that names an episode in `itemIds`
	 * has pinned one file, not undertaken to keep a show in step, and treating the two
	 * as the same thing would refuse the plan somebody actually wanted.
	 */
	public async itemPlans(itemId: string): Promise<ItemSyncPlans> {
		const item = await this._requireItem(itemId);
		const lineage = await this._lineage(item);
		const plans = await this._plans.find({ order: { name: 'ASC' } });
		const covering: SyncPlanCoverage[] = [];
		const extendable: SyncPlan[] = [];

		for (const plan of plans) {
			const roots = plan.scope?.rootItemIds ?? [];
			const covered = lineage.find((ancestorId) => roots.includes(ancestorId));

			if (covered !== undefined) {
				covering.push({
					plan: toSyncPlan(plan),
					coveredItemId: covered,
					exact: covered === itemId,
				});
			}

			if (isSubtreeScope(plan.scope ?? {})) {
				extendable.push(toSyncPlan(plan));
			}
		}

		return { suggestedName: await this._planNameFor(item), covering, extendable };
	}

	/**
	 * Create a plan for one subtree, or add that subtree to a plan that exists.
	 *
	 * The route the owner asked for: from a season card or a series card, one gesture,
	 * with the one thing somebody meant to say already said. Everything it settles is a
	 * decision that the blank form left to whoever was filling it in, and every one of
	 * them is written down where it is taken:
	 *
	 * - the **name** comes from the media, because a list of plans called "Nightly" and
	 *   "Nightly 2" is unreadable six months later;
	 * - the **scope** is the subtree, which is what makes the estimate small and the
	 *   plan explicable;
	 * - the **sources** stay empty, meaning wherever it turns up — see the request shape;
	 * - the **filter** is `missingOnly`, because "keep this in step" is filling holes and
	 *   never replacing a file somebody chose;
	 * - there is **no ceiling**, because a ceiling exists to stop an unbounded scope
	 *   running away and this one is a named show. A ceiling here would silently leave
	 *   half a season behind on every run, which reads as a broken plan.
	 *
	 * The trigger is the one thing it refuses to decide, and the request shape says why.
	 */
	public async createPlanForItem(request: CreateSyncPlanForItemRequest): Promise<SyncPlan> {
		const item = await this._requireItem(request.itemId);

		if (request.extendPlanId !== undefined) {
			return this._extendPlan(request.extendPlanId, item.id);
		}

		const covering = (await this.itemPlans(item.id)).covering;

		if (covering.length > 0) {
			// Named in the log because the refusal itself cannot carry it: the interface
			// asks the coverage route to say which plan, and a gateway operator reading
			// the journal deserves the same answer.
			this._logger.log(
				`Plan "${covering[0].plan.name}" already covers ${item.title}; refusing a second`,
			);

			throw new ConflictException(ErrorKey.SYNC_ITEM_ALREADY_COVERED);
		}

		return this.createPlan({
			name: request.name ?? (await this._planNameFor(item)),
			trigger: request.trigger,
			schedule: request.schedule ?? null,
			sourceServiceIds: request.sourceServiceIds ?? [],
			preferredLibraryId: request.preferredLibraryId ?? null,
			scope: { rootItemIds: [item.id] },
			filter: request.filter ?? { missingOnly: true },
			maxItemsPerRun: request.maxItemsPerRun ?? null,
			maxBytesPerRun: request.maxBytesPerRun ?? null,
			enabled: request.enabled ?? true,
		});
	}

	/**
	 * Add one subtree to an existing plan, which is why `rootItemIds` is plural.
	 *
	 * Refused for any scope that is not subtrees alone: the fields of a scope intersect,
	 * so a root added to a plan scoped by category means the part of that show in that
	 * category, and a root added to a plan that names nothing turns "everything, nightly"
	 * into that one show. Both are silent rewrites of an intent somebody else stated.
	 *
	 * Adding a root the plan already carries changes nothing and is not an error: two
	 * people pressing the same button is not a conflict worth a refusal.
	 */
	private async _extendPlan(planId: string, itemId: string): Promise<SyncPlan> {
		const plan = await this._requirePlan(planId);

		if (!isSubtreeScope(plan.scope ?? {})) {
			throw new ConflictException(ErrorKey.SYNC_PLAN_NOT_EXTENDABLE);
		}

		const roots = plan.scope.rootItemIds ?? [];

		if (roots.includes(itemId)) {
			return toSyncPlan(plan);
		}

		return this.updatePlan(plan.id, { scope: { rootItemIds: [...roots, itemId] } });
	}

	/**
	 * What a plan created from this media is called.
	 *
	 * The name is the only thing a plan list shows, so it has to say which show this is
	 * about: "Season 1" on its own is three plans with the same name the moment somebody
	 * keeps two shows in step. A season therefore carries its series' title, and only
	 * when the season's own title does not already contain it — media servers disagree
	 * about that, and "The Expanse — The Expanse Season 1" is nobody's idea of readable.
	 */
	private async _planNameFor(item: MediaItem): Promise<string> {
		const parent = item.parentId
			? await this._items.findOne({ where: { id: item.parentId } })
			: null;

		if (parent === null || item.kind === MediaKind.SERIES) {
			return item.title;
		}

		return item.title.toLowerCase().includes(parent.title.toLowerCase())
			? item.title
			: `${parent.title} — ${item.title}`;
	}

	/**
	 * This media and everything above it, nearest first.
	 *
	 * Bounded rather than walked to the root, for the same reason the naming walk is: a
	 * parent chain that points back at itself is a row somebody's scanner wrote, and an
	 * unbounded walk over one would hang the request rather than report anything.
	 */
	private async _lineage(item: MediaItem): Promise<string[]> {
		const chain = [item.id];
		let current: MediaItem | null = item;

		for (let hop = 0; hop < MAX_LINEAGE_DEPTH && current?.parentId; hop += 1) {
			current = await this._items.findOne({ where: { id: current.parentId } });

			if (current === null || chain.includes(current.id)) {
				break;
			}

			chain.push(current.id);
		}

		return chain;
	}

	private async _requireItem(itemId: string): Promise<MediaItem> {
		const item = await this._items.findOne({ where: { id: itemId } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return item;
	}

	/**
	 * Refuse a plan that claims a schedule and carries no cron expression.
	 *
	 * The scheduler registers what it can parse, so such a plan is stored, listed as
	 * scheduled, and never fires. Nothing anywhere reports it — the first anybody hears
	 * of it is the episodes that never arrived — which is exactly the class of silent
	 * failure the scope rules above exist to prevent.
	 */
	private _refuseEmptySchedule(trigger: SyncTrigger | undefined, schedule: string | null): void {
		if (trigger === SyncTrigger.SCHEDULE && (schedule ?? '').trim() === '') {
			throw new ConflictException(ErrorKey.SYNC_SCHEDULE_REQUIRED);
		}
	}

	/**
	 * Refuse to stand up a plan that says "everything".
	 *
	 * An empty scope is what an empty form produces, and enabled is the default, so
	 * without this the easiest plan to create is the one that would move a whole media
	 * library at four in the morning. Saying it on purpose is one flag; discovering it
	 * from the disk usage is a weekend.
	 */
	private _refuseBlindSchedule(scope: SyncScope, enabled: boolean, acknowledged: boolean): void {
		if (enabled && isUnbounded(scope) && !acknowledged) {
			throw new ConflictException(ErrorKey.SYNC_SCOPE_UNBOUNDED);
		}
	}

	/**
	 * A plan may only prefer a library this gateway can actually write into.
	 *
	 * The same rule the queue applies when a transfer is re-pointed, and for the same
	 * reason: a destination on a peer's server, or on one of ours whose files we do not
	 * hold, accepts everything and produces nothing anybody can watch. Refusing it here
	 * costs one query at the moment somebody chooses; discovering it at run time costs
	 * whoever was waiting for the files a night.
	 *
	 * The disk is deliberately **not** probed, which is the one place this is laxer than
	 * `TransferManager._requireDestination`. A plan is a standing intent that may not run
	 * for a week, and refusing to save it because a NAS happens to be asleep this evening
	 * would be a refusal about the wrong moment entirely. A preference that cannot be
	 * written into when the run comes is simply passed over by placement, which is what
	 * the rest of the rule is for; a preference naming somebody else's server can never
	 * be right at any moment, and that is what is checked.
	 *
	 * Null clears it, and clearing is always allowed.
	 */
	private async _checkPreferred(libraryId: string | null): Promise<void> {
		if (libraryId === null) {
			return;
		}

		const library = await this._libraries.findOne({ where: { id: libraryId } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		const service = await this._services.findOne({ where: { id: library.serviceId } });

		// The mount and not the sharing switch: what decides a destination is whether
		// this gateway reaches the files, and offering a service's libraries to peers
		// puts no file anywhere. `serviceMode` also keeps a peer-backed row out, which
		// no column test on its own would.
		if (
			service === null
			|| serviceMode(service) !== MediaServiceMode.LOCAL
			|| !library.localPath
		) {
			throw new ConflictException(ErrorKey.TRANSFER_DESTINATION_INVALID);
		}
	}

	public async deletePlan(id: string): Promise<void> {
		const plan = await this._requirePlan(id);

		await this._plans.delete({ id: plan.id });
		this._scheduler.unregisterPlan(plan.id);
	}

	/** What a run would do, computed by the code a run uses. Changes nothing. */
	public async preview(request: RunSyncRequest): Promise<SyncPreview> {
		const planning = await this.plan(request);

		return {
			itemsPlanned: planning.itemsPlanned,
			bytesPlanned: planning.bytesPlanned,
			scope: planning.scope,
			targets: planning.targets,
			stoppedBy: planning.stoppedBy,
			items: planning.items.map((item) => ({
				itemId: item.itemId,
				title: item.title,
				kind: item.kind,
				sourceServiceId: item.sourceServiceId,
				sourceServiceName: item.sourceServiceName,
				targetPath: item.targetPath,
				bytes: item.bytes,
				state: item.state,
			})),
		};
	}

	/**
	 * Turn a plan into a job and a queue of transfers.
	 *
	 * The job row exists before the first transfer does, so a run that fails halfway
	 * is still something somebody can open and read rather than a set of orphaned
	 * transfers with nothing tying them together.
	 */
	public async run(
		request: RunSyncRequest,
		trigger: SyncTrigger = SyncTrigger.MANUAL,
	): Promise<SyncJob> {
		if (request.planId !== undefined) {
			// Two runs of the same plan would pull the same missing episodes into the
			// same paths at the same time, and the second would find the first's
			// half-written file.
			const live = await this._jobs.findLiveForPlan(request.planId);

			if (live !== null) {
				throw new ConflictException(ErrorKey.SYNC_ALREADY_RUNNING);
			}
		}

		const planning = await this.plan(request);
		const settings = await this._settings.get();

		this._refuseOnSpace(planning.targets, request.acknowledgeSpace === true);

		const job = await this._jobs.save(
			this._jobs.create({
				planId: request.planId ?? null,
				state: planning.items.length === 0 ? SyncJobState.DONE : SyncJobState.RUNNING,
				trigger,
				startedAt: new Date(),
				finishedAt: planning.items.length === 0 ? new Date() : null,
				itemsPlanned: planning.itemsPlanned,
				bytesPlanned: planning.bytesPlanned,
				scope: planning.scope,
				targets: planning.targets,
				stoppedBy: planning.stoppedBy,
			}),
		);

		// The lines come before the transfers, and all of them at once. A run that dies
		// on its third transfer is then still something somebody can open and read
		// rather than three orphaned rows and no record of what the other four hundred
		// were going to be.
		await this._recordLines(job.id, planning);

		for (const planned of planning.items) {
			const id = randomUUID();

			await this._transfers.save(
				this._transfers.create({
					id,
					jobId: job.id,
					itemId: planned.itemId,
					contentId: planned.contentId,
					title: planned.title,
					state: TransferState.QUEUED,
					targetPath: planned.targetPath,
					// Empty means a fallback folder outside every registered library, which
					// is exactly the case somebody has to be told about — so it is stored as
					// null rather than as a library identifier nothing can resolve.
					targetLibraryId: planned.targetLibraryId === '' ? null : planned.targetLibraryId,
					placedBy: planned.placedBy,
					// The pieces accumulate beside the database rather than in the library:
					// a half-written file in a watched folder is one a media server will
					// happily index and then fail to play.
					workPath: join(this._transferRoot, `${id}.part`),
					bytesTotal: planned.bytes,
					chunkSize: settings.chunkSize,
				}),
			);

			await this._engine.enqueue(id);
			await this._pullMetadata(planned, settings);
		}

		this._reportUnconfiguredPlacements(planning.items);

		if (request.planId !== undefined) {
			await this._plans.setRunStamps(
				request.planId,
				new Date(),
				this._scheduler.nextRunAt(request.planId),
			);
		}

		const model = toSyncJob(job, await this._planName(job.planId));

		this._events.emit(EventName.JOB_STATE, model);

		return model;
	}

	/**
	 * Say when a pull is about to land somewhere nobody chose.
	 *
	 * The condition is never re-derived here: `UNCONFIGURED_PLACEMENTS` is the list of
	 * steps that mean nobody chose, and `placedBy` is what the placement service
	 * actually decided. Reading the strategy instead would give a different answer the
	 * day a step is added, and this screen, the dashboard and the notifier would then
	 * disagree about the same file.
	 *
	 * Said at the start of the run rather than when the bytes land, because that is
	 * the only moment it is still worth anything: the file is not lost and the
	 * transfer has not failed, so nothing else would ever say a word — the library
	 * simply grows a folder somebody did not plan, and it is found months later. Told
	 * now, the destination can be set before the first file arrives.
	 *
	 * One message for the whole run, not one per file. A sync of four hundred
	 * episodes into an unconfigured category would otherwise be four hundred
	 * notifications, which is how somebody turns the feature off.
	 */
	private _reportUnconfiguredPlacements(items: PlannedItem[]): void {
		const unconfigured = items.filter((item) => UNCONFIGURED_PLACEMENTS.includes(item.placedBy));

		if (unconfigured.length === 0) {
			return;
		}

		const destinations = [...new Set(unconfigured.map((item) => item.targetLibraryName || dirname(item.targetPath)))];

		void this._notifications.notify({
			event: NotificationEvent.PLACEMENT_UNCONFIGURED,
			title: `${unconfigured.length} file(s) are landing where nobody chose`,
			body:
				`Nothing named a destination for them, so they are going to ${destinations.join(', ')}. ` +
				'Set a destination for their category and the next run will file them properly.',
			link: '/settings',
		});
	}

	/**
	 * Stop a run that a destination cannot take.
	 *
	 * The refusal and the question are two different answers on purpose. `INSUFFICIENT`
	 * is arithmetic — the files are larger than the free space — and no acknowledgement
	 * gets past it, because starting anyway buys a transfer that dies at ninety per cent
	 * and a truncated file the media server indexes as real. Tight and unprobeable are
	 * questions, and `acknowledgeSpace` is somebody answering them.
	 *
	 * Both happen before the job row exists. A half-run abandoned for want of room is
	 * the failure this whole check exists to avoid, so nothing is created until it is
	 * known that the bytes have somewhere to go.
	 */
	private _refuseOnSpace(targets: TargetSpace[], acknowledged: boolean): void {
		if (refusesRun(targets)) {
			/*
			 * Said here, before a byte moves, because that is the whole difference
			 * between this and a failed transfer.
			 *
			 * The arithmetic is known now: the free space and the size of every file
			 * are both in hand. Said in time, somebody frees space and the queue
			 * drains. Said afterwards, as a transfer that died at ninety per cent, it
			 * is thirty gigabytes downloaded twice.
			 */
			void this._notifications.notify({
				event: NotificationEvent.DISK_FULL,
				title: 'Not enough space for this run',
				body: this._spaceSentence(targets),
				link: '/settings',
			});

			throw new ConflictException({ key: ErrorKey.SYNC_NOT_ENOUGH_SPACE, targets });
		}

		if (!acknowledged && needsAcknowledgement(targets)) {
			throw new ConflictException({ key: ErrorKey.SYNC_SPACE_NOT_ACKNOWLEDGED, targets });
		}
	}

	/**
	 * Which destinations are short, and by how much, in one line.
	 *
	 * The numbers are the message: "the library is full" sends somebody to look at
	 * the wrong disk on a gateway with four of them, while a name and two figures is
	 * something they can act on from a phone at four in the morning.
	 */
	private _spaceSentence(targets: TargetSpace[]): string {
		const short = targets.filter((target) => refusesRun([target]));

		return (short.length > 0 ? short : targets)
			.map(
				(target) =>
					`${target.libraryName}: ${target.requiredBytes} needed, ${target.freeBytes ?? 'unknown'} free`,
			)
			.join('; ');
	}

	/**
	 * Write the run down, line by line, including the lines it will not do.
	 *
	 * The ones a ceiling dropped are recorded as skipped rather than left out: a job
	 * that planned four hundred items and shows fifty is a job whose `stoppedBy` has to
	 * be taken on faith, and the whole point of the detail is not having to.
	 */
	private async _recordLines(jobId: string, planning: SyncPlanning): Promise<void> {
		const rows: SyncJobItemEntity[] = [];
		let position = 0;

		for (const planned of planning.items) {
			rows.push(this._line(jobId, position++, planned, SyncJobItemState.PENDING));
		}

		for (const planned of planning.dropped) {
			rows.push(this._line(jobId, position++, planned, SyncJobItemState.SKIPPED));
		}

		if (rows.length > 0) {
			await this._lines.save(rows);
		}
	}

	private _line(
		jobId: string,
		position: number,
		planned: PlannedItem,
		state: SyncJobItemState,
	): SyncJobItemEntity {
		return this._lines.create({
			jobId,
			position,
			itemId: planned.itemId,
			title: planned.title,
			kind: planned.kind,
			sourceServiceId: planned.sourceServiceId,
			sourceServiceName: planned.sourceServiceName,
			targetLibraryId: planned.targetLibraryId === '' ? null : planned.targetLibraryId,
			targetPath: planned.targetPath,
			placedBy: planned.placedBy,
			bytes: planned.bytes,
			bytesDone: 0,
			state,
			// Null until a transfer is actually moving this one, which is what the
			// contract says the field means: a queued line has no bytes to reach.
			transferId: null,
			error: null,
			startedAt: null,
			finishedAt: null,
		});
	}

	/** One page of a run's lines, in the order the plan chose. */
	public async jobItems(
		jobId: string,
		query: { page?: number; limit?: number },
	): Promise<ResultList<SyncJobItem>> {
		await this._requireJob(jobId);

		const { page, limit } = pageBounds(query.page, query.limit);
		const [rows, total] = await this._lines.findPage(jobId, (page - 1) * limit, limit);

		return paginate(rows.map(toSyncJobItem), total, page, limit);
	}

	/**
	 * A transfer moved; bring its line, and the job's counters, up to date.
	 *
	 * The counters are recounted from the lines rather than incremented here. An event
	 * arrives twice whenever a transfer is resumed after a restart, and a job that
	 * reports 901 done out of 900 is one nobody believes again — including about the
	 * runs where it was right.
	 *
	 * Live bytes are deliberately not written here: they move several times a second and
	 * the line carries its transfer's identifier precisely so a progress bar can follow
	 * the transfer's own stream. What lands in the row is what survives a restart.
	 */
	private async _recordTransferState(transfer: TransferEntity): Promise<void> {
		// Before the job check, because a transfer started by hand fails exactly as
		// expensively as one belonging to a run — and it is the one nobody is watching
		// a progress bar for.
		if (transfer.state === TransferState.FAILED) {
			void this._notifications.notify({
				event: NotificationEvent.TRANSFER_FAILED,
				title: `Transfer failed: ${transfer.title}`,
				// The error key, not a sentence: the wording belongs to whoever renders
				// it, and a channel is one more renderer. `errorKind` travels with it
				// because it is what says whether this is worth getting up for — a full
				// disk is, a source that went away for the night is not.
				body: `${transfer.errorKind ?? 'unknown'} — ${transfer.error ?? 'no reason recorded'}`,
				// The transfers screen, not a per-transfer route: there is no such route,
				// and a notification whose link 404s is worse than one with no link.
				link: '/transfers',
			});
		}

		if (transfer.jobId === null) {
			return;
		}

		const line = await this._lines.findLine(transfer.jobId, transfer.itemId);

		if (line === null) {
			return;
		}

		const state = jobItemStateOf(transfer.state);

		line.state = state;
		line.bytesDone = Number(transfer.bytesDone);
		line.transferId =
			state === SyncJobItemState.PENDING || state === SyncJobItemState.SKIPPED
				? null
				: transfer.id;
		line.error = transfer.error;
		line.startedAt = transfer.startedAt;
		line.finishedAt = transfer.finishedAt;

		await this._lines.save(line);
		await this._settleJob(transfer.jobId);
	}

	/** The job's counters, and whether it is over. */
	private async _settleJob(jobId: string): Promise<void> {
		const job = await this._jobs.findOne({ where: { id: jobId } });

		if (job === null) {
			return;
		}

		const progress = await this._lines.progressOf(jobId);

		job.itemsDone = progress.done;
		job.itemsFailed = progress.failed;
		job.bytesDone = progress.bytesDone;

		// Only a run still believed to be going gets finished here. A cancelled job
		// whose transfers are still reporting their own cancellation would otherwise
		// come back as done, and the stop button would look like it had failed.
		// Only a state that has just changed is announced. `_settleJob` runs on every
		// transfer event of the run, so notifying on `state === DONE` rather than on
		// the transition would send one message per straggler reporting in after the
		// last one finished.
		const finishing = job.state === SyncJobState.RUNNING && progress.open === 0;

		if (finishing) {
			job.state = SyncJobState.DONE;
			job.finishedAt = new Date();
		}

		const model = toSyncJob(await this._jobs.save(job), await this._planName(job.planId));

		this._events.emit(EventName.JOB_STATE, model);

		// The event stream reaches open tabs and nothing else, which is the entire
		// problem: a run that started at eleven finishes at four in the morning with no
		// tab open anywhere.
		if (finishing) {
			void this._notifications.notify({
				event: NotificationEvent.SYNC_FINISHED,
				title: `Sync finished: ${model.planName ?? 'manual run'}`,
				body: `${model.itemsDone} of ${model.itemsPlanned} done, ${model.itemsFailed} failed.`,
				link: '/sync',
			});
		}
	}

	/**
	 * The series an episode belongs to, for the document written beside it.
	 *
	 * Walked from the parents rather than taken from the episode, which only knows its
	 * own title. Without it the document names the episode twice and says nothing
	 * about the show — and the show is exactly what a media server gets wrong when two
	 * series share an episode title.
	 *
	 * Null for anything that is not an episode, and for an episode whose parents are
	 * not recorded: a missing element is better than a wrong one.
	 */
	private async _seriesTitleOf(item: MediaItem): Promise<string | null> {
		if (item.kind !== MediaKind.EPISODE) {
			return null;
		}

		let current: MediaItem | null = item;

		// Two hops at most — episode, season, series — and bounded anyway so a cycle in
		// the parent chain cannot hang a transfer.
		for (let hop = 0; hop < 4 && current?.parentId; hop += 1) {
			current = await this._items.findOne({ where: { id: current.parentId } });

			if (current?.kind === MediaKind.SERIES) {
				return current.title;
			}
		}

		return null;
	}

	/**
	 * Bring the artwork, the subtitles and the `.nfo` across with the media.
	 *
	 * A sync that lands a bare video file in a tidy library has done half the job: the
	 * whole point of pulling from somebody who files things well is getting what they
	 * filed with it. The companions are written before the video arrives rather than
	 * after, because nothing here is told when a transfer finishes — and a media server
	 * that indexes the video later picks up what is already beside it.
	 *
	 * Local files are never overwritten unless `preferSourceMetadata` says so.
	 * Somebody's own poster, their own corrected `.nfo`, their own hand-timed
	 * subtitles are work they did, and a sync that quietly replaces them is a sync they
	 * turn off.
	 *
	 * Failures are logged and swallowed on purpose. A transfer must not be lost over a
	 * subtitle file, and the source directory is simply unreadable whenever the source
	 * is a remote service — which is the normal case, not an error.
	 */
	private async _pullMetadata(planned: PlannedItem, settings: Settings): Promise<void> {
		if (!settings.pullMetadata) {
			return;
		}

		try {
			const source = await this._items.findOne({ where: { id: planned.itemId } });

			if (source === null) {
				return;
			}

			if (source.file?.path) {
				const sidecars = await this._metadata.discover(source.file.path, planned.targetPath);
				const result = await this._metadata.apply(planned.targetPath, sidecars, settings);

				if (result.copied.length > 0 || result.kept.length > 0) {
					this._logger.log(
						`${planned.title}: ${result.copied.length} companions copied, ${result.kept.length} kept`,
					);
				}
			}

			// After the companions, deliberately. A document the source actually had
			// beats one we assembled from what we know, and `apply` has just had its
			// chance to place it — writing first would mean ours was overwritten by
			// theirs, or worse, kept in preference to a better one.
			const written = await this._metadata.writeNfo(
				planned.targetPath,
				{
					kind: source.kind,
					title: source.title,
					year: source.year,
					seasonNumber: source.seasonNumber,
					episodeNumber: source.episodeNumber,
					overview: source.overview,
					showTitle: await this._seriesTitleOf(source),
					externalIds: (source.externalIds ?? {}) as Record<string, string>,
				},
				settings,
			);

			if (written !== null) {
				this._logger.log(`${planned.title}: wrote ${written}`);
			}

			// Identifiers are additive: one library knows the TVDB number and the other
			// the TMDB one, and holding both makes every later correlation cheaper. The
			// local value wins a disagreement unless the settings say otherwise, because
			// ours is the one somebody may have corrected by hand.
			if (planned.localItemId !== null) {
				const local = await this._items.findOne({ where: { id: planned.localItemId } });

				if (local !== null) {
					local.externalIds = this._metadata.mergeExternalIds(
						local.externalIds,
						source.externalIds,
						settings.preferSourceMetadata,
					);

					await this._items.save(local);
				}
			}
		} catch (error) {
			this._logger.warn(`Could not pull metadata for ${planned.title}: ${String(error)}`);
		}
	}

	/**
	 * Fetch only what sits beside a file we already hold.
	 *
	 * A sync moves what we do not have; this fills in what arrived bare — an episode
	 * already on the disk whose `.nfo`, poster or subtitles never came with it,
	 * because it was pulled before the setting was on, or from a source that had none,
	 * or copied in by hand years ago. Asking somebody to re-pull forty gigabytes to get
	 * a description file beside it is not an answer, and it is the only one they had.
	 *
	 * Each item is tried against every counterpart a match points at, richest first.
	 * One unreadable source must not stop the rest: the failure is recorded against
	 * that item and the loop goes on, because a run over two hundred episodes that
	 * stops on the first sleeping NAS has helped nobody.
	 */
	public async pullCompanions(itemIds: string[]): Promise<CompanionPullResult[]> {
		const settings = await this._settings.get();
		const items = await this._items.find({ where: { id: In(itemIds) } });
		const results: CompanionPullResult[] = [];

		for (const item of items) {
			results.push(await this._pullCompanionsFor(item, settings));
		}

		return results;
	}

	private async _pullCompanionsFor(
		item: MediaItem,
		settings: Settings,
	): Promise<CompanionPullResult> {
		const result: CompanionPullResult = {
			itemId: item.id,
			title: item.title,
			copied: [],
			kept: [],
			error: null,
		};

		const target = item.file?.path;

		if (!target) {
			// A series or a season has no file of its own to put anything beside. Saying
			// so beats reporting nothing copied, which reads as a source having nothing.
			result.error = ErrorKey.MEDIA_NOT_FOUND;

			return result;
		}

		const matches = await this._matches.findForLocalItem(item.id);
		const byRemote = new Map(matches.map((match) => [match.remoteItemId, match]));
		const counterparts = (
			await this._items.find({ where: { id: In([...byRemote.keys()]) } })
		).filter((counterpart) =>
			this._interchangeable(byRemote.get(counterpart.id) as MediaMatchEntity, item, counterpart),
		);

		if (counterparts.length === 0) {
			result.error = ErrorKey.SYNC_NO_SOURCE;

			return result;
		}

		for (const counterpart of counterparts) {
			const source = counterpart.file?.path;

			if (!source) {
				continue;
			}

			try {
				const sidecars = await this._metadata.discover(source, target);
				const applied = await this._metadata.apply(target, sidecars, settings);

				result.copied.push(...applied.copied);
				result.kept.push(...applied.kept);

				item.externalIds = this._metadata.mergeExternalIds(
					item.externalIds,
					counterpart.externalIds,
					settings.preferSourceMetadata,
				);
			} catch (error) {
				this._logger.warn(`Companions for ${item.title}: ${String(error)}`);
			}
		}

		await this._items.save(item);

		// Nothing copied and nothing kept leaves `error` null on purpose: counterparts
		// that had nothing to give are an answer, not a failure, and the interface says
		// so rather than leaving a spinner where a result goes.
		return result;
	}

	/**
	 * One page of the run history.
	 *
	 * `view` is not defaulted here. The screens that want the live half ask for it, and
	 * a route that quietly dropped finished rows would have taken the dashboard's own
	 * reporting with it — that page reads failed work out of exactly this list.
	 */
	public async jobs(query: {
		page?: number;
		limit?: number;
		state?: SyncJobState;
		view?: HistoryView;
	}): Promise<ResultList<SyncJob>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [jobs, total] = await this._jobs.pageOf({
			page,
			limit,
			state: query.state,
			view: query.view,
		});

		const names = await this._planNames(jobs);

		return paginate(
			jobs.map((job) => toSyncJob(job, job.planId === null ? null : (names.get(job.planId) ?? null))),
			total,
			page,
			limit,
		);
	}

	public async readJob(id: string): Promise<SyncJob> {
		const job = await this._requireJob(id);

		return toSyncJob(job, await this._planName(job.planId));
	}

	/**
	 * Stop a run and everything it started.
	 *
	 * The transfers go too. A cancelled job whose transfers kept running would be a
	 * stop button that stops the bookkeeping and not the downloads.
	 */
	public async cancel(id: string): Promise<SyncJob> {
		const job = await this._requireJob(id);

		if ([SyncJobState.DONE, SyncJobState.FAILED, SyncJobState.CANCELLED].includes(job.state)) {
			return toSyncJob(job, await this._planName(job.planId));
		}

		for (const transfer of await this._transfers.findByJob(job.id)) {
			if (
				transfer.state !== TransferState.DONE &&
				transfer.state !== TransferState.CANCELLED &&
				transfer.state !== TransferState.FAILED
			) {
				await this._engine.cancel(transfer.id);
			}
		}

		// Before the job is saved, so that a failure here leaves a job still marked as
		// running rather than a stopped one whose lines say they are still going.
		await this._lines.skipUnfinished(job.id);

		job.state = SyncJobState.CANCELLED;
		job.finishedAt = new Date();

		const model = toSyncJob(await this._jobs.save(job), await this._planName(job.planId));

		this._events.emit(EventName.JOB_STATE, model);

		return model;
	}

	/**
	 * Everything that can feed one transfer, best first.
	 *
	 * The item the transfer names is the source we chose when it was planned; the
	 * others are the services holding a copy we correlated with it. Several sources are
	 * not a luxury — they are what makes a slow friend's connection usable at all, and
	 * what a repair falls back to when one of them serves a bad range.
	 */
	public async resolveSources(transfer: TransferEntity): Promise<TransferSourceRef[]> {
		const item = await this._items.findOne({ where: { id: transfer.itemId } });

		if (item === null) {
			return [];
		}

		const siblings = await this._correlatedItems(item);
		const candidates = [item, ...siblings];
		// One read per service, and the only one that brings the credentials back. It
		// is a handful of rows — the services holding one episode — and keeping the
		// re-selection to that single repository method is what makes the places that
		// hold a token in memory countable.
		const services = new Map(
			await Promise.all(
				[...new Set(candidates.map((candidate) => candidate.serviceId))].map(
					async (serviceId) =>
						[serviceId, await this._services.findWithSecrets(serviceId)] as const,
				),
			),
		);

		return candidates
			.map((candidate) => ({ candidate, service: services.get(candidate.serviceId) ?? null }))
			.filter(
				(entry): entry is { candidate: MediaItem; service: MediaServiceEntity } =>
					entry.service !== null,
			)
			.sort((left, right) => left.service.priority - right.service.priority)
			.map(({ candidate, service }) => ({
				serviceId: service.id,
				serviceName: service.name,
				peerId: service.peerId,
				transport:
					service.peerId === null ? TransferTransport.HTTP_RANGE : TransferTransport.PEER_DIRECT,
				connection:
					service.peerId === null
						? {
							id: service.id,
							type: service.type,
							baseUrl: service.baseUrl,
							token: service.token,
							username: service.username,
							password: service.password,
						}
						: undefined,
				externalId: candidate.externalId,
				contentId: candidate.file?.contentId ?? null,
				sizeHint: candidate.file?.size ?? null,
			}));
	}

	/**
	 * The one computation preview and run share.
	 *
	 * Split into named steps rather than one traversal because every step is a rule
	 * somebody will argue about later: which services are asked, in what order, what
	 * counts as missing, and where the file lands.
	 */
	public async plan(request: RunSyncRequest): Promise<SyncPlanning> {
		const { effective, settings, wanted, estimate } = await this._select(request);
		const libraries = await this._placementLibraries();
		// Which category each item belongs to, so placement can look up the library that
		// category was configured to receive. Asked of the library manager rather than
		// folded from the library name here: the merge is its rule, and a second reading
		// of it would disagree with the keys the settings were saved under.
		const categoryKeys = await this._libraryManager.categoryKeysByLibrary();
		const services = new Map(
			(await this._services.find()).map((service) => [service.id, service.name]),
		);
		const items: PlannedItem[] = [];
		const planned = wanted.slice(0, MAX_PLANNED_ITEMS);
		const seriesTitles = await this._seriesTitles(planned.map((entry) => entry.item));
		const siblings = await this._localSiblings(planned.map((entry) => entry.item));

		/*
		 * Paths this plan has already handed out.
		 *
		 * Nothing is written while a plan is being built, so the filesystem answers
		 * "free" for every one of them — and two versions of one episode, which render
		 * the same name, would both be given it. The second transfer would then land on
		 * the first hours later, with the run reporting two successes.
		 */
		const claimed = new Set<string>();

		for (const entry of planned) {
			const nameable = {
				kind: entry.item.kind,
				title: entry.item.title,
				year: entry.item.year,
				seasonNumber: entry.item.seasonNumber,
				episodeNumber: entry.item.episodeNumber,
				seriesTitle: seriesTitles.get(entry.item.id) ?? null,
				sourcePath: entry.item.file?.path ?? null,
			};

			// Our own copy of the same show, if we have one: it is what the naming
			// service imitates, so a pulled episode lands beside its siblings in the
			// folders that library actually uses rather than in the ones a template
			// would have invented.
			const siblingPath =
				entry.local?.file?.path ?? siblings.get(entry.item.normalizedTitle) ?? null;

			// What tells this copy apart from the one already sitting where it wants to
			// land. Both are labels — the version itself is the fingerprint — and they
			// are only read when a name has to be found, never to decide anything.
			const marks = {
				edition: editionOf(entry.item.file),
				quality: this._quality.resolutionLabel(entry.item.file?.height ?? null),
			};

			const target = await this._placement.resolve({
				kind: entry.item.kind,
				categoryKey: categoryKeys.get(entry.item.libraryId) ?? null,
				settings,
				libraries,
				relativeName: (libraryRoot) =>
					this._naming.render(settings.namingOrder, nameable, { libraryRoot, siblingPath }),
				existingPath: entry.local?.file?.path ?? null,
				/*
				 * Our own copy of *this version* is the only file this pull may replace.
				 *
				 * It is null for a version we do not hold, which is precisely the case
				 * where landing on the rendered name would destroy another version. The
				 * price is visible and worth naming: running the same sync twice before
				 * the index has caught up leaves a second file beside the first rather
				 * than writing over it, because nothing in the index yet says the file
				 * there is ours. A duplicate somebody can delete beats a version nobody
				 * can get back.
				 */
				replacesPath: entry.local?.file?.path ?? null,
				disambiguate: (relativeName, attempt) =>
					this._naming.disambiguate(relativeName, marks, attempt),
				reserved: claimed,
				preferredLibraryId: effective.preferredLibraryId,
				preferredBy: effective.preferredBy,
				requiredBytes: entry.item.file?.size ?? 0,
			});

			claimed.add(target.path);

			items.push({
				itemId: entry.item.id,
				localItemId: entry.local?.id ?? null,
				title: entry.item.title,
				kind: entry.item.kind,
				sourceServiceId: entry.item.serviceId,
				sourceServiceName: services.get(entry.item.serviceId) ?? '',
				targetLibraryId: target.libraryId,
				targetLibraryName: target.libraryName,
				targetPath: target.path,
				placedBy: target.placedBy,
				bytes: entry.item.file?.size ?? 0,
				contentId: entry.item.file?.contentId ?? null,
				state: entry.state,
			});
		}

		// The ceilings cut here rather than in `run()`, so that what a preview shows is
		// what a run does — including the part it will not do. A preview that ignored
		// them would promise four hundred episodes and deliver fifty.
		const cut = applyCeilings(items, effective.ceilings);
		const bytesPlanned = cut.kept.reduce((total, item) => total + item.bytes, 0);

		return {
			items: cut.kept,
			itemsPlanned: cut.kept.length,
			bytesPlanned,
			dropped: cut.dropped,
			scope: effective.scope,
			estimate,
			targets: await this._targets(cut.kept, libraries, settings),
			stoppedBy: cut.stoppedBy,
		};
	}

	/**
	 * What the request covers that nothing local holds, and what that comes to.
	 *
	 * The half of planning that needs no destination, split out so the estimate can
	 * be answered on a gateway that has none — see `estimateScope`. Everything that
	 * decides *what* is wanted lives here; everything that decides *where* it goes
	 * stays in `plan()`, so the two can never count differently.
	 */
	private async _select(request: RunSyncRequest): Promise<{
		effective: EffectiveRequest;
		settings: Settings;
		wanted: WantedItem[];
		estimate: SyncEstimate;
	}> {
		const effective = await this._effective(request);
		const settings = await this._settings.get();
		const order = await this._sourceOrder(effective.sourceServiceIds);
		const rank = new Map(order.map((serviceId, index) => [serviceId, index]));
		const candidates = await this._candidates(effective, order);
		const counterparts = await this._counterparts(candidates);
		const localServiceIds = new Set(
			(await this._services.findLocal()).map((service) => service.id),
		);

		// Grouped before anything is decided, and that order matters. "Do we already
		// hold this?" is a question about a piece of media, not about a row: the same
		// episode is a row per service, and answering row by row would drop the copy we
		// have and then plan a transfer of the identical copy sitting beside it.
		const groups = new Map<string, MediaItem[]>();

		for (const candidate of candidates) {
			// Only a node that carries a file can be transferred. A series is a folder,
			// and planning one would produce a transfer with nothing to fetch.
			if (candidate.file === null) {
				continue;
			}

			const key = this._identity(candidate);

			groups.set(key, [...(groups.get(key) ?? []), candidate]);
		}

		const wanted: WantedItem[] = [];

		for (const members of groups.values()) {
			// The same episode on three services is one transfer, from whichever of them
			// the order puts first. Keeping all three would pull it three times into the
			// same path.
			const source = members
				.filter((member) => !localServiceIds.has(member.serviceId))
				.sort(
					(left, right) =>
						(rank.get(left.serviceId) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(right.serviceId) ?? Number.MAX_SAFE_INTEGER),
				)[0];

			// Nothing but local copies: there is no source to pull from, and the media is
			// already where it belongs.
			if (source === undefined) {
				continue;
			}

			/*
			 * Our own copy is either one of the rows of this group — the same media on a
			 * local service — or a row correlated with one of them. Both count: what
			 * makes something missing is that nothing local holds it.
			 *
			 * Except a different cut, which holds another version and not this one. Two
			 * cuts of one film are correlated on purpose — one work, shown as one group in
			 * `conflict` — and counting the theatrical copy on our disk as holding the
			 * extended one would answer somebody who ticked the extended cut with a run
			 * that fetches nothing. `_counterparts` drops the correlated half of that; the
			 * test here drops the other half, two cuts nobody fingerprinted, which fall
			 * into one bucket of `_identity` because nothing tells them apart but a clock.
			 */
			const local =
				members.find(
					(member) =>
						localServiceIds.has(member.serviceId)
						&& !this._quality.isConflicting(member.file, source.file),
				) ??
				members
					.flatMap((member) => counterparts.get(member.id) ?? [])
					.find((other) => localServiceIds.has(other.serviceId)) ??
				null;

			/*
			 * A file already on our disk is not missing, whatever the absence of a local
			 * row suggests.
			 *
			 * The landing writes `awaiting_index` on the very row a pull came from, and
			 * nothing local holds the media until the media server has indexed it — so
			 * the reading below would call it missing and every run would fetch it again
			 * into the same folder. That is the bug those two states were added for, and
			 * this is the place a plan reads them.
			 */
			const state = LANDED_SYNC_STATES.includes(source.syncState)
				? source.syncState
				: local === null
					? SyncState.MISSING
					: source.syncState;

			if (this._keeps(source, local, state, effective.filter)) {
				wanted.push({ item: source, local, state });
			}
		}

		// Taken over everything the scope covers, before the ceilings and before the
		// walk's own limit, because that is the question the estimate answers: what this
		// plan is for, not what the next run of it will do.
		const estimate: SyncEstimate = {
			itemCount: wanted.length,
			bytes: wanted.reduce((total, entry) => total + (entry.item.file?.size ?? 0), 0),
			unbounded: isUnbounded(effective.scope),
			truncated: wanted.length > MAX_PLANNED_ITEMS,
			computedAt: new Date().toISOString(),
		};

		return { effective, settings, wanted, estimate };
	}

	/**
	 * Every destination this would write into, with the room left after it.
	 *
	 * Grouped by library rather than reported per file, because free space is a
	 * property of the filesystem and not of a transfer: twelve episodes of two
	 * gigabytes into a library with three free is the sentence somebody needs, and
	 * checking each file on its own would pass all twelve.
	 *
	 * The probe goes through the library manager — the same one `make library/check`
	 * uses — so that the free space shown before a run and the free space shown on the
	 * libraries screen can never be two different measurements of the same disk.
	 */
	private async _targets(
		items: PlannedItem[],
		libraries: PlacementLibrary[],
		settings: Settings,
	): Promise<TargetSpace[]> {
		const grouped = new Map<string, { name: string; path: string | null; bytes: number }>();

		for (const item of items) {
			const library = libraries.find((candidate) => candidate.id === item.targetLibraryId);
			const existing = grouped.get(item.targetLibraryId);

			grouped.set(item.targetLibraryId, {
				name: library?.name ?? item.targetLibraryName,
				// A fixed path outside every registered library has no `localPath` to
				// ask about, so the destination directory itself is probed. It answers
				// for the same filesystem, which is the only thing this number is about.
				path: library?.localPath ?? dirname(item.targetPath),
				bytes: (existing?.bytes ?? 0) + item.bytes,
			});
		}

		return Promise.all(
			[...grouped.entries()].map(async ([libraryId, group]) => {
				const probe = await this._libraryManager.probe(group.path);

				return targetSpace({
					libraryId,
					libraryName: group.name,
					localPath: group.path,
					freeBytes: probe.freeBytes,
					requiredBytes: group.bytes,
					reserveBytes: settings.diskReserveBytes,
				});
			}),
		);
	}

	/**
	 * The plan's fields, overridden by whatever the request said explicitly.
	 *
	 * The scope is taken whole rather than merged field by field: a request that names
	 * three shows means those three shows, not those three shows plus whatever the plan
	 * also covered.
	 */
	private async _effective(request: RunSyncRequest): Promise<EffectiveRequest> {
		const plan = request.planId === undefined ? null : await this._requirePlan(request.planId);

		return {
			planId: plan?.id ?? null,
			scope: request.scope ?? plan?.scope ?? {},
			sourceServiceIds: request.sourceServiceIds ?? plan?.sourceServiceIds ?? [],
			preferredLibraryId:
				request.targetLibraryId === undefined
					? (plan?.preferredLibraryId ?? null)
					: request.targetLibraryId,
			// A request that named a library named it for this run alone, and the line
			// has to say so: somebody reading it next month must not be sent to edit a
			// plan whose preference had nothing to do with where that file went.
			preferredBy:
				request.targetLibraryId === undefined
					? PlacedBy.PLAN_PREFERENCE
					: PlacedBy.REQUESTED,
			filter: request.filter ?? plan?.filter ?? {},
			ceilings: {
				maxItems:
					request.maxItemsPerRun === undefined
						? (numberOrNull(plan?.maxItemsPerRun) ?? null)
						: request.maxItemsPerRun,
				maxBytes:
					request.maxBytesPerRun === undefined
						? (numberOrNull(plan?.maxBytesPerRun) ?? null)
						: request.maxBytesPerRun,
			},
		};
	}

	/**
	 * Which services are asked, and in what order.
	 *
	 * An empty list is the normal case and means the priority set in the administration
	 * screen. Reading it here rather than pinning it into every plan is what keeps a
	 * change of priority from requiring every plan to be edited.
	 */
	private async _sourceOrder(sourceServiceIds: string[]): Promise<string[]> {
		if (sourceServiceIds.length > 0) {
			return sourceServiceIds;
		}

		return (await this._services.findByPriority()).map((service) => service.id);
	}

	/**
	 * Everything the scope covers, on the services we are allowed to ask.
	 *
	 * The fields of a scope intersect. Naming both a category and a subtree means the
	 * part of that subtree in that category, which is the reading somebody filling in a
	 * form expects — and an empty intersection is an empty run, not everything.
	 */
	private async _candidates(
		effective: EffectiveRequest,
		order: string[],
	): Promise<MediaItem[]> {
		if (order.length === 0) {
			throw new NotFoundException(ErrorKey.SYNC_NO_SOURCE);
		}

		const scope = effective.scope;
		const libraryIds = await this._scopedLibraries(scope);
		const itemIds = await this._scopedItems(scope);

		if (libraryIds?.length === 0 || itemIds?.length === 0) {
			// The scope named something that resolves to nothing — a category whose
			// libraries have all gone, a subtree that was deleted. Nothing is the right
			// answer; falling through would run it against everything.
			return [];
		}

		const where: FindOptionsWhere<MediaItem> = { serviceId: In(order) };

		if (libraryIds !== null) {
			where.libraryId = In(libraryIds);
		}

		if (itemIds !== null) {
			where.id = In(itemIds);
		}

		return this._items.find({ where });
	}

	/**
	 * The libraries a scope names, categories resolved. Null means "no restriction".
	 *
	 * A merged category is the unit people think in — "keep my Shows in step" is one
	 * intent — and naming the four libraries called Shows across three servers is not
	 * the same thing: it stops being true the moment somebody adds a fourth server.
	 */
	private async _scopedLibraries(scope: SyncScope): Promise<string[] | null> {
		const explicit = scope.libraryIds ?? [];
		const keys = scope.categoryKeys ?? [];

		if (keys.length === 0) {
			return explicit.length === 0 ? null : explicit;
		}

		const merged = new Set<string>();

		for (const key of keys) {
			for (const libraryId of await this._libraryManager.librariesOfCategory(key)) {
				merged.add(libraryId);
			}
		}

		return explicit.length === 0
			? [...merged]
			: explicit.filter((libraryId) => merged.has(libraryId));
	}

	/** The items a scope names, subtrees expanded. Null means "no restriction". */
	private async _scopedItems(scope: SyncScope): Promise<string[] | null> {
		const roots = scope.rootItemIds ?? [];
		const explicit = scope.itemIds ?? [];

		if (roots.length === 0) {
			return explicit.length === 0 ? null : explicit;
		}

		const within = await this._descendants(roots);

		return explicit.length === 0
			? [...within]
			: explicit.filter((itemId) => within.has(itemId));
	}

	/** Everything under these nodes, the nodes themselves included. */
	private async _descendants(rootItemIds: string[]): Promise<Set<string>> {
		const seen = new Set<string>(rootItemIds);
		let frontier = [...rootItemIds];

		while (frontier.length > 0) {
			const children = await this._items.find({ where: { parentId: In(frontier) } });

			frontier = children.map((child) => child.id).filter((id) => !seen.has(id));

			for (const id of frontier) {
				seen.add(id);
			}
		}

		return seen;
	}

	/**
	 * Every item correlated with each candidate that can stand in for it, by candidate
	 * identifier. See `_interchangeable` for the ones that cannot.
	 */
	private async _counterparts(candidates: MediaItem[]): Promise<Map<string, MediaItem[]>> {
		const ids = candidates.map((candidate) => candidate.id);

		if (ids.length === 0) {
			return new Map();
		}

		const matches = await this._matches.find({
			where: [{ localItemId: In(ids) }, { remoteItemId: In(ids) }],
		});

		const otherIds = new Set<string>();

		for (const match of matches) {
			if (match.localItemId !== null) {
				otherIds.add(match.localItemId);
			}

			otherIds.add(match.remoteItemId);
		}

		const others = new Map(
			(otherIds.size === 0
				? []
				: await this._items.find({ where: { id: In([...otherIds]) } })
			).map((item) => [item.id, item]),
		);

		const byCandidate = new Map<string, MediaItem[]>();
		const mine = new Map(candidates.map((candidate) => [candidate.id, candidate]));
		const push = (match: MediaMatchEntity, candidateId: string, otherId: string | null): void => {
			const candidate = mine.get(candidateId) ?? others.get(candidateId);
			const other = otherId === null ? undefined : others.get(otherId);

			if (other === undefined || other.id === candidateId) {
				return;
			}

			if (candidate !== undefined && !this._interchangeable(match, candidate, other)) {
				return;
			}

			byCandidate.set(candidateId, [...(byCandidate.get(candidateId) ?? []), other]);
		};

		for (const match of matches) {
			push(match, match.remoteItemId, match.localItemId);

			if (match.localItemId !== null) {
				push(match, match.localItemId, match.remoteItemId);
			}
		}

		return byCandidate;
	}

	/** The copies correlated with this one that can serve its bytes. */
	private async _correlatedItems(item: MediaItem): Promise<MediaItem[]> {
		const matches = await this._matches.find({
			where: [{ localItemId: item.id }, { remoteItemId: item.id }],
		});

		const byOther = new Map<string, MediaMatchEntity>();

		for (const match of matches) {
			if (match.localItemId !== null && match.localItemId !== item.id) {
				byOther.set(match.localItemId, match);
			}

			if (match.remoteItemId !== item.id) {
				byOther.set(match.remoteItemId, match);
			}
		}

		if (byOther.size === 0) {
			return [];
		}

		const others = await this._items.find({ where: { id: In([...byOther.keys()]) } });

		return others.filter((other) =>
			this._interchangeable(byOther.get(other.id) as MediaMatchEntity, item, other),
		);
	}

	/**
	 * Whether a correlated copy can stand in for this one.
	 *
	 * Three readers ask, and all three would do damage with a different cut: the plan,
	 * which would count the theatrical copy on our disk as holding the extended one and
	 * fetch nothing; the transfer, which would take ranges from both files and assemble
	 * a third that is neither; and the companion pull, which would lay subtitles timed
	 * against one cut over the other, drifting by however many minutes the cuts differ.
	 *
	 * A conflict is only interchangeable when the two are the same bytes. That is the
	 * other kind of conflict — one file filed under two different episode numbers —
	 * where the content is proven identical and only the label is in dispute, and where
	 * refusing would have the gateway fetch a file it already holds.
	 */
	private _interchangeable(match: MediaMatchEntity, left: MediaItem, right: MediaItem): boolean {
		return match.state !== SyncState.CONFLICT || sameContent(left.file, right.file);
	}

	/**
	 * Does this candidate survive the filter?
	 *
	 * `missingOnly` and `replaceOutdated` are the two that decide whether an existing
	 * local file is ever overwritten, and they are the ones somebody will be angry
	 * about if they are wrong: the default is to never replace anything.
	 */
	private _keeps(
		candidate: MediaItem,
		local: MediaItem | null,
		state: SyncState,
		filter: SyncFilter,
	): boolean {
		// The bytes are here and the index has not caught up. Pulling again would write
		// the same file to the same path, which is a download bought for nothing — and
		// with a second name beside the first, since nothing yet says the file there is
		// ours.
		if (LANDED_SYNC_STATES.includes(state)) {
			return false;
		}

		if (local !== null && !(filter.replaceOutdated === true && state === SyncState.OUTDATED)) {
			return false;
		}

		if (filter.missingOnly === true && state !== SyncState.MISSING) {
			return false;
		}

		if (filter.kinds !== undefined && filter.kinds.length > 0 && !filter.kinds.includes(candidate.kind)) {
			return false;
		}

		if (filter.minYear !== undefined && (candidate.year ?? 0) < filter.minYear) {
			return false;
		}

		if (filter.maxBytes !== undefined && (candidate.file?.size ?? 0) > filter.maxBytes) {
			return false;
		}

		if (
			filter.titleMatches !== undefined &&
			filter.titleMatches !== '' &&
			!candidate.normalizedTitle.includes(filter.titleMatches.toLowerCase())
		) {
			return false;
		}

		return true;
	}

	/**
	 * What makes two rows the same thing to pull.
	 *
	 * The same key the correlation indexes on, plus the version. Using the item
	 * identifier instead would plan one transfer per service holding the episode, which
	 * is the failure this grouping exists to prevent — and using the title alone, which
	 * is what it did, collapsed two versions of one media into a single transfer, so
	 * asking for the extended cut and the theatrical one fetched whichever the service
	 * order put first and reported that the other had been dealt with.
	 *
	 * A row nobody has fingerprinted has no version and falls into the one bucket it
	 * used to share with everything else. That is deliberately the old behaviour: it
	 * keeps the same file on three unfingerprinted services one transfer, where giving
	 * each row an identity of its own would download it three times into one path.
	 */
	private _identity(item: MediaItem): string {
		return [
			item.kind,
			item.normalizedTitle,
			item.seasonNumber ?? '',
			item.episodeNumber ?? '',
			versionIdOf(item.file) ?? '',
		].join('|');
	}

	private async _placementLibraries(): Promise<PlacementLibrary[]> {
		const local = await this._services.findLocal();
		const libraries = await this._libraries.findByServices(local.map((service) => service.id));

		return libraries.map((library: LibraryEntity) => ({
			id: library.id,
			name: library.name,
			kind: library.kind,
			localPath: library.localPath,
			writable: library.writable,
			isDefaultTarget: library.isDefaultTarget,
		}));
	}

	private async _reschedule(): Promise<void> {
		this._scheduler.registerPlans(await this._plans.find());
	}

	private async _planName(planId: string | null): Promise<string | null> {
		if (planId === null) {
			return null;
		}

		const plan = await this._plans.findOne({ where: { id: planId } });

		return plan?.name ?? null;
	}

	private async _planNames(jobs: SyncJobEntity[]): Promise<Map<string, string>> {
		const ids = [...new Set(jobs.map((job) => job.planId).filter((id): id is string => id !== null))];

		if (ids.length === 0) {
			return new Map();
		}

		const plans = await this._plans.find({ where: { id: In(ids) } });

		return new Map(plans.map((plan) => [plan.id, plan.name]));
	}

	private async _requirePlan(id: string): Promise<SyncPlanEntity> {
		const plan = await this._plans.findOne({ where: { id } });

		if (plan === null) {
			throw new NotFoundException(ErrorKey.SYNC_PLAN_NOT_FOUND);
		}

		return plan;
	}

	private async _requireJob(id: string): Promise<SyncJobEntity> {
		const job = await this._jobs.findOne({ where: { id } });

		if (job === null) {
			throw new NotFoundException(ErrorKey.SYNC_JOB_NOT_FOUND);
		}

		return job;
	}

	/**
	 * The show's title for each episode, resolved through the parent chain.
	 *
	 * An episode's own title is the episode's — `Back to the Butcher` — and filing a
	 * season under it would give a library one folder per episode. The series row has
	 * the title that belongs on the folder, two hops up.
	 *
	 * Batched because the alternative is two queries per planned item, and a plan is
	 * five hundred of them.
	 */
	private async _seriesTitles(items: MediaItem[]): Promise<Map<string, string>> {
		const episodes = items.filter(
			(item) => item.kind === MediaKind.EPISODE && item.parentId !== null,
		);

		if (episodes.length === 0) {
			return new Map();
		}

		const seasons = await this._items.find({
			where: { id: In([...new Set(episodes.map((item) => item.parentId as string))]) },
		});
		const seasonById = new Map(seasons.map((season) => [season.id, season]));
		const seriesIds = [
			...new Set(seasons.map((season) => season.parentId).filter((id): id is string => id !== null)),
		];
		const series = seriesIds.length
			? await this._items.find({ where: { id: In(seriesIds) } })
			: [];
		const seriesById = new Map(series.map((one) => [one.id, one]));

		const titles = new Map<string, string>();

		for (const episode of episodes) {
			const season = seasonById.get(episode.parentId as string);
			const show = season?.parentId ? seriesById.get(season.parentId) : undefined;
			const title = show?.title ?? season?.title ?? null;

			if (title) {
				titles.set(episode.id, title);
			}
		}

		return titles;
	}

	/**
	 * One local file per show, for the naming service to imitate.
	 *
	 * Keyed on the normalised title because that is what makes two libraries agree
	 * about which show something belongs to — the display titles differ, the normalised
	 * form is what correlation already joins on.
	 */
	private async _localSiblings(items: MediaItem[]): Promise<Map<string, string>> {
		const titles = [...new Set(items.map((item) => item.normalizedTitle))].filter(
			(title) => title !== '',
		);

		if (titles.length === 0) {
			return new Map();
		}

		const localServices = (await this._services.find())
			.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
			.map((service) => service.id);

		if (localServices.length === 0) {
			return new Map();
		}

		const rows = await this._items.find({
			where: { normalizedTitle: In(titles), serviceId: In(localServices) },
		});
		const libraries = new Map(
			(await this._libraries.find()).map((library) => [library.id, library]),
		);
		const siblings = new Map<string, string>();

		for (const row of rows) {
			const library = libraries.get(row.libraryId);

			// Translated, because the path on the row is the one the media service
			// reported — its own. Jellyfin says `/media/Shows/…` where the gateway sees
			// `/mnt/nas/Shows/…`, and an untranslated path simply never matches the
			// destination root: the imitation is skipped in silence and every pull
			// lands in a folder a template invented.
			const path = library ? toLocalPath(library, row.file?.path ?? null) : null;

			if (path && !siblings.has(row.normalizedTitle)) {
				siblings.set(row.normalizedTitle, path);
			}
		}

		return siblings;
	}

}

/**
 * A scope made of subtrees and nothing else, which is the only kind another one can
 * be added to.
 *
 * "These three shows" is one intent and `rootItemIds` is plural for it. Every other
 * field of a scope intersects with the roots, so adding a show to a plan that also
 * names a category or a library silently means "the part of that show in that
 * category" — an answer nobody asked for, written into somebody else's plan.
 */
export const isSubtreeScope = (scope: SyncScope): boolean =>
	(scope.rootItemIds?.length ?? 0) > 0 &&
	(scope.categoryKeys?.length ?? 0) === 0 &&
	(scope.libraryIds?.length ?? 0) === 0 &&
	(scope.itemIds?.length ?? 0) === 0;

/**
 * A scope that names nothing, which means every item on every source.
 *
 * Its own test rather than something inferred from a large count, because the
 * interface refuses to enable an unbounded schedule without an explicit
 * acknowledgement — and "large" is not a decidable test. An empty array counts as
 * naming nothing: a form that cleared its last category is back to everything.
 */
export const isUnbounded = (scope: SyncScope): boolean =>
	(scope.categoryKeys?.length ?? 0) === 0 &&
	(scope.libraryIds?.length ?? 0) === 0 &&
	(scope.rootItemIds?.length ?? 0) === 0 &&
	(scope.itemIds?.length ?? 0) === 0;

/**
 * What one line of a run is doing, from what its transfer is doing.
 *
 * A paused transfer reads as pending rather than as a state of its own: nothing is
 * moving and it will be, which is what pending means here. A cancelled one is skipped,
 * because the line was planned and then dropped — the same thing a ceiling does to it,
 * and the same thing somebody reading the run needs to see.
 */
export const jobItemStateOf = (state: TransferState): SyncJobItemState => {
	switch (state) {
		case TransferState.DONE:
			return SyncJobItemState.DONE;
		case TransferState.FAILED:
			return SyncJobItemState.FAILED;
		case TransferState.CANCELLED:
			return SyncJobItemState.SKIPPED;
		case TransferState.QUEUED:
		case TransferState.PAUSED:
			return SyncJobItemState.PENDING;
		default:
			return SyncJobItemState.RUNNING;
	}
};

/**
 * A `bigint` column as a number, keeping null as null.
 *
 * Depending on the driver a `bigint` comes back as a string, and `Number(null)` is
 * zero — which would turn "no ceiling" into "a ceiling of nothing" and stop every run
 * of that plan dead.
 */
const numberOrNull = (value: number | string | null | undefined): number | null =>
	value === null || value === undefined ? null : Number(value);
