import { LANDED_SYNC_STATES, SyncState } from '@mcs/shared';
import type { MatchPair } from '@/repositories';

/**
 * The rules that decide what a group *is*, with no gateway around them.
 *
 * Pure on purpose, and in its own file for one reason: these two rules are now applied
 * in two threads. The gateway applies them to render a page; a worker applies them to
 * project the whole catalogue — see `CatalogueProjectionService`. A copy in each would
 * be two answers to "what state is this media in", and they would disagree the first
 * time one of them was corrected. One copy, imported by both.
 *
 * Not exported from the services barrel, deliberately. `app.module` registers every
 * class a barrel exports as a provider, and `MatchGraph` is a data structure: Nest
 * would build an empty one at startup for nobody. Imported by path instead, which is
 * what `jobs.worker.ts` already does for the code it runs.
 */

/**
 * The states that mean "the bytes are on our disk", whatever any service says.
 *
 * Grouped because every reader here asks the same question of them — is this a gap to
 * fill — and the answer is no for both: one is waiting for an index and the other has
 * given up waiting, and in neither case would downloading it again put anything new on
 * the disk. Anywhere that tests only one of the two is a screen that counts a landed
 * episode as missing once its grace period expires, which would be the original bug
 * returning twelve hours late.
 */
export const LANDED_STATES = new Set<SyncState>(LANDED_SYNC_STATES);

/**
 * Which state a group shows when its copies disagree, most urgent first.
 *
 * Read off the local copies only, and in this order because that is the order the
 * states matter to somebody looking at a poster: a running transfer is happening now,
 * a conflict needs a decision, an outdated copy is worth replacing, and `in_sync` is
 * the answer that means there is nothing to do. `unknown` is the fallback rather than
 * a rank, since it says only that correlation has not run.
 */
export const GROUP_STATE_ORDER = [
	SyncState.SYNCING,
	SyncState.CONFLICT,
	SyncState.OUTDATED,
	SyncState.MISSING,
	SyncState.IN_SYNC,
	SyncState.LOCAL_ONLY,
] as const;

/** The two fields the state rule reads, rather than a whole row or a whole digest. */
export interface StateBearing {
	serviceId: string;
	syncState: SyncState;
}

/**
 * The state a group shows, derived from the copies we hold.
 *
 * A media with no local copy is `missing` whatever its remote rows say about each
 * other: two friends being in sync with one another is not an answer to "do I have
 * this", and the poster that asks that question is on our screen.
 *
 * Unless the gateway has already put the file on the disk. No service holds it —
 * none of them has scanned yet — so every test above answers "missing" while the
 * bytes are in the library folder, which is exactly how the same episode gets
 * pulled twice. The landing is carried on the copy we pulled from, which is one of
 * these members, so the group can read it here without a second query.
 */
export const groupStateOf = (members: StateBearing[], local: ReadonlySet<string>): SyncState => {
	const held = members.filter((member) => local.has(member.serviceId));

	if (held.length === 0) {
		return members.find((member) => LANDED_STATES.has(member.syncState))?.syncState
			?? SyncState.MISSING;
	}

	for (const state of GROUP_STATE_ORDER) {
		if (held.some((member) => member.syncState === state)) {
			return state;
		}
	}

	return SyncState.UNKNOWN;
};

/**
 * The name a set of states is filed under, so an answer can be found again.
 *
 * Sorted, because the caller's order is an accident of how the filter was written and
 * two callers asking the same question must land on the same name. It is also what a
 * projection answers with, which is why it lives here rather than beside either of the
 * two sides that build one.
 */
export const stateSignature = (states: SyncState[]): string => [...states].sort().join(',');

/**
 * How many match rows one page of a graph build carries.
 *
 * Two thousand is the same figure the catalogue read uses, for the same reason: large
 * enough that the round trips disappear beside the work, small enough that the pause
 * between two of them is a few milliseconds rather than a visible stall.
 *
 * Shared by the gateway's background rebuild and the worker's projection so that the
 * two cannot drift into different ideas of what a page costs.
 */
export const GRAPH_PAGE = 2000;

/**
 * Connected components of the applied-match graph.
 *
 * A union-find held for the length of one request, not a column and not a query. It
 * could not be a column: whether a pair joins depends on the match threshold in force
 * now, so a stored `groupId` would have to be recomputed over the whole index every
 * time somebody moved that slider, and would be silently wrong until they did. It is
 * not a recursive query either — the traversal is the same cost in either place, and
 * doing it here keeps one implementation instead of one per dialect.
 */
export class MatchGraph {
	private readonly _parent = new Map<string, string>();
	private readonly _otherCut = new Set<string>();
	private _components: Map<string, string[]> | null = null;

	public constructor(pairs: MatchPair[] = []) {
		this.absorb(pairs);
	}

	/**
	 * Fold more edges in, so the graph can be built a page at a time.
	 *
	 * Union-find does not care in what order it is told things — that is the whole point
	 * of the structure — so a graph fed thirty pages is the same graph as one fed the
	 * table at once. What it buys is a place to breathe between them, which a constructor
	 * looping over sixty thousand rows had nowhere to put.
	 */
	public absorb(pairs: readonly MatchPair[]): void {
		// Any component cached from an earlier page is a partial answer now.
		this._components = null;

		for (const pair of pairs) {
			this._union(pair.localItemId, pair.remoteItemId);

			if (pair.state === SyncState.CONFLICT) {
				this._otherCut.add(pair.localItemId);
				this._otherCut.add(pair.remoteItemId);
			}
		}
	}

	/** Whether the group holds another version of the work this copy is one version of. */
	public besideAnotherCut(id: string): boolean {
		return this._otherCut.has(id);
	}

	/** The component's representative node. An item nobody matched is its own. */
	public root(id: string): string {
		let current = id;

		while (this._parent.has(current) && this._parent.get(current) !== current) {
			current = this._parent.get(current) as string;
		}

		return current;
	}

	/** Every item an applied match put with this one, itself included, sorted. */
	public members(id: string): string[] {
		return this._index().get(this.root(id)) ?? [id];
	}

	private _union(left: string, right: string): void {
		this._ensure(left);
		this._ensure(right);

		const leftRoot = this.root(left);
		const rightRoot = this.root(right);

		if (leftRoot !== rightRoot) {
			this._parent.set(leftRoot, rightRoot);
		}

		this._components = null;
	}

	private _ensure(id: string): void {
		if (!this._parent.has(id)) {
			this._parent.set(id, id);
		}
	}

	private _index(): Map<string, string[]> {
		if (this._components === null) {
			const index = new Map<string, string[]>();

			for (const id of [...this._parent.keys()].sort()) {
				const root = this.root(id);

				index.set(root, [...(index.get(root) ?? []), id]);
			}

			this._components = index;
		}

		return this._components;
	}
}
