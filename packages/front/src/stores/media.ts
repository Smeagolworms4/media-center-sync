import type {
	ClassificationProposal,
	MediaGroup,
	MediaGroupQuery,
	MediaItem,
	MediaMatch,
	MediaNode,
	MediaOverride,
	MediaSearchQuery,
	Pagination,
	ResultList,
} from '@mcs/shared';
import { EventName, SyncState, TransferState } from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';
import { useTokenStore } from '@/stores/token';

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 50, total: 0, pages: 0 };

/**
 * Turns a search into a query string.
 *
 * `states` repeats the key rather than joining on a comma, which is what a Nest
 * pipe reads back as an array without any custom transformer.
 */
export function buildMediaQuery (query: MediaSearchQuery | MediaGroupQuery): string {
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
	const tokenStore = useTokenStore();

	const items = ref<MediaItem[]>([]);
	const pagination = ref<Pagination>({ ...EMPTY_PAGINATION });
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	/**
	 * The grouped view, one entry per band the library screen draws.
	 *
	 * A poster wall asks for several bands at once — one per registered library —
	 * and each is its own query with its own total, because a heading that counts
	 * what happens to be on the current page is a count nobody can act on. Keying
	 * them rather than holding one list is what lets several calls be in flight
	 * together without the slower one overwriting the faster one's band.
	 */
	const groups = ref<Record<string, MediaGroup[]>>({});
	const groupPagination = ref<Record<string, Pagination>>({});
	const groupsLoading = ref(false);
	/** Counted rather than a boolean: several bands load at once. */
	const pendingGroupCalls = ref(0);

	function patchState (itemId: string, state: SyncState): void {
		// Mutated in place so a row that is already rendered keeps its identity:
		// replacing the array would re-create every row for one changed icon.
		const item = items.value.find(one => one.id === itemId);
		if (item) {
			item.sync = state;
		}
		// A group is addressed by its representative item, so a transfer for any of
		// the rows underneath it may be the one the poster is showing.
		for (const band of Object.values(groups.value)) {
			for (const group of band) {
				if (group.id === itemId || group.sources.some(source => source.itemId === itemId)) {
					group.sync = state;
				}
			}
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

	/**
	 * How many media are in a state, without pulling a single row.
	 *
	 * A dashboard tile asks three of these at once, and that is why it is not `search`.
	 * `search` carries `keepLastKey` so that a viewer typing in the box only renders
	 * the answer to their last keystroke — which means three simultaneous calls under
	 * that key abort each other, and two of the three counters would come back as a
	 * cancelled call rather than a number. It also writes into `items`, which a count
	 * has no business doing.
	 *
	 * One row is asked for because the answer lives in the pagination: counting forty
	 * thousand missing episodes must not mean sending forty thousand rows.
	 */
	async function count (states: SyncState[]): Promise<number> {
		const result = await caller('api').get<ResultList<MediaItem>>(
			`/media${buildMediaQuery({ states, page: 1, limit: 1 })}`,
		);

		return result?.pagination?.total ?? 0;
	}

	/**
	 * One band of the poster wall.
	 *
	 * `key` names the band — the library it shows — and is also what makes the
	 * keep-last work per band: a viewer typing in the search box fires one call
	 * per keystroke per band, and only the last answer of each is worth rendering.
	 */
	async function searchGroups (
		key: string,
		query: MediaGroupQuery = {},
	): Promise<ResultList<MediaGroup>> {
		pendingGroupCalls.value += 1;
		groupsLoading.value = true;
		error.value = null;
		try {
			const result = await caller('api').get<ResultList<MediaGroup>>(
				`/media/groups${buildMediaQuery(query)}`,
				{ keepLastKey: `media|groups|${key}` },
			);
			groups.value = { ...groups.value, [key]: result?.items ?? [] };
			groupPagination.value = {
				...groupPagination.value,
				[key]: result?.pagination ?? { ...EMPTY_PAGINATION },
			};
			loaded.value = true;
			return result;
		} catch (searchError) {
			error.value = searchError;
			throw searchError;
		} finally {
			pendingGroupCalls.value -= 1;
			groupsLoading.value = pendingGroupCalls.value > 0;
		}
	}

	/** Forgets every band, so a filter change cannot leave a stale one on screen. */
	function clearGroups (): void {
		groups.value = {};
		groupPagination.value = {};
	}

	function group (id: string): Promise<MediaGroup> {
		return caller('api').get<MediaGroup>(`/media/groups/${id}`);
	}

	function groupChildren (
		id: string,
		query: MediaGroupQuery = {},
	): Promise<ResultList<MediaGroup>> {
		return caller('api').get<ResultList<MediaGroup>>(
			`/media/groups/${id}/children${buildMediaQuery(query)}`);
	}

	function node (id: string): Promise<MediaNode> {
		return caller('api').get<MediaNode>(`/media/${id}`);
	}

	/**
	 * Where the gateway thinks this media might belong, and why.
	 *
	 * Read-only, and there is deliberately nothing beside it: agreeing with a suggestion
	 * is `setOverride` with the library it names, which is the same single mechanism a
	 * person re-filing by hand uses. A second call that "applied a classification" would
	 * be a second way for a media to have moved, and then no screen could say which one
	 * moved it.
	 */
	function classification (id: string): Promise<ClassificationProposal> {
		return caller('api').get<ClassificationProposal>(`/classification/media/${id}`);
	}

	function children (id: string, query: MediaSearchQuery = {}): Promise<ResultList<MediaItem>> {
		return caller('api').get<ResultList<MediaItem>>(
			`/media/${id}/children${buildMediaQuery(query)}`);
	}

	/**
	 * Replaces a row the index already holds, in place.
	 *
	 * A corrected item comes back whole; keeping the same object means a list that
	 * is already rendered shows the new title without being rebuilt around it.
	 */
	function replaceItem (item: MediaItem): void {
		const index = items.value.findIndex(one => one.id === item.id);
		if (index !== -1) {
			items.value[index] = item;
		}
	}

	/**
	 * Corrects what a media server got wrong, for this gateway only.
	 *
	 * The body is passed through exactly as it was built: an absent field means
	 * "not corrected, leave the service's answer alone" and an explicit `null`
	 * means "cleared". Collapsing the two here — dropping nulls, or turning an
	 * empty string into one — would quietly take away the only way to remove a year
	 * a scraper invented, and would do it in the one place nobody would look.
	 */
	async function setOverride (id: string, override: MediaOverride): Promise<MediaItem> {
		const item = await caller('api').put<MediaItem>(`/media/${id}/override`, override);
		replaceItem(item);
		return item;
	}

	/** Puts every corrected field back to what the service reported. */
	async function clearOverride (id: string): Promise<MediaItem> {
		const item = await caller('api').delete<MediaItem>(`/media/${id}/override`);
		replaceItem(item);
		return item;
	}

	/**
	 * Erases one copy from a disk this gateway can write to, and answers the path.
	 *
	 * The row is deliberately not replaced afterwards. The media server still lists the
	 * file it no longer has, so the index is wrong for as long as it takes the next scan
	 * to notice — and writing a state of our own here would be the interface inventing
	 * an answer the API refused to invent.
	 */
	function deleteFile (id: string): Promise<{ path: string }> {
		return caller('api').delete<{ path: string }>(`/media/${id}/file`);
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
	 *
	 * The access token travels as a query parameter for the same reason: an image
	 * cannot send one any other way, and fetching each poster through `fetch` to
	 * build an object URL would throw away the browser's own image cache on a page
	 * showing two hundred of them. The token in hand is used as it is rather than
	 * awaited through a refresh — a `src` has to be a string the moment the card
	 * renders, and a poster that 401s once is a tile that falls back to its
	 * placeholder, not a broken screen.
	 */
	function artworkUrl (id: string | null): string | null {
		if (!id) {
			return null;
		}
		const base = import.meta.env.VITE_API_BASE_URL ?? '';
		const token = tokenStore.accessToken;
		const query = token ? `?token=${encodeURIComponent(token)}` : '';
		return `${base}/api/media/${id}/artwork${query}`;
	}

	/**
	 * A running transfer is the one thing that changes an item's state without
	 * anybody reloading the list, so the two states it can produce are applied
	 * from the stream rather than left to go stale until the next search.
	 */
	events.on(EventName.TRANSFER_STATE, transfer => {
		switch (transfer.state) {
			case TransferState.DONE: {
				/*
				 * Downloaded is not indexed, and claiming otherwise was half the bug.
				 *
				 * This used to patch the row to `in_sync`, which said the media server
				 * holds it — while the media server had not been told anything yet, so
				 * opening the item offered a file it could not play. The next listing
				 * then reloaded from the API and the row went back to `missing`, with
				 * the file on the disk the whole time and the screen having said two
				 * contradictory things about it in a minute.
				 *
				 * `awaiting_index` is what the gateway has actually just learned, and it
				 * is what the API answers for the same row on the next read — so the
				 * optimistic patch and the reload now agree.
				 */
				patchState(transfer.itemId, SyncState.AWAITING_INDEX);
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

	/**
	 * Add the episodes a metadata source knows about and no server here reports.
	 *
	 * The half of a catalogue the servers cannot supply: an episode that aired last night
	 * and that nobody holds exists on no server, so it has no row and nothing counts it as
	 * missing. Answers how many were added, which is what the screen says back — including
	 * when the answer is none, because "nothing new" is an answer somebody asked for.
	 */
	async function discoverEpisodes (itemId: string): Promise<number> {
		const answer = await caller('api').post<{ added: number }>(`/media/${itemId}/episodes`, {});

		return answer?.added ?? 0;
	}

	return {
		items,
		pagination,
		groups,
		groupPagination,
		groupsLoading,
		loading,
		loaded,
		error,
		search,
		count,
		searchGroups,
		clearGroups,
		group,
		groupChildren,
		node,
		classification,
		discoverEpisodes,
		children,
		matches,
		deleteFile,
		setOverride,
		clearOverride,
		confirmMatch,
		removeMatch,
		artworkUrl,
	};
});
