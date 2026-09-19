import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
	ErrorKey,
	EventName,
	SyncJobState,
	SyncState,
	SyncTrigger,
	TransferState,
	TransferTransport,
	type CreateSyncPlanRequest,
	type MediaKind,
	type ResultList,
	type RunSyncRequest,
	type SyncFilter,
	type Settings,
	type SyncJob,
	type SyncPlan,
	type SyncPreview,
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
import { In } from 'typeorm';
import type { MediaConfig } from '@/config';
import type {
	Library as LibraryEntity,
	MediaItem,
	MediaService as MediaServiceEntity,
	SyncJob as SyncJobEntity,
	SyncPlan as SyncPlanEntity,
	Transfer as TransferEntity,
} from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	SyncJobRepository,
	SyncPlanRepository,
	TransferRepository,
} from '@/repositories';
import {
	EventGatewayService,
	MetadataService,
	NamingService,
	PlacementService,
	SchedulerService,
	SettingsService,
	TransferEngineService,
	type PlacementLibrary,
	type TransferSourceRef,
} from '@/services';
import { pageBounds, paginate, toSyncJob, toSyncPlan } from './mappers';

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
	targetPath: string;
	bytes: number;
	contentId: string | null;
	state: SyncState;
}

export interface SyncPlanning {
	items: PlannedItem[];
	itemsPlanned: number;
	bytesPlanned: number;
}

/** A run request with the plan behind it already folded in. */
interface EffectiveRequest {
	planId: string | null;
	itemIds: string[];
	rootItemId: string | null;
	sourceServiceIds: string[];
	targetLibraryId: string | null;
	filter: SyncFilter;
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
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _transfers: TransferRepository,
		private readonly _settings: SettingsService,
		private readonly _naming: NamingService,
		private readonly _metadata: MetadataService,
		private readonly _placement: PlacementService,
		private readonly _engine: TransferEngineService,
		private readonly _scheduler: SchedulerService,
		private readonly _events: EventGatewayService,
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

		return plans.map(toSyncPlan);
	}

	public async readPlan(id: string): Promise<SyncPlan> {
		return toSyncPlan(await this._requirePlan(id));
	}

	public async createPlan(request: CreateSyncPlanRequest): Promise<SyncPlan> {
		const plan = await this._plans.save(
			this._plans.create({
				name: request.name,
				trigger: request.trigger,
				schedule: request.schedule ?? null,
				sourceServiceIds: request.sourceServiceIds ?? [],
				targetLibraryId: request.targetLibraryId ?? null,
				rootItemId: request.rootItemId ?? null,
				filter: request.filter ?? {},
				enabled: request.enabled ?? true,
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
		plan.targetLibraryId =
			patch.targetLibraryId === undefined ? plan.targetLibraryId : patch.targetLibraryId;
		plan.rootItemId = patch.rootItemId === undefined ? plan.rootItemId : patch.rootItemId;
		plan.filter = patch.filter ?? plan.filter;
		plan.enabled = patch.enabled ?? plan.enabled;

		const saved = await this._plans.save(plan);

		await this._reschedule();

		return toSyncPlan(saved);
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

		const job = await this._jobs.save(
			this._jobs.create({
				planId: request.planId ?? null,
				state: planning.items.length === 0 ? SyncJobState.DONE : SyncJobState.RUNNING,
				trigger,
				startedAt: new Date(),
				finishedAt: planning.items.length === 0 ? new Date() : null,
				itemsPlanned: planning.itemsPlanned,
				bytesPlanned: planning.bytesPlanned,
			}),
		);

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

	public async jobs(query: {
		page?: number;
		limit?: number;
		state?: SyncJobState;
	}): Promise<ResultList<SyncJob>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [jobs, total] = await this._jobs.findAndCount({
			where: query.state === undefined ? {} : { state: query.state },
			order: { createdAt: 'DESC' },
			skip: (page - 1) * limit,
			take: limit,
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

		const siblings = await this._correlatedItems(item.id);
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

		const wanted: { item: MediaItem; local: MediaItem | null; state: SyncState }[] = [];

		for (const members of groups.values()) {
			// Our own copy is either one of the rows of this group — the same media on a
			// local service — or a row correlated with one of them. Both count: what
			// makes something missing is that nothing local holds it.
			const local =
				members.find((member) => localServiceIds.has(member.serviceId)) ??
				members
					.flatMap((member) => counterparts.get(member.id) ?? [])
					.find((other) => localServiceIds.has(other.serviceId)) ??
				null;

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

			const state = local === null ? SyncState.MISSING : source.syncState;

			if (this._keeps(source, local, state, effective.filter)) {
				wanted.push({ item: source, local, state });
			}
		}

		const libraries = await this._placementLibraries();
		const services = new Map(
			(await this._services.find()).map((service) => [service.id, service.name]),
		);
		const items: PlannedItem[] = [];
		let bytesPlanned = 0;

		for (const entry of wanted.slice(0, MAX_PLANNED_ITEMS)) {
			const relativeName = this._naming.render(settings.naming, {
				kind: entry.item.kind,
				title: entry.item.title,
				year: entry.item.year,
				seasonNumber: entry.item.seasonNumber,
				episodeNumber: entry.item.episodeNumber,
				sourcePath: entry.item.file?.path ?? null,
			});

			const target = await this._placement.resolve({
				kind: entry.item.kind,
				settings,
				libraries,
				relativeName,
				existingPath: entry.local?.file?.path ?? null,
				preferredLibraryId: effective.targetLibraryId,
				requiredBytes: entry.item.file?.size ?? 0,
			});

			bytesPlanned += entry.item.file?.size ?? 0;

			items.push({
				itemId: entry.item.id,
				localItemId: entry.local?.id ?? null,
				title: entry.item.title,
				kind: entry.item.kind,
				sourceServiceId: entry.item.serviceId,
				sourceServiceName: services.get(entry.item.serviceId) ?? '',
				targetLibraryId: target.libraryId,
				targetPath: target.path,
				bytes: entry.item.file?.size ?? 0,
				contentId: entry.item.file?.contentId ?? null,
				state: entry.state,
			});
		}

		return { items, itemsPlanned: items.length, bytesPlanned };
	}

	/** The plan's fields, overridden by whatever the request said explicitly. */
	private async _effective(request: RunSyncRequest): Promise<EffectiveRequest> {
		const plan = request.planId === undefined ? null : await this._requirePlan(request.planId);

		return {
			planId: plan?.id ?? null,
			itemIds: request.itemIds ?? [],
			rootItemId: request.rootItemId ?? plan?.rootItemId ?? null,
			sourceServiceIds: request.sourceServiceIds ?? plan?.sourceServiceIds ?? [],
			targetLibraryId:
				request.targetLibraryId === undefined
					? (plan?.targetLibraryId ?? null)
					: request.targetLibraryId,
			filter: request.filter ?? plan?.filter ?? {},
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

	private async _candidates(
		effective: EffectiveRequest,
		order: string[],
	): Promise<MediaItem[]> {
		if (effective.itemIds.length > 0) {
			return this._items.find({ where: { id: In(effective.itemIds) } });
		}

		if (order.length === 0) {
			throw new NotFoundException(ErrorKey.SYNC_NO_SOURCE);
		}

		const withinRoot =
			effective.rootItemId === null ? null : await this._descendants(effective.rootItemId);

		const items = await this._items.find({
			where:
				withinRoot === null
					? { serviceId: In(order) }
					: { serviceId: In(order), id: In([...withinRoot]) },
		});

		return items;
	}

	/** Everything under one node, the node itself included. */
	private async _descendants(rootItemId: string): Promise<Set<string>> {
		const seen = new Set<string>([rootItemId]);
		let frontier = [rootItemId];

		while (frontier.length > 0) {
			const children = await this._items.find({ where: { parentId: In(frontier) } });

			frontier = children.map((child) => child.id).filter((id) => !seen.has(id));

			for (const id of frontier) {
				seen.add(id);
			}
		}

		return seen;
	}

	/** Every item correlated with each candidate, by candidate identifier. */
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
		const push = (candidateId: string, otherId: string | null): void => {
			const other = otherId === null ? undefined : others.get(otherId);

			if (other === undefined || other.id === candidateId) {
				return;
			}

			byCandidate.set(candidateId, [...(byCandidate.get(candidateId) ?? []), other]);
		};

		for (const match of matches) {
			push(match.remoteItemId, match.localItemId);

			if (match.localItemId !== null) {
				push(match.localItemId, match.remoteItemId);
			}
		}

		return byCandidate;
	}

	private async _correlatedItems(itemId: string): Promise<MediaItem[]> {
		const matches = await this._matches.find({
			where: [{ localItemId: itemId }, { remoteItemId: itemId }],
		});

		const ids = new Set<string>();

		for (const match of matches) {
			if (match.localItemId !== null && match.localItemId !== itemId) {
				ids.add(match.localItemId);
			}

			if (match.remoteItemId !== itemId) {
				ids.add(match.remoteItemId);
			}
		}

		return ids.size === 0 ? [] : this._items.find({ where: { id: In([...ids]) } });
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
	 * What makes two rows the same media.
	 *
	 * The same key the correlation indexes on. Using the item identifier instead would
	 * plan one transfer per service holding the episode, which is the failure this
	 * grouping exists to prevent.
	 */
	private _identity(item: MediaItem): string {
		return [item.kind, item.normalizedTitle, item.seasonNumber ?? '', item.episodeNumber ?? ''].join('|');
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
}
