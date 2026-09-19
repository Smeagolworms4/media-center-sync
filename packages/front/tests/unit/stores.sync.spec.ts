import type { SyncJob, SyncPlan } from '@mcs/shared';
import { EventName, SyncJobState, SyncTrigger } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSyncStore } from '@/stores/sync';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

function plan (overrides: Partial<SyncPlan> = {}): SyncPlan {
	return {
		id: 'pl1',
		name: 'Nightly',
		enabled: true,
		trigger: SyncTrigger.SCHEDULE,
		schedule: '0 4 * * *',
		sourceServiceIds: [],
		targetLibraryId: null,
		rootItemId: null,
		filter: { missingOnly: true },
		lastRunAt: null,
		nextRunAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function job (overrides: Partial<SyncJob> = {}): SyncJob {
	return {
		id: 'j1',
		planId: 'pl1',
		planName: 'Nightly',
		state: SyncJobState.RUNNING,
		trigger: SyncTrigger.SCHEDULE,
		startedAt: '2026-02-01T04:00:00.000Z',
		finishedAt: null,
		itemsPlanned: 10,
		itemsDone: 2,
		itemsFailed: 0,
		bytesPlanned: 1000,
		bytesDone: 200,
		error: null,
		createdAt: '2026-02-01T04:00:00.000Z',
		...overrides,
	};
}

describe('stores/sync', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('loads the plans whole, because there are as many as somebody wrote', async () => {
		stubFetch([{ body: [plan(), plan({ id: 'pl2' })] }]);
		const store = useSyncStore();

		await store.loadPlans();

		expect(store.plans).toHaveLength(2);
		expect(store.planById.pl2.name).toBe('Nightly');
	});

	it('keeps the failure so the page can offer a retry', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useSyncStore();

		await expect(store.loadPlans()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
		expect(store.loadingPlans).toBe(false);
	});

	it('replaces an edited plan in place rather than appending a second row', async () => {
		stubFetch([{ body: [plan()] }, { body: plan({ enabled: false }) }]);
		const store = useSyncStore();
		await store.loadPlans();

		await store.updatePlan('pl1', { enabled: false });

		expect(store.plans).toHaveLength(1);
		expect(store.planById.pl1.enabled).toBe(false);
	});

	/**
	 * The point of the preview: it is sent to a different route with exactly the
	 * body the run would take, so what was shown is what happens.
	 */
	it('previews and runs with the same body', async () => {
		const stub = stubFetch([
			{ body: { itemsPlanned: 2, bytesPlanned: 20, items: [] } },
			{ body: job() },
		]);
		const store = useSyncStore();
		const request = { planId: 'pl1', sourceServiceIds: ['s1'], filter: { missingOnly: true } };

		await store.preview(request);
		await store.run(request);

		expect(String(stub.mock.calls[0][0])).toContain('/api/sync/preview');
		expect(String(stub.mock.calls[1][0])).toContain('/api/sync/run');
		expect(stub.mock.calls[0][1]?.body).toBe(stub.mock.calls[1][1]?.body);
	});

	it('paginates the jobs and passes the state filter through', async () => {
		const stub = stubFetch([{
			body: { items: [job()], pagination: { page: 1, limit: 20, total: 41, pages: 3 } },
		}]);
		const store = useSyncStore();

		await store.loadJobs({ page: 1, limit: 20, state: SyncJobState.FAILED });

		expect(String(stub.mock.calls[0][0])).toContain('state=failed');
		expect(store.jobsPagination.total).toBe(41);
	});

	it('advances a running job from the stream without re-creating the row', async () => {
		stubFetch([{ body: { items: [job()], pagination: null } }]);
		const store = useSyncStore();
		await store.loadJobs();
		const row = store.jobs[0];

		connectFakeSocket(pinia);
		emitServerEvent(EventName.JOB_STATE, job({ itemsDone: 7 }));

		expect(store.jobs[0]).toBe(row);
		expect(store.jobs[0].itemsDone).toBe(7);
	});

	it('puts a job nobody had yet at the top of the list', async () => {
		stubFetch([{ body: { items: [job()], pagination: null } }]);
		const store = useSyncStore();
		await store.loadJobs();

		connectFakeSocket(pinia);
		emitServerEvent(EventName.JOB_STATE, job({ id: 'j2' }));

		expect(store.jobs.map(one => one.id)).toEqual(['j2', 'j1']);
	});
});
