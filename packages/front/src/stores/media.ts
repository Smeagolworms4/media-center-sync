import type {
	MediaItem,
	MediaMatch,
	MediaNode,
	MediaSearchQuery,
	Pagination,
	ResultList,
} from '@mcs/shared';
import { EventName, SyncState, TransferState } from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 50, total: 0, pages: 0 };

/**
 * Turns a search into a query string.
 *
 * `states` repeats the key rather than joining on a comma, which is what a Nest
 * pipe reads back as an array without any custom transformer.
 */
export function buildMediaQuery (query: MediaSearchQuery): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === null || value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const one of value) {
				params.append(key, String(one));
			}
			continue;
		}
		const text = String(value);
		if (text.length === 0) {
			continue;
		}
		params.set(key, text);
	}
	const serialized = params.toString();
	return serialized ? `?${serialized}` : '';
}

/**
 * The gateway's index, as the browsing screens read it.
 *
 * Nothing here ever talks to a media server: the interface reads the gateway's
 * own index, which is what makes a library of forty thousand episodes browsable
 * and what keeps ten open tabs from becoming ten requests to a Raspberry Pi.
 */
export const useMediaStore = defineStore('media', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const items = ref<MediaItem[]>([]);
	const pagination = ref<Pagination>({ ...EMPTY_PAGINATION });
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	function patchState (itemId: string, state: SyncState): void {
		// Mutated in place so a row that is already rendered keeps its identity:
		// replacing the array would re-create every row for one changed icon.
		const item = items.value.find(one => one.id === itemId);
		if (item) {
			item.sync = state;
		}
	}

	async function search (query: MediaSearchQuery = {}): Promise<ResultList<MediaItem>> {
		loading.value = true;
		error.value = null;
		try {
			const result = await caller('api').get<ResultList<MediaItem>>(
				`/media${buildMediaQuery(query)}`,
				// A viewer typing in the search box fires one call per keystroke; only
				// the answer to the last one is worth rendering.
				{ keepLastKey: 'media|search' },
			);
			items.value = result?.items ?? [];
			pagination.value = result?.pagination ?? { ...EMPTY_PAGINATION };
			loaded.value = true;
			return result;
		} catch (searchError) {
			error.value = searchError;
			throw searchError;
		} finally {
			loading.value = false;
		}
	}

	function node (id: string): Promise<MediaNode> {
		return caller('api').get<MediaNode>(`/media/${id}`);
	}

	function children (id: string, query: MediaSearchQuery = {}): Promise<ResultList<MediaItem>> {
		return caller('api').get<ResultList<MediaItem>>(
			`/media/${id}/children${buildMediaQuery(query)}`);
	}

	function matches (id: string): Promise<MediaMatch[]> {
		return caller('api').get<MediaMatch[]>(`/media/${id}/matches`);
	}

	/**
	 * A human overruling the scoring.
	 *
	 * The body carries nothing beyond the confirmation itself: everything the API
	 * needs is already in the two identifiers in the path.
	 */
	function confirmMatch (id: string, matchId: string): Promise<MediaMatch> {
		return caller('api').post<MediaMatch>(`/media/${id}/matches/${matchId}/confirm`, {});
	}

	function removeMatch (id: string, matchId: string): Promise<void> {
		return caller('api').delete<void>(`/media/${id}/matches/${matchId}`);
	}

	/**
	 * Artwork is proxied by the gateway because the remote service's own URL needs
	 * that service's token, and an `<img>` tag carries no header. The URL is built
	 * here rather than in a component, which is the rule everywhere else too.
	 */
	function artworkUrl (id: string): string {
		const base = import.meta.env.VITE_API_BASE_URL ?? '';
		return `${base}/api/media/${id}/artwork`;
	}

	/**
	 * A running transfer is the one thing that changes an item's state without
	 * anybody reloading the list, so the two states it can produce are applied
	 * from the stream rather than left to go stale until the next search.
	 */
	events.on(EventName.TRANSFER_STATE, transfer => {
		switch (transfer.state) {
			case TransferState.DONE: {
				patchState(transfer.itemId, SyncState.IN_SYNC);
				break;
			}
			case TransferState.DOWNLOADING:
			case TransferState.CONNECTING:
			case TransferState.QUEUED: {
				patchState(transfer.itemId, SyncState.SYNCING);
				break;
			}
			default: {
				break;
			}
		}
	});

	return {
		items,
		pagination,
		loading,
		loaded,
		error,
		search,
		node,
		children,
		matches,
		confirmMatch,
		removeMatch,
		artworkUrl,
	};
});
