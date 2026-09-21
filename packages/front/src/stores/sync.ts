import type {
	CreateSyncPlanForItemRequest,
	CreateSyncPlanRequest,
	EstimateSyncRequest,
	HistoryView,
	ItemSyncPlans,
	Pagination,
	ResultList,
	RunSyncRequest,
	SyncEstimate,
	SyncJob,
	SyncJobState,
	SyncPlan,
	SyncPreview,
	UpdateSyncPlanRequest,
} from '@mcs/shared';
import { EventName } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 20, total: 0, pages: 0 };

export interface JobQuery {
	page?: number;
	limit?: number;
	state?: SyncJobState | null;
	/** Which half of the history to ask for. Omitted means all of it. */
	view?: HistoryView | null;
}

/**
 * Sync plans and their runs.
 *
 * Plans are bounded by what somebody wrote, so they are held whole; jobs grow
 * without limit and are paginated. Running jobs arrive on the stream, which is
 * the only reason a progress figure on this screen moves at all.
 */
export const useSyncStore = defineStore('sync', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const plans = ref<SyncPlan[]>([]);
	const jobs = ref<SyncJob[]>([]);
	const jobsPagination = ref<Pagination>({ ...EMPTY_PAGINATION });
	const loadingPlans = ref(false);
	const loadingJobs = ref(false);
	const plansLoaded = ref(false);
	const jobsLoaded = ref(false);
	const error = ref<unknown>(null);

	const planById = computed(() => {
		const map: Record<string, SyncPlan> = {};
		for (const plan of plans.value) {
			map[plan.id] = plan;
		}
		return map;
	});

	function replacePlan (plan: SyncPlan): void {
		const index = plans.value.findIndex(one => one.id === plan.id);
		if (index === -1) {
			plans.value = [...plans.value, plan];
		} else {
			plans.value[index] = plan;
		}
	}

	async function loadPlans (): Promise<SyncPlan[]> {
		loadingPlans.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<SyncPlan[]>('/sync/plans', {
				keepLastKey: 'sync|plans',
			});
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			plans.value = Array.isArray(loadedList) ? loadedList : [];
			plansLoaded.value = true;
			return plans.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loadingPlans.value = false;
		}
	}

	async function plan (id: string): Promise<SyncPlan> {
		const found = await caller('api').get<SyncPlan>(`/sync/plans/${id}`);
		replacePlan(found);
		return found;
	}

	async function createPlan (request: CreateSyncPlanRequest): Promise<SyncPlan> {
		const created = await caller('api').post<SyncPlan>('/sync/plans', request);
		replacePlan(created);
		return created;
	}

	/**
	 * Which plans already speak for a media, and what a new one would be called.
	 *
	 * Asked of the gateway rather than worked out from `plans`: a plan on a series
	 * covers every season under it, and answering that here would mean walking the
	 * parent chain in the browser and keeping a second reading of what a scope means.
	 */
	function itemPlans (itemId: string): Promise<ItemSyncPlans> {
		return caller('api').get<ItemSyncPlans>(`/sync/plans/for-item/${itemId}`);
	}

	/** Keep one media in sync: a plan scoped to it, or that subtree added to one. */
	async function createPlanForItem (request: CreateSyncPlanForItemRequest): Promise<SyncPlan> {
		const created = await caller('api').post<SyncPlan>('/sync/plans/for-item', request);
		replacePlan(created);
		return created;
	}

	/**
	 * What a scope comes to, for a plan nobody has saved yet.
	 *
	 * The counterpart of the plan's own estimate for the moment before there is a plan
	 * to address, and computed by the same code a run is: what somebody is shown before
	 * undertaking a whole show is the arithmetic the first run will do.
	 */
	function estimateScope (request: EstimateSyncRequest): Promise<SyncEstimate> {
		return caller('api').post<SyncEstimate>('/sync/estimate', request);
	}

	async function updatePlan (id: string, request: UpdateSyncPlanRequest): Promise<SyncPlan> {
		const updated = await caller('api').patch<SyncPlan>(`/sync/plans/${id}`, request);
		replacePlan(updated);
		return updated;
	}

	async function deletePlan (id: string): Promise<void> {
		await caller('api').delete(`/sync/plans/${id}`);
		plans.value = plans.value.filter(one => one.id !== id);
	}

	/**
	 * The preview takes exactly the body the run takes and changes nothing, which
	 * is what makes "this is what will happen" true rather than a good intention.
	 */
	function preview (request: RunSyncRequest): Promise<SyncPreview> {
		return caller('api').post<SyncPreview>('/sync/preview', request);
	}

	async function run (request: RunSyncRequest): Promise<SyncJob> {
		const job = await caller('api').post<SyncJob>('/sync/run', request);
		mergeJob(job);
		return job;
	}

	function mergeJob (job: SyncJob): void {
		const index = jobs.value.findIndex(one => one.id === job.id);
		if (index === -1) {
			jobs.value = [job, ...jobs.value];
		} else {
			jobs.value[index] = job;
		}
	}

	async function loadJobs (query: JobQuery = {}): Promise<ResultList<SyncJob>> {
		loadingJobs.value = true;
		try {
			const params = new URLSearchParams();
			if (query.page !== undefined) {
				params.set('page', String(query.page));
			}
			if (query.limit !== undefined) {
				params.set('limit', String(query.limit));
			}
			if (query.state) {
				params.set('state', query.state);
			}
			if (query.view) {
				params.set('view', query.view);
			}
			const serialized = params.toString();
			const result = await caller('api').get<ResultList<SyncJob>>(
				`/sync/jobs${serialized ? `?${serialized}` : ''}`,
				{ keepLastKey: 'sync|jobs' },
			);
			jobs.value = result?.items ?? [];
			jobsPagination.value = result?.pagination ?? { ...EMPTY_PAGINATION };
			jobsLoaded.value = true;
			return result;
		} finally {
			loadingJobs.value = false;
		}
	}

	async function job (id: string): Promise<SyncJob> {
		const found = await caller('api').get<SyncJob>(`/sync/jobs/${id}`);
		mergeJob(found);
		return found;
	}

	async function cancelJob (id: string): Promise<SyncJob> {
		const cancelled = await caller('api').post<SyncJob>(`/sync/jobs/${id}/cancel`);
		mergeJob(cancelled);
		return cancelled;
	}

	events.on(EventName.JOB_STATE, payload => {
		const existing = jobs.value.find(one => one.id === payload.id);
		if (existing) {
			// Patched field by field so the row keeps its object identity: only the
			// cells that read a counter are invalidated, not the whole list.
			Object.assign(existing, payload);
			return;
		}
		// A job nobody on this screen had yet — a schedule firing while it is open —
		// belongs at the top, where the most recent runs are.
		jobs.value = [payload, ...jobs.value];
	});

	return {
		plans,
		jobs,
		jobsPagination,
		loadingPlans,
		loadingJobs,
		plansLoaded,
		jobsLoaded,
		error,
		planById,
		loadPlans,
		plan,
		createPlan,
		itemPlans,
		createPlanForItem,
		estimateScope,
		updatePlan,
		deletePlan,
		preview,
		run,
		loadJobs,
		job,
		cancelJob,
	};
});
