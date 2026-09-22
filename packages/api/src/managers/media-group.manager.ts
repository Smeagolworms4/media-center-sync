import {
	ErrorKey,
	LANDED_SYNC_STATES,
	MediaOrigin,
	MediaServiceMode,
	PeerTrust,
	MediaServiceType,
	SyncState,
	type ExternalIds,
	type MediaGroup,
	type MediaGroupQuery,
	type MediaGroupSource,
	type MediaVersion,
	type QualitySummary,
	type ResultList,
} from '@mcs/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, MediaService as MediaServiceEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerRepository,
	type GroupSeedQuery,
	type MatchPair,
	type MediaItemDigest,
} from '@/repositories';
import {
	editionOf,
	QualityService,
	serviceMode,
	SettingsService,
	versionIdOf,
} from '@/services';
import { LibraryManager } from './library.manager';
import { pageBounds, paginate } from './mappers';

/**
 * Which state a group shows when its copies disagree, most urgent first.
 *
 * Read off the local copies only, and in this order because that is the order the
 * states matter to somebody looking at a poster: a running transfer is happening now,
 * a conflict needs a decision, an outdated copy is worth replacing, and `in_sync` is
 * the answer that means there is nothing to do. `unknown` is the fallback rather than
 * a rank, since it says only that correlation has not run.
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
const LANDED_STATES = new Set<SyncState>(LANDED_SYNC_STATES);

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

const GROUP_STATE_ORDER = [
	SyncState.SYNCING,
	SyncState.CONFLICT,
	SyncState.OUTDATED,
	SyncState.MISSING,
	SyncState.IN_SYNC,
	SyncState.LOCAL_ONLY,
] as const;

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
class MatchGraph {
	private readonly _parent = new Map<string, string>();
	private readonly _otherCut = new Set<string>();
	private _components: Map<string, string[]> | null = null;

	public constructor(pairs: MatchPair[]) {
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
}

/** What a listing needs to know about the world, read once per request. */
interface GroupContext {
	graph: MatchGraph;
	services: Map<string, MediaServiceEntity>;
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
 * Three things could not be pushed down, and each is a schema fact rather than an
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
 */
@Injectable()
export class MediaGroupManager {
	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _peers: PeerRepository,
		private readonly _quality: QualityService,
		private readonly _settings: SettingsService,
		private readonly _libraries: LibraryManager,
	) {}

	public async groups(query: MediaGroupQuery): Promise<ResultList<MediaGroup>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const context = await this._context();
		const parentIds =
			query.parentId === undefined ? undefined : await this._parentScope(query.parentId, context);

		const seedQuery: GroupSeedQuery = {
			serviceIds: this._servicesFor(query, context),
			libraryIds: await this._librariesFor(query),
			kind: query.kind,
			rootsOnly: query.rootsOnly,
			search: query.search,
			sort: query.sort,
			direction: query.direction,
			parentIds,
		};
		const seeds = await this._items.findGroupSeeds(seedQuery);

		const skeletons = await this._skeletons(seeds, context, query.hideOwned === true);
		const states = query.states ?? [];
		const byState =
			states.length === 0
				? skeletons
				: await this._inState(skeletons, states, seedQuery, context);

		/*
		 * "Hide what I already have" means hidden only when there is nothing left to
		 * fetch beneath it either.
		 *
		 * A series we hold with three episodes short is the case somebody opens this
		 * screen to find, and a filter that dropped it because the series row itself
		 * exists would hide exactly that. So holding it is not enough — the gaps have
		 * to be closed too, and an ignored child is not a gap.
		 */
		const matching = query.hideOwned === true
			? byState.filter((skeleton) => !skeleton.held || skeleton.missingCount > 0)
			: byState;

		const window = matching.slice((page - 1) * limit, page * limit);
		const groups = await this._read(
			window.map((skeleton) => skeleton.memberIds),
			context,
		);

		return paginate(groups, matching.length, page, limit);
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

		const [group] = await this._read([context.graph.members(id)], context);

		if (group === undefined) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return group;
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
		context: GroupContext,
	): Promise<GroupSkeleton[]> {
		const ownState = (skeleton: GroupSkeleton): boolean => states.includes(skeleton.sync);

		if (seedQuery.rootsOnly !== true) {
			return skeletons.filter(ownState);
		}

		const scope = await this._items.findGroupSeeds({
			...seedQuery,
			rootsOnly: false,
			search: undefined,
			kind: undefined,
		});
		const parentOf = new Map(scope.map((seed) => [seed.id, seed.parentId]));
		const below = scope.filter((seed) => seed.parentId !== null);
		const matching = (await this._skeletons(below, context)).filter(ownState);

		const roots = new Set<string>();

		for (const skeleton of matching) {
			for (const memberId of skeleton.memberIds) {
				let current: string | null | undefined = memberId;

				// Bounded, because a parent chain is data a media server wrote: a
				// series, a season, an episode is three steps, and a loop in somebody's
				// index must cost a few iterations rather than the request.
				for (let depth = 0; depth < 8 && current; depth += 1) {
					const parent = parentOf.get(current);

					if (parent === null) {
						roots.add(current);
						break;
					}

					current = parent;
				}
			}
		}

		return skeletons.filter(
			(skeleton) => ownState(skeleton) || skeleton.memberIds.some((memberId) => roots.has(memberId)),
		);
	}

	private async _context(): Promise<GroupContext> {
		const threshold = await this._settings.getValue('matchThreshold');
		const [pairs, services, peers] = await Promise.all([
			this._matches.findAppliedPairs(threshold),
			this._services.find(),
			this._peers.find(),
		]);

		return {
			graph: new MatchGraph(pairs),
			services: new Map(services.map((service) => [service.id, service])),
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

		return order.map((root) => {
			const memberIds = byRoot.get(root) as string[];
			const members = memberIds
				.map((id) => digests.get(id))
				.filter((digest): digest is MediaItemDigest => digest !== undefined);

			return {
				memberIds,
				sync: this._state(members, context),
				// A media whose file we have already downloaded counts as held, so that
				// "hide what I already have" hides it. It is the same answer the wall
				// gives about it, and a filter that kept offering a file already on the
				// disk is the behaviour this whole state exists to remove.
				held: members.some((member) => this._holds(member, context)),
				missingCount: gaps.get(root) ?? 0,
			};
		});
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

		for (const child of children) {
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

			if (!held) {
				gaps.set(parentRoot, (gaps.get(parentRoot) ?? 0) + 1);
			}
		}

		return gaps;
	}

	/** The full rows for one page of groups, and the children those groups count. */
	private async _read(components: string[][], context: GroupContext): Promise<MediaGroup[]> {
		const memberIds = components.flat();
		const rows = new Map(
			(await this._items.findByIds(memberIds)).map((item) => [item.id, item]),
		);

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
		const sources = ranked.map((item) => this._source(item, context));
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
				groups.set(
					root,
					context.graph
						.members(child.id)
						.some((id) => {
							const copy = children.byId.get(id);

							return copy !== undefined && this._holds(copy, context);
						}),
				);
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
		return (
			(context.local.has(copy.serviceId) && !context.graph.besideAnotherCut(copy.id))
			|| LANDED_STATES.has(copy.syncState)
		);
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
	private _state(members: MediaItemDigest[], context: GroupContext): SyncState {
		const held = members.filter((member) => context.local.has(member.serviceId));

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
			sync: item.syncState,
		};
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

		return [...byVersion.values()];
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
