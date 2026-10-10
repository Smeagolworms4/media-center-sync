import {
	ActionableReason,
	CacheRefreshReason,
	ErrorKey,
	MediaOrigin,
	MediaServiceMode,
	PeerTrust,
	MediaKind,
	MediaServiceType,
	MediaWatchState,
	NewsSignal,
	SyncState,
	type ExternalIds,
	type MediaGroup,
	type MediaGroupQuery,
	type MediaGroupSource,
	type MediaVersion,
	type QualitySummary,
	type ResultList,
} from '@mcs/shared';
import {
	Injectable,
	Logger,
	NotFoundException,
	type OnApplicationBootstrap,
	type OnModuleInit,
} from '@nestjs/common';
import { In } from 'typeorm';
import type { MediaItem as MediaItemEntity, MediaService as MediaServiceEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerRepository,
	SyncPlanRepository,
	type GroupSeedQuery,
	type MediaItemDigest,
} from '@/repositories';
import { createHash } from 'node:crypto';
import {
	breathe,
	CatalogueCacheService,
	CatalogueProjectionService,
	editionOf,
	episodesCovered,
	isWorkerThread,
	mappedLocalPath,
	OUTSIDE_PROJECTION,
	QualityService,
	serviceMode,
	SettingsService,
	fetchableOf,
	spanOf,
	versionIdOf,
	WorkerPoolService,
	type EpisodeSpan,
	type ProjectionAnswer,
	type ProjectionRequest,
} from '@/services';
/*
 * By path rather than through the barrel, and the barrel says why: `app.module`
 * registers every class a barrel exports as a provider, and `MatchGraph` is a data
 * structure Nest would build once at startup for nobody.
 */
import {
	GRAPH_PAGE,
	groupStateOf,
	LANDED_STATES,
	MatchGraph,
	stateSignature,
} from '@/services/grouping';
import { JobKind } from '@/worker/protocol';
import { LibraryManager } from './library.manager';
import { pageBounds, paginate } from './mappers';

/**
 * The kinds for which holding the media means holding a file.
 *
 * A series and a season hold nothing themselves — what is under them does — so a row
 * of either is evidence that a server knows the show and never evidence of bytes. An
 * episode and a film are the opposite: a row of one with no file names something a
 * server listed and does not have, which is a gap and not a holding. Testing the file
 * without the kind would make every season of every library a gap; testing the kind
 * without the file is what let a discovered episode read as held.
 */
const CARRIES_A_FILE = new Set<MediaKind>([MediaKind.EPISODE, MediaKind.MOVIE]);

/**
 * How many scopes' projections to keep.
 *
 * One per shape of filter somebody is browsing with — the news wall, a library, a
 * friend's copies. Eight covers a household several tabs deep and bounds a map whose
 * keys are built from query objects, which is the kind that grows for ever if nobody
 * says otherwise.
 */
const SCOPES_KEPT = 8;

/**
 * How many of them are recomputed when the catalogue moves.
 *
 * Fewer than are kept, and that asymmetry is deliberate: keeping an answer costs a few
 * hundred kilobytes, recomputing one costs a pass over the catalogue, and `refresh`
 * waits for these before it reports that anything changed — which is what makes the
 * reloading tab find its answer ready. A request that arrives mid-refresh waits for the
 * same thing, so this number is also the worst case somebody can be made to wait.
 *
 * Two covers the real case: the news wall, and the library screen somebody came from.
 * The scopes beyond that are recomputed by whoever asks for them next, exactly as they
 * were before any of this was kept.
 */
const SCOPES_WARMED = 2;

/**
 * The fields the projection neutralises, and therefore the ones it does **not** depend
 * on. Owned by the projection, because it is the thing that ignores them.
 *
 * Listed as what to *remove* rather than what to keep, on purpose: a filter added to
 * `GroupSeedQuery` tomorrow lands in the signature by default and gets its own
 * projection. The opposite spelling — naming the fields that matter — would silently
 * serve one filter's answer to another the day somebody adds a field and forgets this
 * line, and a wrong answer here looks exactly like a right one.
 */
const OUTSIDE_SCOPE = new Set<string>(OUTSIDE_PROJECTION);

/** A query's scope, as a string two equal scopes always spell the same way. */
const scopeSignature = (seedQuery: GroupSeedQuery): string => {
	const scoped = Object.entries(seedQuery as unknown as Record<string, unknown>)
		.filter(([field, value]) => !OUTSIDE_SCOPE.has(field) && value !== undefined)
		// Sorted because `JSON.stringify` keeps insertion order, and two queries built by
		// different routes hold the same filters in different orders.
		.sort(([left], [right]) => left.localeCompare(right));

	return createHash('sha1').update(JSON.stringify(scoped)).digest('hex');
};

/**
 * The fields a group fills per copy and a person can correct by hand.
 *
 * Named as a type rather than left open because the rule only holds where the item
 * column and the `reported` snapshot describe the same thing: both carry these five,
 * and comparing them is what says a value was corrected. `externalIds` is left out on
 * purpose — identifiers are merged key by key rather than chosen, so there is no single
 * value for a correction to win, and a correction there enriches the merge instead of
 * beating it. `libraryId` is left out too: it says which shelf this copy sits on, which
 * is a fact about the copy and not about the media, and the listing already filters on
 * each row's effective value.
 */
type OverriddenField = 'title' | 'year' | 'seasonNumber' | 'episodeNumber' | 'overview';

/**
 * The states that mean a copy worth having exists somewhere else.
 *
 * What `actionable` reads for its "something new" half, and deliberately the same three
 * words the state chips already use rather than a fourth vocabulary: missing is not here
 * at all, outdated is here in a worse encoding, and conflict is a cut of the work we do
 * not hold. `syncing` is left out because a transfer already running is not something to
 * ask anybody to do, and `local_only` because nobody else has anything to offer.
 */

/**
 * How far up a parent chain the followed scope climbs.
 *
 * Series, season, episode is three steps, and one extra for a collection above a film.
 * Bounded because the chain is data a media server wrote: a loop in somebody's index has
 * to cost a few queries rather than the request.
 */
const FOLLOWED_HOPS = 4;

/**
 * The children of a page of groups, and every copy of those children.
 *
 * `byId` holds more than `byParent` does, and that difference is the whole reason the
 * index exists — see `_children`.
 */
interface ChildIndex {
	byParent: Map<string, MediaItemDigest[]>;
	byId: Map<string, MediaItemDigest>;
}

/** One group before its rows are read: who is in it, and what state it is in. */
interface GroupSkeleton {
	memberIds: string[];
	sync: SyncState;
	/** At least one copy sits on a service whose libraries we can write into. */
	held: boolean;
	/**
	 * Children known somewhere and absent here, ignored ones excluded.
	 *
	 * Zero unless the caller asked for it: working it out costs a query over every
	 * child of every group in the result, not just the page being rendered, and the
	 * only filter that needs it is `hideOwned`. Paying for it on every listing would
	 * make the common case slower to serve a question nobody asked.
	 */
	missingCount: number;
	/**
	 * What was last seen that could fill a gap beneath it. See `fetchableOf`.
	 *
	 * Read off the digests rather than with the page, because the filter has to narrow
	 * the catalogue before it is paged: a screen that dropped rows after receiving them
	 * would page over the ones it dropped — twelve asked for, four drawn, and a pager
	 * counting twelve.
	 */
	fetchable: NewsSignal[];
}

/** What a listing needs to know about the world, read once per request. */
interface GroupContext {
	graph: MatchGraph;
	services: Map<string, MediaServiceEntity>;
	/**
	 * Where a container sits on this gateway's own disks, by item.
	 *
	 * Only filled for the reads that show one media — the page for a series, a season
	 * or a file — because working it out means walking down to the files underneath, and
	 * a wall of two hundred posters would walk the whole catalogue to answer a question
	 * nobody asked there. Empty elsewhere, which reads as "not known" and shows nothing.
	 */
	folders: Map<string, string>;
	peerNames: Map<string, string>;
	/** Services whose libraries the gateway can write into. */
	local: Set<string>;
	/** Peers a friend introduced, rather than ones we linked to ourselves. */
	friendsOfFriends: Set<string>;
}

/**
 * The library screen's view of the index: one media, whoever holds it.
 *
 * The index keeps a row per service on purpose — merging them would mean choosing
 * whose title, whose artwork and whose file size survive. Browsing wants the opposite,
 * so a group is computed from the match graph at read time and never stored. Two rows
 * only join when a match was **applied**: a proposal below the threshold stays two
 * posters, because that state exists precisely to say that nobody has decided the pair
 * is one thing. Two cuts of one work do join — the identifier decided the work, and
 * one card reading `conflict` says what two unrelated cards never could — and that is
 * safe only because a copy in `conflict` never counts as holding the media; see
 * `_holds`.
 *
 * It is a manager of its own rather than four more methods on `MediaManager` because
 * nothing here is shared with correlation or artwork: it reads, folds and ranks, and
 * the only thing it has in common with its neighbour is the table.
 *
 * **What is pushed into SQL, and what is not.** The filters that name a column —
 * service, library, kind, parent, search — are `WHERE` clauses on a six-column
 * projection, so the rows a library page never shows are never read. The matches are
 * one query per request, not one per item. The full rows, with their JSON columns, are
 * read for the page and for nothing else.
 *
 * Two filters that look like they could not be pushed down are, and both are worth
 * naming because the obvious reading of them is the expensive one:
 *
 * - **Resolution and codec.** They describe files, and the files sit in a JSON column —
 *   but a scan writes the *derived* labels onto every row's quality summary, banded and
 *   folded by `QualityService`, so the filter is a substring test on that column rather
 *   than thirty thousand rows deserialised to be dropped. It also means the wall and the
 *   chip on a card can never disagree about what a file is, since both read the one
 *   reading. Aggregates roll upward, so a series row carries every encoding beneath it
 *   and the filter needs no walk down the tree.
 * - **Following.** Which media a sync plan covers is a rule — coverage takes the parent
 *   chain — so it is resolved here, into identifiers, and handed to the query as a set of
 *   rows to keep. The set is the followed subtrees and not the index, which is the point.
 *
 * Four things could not be pushed down, and each is a schema fact rather than an
 * oversight:
 *
 * - **The components.** There is no `groupId` column and there should not be one; see
 *   `MatchGraph`. So the fold is in memory, over identifiers.
 * - **Pagination.** Several rows collapse into one group, so `LIMIT` on rows returns a
 *   page whose size nobody can predict and a total that contradicts it. The slice is
 *   taken on groups, which means the filtered identifiers are all read. They are six
 *   scalar columns; the expensive ones are not.
 * - **The state filter.** A group's state is derived from its local copies, and the
 *   rows do not carry it. Filtering on `media_items.syncState` instead would answer a
 *   different question — "is one of the copies missing" rather than "is this media
 *   missing here" — and would be wrong exactly where it matters, on a media held
 *   nowhere local.
 * - **Having something to do about it.** One half of it is the state above; the other is
 *   the gap count, which is a fold of the children through the match graph and not a
 *   column either. Both are already computed for the filtered set, so the filter costs
 *   the reading rather than a query.
 */
/**
 * What a resolved `followed` or `watched` filter narrows the catalogue to.
 *
 * Three fields rather than one list, because they are three different questions. `ids`
 * are rows kept outright. `underIds` are rows kept because their parent is one of these —
 * the episodes of a followed season come along, while a *sibling* season does not just
 * because they share a series. `watchStates` are rows kept because of what the household
 * said about them, which is how a whole watchlist is named without enumerating it.
 */
interface Scope {
	ids: string[];
	underIds: string[];
	watchStates?: MediaWatchState[];
}

@Injectable()
export class MediaGroupManager implements OnApplicationBootstrap, OnModuleInit {
	/** The grouping graph last built, and what the match table looked like then. */
	private _graph: { version: string; threshold: number; graph: MatchGraph } | null = null;

	/**
	 * Which roots have something beneath them in a given set of states, per scope.
	 *
	 * The answer a request needs from the catalogue walk, reduced to what it actually
	 * uses: a set of member identifiers. Keeping the skeletons instead would be thirty
	 * thousand objects held for a NAS that is already short of memory; keeping the ids is
	 * a few hundred kilobytes.
	 *
	 * Keyed by the scope **and the version of the match table it was built from**, so a
	 * catalogue that moved simply misses the key. That is deliberate: an explicit
	 * invalidation is a line somebody has to remember to write on every path that
	 * changes a row, and the day one is missed the gateway serves a confident wrong
	 * answer — a wall that says there is nothing to fetch when there is.
	 */
	private readonly _roots = new Map<string, Map<string, Set<string>>>();

	/**
	 * A pass already running, so three tabs opening at once share one walk.
	 *
	 * This is what makes "wait for the first computation" affordable: the first caller
	 * after a boot pays for it, the others wait on the same promise, and none of them
	 * blocks the event loop while waiting.
	 */
	private readonly _building = new Map<string, Promise<Map<string, Set<string>>>>();

	/**
	 * The questions worth asking again when the catalogue moves. See `_remember`.
	 *
	 * The scope rather than the key, because a key names a version of the match table
	 * and the whole point is to re-project for the *next* one. Bounded with `_roots`, so
	 * a household that browsed eight shapes of filter does not accumulate a ninth
	 * forever.
	 */
	private readonly _warmable = new Map<
		string,
		{ seedQuery: GroupSeedQuery; states: SyncState[][] }
	>();

	private readonly _logger = new Logger(MediaGroupManager.name);

	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _peers: PeerRepository,
		private readonly _quality: QualityService,
		private readonly _settings: SettingsService,
		private readonly _libraries: LibraryManager,
		private readonly _plans: SyncPlanRepository,
		private readonly _cache: CatalogueCacheService,
		/** The catalogue pass itself, which runs on a worker whenever there is one. */
		private readonly _projection: CatalogueProjectionService,
		private readonly _workers: WorkerPoolService,
	) {}

	/**
	 * Hand the cache the one thing only this class can do.
	 *
	 * `onModuleInit` rather than the bootstrap hook: a scan can finish — and schedule a
	 * refresh — before every bootstrap hook has run, and a refresher registered after
	 * that point would miss it. Module init happens before any of them.
	 */
	public onModuleInit(): void {
		this._cache.onRefresh(() => this.refresh());
	}

	/**
	 * Build the graph before anybody asks for it, because nothing survived the restart.
	 *
	 * The cache is in memory, so every deployment and every crash leaves it empty — and
	 * the first person to open a page rebuilds the whole match table on their own clock.
	 * That is the exact cost this cache exists to remove, and warming only after a scan
	 * left the one case where it is guaranteed to be cold completely uncovered: the
	 * minute after an update, which is also the minute somebody is most likely to be
	 * looking.
	 *
	 * `onApplicationBootstrap` and not `onModuleInit`: this reads the database, and the
	 * connection is not up at module init. Not awaited and never allowed to fail the
	 * boot — a gateway that refused to start because it could not pre-compute a cache
	 * would be trading a slow first page for no gateway at all.
	 */
	public onApplicationBootstrap(): void {
		if (isWorkerThread()) {
			// The gateway owns this. See `isWorkerThread`: a worker that armed it too would
			// give the household two of everything.
			return;
		}

		this._cache.schedule(CacheRefreshReason.BOOT);
	}

	public async groups(query: MediaGroupQuery): Promise<ResultList<MediaGroup>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const context = await this._context();
		const parentIds =
			query.parentId === undefined ? undefined : await this._parentScope(query.parentId, context);
		const followed = query.followed === true ? await this._followedScope() : null;
		const watched = query.watched === true ? await this._watchedScope() : null;
		// Both narrow the same way — a membership test on the seed — so two of them is an
		// intersection and never a contradiction. A caller asking for both gets what a plan
		// follows *and* what was asked for, which is a reasonable question to ask.
		/*
		 * Both asked for at once is an intersection, and the library branch drops out of it
		 * on purpose rather than by oversight. `_watchedScope` is `_followedScope` widened
		 * by the watchlist, so intersecting the two id sets already *is* the followed set —
		 * and a row that is in the watchlist without being followed is precisely what an
		 * "and followed" filter is asking to exclude.
		 */
		const scope: Scope | null = followed === null || watched === null
			? (followed ?? watched)
			: {
				ids: followed.ids.filter(id => watched.ids.includes(id)),
				underIds: followed.underIds.filter(id => watched.underIds.includes(id)),
			};

		const seedQuery: GroupSeedQuery = {
			serviceIds: this._servicesFor(query, context),
			libraryIds: await this._librariesFor(query),
			kind: query.kind,
			rootsOnly: query.rootsOnly,
			search: query.search,
			sort: query.sort,
			direction: query.direction,
			parentIds,
			resolutions: query.resolutions,
			// Folded before the query sees them, because the index only ever holds the
			// folded spelling and `hevc` is what somebody will actually type.
			videoCodecs: this._codecsFor(query),
			coveredIds: scope?.ids,
			coveredParentIds: scope?.underIds,
			coveredWatchStates: scope?.watchStates,
			/*
			 * Asked for outright, and kept apart from the scope above. The scope is a
			 * membership test that `followed` and `watched` resolve into; this is a plain
			 * filter somebody wrote in an address — "show me what I have asked for" — and
			 * folding it into the scope would make the two widen each other where they are
			 * meant to narrow.
			 */
			watchStates: query.watchStates,
		};
		const seeds = await this._items.findGroupSeeds(seedQuery);

		// The gap count is worked out for `actionable` as well as for `hideOwned`: both
		// ask whether anything beneath a media is still missing, and neither can read it
		// off a column.
		const skeletons = await this._skeletons(
			seeds,
			context,
			query.hideOwned === true || query.actionable === true,
		);
		const states = query.states ?? [];
		const byState =
			states.length === 0
				? skeletons
				: await this._inState(skeletons, states, seedQuery);
		const actionable =
			query.actionable === true
				? await this._actionable(byState, seedQuery, query.reasons)
				: byState;

		/*
		 * "Hide what I already have" means hidden only when there is nothing left to
		 * fetch beneath it either.
		 *
		 * A series we hold with three episodes short is the case somebody opens this
		 * screen to find, and a filter that dropped it because the series row itself
		 * exists would hide exactly that. So holding it is not enough — the gaps have
		 * to be closed too, and an ignored child is not a gap.
		 */
		const owned = query.hideOwned === true
			? actionable.filter((skeleton) => !skeleton.held || skeleton.missingCount > 0)
			: actionable;

		/*
		 * And finally what can actually be had, which is the one filter here that reads a
		 * sighting rather than the catalogue.
		 *
		 * Last on purpose. It is the narrowest of them and the only one whose answer is
		 * unknown rather than false for most of the library: a show the episode watch has
		 * not reached yet carries no signal, so asking this first would throw away the
		 * work every filter before it does. An empty list is read as no filter, for the
		 * same reason `reasons` is — it arrives from a screen where somebody has unticked
		 * every box, and an empty page reads as a quiet week rather than as a filter.
		 */
		const matching = query.signals === undefined || query.signals.length === 0
			? owned
			: owned.filter((skeleton) =>
				skeleton.fetchable.some((signal) => (query.signals as NewsSignal[]).includes(signal)));

		const window = matching.slice((page - 1) * limit, page * limit);
		const groups = await this._read(
			window.map((skeleton) => skeleton.memberIds),
			context,
			// Only the children of one media, never the wall. Working out where a folder
			// is means walking down to the files inside it, and doing that for two
			// hundred posters would read the whole catalogue to answer a question that
			// screen does not ask.
			{ folders: query.parentId !== undefined },
		);

		return paginate(await this._named(groups), matching.length, page, limit);
	}

	/**
	 * The show each episode belongs to, for a list read outside that show's own page.
	 *
	 * The new releases screen draws episodes from across the whole library, and a row
	 * reading "Le Bandit  S8E18" says nothing about which series that is — which is the one
	 * fact somebody needs to decide anything about it. Under a series' own page the answer
	 * is the page, so nothing is drawn there.
	 *
	 * Two queries for the page rather than one per row: an episode's parent is a season and
	 * its parent is the show, so the walk is fixed and shallow.
	 */
	private async _named(groups: MediaGroup[]): Promise<MediaGroup[]> {
		const wanted = groups.filter(
			(group) => group.kind === MediaKind.EPISODE && group.parentId !== null,
		);

		if (wanted.length === 0) {
			return groups;
		}

		const seasons = await this._items.findByIds([
			...new Set(wanted.map((group) => group.parentId as string)),
		]);
		const seriesIds = [
			...new Set(
				seasons
					.map((season) => season.parentId)
					.filter((id): id is string => id !== null),
			),
		];
		const series = new Map(
			(await this._items.findByIds(seriesIds)).map((item) => [item.id, item.title]),
		);
		const bySeason = new Map(
			seasons.map((season) => [
				season.id,
				season.parentId === null ? null : (series.get(season.parentId) ?? null),
			]),
		);

		return groups.map((group) => {
			const title = group.parentId === null ? null : (bySeason.get(group.parentId) ?? null);

			return title === null ? group : { ...group, seriesTitle: title };
		});
	}

	/**
	 * One group, addressed by any item in it.
	 *
	 * The contract says a group is identified by its representative, and that is what
	 * a listing hands out — but accepting any member costs nothing and spares every
	 * caller holding an item identifier from having to work out which copy won.
	 */
	public async group(id: string): Promise<MediaGroup> {
		const context = await this._context();

		await this._require(id);

		const [group] = await this._read([context.graph.members(id)], context, { folders: true });

		if (group === undefined) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return group;
	}

	/**
	 * The folder each of these containers sits in, worked out from the files below it.
	 *
	 * A series and a season carry no file of their own — nothing in the index says where
	 * `Spartacus` is on the disk — so the answer is the deepest directory every file
	 * underneath shares. That is the honest definition and it survives both layouts a
	 * media server produces: seasons in their own folders give the series folder, and a
	 * flat show whose episodes all sit together gives that one directory.
	 *
	 * Compared by whole path components, never by letters: a prefix test on the raw
	 * strings calls `/share/Media2` a parent of `/share/Media`, which would print a
	 * folder the media is not in.
	 *
	 * Two levels deep and no further, because that is the whole shape of a media tree —
	 * series, season, episode. A walk with no bound would follow a cycle in a corrupt
	 * parent chain for as long as the request lasted.
	 *
	 * Copies whose files are not ours are skipped: their paths mean nothing here.
	 */
	private async _folders(
		members: MediaItemEntity[],
		context: GroupContext,
	): Promise<Map<string, string>> {
		const wanted = members.filter(
			(item) => item.file === null && context.local.has(item.serviceId),
		);

		if (wanted.length === 0) {
			return new Map();
		}

		// Which container each descendant is being counted for, so a file three levels
		// down still lands under the series it belongs to.
		const owner = new Map<string, string>(wanted.map((item) => [item.id, item.id]));
		const found = new Map<string, string[][]>();
		let frontier = wanted.map((item) => item.id);

		for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
			const children = await this._items.find({ where: { parentId: In(frontier) } });

			frontier = [];

			for (const child of children) {
				const root = child.parentId === null ? undefined : owner.get(child.parentId);

				if (root === undefined) {
					continue;
				}

				owner.set(child.id, root);

				const local = this._localPath(child, context);

				if (local === null) {
					frontier.push(child.id);

					continue;
				}

				const paths = found.get(root) ?? [];

				paths.push(local.split('/').slice(0, -1));
				found.set(root, paths);
			}
		}

		const folders = new Map<string, string>();

		for (const [id, paths] of found) {
			const [first, ...rest] = paths;
			let shared = first;

			for (const other of rest) {
				let index = 0;

				while (index < shared.length && index < other.length && shared[index] === other[index]) {
					index += 1;
				}

				shared = shared.slice(0, index);
			}

			const folder = shared.join('/');

			// A group of files with nothing in common above the root says nothing useful,
			// and printing `/` would be worse than printing nothing.
			if (folder !== '') {
				folders.set(id, folder);
			}
		}

		return folders;
	}

	/**
	 * The children of every copy, merged into child groups.
	 *
	 * This is the case that makes a series page work when the seasons live on
	 * different servers: season one only on ours, season two only on a friend's, and
	 * one page that shows both. The parent is the route's and never the query
	 * string's — a caller who sent both would otherwise be browsing a different
	 * subtree than the one they asked for.
	 */
	public groupChildren(id: string, query: MediaGroupQuery): Promise<ResultList<MediaGroup>> {
		return this.groups({ ...query, parentId: id });
	}

	/**
	 * The groups in one of these states — themselves, or somewhere beneath them.
	 *
	 * On a listing of whole media (`rootsOnly`) a state filter that only read the
	 * top of each tree answered a question nobody asks. A series is almost never
	 * itself `awaiting_index` or `missing`; its episodes are. So the wall filtered on
	 * "downloaded, waiting" said *nothing matches* while an episode had really landed,
	 * and the dashboard's line counting it linked to that empty wall — a screen
	 * contradicting itself. A poster matches when the thing asked for is under it,
	 * because that poster is the only way to reach it from this screen.
	 *
	 * Two alternatives were rejected. Switching the wall to episode level whenever a
	 * state is chosen turns "what is missing" into thirty thousand episode posters and
	 * loses the show they belong to. Carrying a kind in the dashboard's link fixes one
	 * link and leaves the filter itself broken for everybody who uses it by hand.
	 *
	 * The descendants are read in the same scope as the roots — same services, same
	 * libraries — but not narrowed by the search, which names the poster rather than
	 * its episodes. They are narrow rows, and only read when a state is asked for.
	 */
	private async _inState(
		skeletons: GroupSkeleton[],
		states: SyncState[],
		seedQuery: GroupSeedQuery,
	): Promise<GroupSkeleton[]> {
		return (await this._inStates(skeletons, [states], seedQuery))[0];
	}

	/**
	 * The same answer for several groups of states, over **one** projection.
	 *
	 * Answering "is anything beneath this root in one of these states" means reading
	 * every row in scope and folding each one through the match graph. The states
	 * themselves are a predicate applied at the end, and they were the *only* thing
	 * that differed between the two calls `_actionable` used to make: gaps, then
	 * upgrades. So the catalogue was walked twice per request to evaluate two
	 * predicates over identical data. Measured on the owner's catalogue of 31 631
	 * rows: 5.2 s for the news wall, and `limit=1` cost the same 5.4 s because none of
	 * this work depends on how many rows the caller asked for.
	 *
	 * It no longer happens here at all. See `CatalogueProjectionService`: the pass runs
	 * on a worker thread, its answer is kept until the catalogue moves, and it is warmed
	 * again off-request the moment it does — so a request either finds the answer
	 * already there or waits for a thread that holds no sockets while doing it.
	 */
	private async _inStates(
		skeletons: GroupSkeleton[],
		groups: SyncState[][],
		seedQuery: GroupSeedQuery,
	): Promise<GroupSkeleton[][]> {
		const own = (states: SyncState[]) =>
			(skeleton: GroupSkeleton): boolean => states.includes(skeleton.sync);

		if (seedQuery.rootsOnly !== true) {
			return groups.map((states) => skeletons.filter(own(states)));
		}

		const roots = await this._rootsBeneath(groups, seedQuery);

		return groups.map((states, at) => {
			const ownState = own(states);
			const beneath = roots[at];

			return skeletons.filter(
				(skeleton) =>
					ownState(skeleton) || skeleton.memberIds.some((memberId) => beneath.has(memberId)),
			);
		});
	}

	/**
	 * The projection, from the store when it is there and from one pass when it is not.
	 *
	 * Asking is cheap and the pass is not, which is the whole reason it is stored: the
	 * answer only changes when the catalogue does, and the catalogue says so — see
	 * `refresh`, which rebuilds the graph and then warms every scope somebody has been
	 * looking at before the interface is told anything moved.
	 *
	 * No graph version means no key worth storing under, so nothing is kept — a read
	 * that happens before the graph is warm is rare, and a projection filed under a
	 * version nobody can compare is worse than one computed twice.
	 */
	private async _rootsBeneath(
		groups: SyncState[][],
		seedQuery: GroupSeedQuery,
	): Promise<Set<string>[]> {
		const wanted = groups.map(stateSignature);
		const graph = this._graph;

		if (graph === null) {
			const fresh = await this._project(null, groups, seedQuery, null);

			return wanted.map((signature) => fresh.get(signature) as Set<string>);
		}

		const key = this._scopeKey(seedQuery, graph);
		const held = this._roots.get(key);

		if (held !== undefined && wanted.every((signature) => held.has(signature))) {
			return wanted.map((signature) => held.get(signature) as Set<string>);
		}

		/*
		 * A pass already in flight is joined, then **checked again** rather than trusted.
		 *
		 * It was started for whichever states its own caller asked about, which are not
		 * necessarily these. Reading a missing set as an empty one would answer "nothing
		 * beneath this is missing" — a wall that looks complete while it is not, which is
		 * the one wrong answer this screen must never give.
		 */
		const running = this._building.get(key);

		if (running !== undefined) {
			const shared = await running;

			if (wanted.every((signature) => shared.has(signature))) {
				return wanted.map((signature) => shared.get(signature) as Set<string>);
			}
		}

		const built = await this._build(key, groups, seedQuery, graph);

		return wanted.map((signature) => built.get(signature) as Set<string>);
	}

	/** What a scope's answer is filed under: the filter, and the catalogue it describes. */
	private _scopeKey(
		seedQuery: GroupSeedQuery,
		graph: { version: string; threshold: number },
	): string {
		return `${scopeSignature(seedQuery)}:${graph.version}:${graph.threshold}`;
	}

	/** Registers the pass before awaiting it, which is what lets the next caller join. */
	private _build(
		key: string,
		groups: SyncState[][],
		seedQuery: GroupSeedQuery,
		graph: { version: string; threshold: number },
	): Promise<Map<string, Set<string>>> {
		const pass = this._project(key, groups, seedQuery, graph).finally(() => {
			this._building.delete(key);
		});

		this._building.set(key, pass);

		return pass;
	}

	/**
	 * Ask for the state groups that are missing, and keep what comes back.
	 *
	 * Only the missing ones: a scope asked about gaps an hour ago and about upgrades now
	 * has half the answer already, and re-projecting for the half it has would be the
	 * whole catalogue read to recompute something identical.
	 *
	 * Kept only when the answer describes the catalogue the key names. A projection runs
	 * while the gateway goes on serving, so a scan can write matches underneath it — and
	 * filing that answer under the version the caller believed in would leave a wall
	 * confidently wrong until something else happened to change the table. The answer is
	 * still returned: it is a correct answer, just not one worth a key.
	 */
	private async _project(
		key: string | null,
		groups: SyncState[][],
		seedQuery: GroupSeedQuery,
		graph: { version: string; threshold: number } | null,
	): Promise<Map<string, Set<string>>> {
		/*
		 * A copy of what is stored, never the stored map itself.
		 *
		 * The version check below decides whether this answer is worth keeping — and
		 * filling the stored map first would have already mixed an answer about one
		 * version of the catalogue into a projection filed under another, which is the
		 * exact confusion that check exists to prevent.
		 */
		const filled = new Map(key === null ? undefined : this._roots.get(key));
		const missing = groups.filter((states) => !filled.has(stateSignature(states)));

		if (missing.length === 0) {
			return filled;
		}

		const threshold = graph?.threshold ?? (await this._settings.getValue('matchThreshold'));
		const answer = await this._projected({ seedQuery, states: missing, threshold });

		for (const [signature, ids] of Object.entries(answer.roots)) {
			filled.set(signature, new Set(ids));
		}

		if (key !== null && graph !== null && answer.version === graph.version) {
			// Deleted first, so a scope asked about again moves to the back and the one
			// nobody has opened for longest is the one `_forgetOldest` drops.
			this._roots.delete(key);
			this._roots.set(key, filled);
			this._remember(seedQuery, groups);
			this._forgetOldest();
		}

		return filled;
	}

	/**
	 * On a thread of its own whenever there is one, and here when there is not.
	 *
	 * The fallback is not a second implementation — it is the same service, called in
	 * process. It exists because an in-memory database belongs to the connection that
	 * opened it, so the unit and functional suites have no worker to send this to and
	 * run the pass where they can test it.
	 *
	 * A worker that fails is logged and answered here rather than raised. That trades a
	 * blocked loop for an answer, which is the trade this whole change was made to stop
	 * making — but it is the behaviour this gateway had before the thread existed, and a
	 * dead thread turning every library page into a 500 would be strictly worse than a
	 * slow one.
	 */
	private async _projected(request: ProjectionRequest): Promise<ProjectionAnswer> {
		if (!this._workers.available) {
			return this._projection.project(request);
		}

		try {
			const answer = await this._workers.run<ProjectionAnswer>(JobKind.PROJECT, { ...request });

			/*
			 * Checked, because an answer that came up short must not be read as an empty
			 * one. A missing set means "nothing beneath this root is missing" — a wall
			 * that looks complete while it is not, which is the one wrong answer this
			 * screen must never give. Over a thread boundary the answer is whatever was
			 * cloned back, so this is the only place that can tell.
			 */
			const absent = request.states
				.map(stateSignature)
				.filter((signature) => !(signature in answer.roots));

			if (absent.length > 0) {
				throw new Error(`the projection answered nothing for ${absent.join(' and ')}`);
			}

			return answer;
		} catch (error: unknown) {
			this._logger.warn(
				`The projection could not run on a worker and will block this thread: ${String(error)}`,
			);

			return this._projection.project(request);
		}
	}

	/**
	 * Keep the question, so the answer can be recomputed before anybody asks again.
	 *
	 * This is what makes the cost invisible rather than merely rarer: the scopes
	 * somebody has actually been browsing are re-projected when the catalogue moves, off
	 * any request, and the interface is told about the change afterwards — see `refresh`.
	 * Without it the first person to open the page after every scan pays for the pass,
	 * which is precisely the cost the store was added to remove.
	 */
	private _remember(seedQuery: GroupSeedQuery, groups: SyncState[][]): void {
		const scope = scopeSignature(seedQuery);
		const known = this._warmable.get(scope) ?? { seedQuery, states: [] };
		const names = new Set(known.states.map(stateSignature));

		for (const states of groups) {
			if (!names.has(stateSignature(states))) {
				known.states.push(states);
			}
		}

		// Deleted first, so a scope asked about again moves to the back of the queue and
		// the one nobody has opened for longest is the one evicted.
		this._warmable.delete(scope);
		this._warmable.set(scope, known);
	}

	/** Oldest first: a `Map` keeps insertion order, which is the order worth losing. */
	private _forgetOldest(): void {
		for (const store of [this._roots, this._warmable] as Map<string, unknown>[]) {
			while (store.size > SCOPES_KEPT) {
				const oldest = store.keys().next();

				if (oldest.done) {
					break;
				}

				store.delete(oldest.value);
			}
		}
	}

	/**
	 * Re-project every scope somebody has been browsing, now that the graph has moved.
	 *
	 * Off any request, on the worker's own thread, and **before** the interface is told
	 * the catalogue changed — which is the order that matters. The tab that reloads on
	 * that event finds the answer already filed rather than paying for the pass, and
	 * that is the difference between "the first page after a scan is slow" and "no page
	 * is ever slow".
	 *
	 * Failures are logged and dropped. A projection that could not run leaves the store
	 * without that key, which the next reader simply misses and recomputes; refusing to
	 * announce a catalogue change because a cache could not be warmed would hold back
	 * the one thing every open tab is waiting for.
	 */
	private async _warm(graph: { version: string; threshold: number }): Promise<void> {
		// The most recently asked for, in that order: `_remember` keeps the map in
		// recency order, oldest first.
		const recent = [...this._warmable.values()].slice(-SCOPES_WARMED).reverse();

		for (const { seedQuery, states } of recent) {
			const key = this._scopeKey(seedQuery, graph);

			if (this._roots.has(key) || states.length === 0) {
				continue;
			}

			try {
				await this._build(key, states, seedQuery, graph);
			} catch (error: unknown) {
				this._logger.warn(`Could not warm a catalogue projection: ${String(error)}`);
			}
		}
	}

	/**
	 * The groups there is something to do about: a gap beneath them, or a copy worth
	 * having somewhere else.
	 *
	 * An **or**, and that is the whole shape of the filter. A followed series we hold
	 * complete but in 1080p while a friend has the 2160p is worth showing and has no gap;
	 * a series we hold complete in the best encoding anybody has, with three episodes
	 * nobody has sent us yet, is worth showing and is in no interesting state. Either
	 * alone would hide half of what somebody opened this list to find.
	 *
	 * Neither half is a new rule. The gaps are the count a season card already shows —
	 * ignored children excluded, a child held under another name counted as held — and
	 * the states go through `_inState`, so "something beneath it is outdated" is answered
	 * for a series poster exactly as the state chips are. That second point is what makes
	 * this usable at all: a series is almost never itself `outdated`, its episodes are.
	 *
	 * The skeletons come back from `_inState` by identity, which is why the set can hold
	 * them: it filters the very array it was handed and never rebuilds an element.
	 */
	private async _actionable(
		skeletons: GroupSkeleton[],
		seedQuery: GroupSeedQuery,
		reasons?: ActionableReason[],
	): Promise<GroupSkeleton[]> {
		/*
		 * No reasons named is both of them, which is what this filter has always meant.
		 * An empty list is read the same way rather than as "nothing": it arrives from a
		 * screen where somebody has unticked every box, and answering an empty page to
		 * that reads as a catalogue with nothing in it rather than as a filter.
		 */
		const wanted = reasons === undefined || reasons.length === 0
			? [ActionableReason.GAP, ActionableReason.UPGRADE]
			: reasons;
		const gaps = wanted.includes(ActionableReason.GAP);
		const upgrades = wanted.includes(ActionableReason.UPGRADE);

		/*
		 * Two passes rather than one over every state, because the states divide the
		 * same way the reasons do and a single set could not be split afterwards.
		 * `conflict` goes with the gaps: two cuts that cannot be ordered means the one
		 * we do not hold is not held by anything, which is an absence and not an
		 * upgrade.
		 */
		/*
		 * Both halves in one pass, and only the halves that were asked for.
		 *
		 * These were two calls, and the walk they share — every row in scope, a skeleton
		 * for each — is the whole cost. See `_inStates`: the states are a predicate at
		 * the end, so reading twice to apply two predicates was the catalogue traversed
		 * twice per request for nothing.
		 */
		const stateGroups: SyncState[][] = [];

		if (gaps) {
			stateGroups.push([SyncState.MISSING, SyncState.CONFLICT]);
		}

		if (upgrades) {
			stateGroups.push([SyncState.OUTDATED]);
		}

		const answered =
			stateGroups.length === 0
				? []
				: await this._inStates(skeletons, stateGroups, seedQuery);

		const absent = gaps ? new Set(answered[0]) : new Set<GroupSkeleton>();
		// Second when both were asked for, first when the gaps were not.
		const better = upgrades ? new Set(answered[gaps ? 1 : 0]) : new Set<GroupSkeleton>();

		return skeletons.filter(
			(skeleton) =>
				(gaps && (skeleton.missingCount > 0 || absent.has(skeleton))) ||
				(upgrades && better.has(skeleton)),
		);
	}

	/**
	 * The items a sync plan undertakes to keep in step, as rows a query can filter on.
	 *
	 * Following is not a notion of its own in this product and must not become one: a
	 * plan whose `SyncScope.rootItemIds` names a media *is* the standing intent to follow
	 * it, created by one gesture on that media's own page and named after it. A second
	 * flag beside it would be a second answer to "am I following this", and the two would
	 * disagree the first time somebody deleted a plan.
	 *
	 * Read across every plan rather than the enabled ones, which is the same reading
	 * `SyncManager.itemPlans` uses when it tells somebody a plan already speaks for a
	 * media. A paused plan is a standing intent somebody paused; a tab that called it
	 * unfollowed while the dialog called it covered would be two answers to one question.
	 *
	 * Two directions, because a wall of posters is not where the plan was made:
	 *
	 * - **Up**, so a plan on one season makes its series appear. The library shows roots,
	 *   and a filter that answered nothing for a followed season would put the followed
	 *   thing out of reach of the screen built to show it.
	 * - **Down one level**, which together with the parent half of the test reaches the
	 *   episodes of a followed series — the seasons match on their parent, the episodes on
	 *   theirs. Kept as a separate list so that reach downward does not also drag in a
	 *   sibling of a followed season.
	 *
	 * Nothing here goes through the match graph, and it does not need to: a plan names one
	 * copy, that copy is a member of its group, and one member matching is what makes a
	 * group appear.
	 */
	private async _followedScope(): Promise<Scope> {
		const plans = await this._plans.find();
		const roots = [...new Set(plans.flatMap((plan) => plan.scope?.rootItemIds ?? []))];

		if (roots.length === 0) {
			// Nothing is followed, which the query has to read as a filter nothing
			// satisfies rather than as no filter at all.
			return { ids: [], underIds: [] };
		}

		const ids = new Set(roots);
		let frontier = await this._items.findDigests(roots);

		for (let hop = 0; hop < FOLLOWED_HOPS && frontier.length > 0; hop += 1) {
			const parents = [
				...new Set(
					frontier
						.map((digest) => digest.parentId)
						.filter((id): id is string => id !== null && !ids.has(id)),
				),
			];

			if (parents.length === 0) {
				break;
			}

			for (const id of parents) {
				ids.add(id);
			}

			frontier = await this._items.findDigests(parents);
		}

		const children = await this._items.findChildDigests(roots);

		return { ids: [...ids], underIds: [...roots, ...children.map((child) => child.id)] };
	}

	/**
	 * Everything the household has said it cares about, in either of the two ways it can.
	 *
	 * A sync plan is one way of saying it. Asking for the show on the request source is the
	 * other, and it is the one most of a household's shows are said with — nobody writes a
	 * plan for a series they have just asked a friend's Seerr for. The new releases screen
	 * reads this, and reading plans alone would have left that screen almost empty while
	 * the request list was full.
	 *
	 * A union and not a second filter beside the first: the seed query narrows by
	 * membership, so "followed or requested" is one set, and nothing in the query layer has
	 * to learn about a second kind of covering.
	 */
	private async _watchedScope(): Promise<Scope> {
		const followed = await this._followedScope();
		const services = (await this._services.find()).filter(
			(service) => service.type === MediaServiceType.REQUESTS,
		);

		if (services.length === 0) {
			return followed;
		}

		/*
		 * Followed, and not everything the request source holds.
		 *
		 * The source says two different things and only one of them is a standing one: a
		 * request is answered once and done with, while a watchlist entry never is.
		 * Counting requests as followed would fill the new releases screen with shows
		 * somebody asked for a year ago and has not thought about since — "les nouveautés,
		 * c'est sur les éléments suivis, pas les requests".
		 */
		/*
		 * The state, not the rows that carry it and not the shelf they used to sit on.
		 *
		 * This read every item of the watchlist and handed the query their ids, which
		 * worked for exactly as long as the list was short: a row per series, per season
		 * and per aired episode, so four hundred followed shows became thousands of bound
		 * parameters and the screen answered `SQLITE_ERROR: too many SQL variables`. It did
		 * not degrade — it broke the moment the feature started working.
		 *
		 * Then it named the library, which scaled but said the wrong thing: being followed
		 * is not a place a media lives, and a media held locally *and* followed is one
		 * media. It is a state on the row now, so this asks for the state — and the rows
		 * that carry it are the merged media, not a second copy standing beside it.
		 */
		return { ...followed, watchStates: [MediaWatchState.FOLLOWED] };
	}

	/**
	 * The codecs a query is asking for, spelled the way the index spells them.
	 *
	 * `x265`, `hevc`, `h265` and `h.265` are one decoder and four habits of naming it,
	 * and the quality summaries are written after that folding — so a filter that passed
	 * `hevc` through untouched would answer nothing on a library entirely encoded in it.
	 * Folded through the same service that wrote the values, never a second table.
	 *
	 * A spelling that folds to nothing leaves an empty list, which the query reads as a
	 * filter nothing satisfies — the same answer the service list gives to somebody
	 * naming a server that does not exist.
	 */
	private _codecsFor(query: MediaGroupQuery): string[] | undefined {
		if (query.videoCodecs === undefined) {
			return undefined;
		}

		return [
			...new Set(
				query.videoCodecs
					.map((codec) => this._quality.normalizeVideoCodec(codec))
					.filter((codec): codec is string => codec !== null),
			),
		];
	}

	/**
	 * Everything a group query needs that is about the catalogue rather than the query.
	 *
	 * **The graph is kept between requests, because it was the price of every page.** It
	 * is built from *every applied match in the catalogue* — the whole table, read and
	 * walked into a union-find — and it was rebuilt from scratch on each request,
	 * including the one that draws a series with three episodes in it. Nothing in it
	 * depends on what was asked for, so a household browsing paid for the whole match
	 * table once per click.
	 *
	 * Kept against a **version of the table**, never against the clock. A window of a few
	 * seconds was tried and is wrong in a way that matters: a scan that has just finished
	 * changes what is grouped with what, and answering from a graph built before it shows
	 * somebody a library that disagrees with the pass they watched run. One indexed
	 * aggregate says whether the graph is still the truth; everything else here is three
	 * services and a handful of peers, which cost nothing to read every time.
	 *
	 * The threshold is part of the key: it is a setting somebody can move, it decides
	 * which matches count, and an answer from a graph built under the old one would be
	 * the setting quietly not taking.
	 */
	private async _context(): Promise<GroupContext> {
		const threshold = await this._settings.getValue('matchThreshold');
		const [version, services, peers] = await Promise.all([
			this._matches.version(),
			this._services.find(),
			this._peers.find(),
		]);

		return {
			graph: await this._cachedGraph(version, threshold),
			services: new Map(services.map((service) => [service.id, service])),
			// A fresh map per caller: it is a per-request memo that `_read` fills while
			// walking one page, and sharing it would hand one page another's folders.
			folders: new Map(),
			peerNames: new Map(peers.map((peer) => [peer.id, peer.name])),
			friendsOfFriends: new Set(
				peers
					.filter((peer) => peer.trust === PeerTrust.FRIEND_OF_FRIEND)
					.map((peer) => peer.id),
			),
			local: new Set(
				services
					.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
					.map((service) => service.id),
			),
		};
	}

	/**
	 * Rebuild the shared graph now, off anybody's request, and say whether it moved.
	 *
	 * This is the half of the problem that making the work interruptible never touched.
	 * Yielding stops a scan from strangling the server, but the graph is still rebuilt
	 * *lazily*, by whoever asks first after it goes stale — and that is a person, who
	 * waits the whole rebuild for a page they expected to be instant. Scans end at a
	 * known moment; doing it there means the cost lands where nobody is looking at a
	 * spinner.
	 *
	 * Paged and breathing, because it has no reason to hurry: a rebuild that takes four
	 * seconds instead of one costs nothing if the server answers throughout, and the
	 * previous graph stays in place and keeps answering until this one is complete. The
	 * swap at the end is a single assignment, so no request ever sees a half-filled
	 * graph — the thing that would quietly show somebody half their library.
	 *
	 * Returns false when nothing had changed, which is how the caller avoids telling
	 * every open tab to re-read a catalogue that is the same as the one it has.
	 */
	public async refresh(): Promise<boolean> {
		const threshold = await this._settings.getValue('matchThreshold');
		const version = await this._matches.version();

		if (!this._stale(version, threshold)) {
			return false;
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

		/*
		 * Re-read the version rather than trusting the one we started from.
		 *
		 * A correlation pass writing matches while this read its pages would leave a
		 * graph that holds some of them, stored under a version that claims it holds all
		 * of them — and it would stay wrong until something else changed the table.
		 * Storing the version observed at the start of the read is the conservative lie:
		 * at worst the next caller rebuilds once for nothing.
		 */
		this._graph = { version, threshold, graph };

		/*
		 * And the projections that depend on it, before this returns.
		 *
		 * `true` is what makes the cache announce the change, and every open tab re-reads
		 * on that announcement. Warming afterwards would mean the announcement arrived
		 * first and the tabs raced the warm — which is the state this gateway was in, and
		 * is why the first page after every scan was the slow one. Awaiting it costs
		 * nothing anybody is waiting for: `refresh` runs off any request, and the pass it
		 * waits for runs on a worker.
		 */
		await this._warm({ version, threshold });

		return true;
	}

	/**
	 * The graph for this version of the table, waited for rather than raced.
	 *
	 * A request that finds the graph stale used to build its own, in **one** statement
	 * over the whole match table. `better-sqlite3` is synchronous, so that statement was
	 * not latency this request paid — it was the gateway's event loop, gone for its
	 * duration, with every other connection unread. The same defect as the catalogue
	 * walk, in a tenth of the time and in a place nobody was looking, and it fired
	 * exactly when a scan had just moved the version and somebody opened a page.
	 *
	 * So there is one builder now, `refresh`, and it reads in slices and hands the loop
	 * back between them. Asking for it rather than duplicating it makes *this* request
	 * slower than its own statement would have been. It makes every other request
	 * possible while it waits, and that is the trade the whole cache was built for.
	 *
	 * The statement below is what is left for the case where there is nothing to ask: a
	 * gateway whose refresher has not registered yet — `schedule` can be called from a
	 * hook that runs before the one that registers — or a threshold that moved between
	 * the two reads. Both are a rebuild that has to happen somewhere, and nowhere else
	 * is left.
	 */
	private async _cachedGraph(version: string, threshold: number): Promise<MatchGraph> {
		const cached = this._graph;

		if (cached !== null && cached.version === version && cached.threshold === threshold) {
			return cached.graph;
		}

		/*
		 * Compared by identity, not by version, and that is the whole of the check.
		 *
		 * A rebuild that ran produced a *new* graph, and it is the freshest there is —
		 * fresher, possibly, than the version this request read a moment ago, which is
		 * fine: the projection is keyed on the graph's own version, so the page and its
		 * filter describe the same catalogue either way.
		 *
		 * What this must not do is accept the graph that was already there. Nothing
		 * registered a refresher, or nothing was due, and the graph that is still in
		 * place is the stale one this method was called to replace. Returning it would
		 * draw a library from a catalogue that has moved, and file the filter's answer
		 * under it — a wrong answer that looks exactly like a right one.
		 */
		const before = this._graph;

		await this._cache.refreshNow();

		const warmed = this._graph;

		if (warmed !== null && warmed !== before && warmed.threshold === threshold) {
			return warmed.graph;
		}

		const graph = new MatchGraph(await this._matches.findAppliedPairs(threshold));

		this._graph = { version, threshold, graph };

		return graph;
	}

	/** The cached graph no longer answers for this version of the table, or this threshold. */
	private _stale(version: string, threshold: number): boolean {
		return (
			this._graph === null
			|| this._graph.version !== version
			|| this._graph.threshold !== threshold
		);
	}

	/**
	 * The libraries a query is allowed to look at.
	 *
	 * A category names every library of that name across every service, which is the
	 * filter a library screen uses; `libraryId` names exactly one, which is what a
	 * diagnostic screen wants. Both are worth asking, and asking both means the
	 * intersection.
	 */
	private async _librariesFor(query: MediaGroupQuery): Promise<string[] | undefined> {
		if (query.categoryKey === undefined) {
			return query.libraryId === undefined ? undefined : [query.libraryId];
		}

		const inCategory = await this._libraries.librariesOfCategory(query.categoryKey);

		if (query.libraryId === undefined) {
			return inCategory;
		}

		return inCategory.filter((id) => id === query.libraryId);
	}

	/**
	 * The services a query is allowed to look at.
	 *
	 * Two filters that mean different things end up in one list here: naming services
	 * outright, and naming where copies come from. Somebody asking for "my friends"
	 * should not have to name six servers, and somebody naming two servers should not
	 * have their origins guessed. Given both, the intersection is what they asked for —
	 * these friends' servers, and only those.
	 */
	private _servicesFor(query: MediaGroupQuery, context: GroupContext): string[] | undefined {
		const named = query.serviceIds?.length ? new Set(query.serviceIds) : null;
		const origins = query.origins?.length ? new Set(query.origins) : null;

		if (named === null && origins === null) {
			return undefined;
		}

		const allowed = [...context.services.values()]
			.filter((service) => named === null || named.has(service.id))
			.filter((service) => origins === null || origins.has(this._originOf(service, context)))
			.map((service) => service.id);

		// An empty list is not "no filter": it is a filter nothing satisfies, and
		// returning undefined here would answer the whole library to somebody who asked
		// for a friend they have not linked.
		return allowed;
	}

	/** Where a service's copies come from, in the terms the filter is written in. */
	private _originOf(service: MediaServiceEntity, context: GroupContext): MediaOrigin {
		/*
		 * Before the rest, because it is not a place a copy comes from: a request source
		 * holds no files at all. Read after `local` it would answer `direct` — a server we
		 * registered — and a household filtering for what it actually has would be handed
		 * every show it has merely asked for.
		 */
		if (service.type === MediaServiceType.REQUESTS) {
			return MediaOrigin.REQUESTED;
		}

		if (context.local.has(service.id)) {
			return MediaOrigin.LOCAL;
		}

		if (service.peerId === null) {
			return MediaOrigin.DIRECT;
		}

		return context.friendsOfFriends.has(service.peerId)
			? MediaOrigin.FRIEND_OF_FRIEND
			: MediaOrigin.FRIEND;
	}

	/** The parent group's items, so `parentId` addresses a group and not one copy. */
	private async _parentScope(parentId: string, context: GroupContext): Promise<string[]> {
		await this._require(parentId);

		return context.graph.members(parentId);
	}

	/**
	 * The filtered rows, folded into groups, in the order the rows came back.
	 *
	 * A group takes the position of the first row of it the filter selected, which is
	 * the only ordering available: the representative may well be a copy the filter
	 * excluded — that is the point of "narrow which groups appear without ungrouping
	 * the rest" — and sorting on a row nobody asked for would be stranger still.
	 */
	private async _skeletons(
		seeds: MediaItemDigest[],
		context: GroupContext,
		withGaps = false,
	): Promise<GroupSkeleton[]> {
		const order: string[] = [];
		const byRoot = new Map<string, string[]>();

		for (const seed of seeds) {
			const root = context.graph.root(seed.id);

			if (!byRoot.has(root)) {
				byRoot.set(root, context.graph.members(seed.id));
				order.push(root);
			}
		}

		const digests = new Map(seeds.map((seed) => [seed.id, seed]));
		const outsiders = [...byRoot.values()]
			.flat()
			.filter((id) => !digests.has(id));

		// The copies the filter left out still decide the group's state: a media held
		// on a friend's server and not here reads `missing` only because that copy was
		// looked at.
		for (const digest of await this._items.findDigests(outsiders)) {
			digests.set(digest.id, digest);
		}

		const gaps = withGaps
			? await this._gapCounts([...byRoot.values()].flat(), context)
			: new Map<string, number>();

		const built: GroupSkeleton[] = [];

		/*
		 * A loop with a breath in it rather than a `map`, and that is the whole reason it
		 * is not one.
		 *
		 * This runs once over the roots and again, through `_inState`, over every
		 * descendant in scope. Measured on the owner's catalogue it is where a grouped
		 * read with `actionable` spends its time: 543 ms in which a 10 ms heartbeat did
		 * not fire once — the gateway was not slow, it was deaf, and every artwork
		 * request and the event socket died together because nothing was reading the
		 * sockets. `await` alone does not help: `better-sqlite3` is synchronous and the
		 * awaits here resolve at once, so the loop never reaches the poll phase. See
		 * `breathe`.
		 */
		for (const [index, root] of order.entries()) {
			await breathe(index);

			const memberIds = byRoot.get(root) as string[];
			const members = memberIds
				.map((id) => digests.get(id))
				.filter((digest): digest is MediaItemDigest => digest !== undefined);

			built.push({
				memberIds,
				sync: this._state(members, context),
				// Over every copy, because the watch wrote its answer on whichever one
				// represented the group the day it searched.
				fetchable: fetchableOf(members),
				// A media whose file we have already downloaded counts as held, so that
				// "hide what I already have" hides it. It is the same answer the wall
				// gives about it, and a filter that kept offering a file already on the
				// disk is the behaviour this whole state exists to remove.
				held: members.some((member) => this._holds(member, context)),
				missingCount: gaps.get(root) ?? 0,
			});
		}

		return built;
	}

	/**
	 * How many children each group is short of, by group root.
	 *
	 * The same folding `_childGroups` does for the page being rendered, over every
	 * group in the result instead — a child known on two servers counts once, a child
	 * we hold under another name counts as held, and an ignored child does not count
	 * at all. Kept as its own method rather than shared with `_childGroups` because
	 * that one also builds the map a group's `childCount` is read from, and merging
	 * them would make the cheap path pay for the expensive one.
	 */
	private async _gapCounts(
		memberIds: string[],
		context: GroupContext,
	): Promise<Map<string, number>> {
		const children = await this._items.findChildDigests(memberIds);
		const byId = new Map(children.map((child) => [child.id, child]));
		const parentOf = new Map<string, string>();

		for (const child of children) {
			if (child.parentId !== null) {
				parentOf.set(child.id, context.graph.root(child.parentId));
			}
		}

		const counted = new Map<string, Set<string>>();
		const gaps = new Map<string, number>();
		const covered = this._rangesUnder(children, parentOf, context);

		for (const [index, child] of children.entries()) {
			// The other half of the same stall: this walks every child of every group in
			// the result, not just the page. See the loop in `_skeletons`.
			await breathe(index);

			const parentRoot = parentOf.get(child.id);

			if (parentRoot === undefined) {
				continue;
			}

			const childRoot = context.graph.root(child.id);
			const seen = counted.get(parentRoot) ?? new Set<string>();

			if (seen.has(childRoot)) {
				continue;
			}

			seen.add(childRoot);
			counted.set(parentRoot, seen);

			const copies = context.graph.members(child.id);

			if (copies.some((id) => byId.get(id)?.ignored === true)) {
				continue;
			}

			// A child whose file the gateway has already put on the disk is not a gap,
			// whether the media server has indexed it yet or never will: fetching it
			// again writes the same bytes to the same path. Counted, it would be a
			// number on a season card that nothing anybody does can bring down.
			const held = copies.some((id) => {
				const copy = byId.get(id);

				return copy !== undefined && this._holds(copy, context);
			});

			if (!held && !this._insideARange(child, covered.get(parentRoot))) {
				gaps.set(parentRoot, (gaps.get(parentRoot) ?? 0) + 1);
			}
		}

		return gaps;
	}

	/**
	 * Episode numbers held under each parent by a file that holds several.
	 *
	 * Only files actually on a disk here count, which is the whole point: a row
	 * claiming to cover four episodes while holding none of them would silence the
	 * gap for all four.
	 */
	private _rangesUnder(
		children: MediaItemDigest[],
		parentOf: Map<string, string>,
		context: GroupContext,
	): Map<string, Set<number>> {
		const covered = new Map<string, Set<number>>();

		for (const child of children) {
			const parentRoot = parentOf.get(child.id);

			if (
				parentRoot === undefined ||
				child.episodeNumberEnd === null ||
				!this._holds(child, context)
			) {
				continue;
			}

			const under = covered.get(parentRoot) ?? new Set<number>();

			for (const number of spanOf(child)) {
				under.add(number);
			}

			covered.set(parentRoot, under);
		}

		return covered;
	}

	/**
	 * Whether this child is the second half of a neighbour's two-part file.
	 *
	 * A row for episode two exists beside the `S01E01-E02` file in every catalogue
	 * scanned before the range was read, because the gap detection minted one and
	 * nothing deletes it. Drawn as a gap it is an episode the household is told to
	 * fetch while it is already watching it, so the row survives — it is a real
	 * episode and the provider really lists it — and simply stops being counted.
	 *
	 * Its own number is what is tested, never the range it would itself carry: a
	 * two-part file covers its own first episode, and reading that as "somebody else
	 * has it" would excuse every gap in the season.
	 */
	private _insideARange(child: EpisodeSpan, covered: Set<number> | undefined): boolean {
		// Absent normalised before comparing, for the reason `spanOf` sets out.
		const number = child.episodeNumber ?? null;

		return (
			covered !== undefined &&
			(child.episodeNumberEnd ?? null) === null &&
			number !== null &&
			covered.has(number)
		);
	}

	/** The full rows for one page of groups, and the children those groups count. */
	private async _read(
		components: string[][],
		context: GroupContext,
		options: { folders?: boolean } = {},
	): Promise<MediaGroup[]> {
		const memberIds = components.flat();
		const rows = new Map(
			(await this._items.findByIds(memberIds)).map((item) => [item.id, item]),
		);

		if (options.folders === true) {
			// Written onto the context rather than threaded through `_group` and
			// `_source`: those two already take it, and a second map passed beside it
			// would be one more thing every call site has to remember to forward.
			for (const [id, folder] of await this._folders([...rows.values()], context)) {
				context.folders.set(id, folder);
			}
		}

		const children = await this._children(memberIds, context);

		return components
			.map((ids) =>
				ids
					.map((id) => rows.get(id))
					.filter((item): item is MediaItemEntity => item !== undefined),
			)
			.filter((members) => members.length > 0)
			.map((members) => this._group(members, children, context));
	}

	/**
	 * The children of a page of groups, with every copy of each child.
	 *
	 * Two queries rather than one, and the second is what makes `missingCount` true.
	 * A child is fetched by its parent, so a copy filed under a parent this group does
	 * not contain is not fetched — and in the lab that is not a corner case: the two
	 * servers never agreed on the series title of one show, so its seasons are two
	 * groups, while the episode inside is correctly one. Counting only the rows under
	 * this parent would report that episode as missing on a season card while the
	 * episode's own poster says we hold it, which is the kind of disagreement nobody
	 * can debug from the screen.
	 */
	private async _children(memberIds: string[], context: GroupContext): Promise<ChildIndex> {
		const byParent = new Map<string, MediaItemDigest[]>();
		const byId = new Map<string, MediaItemDigest>();
		const children = await this._items.findChildDigests(memberIds);

		for (const child of children) {
			const parentId = child.parentId as string;

			byParent.set(parentId, [...(byParent.get(parentId) ?? []), child]);
			byId.set(child.id, child);
		}

		const outsiders = children
			.flatMap((child) => context.graph.members(child.id))
			.filter((id) => !byId.has(id));

		for (const digest of await this._items.findDigests(outsiders)) {
			byId.set(digest.id, digest);
		}

		return { byParent, byId };
	}

	private _group(
		members: MediaItemEntity[],
		children: ChildIndex,
		context: GroupContext,
	): MediaGroup {
		const ranked = this._rank(members, context);
		const representative = ranked[0];
		/*
		 * Never the request source. Its rows are the statement that nobody holds the file,
		 * so listing one as a copy offered it on "fetch from" — with an unknown quality and
		 * a `direct` badge, as though Seerr could serve bytes. The row still counts for
		 * everything else a member counts for: it is what makes the media exist at all when
		 * nothing else reports it.
		 */
		const sources = ranked
			.filter((item) => context.services.get(item.serviceId)?.type !== MediaServiceType.REQUESTS)
			.map((item) => this._source(item, context));
		const qualities = sources.map((source) => source.quality);
		const childGroups = this._childGroups(ranked, children, context);
		// Title and normalised title come from the same copy or the group contradicts
		// itself: the first is what people read, the second is what the interface
		// de-duplicates the wall on, and two rows disagreeing about which media this is
		// would show the same poster twice.
		const titled = this._preferring(ranked, 'title')[0];

		return {
			id: representative.id,
			kind: representative.kind,
			title: titled.title,
			normalizedTitle: titled.normalizedTitle,
			// Gaps filled from the other copies: a remote server often carries an
			// overview or a year the local one never received. A correction outranks
			// both — see `_preferring`.
			year: this._first(this._preferring(ranked, 'year'), (item) => item.year),
			seasonNumber: this._first(
				this._preferring(ranked, 'seasonNumber'),
				(item) => item.seasonNumber,
			),
			episodeNumber: this._first(
				this._preferring(ranked, 'episodeNumber'),
				(item) => item.episodeNumber,
			),
			/*
			 * Read off a copy *we hold*, never off the widest claim among them.
			 *
			 * Every reader expands this range and treats what is inside it as held, so a
			 * remote row claiming `E01-E04` would silence three real gaps on the strength
			 * of somebody else's file name. Ours is the only copy whose range says
			 * anything about what is on this disk — which is the same rule `_rangesUnder`
			 * applies one level down, for the same reason.
			 *
			 * The flag is derived from the row rather than read off a digest because this
			 * is the one path that works from the full entities; the digest's `hasFile` is
			 * the same test written in SQL so the projection can skip the column.
			 */
			episodeNumberEnd: this._first(
				ranked.filter((item) =>
					this._holds({ ...item, hasFile: item.file !== null }, context)),
				(item) => item.episodeNumberEnd,
			),
			externalIds: this._externalIds(ranked),
			overview: this._first(this._preferring(ranked, 'overview'), (item) => item.overview),
			// The local copy's poster when there is one: artwork is fetched through the
			// service that reported it, and a friend's server may be asleep while ours
			// answers.
			artworkItemId: ranked.find((item) => this._hasArtwork(item))?.id ?? null,
			sync: this._state(members, context),
			quality: qualities.every((quality) => quality === null)
				? null
				: this._quality.merge(qualities),
			sources,
			versions: this._versions(sources),
			childCount: childGroups.size,
			missingCount: [...childGroups.values()].filter((held) => !held).length,
			libraryId: representative.libraryId,
			parentId: representative.parentId,
			// The most recent addition across the copies, which is what a client sorting
			// on `addedAt` is asking for: when did this media become available to me,
			// not when did one particular server happen to index it.
			addedAt: this._addedAt(ranked),
			/*
			 * The same rule the filter read, off the same rows.
			 *
			 * Read again here rather than carried down from the skeleton because this
			 * method is also how one media is answered on its own page, where there is no
			 * skeleton to carry anything. Both go through `fetchableOf`, which is the whole
			 * reason that function exists: a wall that filtered on "a torrent was found"
			 * and then drew the chip on half of what it kept would read as a broken
			 * filter, and the fault would be two readings of one rule.
			 */
			fetchable: fetchableOf(ranked),
		};
	}

	/**
	 * The children of every copy, folded into child groups, and whether we hold each.
	 *
	 * `missingCount` is read off this map, and it is what a season poster says at a
	 * glance — so a child known on two remote servers has to count once, not twice,
	 * and a child we hold under a different name has to count as held. Both fall out
	 * of folding the children through the same graph as their parents.
	 */
	private _childGroups(
		members: MediaItemEntity[],
		children: ChildIndex,
		context: GroupContext,
	): Map<string, boolean> {
		const groups = new Map<string, boolean>();
		/*
		 * The episodes held by a file that holds several, under this group.
		 *
		 * Flat rather than per parent, because this runs for one media: the children
		 * are the seasons of a series, which carry no episode number at all, or the
		 * episodes of a single season, which cannot collide.
		 */
		const covered = episodesCovered(
			[...children.byId.values()].filter(
				(child) => child.episodeNumberEnd !== null && this._holds(child, context),
			),
		);

		for (const member of members) {
			for (const child of children.byParent.get(member.id) ?? []) {
				const root = context.graph.root(child.id);

				if (groups.has(root)) {
					continue;
				}

				/*
				 * An ignored child is not a gap.
				 *
				 * Specials and recaps a scraper filed as episodes make a complete
				 * season read as incomplete for ever, and a count that is never zero
				 * is a count people stop reading. Tested on any copy of the child, not
				 * on this one: the decision is about the media, not about which server
				 * happened to list it — the same reason holding it is tested that way
				 * two lines below.
				 */
				const ignored = context.graph
					.members(child.id)
					.some((id) => children.byId.get(id)?.ignored === true);

				if (ignored) {
					continue;
				}

				// Asked of every copy of the child, not of the copies filed under this
				// parent: holding it is a fact about the media, not about where one
				// server decided to put it. A file already on our disk counts as held
				// for the same reason it does in `_gapCounts` — the same count is read
				// off both, and a season card that disagreed with itself between the
				// listing and the detail page would be unexplainable from the screen.
				const held = context.graph.members(child.id).some((id) => {
					const copy = children.byId.get(id);

					return copy !== undefined && this._holds(copy, context);
				});

				// The second half of a neighbour's two-part file reads as held, for the
				// reason spelled out on `_insideARange`: the same count is read off this
				// map and off `_gapCounts`, and the two disagreeing would put one number
				// on the season card and another on the page behind it.
				groups.set(root, held || this._insideARange(child, covered));
			}
		}

		return groups;
	}

	/**
	 * Whether this copy means we have the media, for every count and filter that asks.
	 *
	 * A copy on one of our own services, or a file we already put on the disk — with one
	 * exception. A local copy the group joined to another cut is one version of a work
	 * the group holds another version of elsewhere: the theatrical cut here, the
	 * extended one on a friend's server. Counting it as held would drop the group from
	 * "hide what I already have" and the episode from its season's missing count, which
	 * are the two places somebody looks to find what is left to fetch — the other cut
	 * would become unfindable the moment correlation put the two together.
	 *
	 * Read off the joining edge and not off the copy's own `conflict` state, because
	 * that state has a second meaning the edge does not: the same bytes filed under two
	 * episode numbers, which never joins, and which we hold perfectly well.
	 */
	private _holds(copy: MediaItemDigest, context: GroupContext): boolean {
		if (LANDED_STATES.has(copy.syncState)) {
			return true;
		}

		/*
		 * Asked before the service, and that order is the fix: a row with no file is not
		 * a copy, wherever it sits. Media servers list episodes they do not have and the
		 * gateway mints rows for episodes nobody has at all, both on *our* service — so
		 * reading the service alone answered "we hold it" about the very rows that exist
		 * to say nobody does, and every one of those holes vanished from the count on its
		 * season, from the news screen, and from what the episode watch searches for.
		 *
		 * After the landed states on purpose. A file this gateway has just put on the disk
		 * is held before any server has a row for it, which is the whole reason those
		 * states exist, and testing the file first would re-introduce the double download
		 * they were added to stop.
		 */
		if (CARRIES_A_FILE.has(copy.kind) && !copy.hasFile) {
			return false;
		}

		return context.local.has(copy.serviceId) && !context.graph.besideAnotherCut(copy.id);
	}

	/** The shared rule, with this request's view of which services are ours. */
	private _state(
		// The two fields it reads, rather than a digest: this is called with full rows
		// for the page being rendered and with digests everywhere else, and a digest
		// carries a derived flag no entity has.
		members: { serviceId: string; syncState: SyncState }[],
		context: GroupContext,
	): SyncState {
		return groupStateOf(members, context.local);
	}

	/**
	 * The copies in the order the group prefers them; the first one represents it.
	 *
	 * Local first, because everything the group borrows from one row — the title, the
	 * poster, the identifier — should come from the server that answers. Then the
	 * configured priority, which is already the order a sync consults services in.
	 * Then the item identifier, and that last term is what makes the choice stable:
	 * two calls have to return the same `id` or the interface loses its place on a
	 * reload, and nothing else on the row is both unique and unchanging — titles
	 * differ from one service to the next, `addedAt` is often null, and the order rows
	 * come back in is whatever the engine felt like.
	 */
	private _rank(members: MediaItemEntity[], context: GroupContext): MediaItemEntity[] {
		const priority = (item: MediaItemEntity): number =>
			context.services.get(item.serviceId)?.priority ?? Number.MAX_SAFE_INTEGER;

		return [...members].sort(
			(left, right) =>
				Number(context.local.has(right.serviceId)) -
					Number(context.local.has(left.serviceId)) ||
				priority(left) - priority(right) ||
				left.id.localeCompare(right.id),
		);
	}

	private _source(item: MediaItemEntity, context: GroupContext): MediaGroupSource {
		const service = context.services.get(item.serviceId);
		const peerId = service?.peerId ?? null;

		return {
			itemId: item.id,
			serviceId: item.serviceId,
			serviceName: service?.name ?? '',
			// A service that vanished between the two reads leaves its rows behind for
			// one request. Treating it as an unreachable remote is the honest fallback:
			// claiming it is local would offer a pull from a disk nobody can write to.
			serviceType: service?.type ?? MediaServiceType.JELLYFIN,
			peerId,
			peerName: peerId === null ? null : (context.peerNames.get(peerId) ?? null),
			// An episode carries a file and no aggregate; a season carries the aggregate
			// and no file. Both have to answer the same question here.
			quality: this._summary(item),
			companions: item.companions,
			bytes: item.file?.size ?? null,
			versionId: versionIdOf(item.file),
			edition: editionOf(item.file),
			local: context.local.has(item.serviceId),
			path: item.file?.path ?? null,
			localPath: this._localPath(item, context),
			sync: item.syncState,
		};
	}

	/**
	 * Where this copy is on the gateway's own disks, spelled as the gateway sees it.
	 *
	 * `path` beside it is the *server's* spelling, which is the right thing to show
	 * before erasing a file — it is what somebody's Jellyfin displays. It is the wrong
	 * thing for anybody who then wants to go and look: `/media/SeriesTV/…` exists inside
	 * a container and nowhere a shell can reach. So both are answered, and neither
	 * stands in for the other.
	 *
	 * Null for a copy on a service whose files this gateway does not hold. A friend's
	 * server has paths, and none of them mean anything here; printing one would be a
	 * directory somebody goes looking for and never finds.
	 *
	 * A folder — a series, a season — has no file to translate, so it is worked out from
	 * what is underneath it. See `_folders`.
	 */
	private _localPath(item: MediaItemEntity, context: GroupContext): string | null {
		if (!context.local.has(item.serviceId)) {
			return null;
		}

		const reported = item.file?.path ?? null;

		if (reported === null) {
			return context.folders.get(item.id) ?? null;
		}

		const service = context.services.get(item.serviceId);

		return service === undefined
			? null
			: mappedLocalPath(reported, service.rootMappings ?? []);
	}

	/**
	 * The distinct things to hold, as opposed to the places to get them from.
	 *
	 * Folded on the fingerprint rather than on the service, because that is what makes
	 * the difference the screen needs: three friends holding the one file is one version
	 * with three sources and one transfer, while a 1080p and a 2160p of the same cut are
	 * two versions and two transfers. Holding one of them is an ordinary state and not a
	 * half-finished sync, which is why `heldLocally` is per version and not per group.
	 *
	 * A copy nobody has fingerprinted contributes nothing here, and that is the honest
	 * answer rather than an inconvenient one: giving it an identity of its own would make
	 * the same file on two unscanned servers look like two versions, and offering both
	 * would download it twice into one path. The sources list still shows it — this list
	 * only ever says what is *known* to be distinct.
	 *
	 * The order is the ranked order of the copies, so a version we hold comes before one
	 * only a friend has, which is what the contract means by "ours first".
	 */
	private _versions(sources: MediaGroupSource[]): MediaVersion[] {
		const byVersion = new Map<string, MediaVersion>();

		for (const source of sources) {
			if (source.versionId === null) {
				continue;
			}

			const known = byVersion.get(source.versionId);

			if (known === undefined) {
				byVersion.set(source.versionId, {
					versionId: source.versionId,
					edition: source.edition,
					quality: source.quality,
					bytes: source.bytes,
					heldLocally: source.local,
					sourceItemIds: [source.itemId],
				});

				continue;
			}

			known.sourceItemIds.push(source.itemId);
			known.heldLocally = known.heldLocally || source.local;

			// One copy of a version labelled and the others not is the normal case — only
			// Plex reports an edition, and only some filenames carry the tag. A label
			// found on any copy describes the version, since they are the same bytes.
			known.edition = known.edition ?? source.edition;
		}

		this._foldUnidentified(sources, byVersion);

		return [...byVersion.values()];
	}

	/**
	 * Attach a copy with no identity of its own to the version its bytes say it is.
	 *
	 * A copy on a server this gateway has no mount for cannot be fingerprinted from a
	 * disk, so it arrives with no `versionId` and becomes a version of its own — and the
	 * media page then offers to fetch, over the network, twenty gigabytes already
	 * sitting on the disk it would write them to. That is the owner's Jellyfin and Plex
	 * indexing one file on one NAS, and it cost him the transfer to find out.
	 *
	 * `identifyTwins` fixes this properly, by fetching three windows and computing the
	 * real value. This is what stands in until a scan has run, and what covers the
	 * servers that will not serve ranges at all.
	 *
	 * **The test is exact bytes and the same encoding**, and both halves matter. Byte
	 * equality alone is conclusive on a film and a coincidence on a two-minute clip;
	 * requiring the quality label as well — the codec and the resolution the services
	 * themselves report — makes an accident essentially impossible without asking
	 * anybody for a threshold nobody could justify.
	 *
	 * **Only onto a version we already hold.** The whole consequence of being wrong here
	 * is not offering a fetch for a copy that was in fact different, which is visible,
	 * recoverable and far cheaper than the reverse. Folding two remote copies together
	 * would instead make a version disappear from the list with nothing to show for it.
	 */
	private _foldUnidentified(
		sources: MediaGroupSource[],
		byVersion: Map<string, MediaVersion>,
	): void {
		const held = [...byVersion.values()].filter((version) => version.heldLocally);

		if (held.length === 0) {
			return;
		}

		const labelOf = (version: MediaVersion): string | null => version.quality?.label ?? null;

		for (const source of sources) {
			if (source.versionId !== null || source.bytes === null || source.local) {
				continue;
			}

			const twin = held.find(
				(version) =>
					version.bytes === source.bytes
					&& labelOf(version) !== null
					&& labelOf(version) === (source.quality?.label ?? null),
			);

			if (twin === undefined) {
				continue;
			}

			twin.sourceItemIds.push(source.itemId);
		}
	}

	private _addedAt(ranked: MediaItemEntity[]): string | null {
		const stamps = ranked
			.map((item) => item.addedAt)
			.filter((value): value is Date => value instanceof Date);

		if (stamps.length === 0) {
			return null;
		}

		return new Date(Math.max(...stamps.map((value) => value.getTime()))).toISOString();
	}

	private _summary(item: MediaItemEntity): QualitySummary | null {
		if (item.quality !== null) {
			return item.quality;
		}

		return item.file === null ? null : this._quality.summarise([item.file]);
	}

	/**
	 * Every identifier any copy carries, the preferred copy winning a disagreement.
	 *
	 * Merged rather than taken from the representative alone because the identifiers
	 * are the one field where a remote library is routinely richer: a Plex section with
	 * an agent enabled has a TVDB identifier for an episode a Jellyfin library filed by
	 * filename knows nothing about, and dropping it would cost the next correlation its
	 * best signal.
	 */
	private _externalIds(ranked: MediaItemEntity[]): ExternalIds {
		const merged: ExternalIds = {};

		for (const item of [...ranked].reverse()) {
			for (const [key, value] of Object.entries(item.externalIds ?? {})) {
				if (typeof value === 'string' && value !== '') {
					merged[key as keyof ExternalIds] = value;
				}
			}
		}

		return merged;
	}

	/**
	 * The same copies, with the ones somebody corrected this field on moved to the
	 * front.
	 *
	 * The precedence a household actually wants is three deep and it is per field:
	 * **a correction, then what our own servers report, then what a friend's does.**
	 * The middle and the last are what `_rank` already gives; the first was missing,
	 * and its absence had a consequence worth spelling out. A correction is written
	 * onto the copy it was made on, and that copy may well be a friend's — the wrong
	 * season number is usually noticed on the shelf it makes a mess of. That copy ranks
	 * behind every local one, so the local server's value still won the group and the
	 * person who made the correction saw nothing change. A correction that is recorded
	 * and has no effect is the same defect as a correction that does not move the
	 * episode.
	 *
	 * Per field rather than per item, and that is the whole reason this is a sort and
	 * not a different representative. A friend's copy with a corrected year and no
	 * overview at all must win the year and leave the overview alone; promoting the
	 * whole row would drag its empty fields along and blank out an overview our own
	 * server has.
	 *
	 * The sort is stable, so inside each half the ranked order — local first, then the
	 * configured priority — survives untouched. Nothing else about the group moves:
	 * `id`, the artwork and the sources still come from the preferred *copy*, because
	 * those are about which server to ask rather than about what this media is.
	 */
	private _preferring(ranked: MediaItemEntity[], field: OverriddenField): MediaItemEntity[] {
		return [...ranked].sort(
			(left, right) => Number(this._corrected(right, field)) - Number(this._corrected(left, field)),
		);
	}

	/**
	 * Whether this copy carries a hand correction of this field, read from the snapshot
	 * rather than guessed.
	 *
	 * `reported` is what the service last said, written beside the correction for
	 * exactly this: the column holds the effective value and the snapshot holds the
	 * service's, so the two differing *is* the correction. Reading the `overrides` blob
	 * instead would count a key somebody sent that happens to match what the server
	 * already says as a correction, which it is not — and that distinction is the same
	 * one that decides whether an item keeps following its server.
	 *
	 * A field cleared on purpose therefore counts as corrected and still wins nothing:
	 * its effective value is null, `_first` skips null, and the gap goes on being filled
	 * from the other copies. That is deliberate. "This value is wrong and there is no
	 * right one" is a statement about one server's answer; it is not a reason to blank
	 * out a year another copy has.
	 */
	private _corrected(item: MediaItemEntity, field: OverriddenField): boolean {
		const reported = item.reported;

		return reported !== null && reported !== undefined && item[field] !== reported[field];
	}

	private _first<T>(
		ranked: MediaItemEntity[],
		read: (item: MediaItemEntity) => T | null,
	): T | null {
		for (const item of ranked) {
			const value = read(item);

			if (value !== null && value !== undefined) {
				return value;
			}
		}

		return null;
	}

	private _hasArtwork(item: MediaItemEntity): boolean {
		return item.artworkUrl !== null && item.artworkUrl !== '';
	}

	private async _require(id: string): Promise<MediaItemEntity> {
		const item = await this._items.findOne({ where: { id } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return item;
	}
}
