import type { Transfer } from '@mcs/shared';
import {
	EventName,
	PlacedBy,
	RevalidationAction,
	RevalidationOutcome,
	TransferErrorKind,
	TransferState,
	TransferTransport,
} from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTransfersStore } from '@/stores/transfers';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

function transfer (overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: 't1',
		jobId: null,
		itemId: 'm1',
		contentId: 'c1',
		title: 'The Expanse - S01E02',
		kind: 'episode',
		state: TransferState.DOWNLOADING,
		targetPath: '/media/shows/The Expanse/S01E02.mkv',
		targetLibraryId: 'lib-shows',
		placedBy: PlacedBy.CATEGORY,
		lot: null,
		landing: null,
		bytesTotal: 1000,
		bytesDone: 100,
		rate: 50,
		etaSeconds: 18,
		sources: [{
			serviceId: 's1',
			serviceName: 'Bob',
			peerId: 'p1',
			peerName: 'Bob',
			transport: TransferTransport.PEER_DIRECT,
			rate: 50,
			bytesDone: 100,
			connections: 2,
			healthy: true,
		}],
		chunkSize: 100,
		chunksTotal: 10,
		chunksDone: 1,
		error: null,
		errorKind: null,
		errorDetail: null,
		chunksRepaired: 0,
		lastVerifiedAt: null,
		startedAt: null,
		finishedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('stores/transfers', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('loads a page of the queue and seeds one progress object per row', async () => {
		const stub = stubFetch([{
			body: { items: [transfer()], pagination: { page: 1, limit: 20, total: 3, pages: 1 } },
		}]);
		const store = useTransfersStore();

		await store.load({ page: 1, limit: 20, state: TransferState.FAILED });

		expect(String(stub.mock.calls[0][0])).toContain('state=failed');
		expect(store.progress.t1.bytesDone).toBe(100);
		expect(store.pagination.total).toBe(3);
	});

	it('keeps the failure so the page can offer a retry', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const store = useTransfersStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
	});

	/**
	 * The reason a queue of forty rows survives a frame every half second: the
	 * progress object is written into, never replaced, so only the bar that reads
	 * those fields is invalidated.
	 */
	it('applies a batched frame into the objects it already holds', async () => {
		stubFetch([{ body: { items: [transfer(), transfer({ id: 't2' })], pagination: null } }]);
		const store = useTransfersStore();
		await store.load();
		const first = store.progress.t1;
		const rows = store.transfers;

		connectFakeSocket(pinia);
		emitServerEvent(EventName.TRANSFER_PROGRESS, [
			{
				id: 't1',
				state: TransferState.DOWNLOADING,
				bytesDone: 600,
				bytesTotal: 1000,
				rate: 120,
				etaSeconds: 4,
				chunksDone: 6,
				chunksTotal: 10,
				sourceCount: 2,
			},
			{
				id: 't2',
				state: TransferState.PAUSED,
				bytesDone: 10,
				bytesTotal: 1000,
				rate: 0,
				etaSeconds: null,
				chunksDone: 1,
				chunksTotal: 10,
				sourceCount: 0,
			},
		]);

		expect(store.progress.t1).toBe(first);
		expect(store.progress.t1.bytesDone).toBe(600);
		expect(store.progress.t2.state).toBe(TransferState.PAUSED);
		// The row objects are patched too, so a state chip follows without a reload.
		expect(store.transfers).toBe(rows);
		expect(store.transfers[0].bytesDone).toBe(600);
		expect(store.transfers[1].state).toBe(TransferState.PAUSED);
	});

	it('takes in a transfer that appeared between two loads', async () => {
		stubFetch([{ body: { items: [], pagination: null } }]);
		const store = useTransfersStore();
		await store.load();

		connectFakeSocket(pinia);
		emitServerEvent(EventName.TRANSFER_STATE, transfer({ id: 'new' }));

		expect(store.transfers.map(one => one.id)).toEqual(['new']);
		expect(store.progress.new.bytesTotal).toBe(1000);
	});

	it('keeps the queue counters the gateway pushes', async () => {
		const store = useTransfersStore();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.QUEUE_STATS, {
			active: 2, queued: 5, paused: 1, failed: 3, rate: 900, bytesRemaining: 42,
		});

		expect(store.stats.failed).toBe(3);
		expect(store.stats.rate).toBe(900);
	});

	it('remembers a verification, which is an answer even when the state does not move', async () => {
		const store = useTransfersStore();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_VERIFIED, {
			transferId: 't1',
			ok: true,
			chunksChecked: 10,
			chunksCorrupt: 0,
			bytesToRepair: 0,
			checkedAt: '2026-02-02T00:00:00.000Z',
		});

		expect(store.verifications.t1.ok).toBe(true);
	});

	it('puts a revalidation at the top of that transfer’s history', async () => {
		const store = useTransfersStore();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.TRANSFER_REVALIDATED, {
			id: 'r1',
			transferId: 't1',
			sourceServiceId: 's1',
			sourceServiceName: 'Bob',
			cause: TransferErrorKind.SOURCE_GONE,
			requestedAt: '2026-02-02T00:00:00.000Z',
			answeredAt: null,
			outcome: null,
			remoteFile: null,
			action: null,
			note: null,
		});
		emitServerEvent(EventName.TRANSFER_REVALIDATED, {
			id: 'r2',
			transferId: 't1',
			sourceServiceId: 's1',
			sourceServiceName: 'Bob',
			cause: TransferErrorKind.SOURCE_GONE,
			requestedAt: '2026-02-02T00:01:00.000Z',
			answeredAt: '2026-02-02T00:01:30.000Z',
			outcome: RevalidationOutcome.GONE,
			remoteFile: null,
			action: RevalidationAction.SWITCH_SOURCE,
			note: null,
		});

		expect(store.revalidations.t1.map(one => one.id)).toEqual(['r2', 'r1']);
	});

	it('replaces a revalidation that was answered rather than listing it twice', async () => {
		const store = useTransfersStore();
		connectFakeSocket(pinia);
		const base = {
			id: 'r1',
			transferId: 't1',
			sourceServiceId: 's1',
			sourceServiceName: 'Bob',
			cause: TransferErrorKind.CHECKSUM_MISMATCH,
			requestedAt: '2026-02-02T00:00:00.000Z',
			remoteFile: null,
			note: null,
		};

		emitServerEvent(EventName.TRANSFER_REVALIDATED, { ...base, answeredAt: null, outcome: null, action: null });
		emitServerEvent(EventName.TRANSFER_REVALIDATED, {
			...base,
			answeredAt: '2026-02-02T00:00:30.000Z',
			outcome: RevalidationOutcome.CONFIRMED,
			action: RevalidationAction.REPAIR_LOCAL,
		});

		expect(store.revalidations.t1).toHaveLength(1);
		expect(store.revalidations.t1[0].action).toBe(RevalidationAction.REPAIR_LOCAL);
	});

	it('keeps verification apart from repair, so asking does not commit to the answer', async () => {
		const stub = stubFetch([
			{ body: { transferId: 't1', ok: false, chunksChecked: 10, chunksCorrupt: 2, bytesToRepair: 200, checkedAt: 'now' } },
			{ body: transfer({ state: TransferState.REPAIRING }) },
		]);
		const store = useTransfersStore();

		const verification = await store.verify('t1');
		await store.repair('t1');

		expect(verification.chunksCorrupt).toBe(2);
		expect(store.verifications.t1.ok).toBe(false);
		expect(String(stub.mock.calls[0][0])).toContain('/api/transfers/t1/verify');
		expect(String(stub.mock.calls[1][0])).toContain('/api/transfers/t1/repair');
		expect(store.byId.t1.state).toBe(TransferState.REPAIRING);
	});

	/**
	 * A row that has been dealt with leaves the list at once.
	 *
	 * Waiting for the next reload would keep showing somebody a problem they just
	 * solved, and a zone about things needing attention that does that is one people
	 * stop reading — which puts the whole thing back to being invisible.
	 */
	it('drops a placement from the unconfigured list once it has been sent somewhere', async () => {
		const stub = stubFetch([
			{ body: [{
				transferId: 't1',
				itemId: 'm1',
				title: 'The Expanse - S01E02',
				kind: 'episode',
				state: TransferState.DONE,
				targetPath: '/media/shows/The Expanse/S01E02.mkv',
				targetLibraryId: 'lib-shows',
				targetLibraryName: 'Shows',
				placedBy: PlacedBy.DEFAULT_LIBRARY,
				categoryKey: 'shows',
				categoryName: 'Shows',
				placedAt: '2026-02-02T10:00:00.000Z',
			}] },
			{ body: transfer({ targetLibraryId: 'lib-anime', placedBy: PlacedBy.CHOSEN_BY_HAND }) },
		]);
		const store = useTransfersStore();

		await store.loadUnconfigured();

		expect(store.unconfigured).toHaveLength(1);

		await store.setDestination('t1', 'lib-anime');

		expect(store.unconfigured).toHaveLength(0);
		expect(String(stub.mock.calls[1][0])).toContain('/api/transfers/t1/destination');
		expect(store.byId.t1.targetLibraryId).toBe('lib-anime');
	});

	it('holds the chunk map and the revalidation history per transfer', async () => {
		stubFetch([
			{ body: [{ index: 0, start: 0, end: 99, state: 'done', bytesDone: 100, sourceServiceId: 's1', attempts: 1, checksum: null }] },
			{ body: [] },
		]);
		const store = useTransfersStore();

		await store.loadChunks('t1');
		await store.loadRevalidations('t1');

		expect(store.chunks.t1).toHaveLength(1);
		expect(store.revalidations.t1).toEqual([]);
	});

	/**
	 * The queue read as downloads, which is the whole of what a household reads off that
	 * screen.
	 *
	 * The grouping itself is the gateway's now, and deliberately: this store grouped
	 * whatever a page of twenty files happened to hold, so a season of twenty-two arrived as
	 * two blocks on two pages — two percentages, two sets of buttons, and a queue of nine
	 * downloads announcing a hundred and eighty-seven rows. What is pinned here is what the
	 * store still owes the screen: the objects the stream writes to, and a download that
	 * grows while somebody watches it.
	 */
	describe('reading the queue as downloads', () => {
		function lot (key: string, transfers: Transfer[], title = 'Les Schtroumpfs') {
			return { key, lot: key, title, transfers };
		}

		async function load (lots: ReturnType<typeof lot>[]) {
			stubFetch([{
				body: { items: lots, pagination: { page: 1, limit: 20, total: lots.length, pages: 1 } },
			}]);

			const store = useTransfersStore();

			await store.loadLots();

			return store;
		}

		it('holds each download whole, with its files flattened for everything else', async () => {
			const store = await load([
				lot('season-1', [
					transfer({ id: 'e1', lot: 'season-1' }),
					transfer({ id: 'e2', lot: 'season-1' }),
				]),
				lot('season-2', [transfer({ id: 'e3', lot: 'season-2' })], 'Scrubs'),
			]);

			expect(store.lots.map(one => one.transfers.length)).toEqual([2, 1]);
			expect(store.lots[1].title).toBe('Scrubs');
			// The flat list is what the progress record, `byId` and the failed count read.
			expect(store.transfers.map(one => one.id)).toEqual(['e1', 'e2', 'e3']);
			expect(store.progress.e2).toBeDefined();
		});

		it('moves a bar inside a card, because the card holds the very object a frame patches',
			async () => {
				// The one mistake that would break the live progress without breaking a
				// rendering test: copying the transfers into the lots instead of holding them.
				const store = await load([
					lot('season-1', [transfer({ id: 'e1', lot: 'season-1' })]),
				]);

				connectFakeSocket(pinia);
				emitServerEvent(EventName.TRANSFER_STATE, transfer({
					id: 'e1',
					lot: 'season-1',
					state: TransferState.DONE,
				}));

				expect(store.lots[0].transfers[0].state).toBe(TransferState.DONE);
			});

		it('adds a file the run plans while somebody is watching to the download it belongs to',
			async () => {
				/*
				 * A run plans its files one at a time, so a season being fetched grows on
				 * screen. Without this the card said `4 files` while the counters said twenty,
				 * until the page was reloaded.
				 */
				const store = await load([
					lot('season-1', [transfer({ id: 'e1', lot: 'season-1' })]),
				]);

				connectFakeSocket(pinia);
				emitServerEvent(EventName.TRANSFER_STATE, transfer({ id: 'e2', lot: 'season-1' }));

				expect(store.lots[0].transfers.map(one => one.id)).toEqual(['e1', 'e2']);
			});

		it('leaves a pushed row that belongs to no download on screen alone', async () => {
			const store = await load([lot('season-1', [transfer({ id: 'e1', lot: 'season-1' })])]);

			connectFakeSocket(pinia);
			emitServerEvent(EventName.TRANSFER_STATE, transfer({ id: 'other', lot: 'elsewhere' }));

			expect(store.lots).toHaveLength(1);
			expect(store.byId.other).toBeDefined();
		});

		it('takes an archived file out of its download, and an emptied download off the screen',
			async () => {
				const store = await load([
					lot('season-1', [
						transfer({ id: 'e1', lot: 'season-1' }),
						transfer({ id: 'e2', lot: 'season-1' }),
					]),
					lot('season-2', [transfer({ id: 'e3', lot: 'season-2' })]),
				]);

				stubFetch([{ body: {} }]);
				await store.archive('e3');

				expect(store.lots.map(one => one.key)).toEqual(['season-1']);

				stubFetch([{ body: {} }]);
				await store.archive('e1');

				expect(store.lots[0].transfers.map(one => one.id)).toEqual(['e2']);
			});

		it('acts on a whole download in one request, and keeps the objects the stream writes to',
			async () => {
				/*
				 * Twenty requests racing each other and the engine is how pressing pause on a
				 * season answered a column of errors about the files that had finished in
				 * between. One request, and the answer replaces the card.
				 */
				const store = await load([
					lot('season-1', [transfer({ id: 'e1', lot: 'season-1' })]),
				]);
				const held = store.lots[0].transfers[0];

				stubFetch([{
					body: lot('season-1', [transfer({
						id: 'e1',
						lot: 'season-1',
						state: TransferState.PAUSED,
					})]),
				}]);

				await store.pauseLot('season-1');

				expect(store.lots[0].transfers[0]).toBe(held);
				expect(held.state).toBe(TransferState.PAUSED);
			});
	});
});
