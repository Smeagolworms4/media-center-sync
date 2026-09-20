import type {
	HistoryView,
	Pagination,
	ResultList,
	Revalidation,
	Transfer,
	TransferChunk,
	TransferProgress,
	TransferQueueStats,
	TransferState,
	TransferVerification,
	UnconfiguredPlacement,
} from '@mcs/shared';
import { EventName } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 20, total: 0, pages: 0 };

const EMPTY_STATS: TransferQueueStats = {
	active: 0,
	queued: 0,
	paused: 0,
	failed: 0,
	rate: 0,
	bytesRemaining: 0,
};

export interface TransferQuery {
	page?: number;
	limit?: number;
	state?: TransferState | null;
	/**
	 * Which half of the queue to ask for. Omitted means all of it.
	 *
	 * The queue screen asks for the live half so that a transfer that ended thirty
	 * seconds ago stops sitting on top of the one that is running. The dashboard
	 * deliberately does not: it reports failed transfers out of the same list.
	 */
	view?: HistoryView | null;
}

/** A transfer the list does not hold yet has to show something before its first frame. */
function progressOf (transfer: Transfer): TransferProgress {
	return {
		id: transfer.id,
		state: transfer.state,
		bytesDone: transfer.bytesDone,
		bytesTotal: transfer.bytesTotal,
		rate: transfer.rate,
		etaSeconds: transfer.etaSeconds,
		chunksDone: transfer.chunksDone,
		chunksTotal: transfer.chunksTotal,
		sourceCount: transfer.sources?.length ?? 0,
	};
}

/**
 * The transfer queue.
 *
 * How a batched frame is applied without re-creating the list: `progress` holds
 * one object per transfer, keyed by identifier, and a frame writes into that
 * object with `Object.assign` rather than replacing it. Vue tracks dependencies
 * per render effect, so only the progress bar that reads those fields is
 * invalidated — the list above it reads identifiers and titles, which did not
 * change, and is therefore not re-rendered at all. Replacing the record, or the
 * transfer array, would diff every row several times a second for numbers that
 * live in one cell.
 *
 * The same reasoning applies to the `Transfer` rows themselves: the few fields a
 * frame also carries are patched in place on the existing object.
 */
export const useTransfersStore = defineStore('transfers', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const transfers = ref<Transfer[]>([]);
	const progress = ref<Record<string, TransferProgress>>({});
	const stats = ref<TransferQueueStats>({ ...EMPTY_STATS });
	const pagination = ref<Pagination>({ ...EMPTY_PAGINATION });
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	/**
	 * Detail held per transfer, filled when a row is expanded and then kept up to
	 * date by the stream. A verification or a revalidation that arrives while the
	 * row is open is exactly the moment somebody is looking at it.
	 */
	const chunks = ref<Record<string, TransferChunk[]>>({});
	const revalidations = ref<Record<string, Revalidation[]>>({});
	const verifications = ref<Record<string, TransferVerification>>({});

	/**
	 * What landed on a step of the placement rule nobody configured.
	 *
	 * Its own list rather than a filter over `transfers`: the queue page holds one page
	 * of recent transfers and these are, by their nature, old — a file placed where
	 * nobody chose is found months later, which is the whole problem.
	 */
	const unconfigured = ref<UnconfiguredPlacement[]>([]);

	const byId = computed(() => {
		const map: Record<string, Transfer> = {};
		for (const transfer of transfers.value) {
			map[transfer.id] = transfer;
		}
		return map;
	});

	const failed = computed(() => transfers.value.filter(one => one.errorKind !== null));

	function seedProgress (list: Transfer[]): void {
		const next: Record<string, TransferProgress> = {};
		for (const transfer of list) {
			// A transfer already known keeps its object, so a list reload does not
			// reset a bar that the stream is currently moving.
			next[transfer.id] = progress.value[transfer.id] ?? progressOf(transfer);
		}
		progress.value = next;
	}

	function mergeTransfer (transfer: Transfer): void {
		const existing = transfers.value.find(one => one.id === transfer.id);
		if (existing) {
			Object.assign(existing, transfer);
		} else {
			transfers.value = [transfer, ...transfers.value];
		}
		progress.value[transfer.id] = progress.value[transfer.id]
			? Object.assign(progress.value[transfer.id], progressOf(transfer))
			: progressOf(transfer);
	}

	async function load (query: TransferQuery = {}): Promise<ResultList<Transfer>> {
		loading.value = true;
		error.value = null;
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
			const result = await caller('api').get<ResultList<Transfer>>(
				`/transfers${serialized ? `?${serialized}` : ''}`,
				{ keepLastKey: 'transfers|list' },
			);
			transfers.value = result?.items ?? [];
			pagination.value = result?.pagination ?? { ...EMPTY_PAGINATION };
			seedProgress(transfers.value);
			loaded.value = true;
			return result;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function loadStats (): Promise<TransferQueueStats> {
		const loadedStats = await caller('api').get<TransferQueueStats>('/transfers/stats', {
			keepLastKey: 'transfers|stats',
		});
		// The counters are rendered unconditionally, so an answer that carried none
		// has to become zeroes rather than a null the page would read fields off.
		stats.value = loadedStats ?? { ...EMPTY_STATS };
		return stats.value;
	}

	async function loadUnconfigured (): Promise<UnconfiguredPlacement[]> {
		const rows = await caller('api').get<UnconfiguredPlacement[]>('/transfers/unconfigured', {
			keepLastKey: 'transfers|unconfigured',
		});
		// Anything but a list becomes an empty one. The home screen renders this zone
		// unconditionally, so an answer of the wrong shape — an older gateway, a proxy
		// error page — would take the whole dashboard down rather than one card.
		unconfigured.value = Array.isArray(rows) ? rows : [];
		return unconfigured.value;
	}

	/**
	 * Send one transfer somewhere else.
	 *
	 * The row leaves the list straight away rather than on the next reload. It is no
	 * longer a destination nobody chose — somebody just chose it — and a zone about
	 * things needing attention that keeps showing what has been dealt with is one
	 * people stop reading.
	 */
	async function setDestination (id: string, libraryId: string): Promise<Transfer> {
		const transfer = await caller('api').post<Transfer>(`/transfers/${id}/destination`, {
			libraryId,
		});
		mergeTransfer(transfer);
		unconfigured.value = unconfigured.value.filter(one => one.transferId !== id);
		return transfer;
	}

	async function get (id: string): Promise<Transfer> {
		const transfer = await caller('api').get<Transfer>(`/transfers/${id}`);
		mergeTransfer(transfer);
		return transfer;
	}

	async function loadChunks (id: string): Promise<TransferChunk[]> {
		const loadedChunks = await caller('api').get<TransferChunk[]>(`/transfers/${id}/chunks`);
		chunks.value = { ...chunks.value, [id]: loadedChunks };
		return loadedChunks;
	}

	async function loadRevalidations (id: string): Promise<Revalidation[]> {
		const loadedRevalidations = await caller('api').get<Revalidation[]>(
			`/transfers/${id}/revalidations`);
		revalidations.value = { ...revalidations.value, [id]: loadedRevalidations };
		return loadedRevalidations;
	}

	async function act (id: string, action: string): Promise<Transfer> {
		const transfer = await caller('api').post<Transfer>(`/transfers/${id}/${action}`);
		mergeTransfer(transfer);
		return transfer;
	}

	const pause = (id: string) => act(id, 'pause');
	const resume = (id: string) => act(id, 'resume');
	const cancel = (id: string) => act(id, 'cancel');
	const retry = (id: string) => act(id, 'retry');
	const repair = (id: string) => act(id, 'repair');

	/**
	 * `verify` answers what is on disk without changing anything, which is why it
	 * returns a verification rather than a transfer: asking the question must not
	 * commit to the answer when the answer is "fetch nine gigabytes again".
	 */
	async function verify (id: string): Promise<TransferVerification> {
		const verification = await caller('api').post<TransferVerification>(`/transfers/${id}/verify`);
		verifications.value = { ...verifications.value, [id]: verification };
		return verification;
	}

	events.on(EventName.TRANSFER_PROGRESS, frames => {
		for (const frame of frames) {
			const existing = progress.value[frame.id];
			if (existing) {
				Object.assign(existing, frame);
			} else {
				// A transfer that appeared between two loads: adding a key does
				// invalidate the record, which is the one case worth the cost.
				progress.value[frame.id] = { ...frame };
			}

			const transfer = transfers.value.find(one => one.id === frame.id);
			if (transfer) {
				transfer.state = frame.state;
				transfer.bytesDone = frame.bytesDone;
				transfer.rate = frame.rate;
				transfer.etaSeconds = frame.etaSeconds;
				transfer.chunksDone = frame.chunksDone;
			}
		}
	});

	events.on(EventName.TRANSFER_STATE, transfer => mergeTransfer(transfer));

	events.on(EventName.QUEUE_STATS, next => {
		stats.value = next;
	});

	/**
	 * A verification is worth keeping even when the state does not move: a file
	 * that came back clean says the source was fine and the problem is elsewhere,
	 * which is invisible if the only signal is the transfer returning to `done`.
	 */
	events.on(EventName.TRANSFER_VERIFIED, verification => {
		verifications.value = {
			...verifications.value,
			[verification.transferId]: verification,
		};
	});

	events.on(EventName.TRANSFER_REVALIDATED, revalidation => {
		const current = revalidations.value[revalidation.transferId] ?? [];
		const index = current.findIndex(one => one.id === revalidation.id);
		// The most recent answer first: a revalidation arrives when the transfer is
		// deciding something, and that decision is the top of the history.
		const next = index === -1
			? [revalidation, ...current]
			: current.map(one => (one.id === revalidation.id ? revalidation : one));
		revalidations.value = { ...revalidations.value, [revalidation.transferId]: next };
	});

	return {
		transfers,
		progress,
		stats,
		pagination,
		loading,
		loaded,
		error,
		chunks,
		revalidations,
		verifications,
		unconfigured,
		byId,
		failed,
		load,
		loadStats,
		loadUnconfigured,
		setDestination,
		get,
		loadChunks,
		loadRevalidations,
		pause,
		resume,
		cancel,
		retry,
		verify,
		repair,
	};
});
