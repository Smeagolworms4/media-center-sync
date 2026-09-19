import {
	ErrorKey,
	MediaOrigin,
	MediaServiceScope,
	PeerTrust,
	MediaServiceType,
	SyncState,
	type ExternalIds,
	type MediaGroup,
	type MediaGroupQuery,
	type MediaGroupSource,
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
	type MatchPair,
	type MediaItemDigest,
} from '@/repositories';
import { QualityService, SettingsService } from '@/services';
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
	private _components: Map<string, string[]> | null = null;

	public constructor(pairs: MatchPair[]) {
		for (const pair of pairs) {
			this._union(pair.localItemId, pair.remoteItemId);
		}
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
 * posters, and a conflict stays two, because both of those states exist precisely to
 * say that nobody has decided the pair is one thing.
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
	) {}

	public async groups(query: MediaGroupQuery): Promise<ResultList<MediaGroup>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const context = await this._context();
		const parentIds =
			query.parentId === undefined ? undefined : await this._parentScope(query.parentId, context);

		const seeds = await this._items.findGroupSeeds({
			serviceIds: this._servicesFor(query, context),
			libraryIds: query.libraryId === undefined ? undefined : [query.libraryId],
			kind: query.kind,
			rootsOnly: query.rootsOnly,
			search: query.search,
			sort: query.sort,
			direction: query.direction,
			parentIds,
		});

		const skeletons = await this._skeletons(seeds, context);
		const states = query.states ?? [];
		const matching =
			states.length === 0
				? skeletons
				: skeletons.filter((skeleton) => states.includes(skeleton.sync));

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
					.filter((service) => service.scope === MediaServiceScope.LOCAL)
					.map((service) => service.id),
			),
		};
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

		return order.map((root) => {
			const memberIds = byRoot.get(root) as string[];
			const members = memberIds
				.map((id) => digests.get(id))
				.filter((digest): digest is MediaItemDigest => digest !== undefined);

			return { memberIds, sync: this._state(members, context) };
		});
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

		return {
			id: representative.id,
			kind: representative.kind,
			title: representative.title,
			normalizedTitle: representative.normalizedTitle,
			// Gaps filled from the other copies: a remote server often carries an
			// overview or a year the local one never received.
			year: this._first(ranked, (item) => item.year),
			seasonNumber: this._first(ranked, (item) => item.seasonNumber),
			episodeNumber: this._first(ranked, (item) => item.episodeNumber),
			externalIds: this._externalIds(ranked),
			overview: this._first(ranked, (item) => item.overview),
			// The local copy's poster when there is one: artwork is fetched through the
			// service that reported it, and a friend's server may be asleep while ours
			// answers.
			artworkItemId: ranked.find((item) => this._hasArtwork(item))?.id ?? null,
			sync: this._state(members, context),
			quality: qualities.every((quality) => quality === null)
				? null
				: this._quality.merge(qualities),
			sources,
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

				// Asked of every copy of the child, not of the copies filed under this
				// parent: holding it is a fact about the media, not about where one
				// server decided to put it.
				groups.set(
					root,
					context.graph
						.members(child.id)
						.some((id) => {
							const copy = children.byId.get(id);

							return copy !== undefined && context.local.has(copy.serviceId);
						}),
				);
			}
		}

		return groups;
	}

	/**
	 * The state a group shows, derived from the copies we hold.
	 *
	 * A media with no local copy is `missing` whatever its remote rows say about each
	 * other: two friends being in sync with one another is not an answer to "do I have
	 * this", and the poster that asks that question is on our screen.
	 */
	private _state(members: MediaItemDigest[], context: GroupContext): SyncState {
		const held = members.filter((member) => context.local.has(member.serviceId));

		if (held.length === 0) {
			return SyncState.MISSING;
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
			scope: service?.scope ?? MediaServiceScope.REMOTE,
			peerId,
			peerName: peerId === null ? null : (context.peerNames.get(peerId) ?? null),
			// An episode carries a file and no aggregate; a season carries the aggregate
			// and no file. Both have to answer the same question here.
			quality: this._summary(item),
			companions: item.companions,
			bytes: item.file?.size ?? null,
			local: context.local.has(item.serviceId),
			sync: item.syncState,
		};
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
