import type {
	CoveragePlan,
	EpisodeRef,
	PeerCopy,
	ReleaseGrab,
	ReleaseSearchQuery,
	ReleaseSearchResult,
	ReleaseSuggestion,
	SyncJob,
} from '@mcs/shared';
import { EventName, isPeerSuggestion } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';
import { useSyncStore } from '@/stores/sync';

/**
 * What could satisfy a media, and what has been fetched towards it.
 *
 * The search result is held for one media at a time rather than accumulated: a release
 * has no existence outside the search it came from — it is what a tracker said a minute
 * ago — and a list kept from the last media would offer rows the gateway has already
 * forgotten and would refuse to grab.
 *
 * It answers two kinds of row and they are fetched by two different machines. That
 * distinction lives here rather than in the component, because a component that chose
 * between two endpoints would be a second place the choice could be got wrong — and
 * getting it wrong is silent at both ends: a peer copy handed to the download client is a
 * magnetless add that reports nothing, and a magnet handed to the transfer engine names no
 * file anybody holds. So `grab` takes a release identifier and `pull` takes a `PeerCopy`,
 * and neither will accept the other's argument.
 */
export const useReleasesStore = defineStore('releases', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const result = ref<ReleaseSearchResult | null>(null);
	const grabs = ref<ReleaseGrab[]>([]);
	const searching = ref(false);
	/** The media the held result belongs to, so a stale one is never shown. */
	const searchedFor = ref<string | null>(null);
	const plan = ref<CoveragePlan | null>(null);
	const planning = ref(false);
	/** The media the held plan was built for. Same reason as `searchedFor`. */
	const plannedFor = ref<string | null>(null);

	/** Only what was actually asked for: an empty parameter is not the same as none. */
	function queryString (query: Record<string, string | number | boolean | undefined>): string {
		const params = new URLSearchParams();

		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== '') {
				params.set(key, String(value));
			}
		}

		const encoded = params.toString();

		return encoded ? `?${encoded}` : '';
	}

	async function search (query: ReleaseSearchQuery): Promise<ReleaseSearchResult> {
		searching.value = true;
		try {
			const found = await caller('api').get<ReleaseSearchResult>(
				`/releases/search${queryString({
					itemId: query.itemId,
					term: query.term,
					seasonNumber: query.seasonNumber,
					episodeNumber: query.episodeNumber,
					seasonPack: query.seasonPack,
					// Always sent, and that is the point of it: a search that does not say
					// falls back to the television categories, which finds nothing at all for
					// a film and reports no fault while doing it.
					kind: query.kind,
				})}`,
			);

			result.value = found;
			searchedFor.value = query.itemId ?? null;

			return found;
		} finally {
			searching.value = false;
		}
	}

	/**
	 * A way of covering every gap, as several releases taken in order.
	 *
	 * A POST for what reads like a question, because the body is the search body: the
	 * gateway searches again to build the plan — a release identifier is only valid
	 * inside the search that produced it, so a plan assembled from the held result
	 * would name rows the gateway may already have forgotten.
	 */
	async function planFor (query: ReleaseSearchQuery): Promise<CoveragePlan> {
		planning.value = true;
		try {
			const built = await caller('api').post<CoveragePlan>('/releases/plan', {
				itemId: query.itemId,
				term: query.term,
				seasonNumber: query.seasonNumber,
				episodeNumber: query.episodeNumber,
				seasonPack: query.seasonPack,
				kind: query.kind,
			});

			plan.value = built;
			plannedFor.value = query.itemId ?? null;

			return built;
		} finally {
			planning.value = false;
		}
	}

	/** Forgets the held result, for when the page moves to another media. */
	function clear (): void {
		result.value = null;
		searchedFor.value = null;
		clearPlan();
	}

	/** Forgets the plan alone, for when a new search makes it stale. */
	function clearPlan (): void {
		plan.value = null;
		plannedFor.value = null;
	}

	/**
	 * Hand a release to the download client, or part of one.
	 *
	 * `wanted` is what makes a season pack cost two files instead of a season: the
	 * gateway adds the torrent stopped, reads its file list, sets everything else to
	 * zero priority and only then starts it. Omitted means the whole release, which is
	 * what a single episode always is — and sending the episodes of a single-file
	 * release would ask the client to deprioritise the only file it has.
	 */
	async function grab (
		releaseId: string,
		itemId: string,
		wanted?: EpisodeRef[],
	): Promise<ReleaseGrab> {
		const created = await caller('api').post<ReleaseGrab>('/releases/grab', {
			releaseId,
			itemId,
			...(wanted === undefined || wanted.length === 0 ? {} : { wanted }),
		});

		merge(created);

		return created;
	}

	/**
	 * Fetch a copy a peer already holds, through the machinery that moves every other byte.
	 *
	 * **Never the download client.** There is no magnet here and no torrent to add: this is
	 * one of our own catalogue rows on somebody else's server, which is precisely what a
	 * sync run reads from. Sending it to `/releases/grab` would be refused by the gateway,
	 * and the point of it living in this one function is that nothing has to remember to.
	 *
	 * `itemIds` are the *holder's* rows and never ours. Naming our own would plan a pull
	 * from the disk the file is missing off, which succeeds at planning nothing.
	 *
	 * `includeHeld` because pressing this row is the decision, already made: without it the
	 * planner drops a media we hold in another version and answers a run that plans
	 * nothing, finishes at once and says nothing — the same trap the source list hit.
	 */
	async function pull (copy: PeerCopy): Promise<SyncJob> {
		return useSyncStore().run({
			scope: { itemIds: copy.itemIds },
			sourceServiceIds: [copy.serviceId],
			filter: { includeHeld: true },
		});
	}

	/**
	 * The trackers the configured indexer reaches, for the search-order screen.
	 *
	 * Suggestions and nothing more: any value can still be written, because a tracker this
	 * gateway has never searched is still one somebody may prefer. What they prevent is the
	 * silent miss — a name typed one character off orders nothing and says nothing.
	 */
	const trackers = ref<string[]>([]);

	async function loadTrackers (): Promise<string[]> {
		const rows = await caller('api').get<string[]>('/releases/trackers');

		trackers.value = Array.isArray(rows) ? rows : [];

		return trackers.value;
	}

	async function loadGrabs (itemId?: string): Promise<ReleaseGrab[]> {
		const rows = await caller('api').get<ReleaseGrab[]>(
			`/releases/downloads${queryString({ itemId })}`,
		);

		grabs.value = Array.isArray(rows) ? rows : [];

		return grabs.value;
	}

	/**
	 * Send a torrent somewhere else, before it is filed.
	 *
	 * Nothing is copied: the gateway reads the destination when the download finishes,
	 * so changing it beforehand costs one row write whatever the torrent is doing.
	 */
	async function setDestination (
		id: string,
		libraryId: string | null,
		folder: string | null,
	): Promise<ReleaseGrab> {
		const updated = await caller('api').post<ReleaseGrab>(
			`/releases/downloads/${id}/destination`,
			{ libraryId, folder },
		);

		merge(updated);

		return updated;
	}

	/**
	 * Replaced by identifier rather than appended.
	 *
	 * The stream pushes a frame per poll, and a list that grew by one every five seconds
	 * would be a progress bar repeated four hundred times by the end of a film.
	 */
	function merge (grabbed: ReleaseGrab): void {
		const index = grabs.value.findIndex(one => one.id === grabbed.id);

		grabs.value = index === -1
			? [grabbed, ...grabs.value]
			: grabs.value.map(one => (one.id === grabbed.id ? grabbed : one));
	}

	events.on(EventName.RELEASE_GRAB, (payload: ReleaseGrab) => {
		merge(payload);
	});

	/**
	 * Everything the last search answered, in the one order the gateway put it in.
	 *
	 * Read through here rather than off `result` so that no screen re-sorts it: the rule
	 * that a copy which exists outranks a name on a tracker is the gateway's, and a second
	 * opinion about it in a component would be an order nobody could account for.
	 */
	const suggestions = computed<ReleaseSuggestion[]>(() => result.value?.suggestions ?? []);

	/** The peer half, which is what a plan's uncovered episodes are checked against. */
	const peerSuggestions = computed<PeerCopy[]>(
		() => suggestions.value.filter(one => isPeerSuggestion(one)).map(one => one.copy));

	return {
		result,
		grabs,
		searching,
		searchedFor,
		suggestions,
		peerSuggestions,
		plan,
		planning,
		plannedFor,
		search,
		planFor,
		clear,
		clearPlan,
		grab,
		pull,
		trackers,
		loadTrackers,
		loadGrabs,
		setDestination,
	};
});
