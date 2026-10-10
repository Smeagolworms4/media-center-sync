import { MediaServiceMode, SyncState } from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import {
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	type GroupSeedQuery,
	type MediaItemDigest,
} from '@/repositories';
import { breathe } from './breathe';
import { GRAPH_PAGE, groupStateOf, MatchGraph, stateSignature } from './grouping';
import { serviceMode } from './service-mode';

/**
 * How many rows of the scope one statement reads.
 *
 * Four thousand, which on the owner's catalogue turns one 177 ms block into eight of
 * about twenty. It matters less here than it did on the gateway's thread — nothing on
 * this thread is holding a socket — but the pass also runs in-process wherever there is
 * no worker, and there it is the difference between a readable gateway and a deaf one.
 */
const SCOPE_PAGE = 4_000;

/**
 * The fields the projection does not look at, and therefore the ones its key leaves out.
 *
 * `rootsOnly`, `search` and `kind` are overridden by `_scope` below, because the answer
 * is about everything beneath a root: the search names the poster rather than its
 * episodes, and the kind filter would hide the very children being counted. `skip` and
 * `take` are the page the caller wanted, which is not a property of the catalogue.
 *
 * Exported because the caller keys its store on everything *else*, and the two lists
 * have to be the same list — a filter added to one and not the other is a projection
 * silently shared between two different questions.
 */
export const OUTSIDE_PROJECTION = ['rootsOnly', 'search', 'kind', 'skip', 'take'] as const;

/** What a projection is asked for. Plain data: it crosses `postMessage`. */
export interface ProjectionRequest {
	seedQuery: GroupSeedQuery;
	/** One group of states per answer wanted, each filed under its `stateSignature`. */
	states: SyncState[][];
	/** The match threshold in force, because what joins depends on it. */
	threshold: number;
}

/** What a projection answers. Plain data, for the same reason. */
export interface ProjectionAnswer {
	/**
	 * The match table's version when the graph was read.
	 *
	 * Returned rather than assumed so the caller can tell whether the answer describes
	 * the catalogue it asked about. A projection computed while a scan was writing
	 * matches is a correct answer to a *different* question, and filing it under the
	 * version the caller believed in is how a wall ends up confidently wrong.
	 */
	version: string;
	/** Root item identifiers per state signature. Arrays rather than sets, to be cloned. */
	roots: Record<string, string[]>;
}

/**
 * How far up a parent chain the walk climbs before it gives up.
 *
 * A series, a season, an episode is three steps. Bounded because the chain is data a
 * media server wrote: a loop in somebody's index has to cost a few iterations rather
 * than the pass.
 */
const PARENT_HOPS = 8;

/**
 * Which roots have something beneath them in a given set of states.
 *
 * This is the one expensive question the library screen asks, and the reason it is a
 * service of its own rather than four methods on `MediaGroupManager` is that it has to
 * run **somewhere else**. Measured on the owner's catalogue of 31 631 rows: 5.2 s per
 * request, of which `limit=1` cost the same 5.4 s because none of the work depends on
 * how many rows the caller asked for. `better-sqlite3` is synchronous, so those seconds
 * were not latency — they were the gateway's event loop, gone, with thirty artwork
 * transfers and the event socket dying together because nothing was reading the sockets.
 *
 * Breathing between pages made the slices shorter and did not make them go away: a
 * request still blocked in bursts of about 140 ms. What removes the blocking is running
 * it on a thread that holds no sockets — see `WorkerPoolService` and `JobKind.PROJECT`.
 *
 * So everything here is built to cross a thread boundary: plain data in, plain data out,
 * no entity, no query runner, no `GroupContext`. It reads its own graph rather than
 * borrowing the gateway's, which is safe because a union-find does not care in what
 * order it is told things — the same table at the same threshold is the same graph —
 * and the version it answers with is what lets the caller check that assumption.
 *
 * It is kept injectable, and the gateway keeps a copy, for the runs that have no worker:
 * an in-memory database cannot be opened twice, so the unit and functional suites run
 * this pass in-process and test it there.
 */
@Injectable()
export class CatalogueProjectionService {
	/**
	 * The graph this thread last built, kept for the next projection.
	 *
	 * A catalogue change triggers one projection per scope somebody has been looking at,
	 * and they arrive together. Rebuilding the union-find for each would read the whole
	 * match table two or three times over for an answer that cannot have moved between
	 * them — the version is part of the key, so one that has moved simply misses.
	 */
	private _graph: { version: string; threshold: number; graph: MatchGraph } | null = null;

	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
	) {}

	public async project(request: ProjectionRequest): Promise<ProjectionAnswer> {
		const version = await this._matches.version();
		const graph = await this._graphFor(version, request.threshold);
		const local = await this._local();
		const scope = await this._scope(request.seedQuery);
		const parentOf = new Map(scope.map((seed) => [seed.id, seed.parentId]));
		const beneath = await this._states(
			scope.filter((seed) => seed.parentId !== null),
			graph,
			local,
		);
		const roots: Record<string, string[]> = {};

		for (const states of request.states) {
			const signature = stateSignature(states);

			if (signature in roots) {
				continue;
			}

			roots[signature] = [...(await this._climb(beneath, states, parentOf))];
		}

		return { version, roots };
	}

	/**
	 * Every row in scope, read a page at a time.
	 *
	 * One statement over the whole scope was a single uninterruptible block — 177 ms for
	 * thirty-one thousand rows on the owner's catalogue, measured. The only way to
	 * interrupt a statement is to make it several, which is the same thing the graph
	 * build above does and for the same reason.
	 *
	 * The order the query applies is total and ends on the identifier, so the pages
	 * cannot overlap or lose a row between them.
	 *
	 * The three overrides are `OUTSIDE_PROJECTION`, less the paging: keep them in step.
	 */
	private async _scope(seedQuery: GroupSeedQuery): Promise<MediaItemDigest[]> {
		const scope: MediaItemDigest[] = [];

		for (let skip = 0; ; skip += SCOPE_PAGE) {
			const page = await this._items.findGroupSeeds({
				...seedQuery,
				rootsOnly: false,
				search: undefined,
				kind: undefined,
				skip,
				take: SCOPE_PAGE,
			});

			scope.push(...page);
			await breathe(0);

			if (page.length < SCOPE_PAGE) {
				return scope;
			}
		}
	}

	/** The graph for this version of the table, built a page at a time, kept after. */
	private async _graphFor(version: string, threshold: number): Promise<MatchGraph> {
		const held = this._graph;

		if (held !== null && held.version === version && held.threshold === threshold) {
			return held.graph;
		}

		const graph = new MatchGraph();

		for (let skip = 0; ; skip += GRAPH_PAGE) {
			const page = await this._matches.findAppliedPairs(threshold, skip, GRAPH_PAGE);

			graph.absorb(page);
			await breathe(0);

			if (page.length < GRAPH_PAGE) {
				break;
			}
		}

		this._graph = { version, threshold, graph };

		return graph;
	}

	/** The services whose libraries this gateway can write into. */
	private async _local(): Promise<Set<string>> {
		const services = await this._services.find();

		return new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
	}

	/**
	 * Each group beneath a root reduced to the two things the answer needs: who is in it
	 * and what state it shows.
	 *
	 * Deliberately not a `GroupSkeleton` — the gap count, the news signals and whether a
	 * copy is held are the expensive half of that shape and none of them is read here.
	 * The state filter and the member identifiers are the whole of what a projection
	 * uses, so building the rest would be work done to be thrown away, thirty thousand
	 * times per pass.
	 */
	private async _states(
		seeds: MediaItemDigest[],
		graph: MatchGraph,
		local: ReadonlySet<string>,
	): Promise<{ memberIds: string[]; sync: SyncState }[]> {
		const order: string[] = [];
		const byRoot = new Map<string, string[]>();

		for (const seed of seeds) {
			const root = graph.root(seed.id);

			if (!byRoot.has(root)) {
				byRoot.set(root, graph.members(seed.id));
				order.push(root);
			}
		}

		const digests = new Map(seeds.map((seed) => [seed.id, seed]));
		const outsiders = [...byRoot.values()].flat().filter((id) => !digests.has(id));

		// The copies the filter left out still decide the group's state: a media held
		// on a friend's server and not here reads `missing` only because that copy was
		// looked at.
		for (const digest of await this._items.findDigests(outsiders)) {
			digests.set(digest.id, digest);
		}

		const built: { memberIds: string[]; sync: SyncState }[] = [];

		for (const [index, root] of order.entries()) {
			await breathe(index);

			const memberIds = byRoot.get(root) as string[];
			const members = memberIds
				.map((id) => digests.get(id))
				.filter((digest): digest is MediaItemDigest => digest !== undefined);

			built.push({ memberIds, sync: groupStateOf(members, local) });
		}

		return built;
	}

	/** The top of the parent chain above every group in one of these states. */
	private async _climb(
		beneath: { memberIds: string[]; sync: SyncState }[],
		states: SyncState[],
		parentOf: Map<string, string | null>,
	): Promise<Set<string>> {
		const roots = new Set<string>();
		const wanted = beneath.filter((group) => states.includes(group.sync));

		for (const [index, group] of wanted.entries()) {
			await breathe(index);

			for (const memberId of group.memberIds) {
				let current: string | null | undefined = memberId;

				for (let depth = 0; depth < PARENT_HOPS && current; depth += 1) {
					const parent = parentOf.get(current);

					if (parent === null) {
						roots.add(current);
						break;
					}

					current = parent;
				}
			}
		}

		return roots;
	}
}
