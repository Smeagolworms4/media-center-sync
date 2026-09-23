import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, Not, Repository, type SelectQueryBuilder } from 'typeorm';
import type { MediaGroupQuery, MediaSearchQuery } from '@mcs/shared';
import { MediaKind, SyncState } from '@mcs/shared';
import { MediaItem } from '@/entities';

/** The columns a list may be ordered by, and the only ones. */
const SORTABLE = {
	title: 'item.title',
	year: 'item.year',
	addedAt: 'item.addedAt',
} as const;

/**
 * Episodes come out in broadcast order, not alphabetical order.
 *
 * Sorting a season by title puts episode 10 before episode 2, and puts an episode
 * called "Pilot" in the middle of the season. It is the ordering a person opening a
 * show is least able to work around, because there is no control on the screen that
 * would undo it.
 *
 * Applied before the requested column rather than instead of it, so it costs nothing
 * anywhere else: a film has no season and no episode, every row collapses to the same
 * key, and the list is ordered by what was actually asked for.
 *
 * The sentinel is there because the two engines disagree about where a NULL sorts —
 * SQLite puts it first ascending, PostgreSQL puts it last — and an episode the
 * service numbered nothing would otherwise land at opposite ends of the season
 * depending on which database somebody chose. Last, on both, and deliberately: a row
 * with no number is the odd one out and belongs after the ones that have one.
 */
const EPISODE_ORDER = [
	'COALESCE(item.seasonNumber, 999999)',
	'COALESCE(item.episodeNumber, 999999)',
] as const;

/**
 * The column to order by, for a sort that may be anything at all.
 *
 * A name that is not in the table falls back to the title rather than reaching the
 * query: `SORTABLE[unknown]` is `undefined`, and handing that to the builder used to
 * clear the ordering instead of raising — so a mistyped sort silently returned rows
 * in whatever order the engine felt like, page by page, which is a paginated list
 * that shows the same row twice and never shows another.
 */
const sortColumn = (sort: string | undefined): string =>
	SORTABLE[(sort ?? 'title') as keyof typeof SORTABLE] ?? SORTABLE.title;

/**
 * How many identifiers go into one `IN (…)`.
 *
 * SQLite refuses a statement past its variable ceiling, and the grouped routes build
 * their lists from identifiers rather than from a join — a library page can easily
 * name a few thousand rows. Splitting is cheaper than finding out in production that
 * a query works up to a certain library size.
 */
const ID_CHUNK = 400;

/**
 * The few columns grouping needs to fold rows into components.
 *
 * Deliberately not the entity: `file`, `quality`, `externalIds` and `overview` are
 * JSON columns, and a library screen would read all of them for every row in the
 * index just to find out which rows belong together. This projection is read for the
 * whole filtered set; the full rows are read for one page.
 */
export interface MediaItemDigest {
	id: string;
	serviceId: string;
	libraryId: string;
	parentId: string | null;
	kind: MediaKind;
	syncState: SyncState;
	/** Excluded from gap counts and from what a sync plans. See `MediaOverride.ignored`. */
	ignored: boolean;
}

/**
 * One season, reduced to the series it belongs to and what decides whether it is odd.
 *
 * The number and the child count travel with the name because both change the verdict
 * and neither can be recovered from it: a season the server numbered is a season
 * whatever it is called, and a season holding nothing is not drawn, so neither can be
 * evidence that a folder was misread. Filtering them out of the query instead would
 * also take them out of the *count*, which is what the other signal — a series
 * claiming more seasons than a show runs for — is measured on.
 */
export interface SeasonName {
	id: string;
	parentId: string;
	title: string;
	seasonNumber: number | null;
	childCount: number;
}

/**
 * One row of a service's series tree, reduced to what deciding a place needs.
 *
 * A projection rather than entities because the pass that uses it walks every series,
 * season and episode a service holds — forty thousand rows on the owner's Jellyfin —
 * and reading entities would pull `file`, `quality`, `overview` and `externalIds` for
 * all of them to compare two numbers and follow one link.
 */
export interface Placement {
	id: string;
	parentId: string | null;
	kind: MediaKind;
	seasonNumber: number | null;
	synthetic: boolean;
}

/** A parent a child points at and the index does not hold, with somewhere to file it. */
export interface UnresolvedParent {
	parentExternalId: string;
	libraryId: string;
}

/** A group listing's filter, with the parent addressed as a set of items rather than one. */
export interface GroupSeedQuery
	extends Omit<MediaGroupQuery, 'parentId' | 'states' | 'libraryId' | 'origins'> {
	/** Resolved from the origins and the service filter before the query is built. */
	libraryIds?: string[];
	/** Every item of the parent group, because a series' seasons may live on either. */
	parentIds?: string[];
}

@Injectable()
export class MediaItemRepository extends Repository<MediaItem> {
	public constructor(dataSource: DataSource) {
		super(MediaItem, dataSource.createEntityManager());
	}

	public findChildren(parentId: string): Promise<MediaItem[]> {
		return this.find({
			where: { parentId },
			order: { seasonNumber: 'ASC', episodeNumber: 'ASC', title: 'ASC' },
		});
	}

	/** The top of a library: what has no parent. */
	public findRoots(libraryId: string): Promise<MediaItem[]> {
		return this.find({ where: { libraryId, parentId: IsNull() }, order: { title: 'ASC' } });
	}

	public findByExternalId(serviceId: string, externalId: string): Promise<MediaItem | null> {
		return this.findOne({ where: { serviceId, externalId } });
	}

	public findByExternalIds(serviceId: string, externalIds: string[]): Promise<MediaItem[]> {
		return externalIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { serviceId, externalId: In(externalIds) } });
	}

	/**
	 * Hang every unlinked child onto the parent it names, in one statement.
	 *
	 * The correlated subquery is the point: a library of forty thousand episodes would
	 * otherwise be forty thousand lookups and forty thousand writes, once per scan,
	 * for a repair that concerns a handful of rows. Written as SQL both engines accept
	 * — a subquery in `SET` and the same one in `EXISTS`, with the outer row qualified
	 * by the table name because neither dialect aliases the target of an `UPDATE`.
	 *
	 * The `EXISTS` guard is not redundant with the assignment. Without it every row
	 * matching the filter is written, and the ones whose parent is still unknown get
	 * `NULL` assigned over `NULL` — harmless to read, but it moves `updatedAt` on rows
	 * nothing happened to and makes the returned count meaningless as a signal that
	 * anything was repaired.
	 *
	 * Answers how many rows it linked, which is what the caller logs.
	 */
	public async linkKnownParents(serviceId: string): Promise<number> {
		const parent =
			'SELECT "parent"."id" FROM "media_items" "parent"'
			+ ' WHERE "parent"."serviceId" = "media_items"."serviceId"'
			+ ' AND "parent"."externalId" = "media_items"."parentExternalId"';

		const result = await this.createQueryBuilder()
			.update(MediaItem)
			.set({ parentId: () => `(${parent})` })
			.where('"media_items"."serviceId" = :serviceId', { serviceId })
			.andWhere('"media_items"."parentId" IS NULL')
			.andWhere('"media_items"."parentExternalId" IS NOT NULL')
			.andWhere(`EXISTS (${parent})`)
			.execute();

		return result.affected ?? 0;
	}

	/**
	 * The parents children name that this service never reported, once each.
	 *
	 * Grouped rather than listed: a series whose four hundred episodes all point at it
	 * has to be asked for once, and the caller turns each row into exactly one request
	 * to the media server. `MIN(libraryId)` picks a library to file the fetched parent
	 * in — any child's will do, since a parent lives where its children do, and the
	 * aggregate is only there because both engines refuse a bare column beside a
	 * `GROUP BY`.
	 */
	public findUnresolvedParents(serviceId: string): Promise<UnresolvedParent[]> {
		return this.createQueryBuilder('item')
			.select('item.parentExternalId', 'parentExternalId')
			.addSelect('MIN(item.libraryId)', 'libraryId')
			.where('item.serviceId = :serviceId', { serviceId })
			.andWhere('item.parentId IS NULL')
			.andWhere('item.parentExternalId IS NOT NULL')
			.andWhere(
				'NOT EXISTS (SELECT 1 FROM "media_items" "parent"'
				+ ' WHERE "parent"."serviceId" = item."serviceId"'
				+ ' AND "parent"."externalId" = item."parentExternalId")',
			)
			.groupBy('item.parentExternalId')
			.getRawMany<UnresolvedParent>();
	}

	/**
	 * One page of the browsing tree, and the total that goes with it.
	 *
	 * The sort column comes from a fixed table rather than from the request: an
	 * `ORDER BY` is not a bound parameter, so a name taken straight from the query
	 * string would be pasted into the SQL.
	 */
	public async search(query: MediaSearchQuery): Promise<[MediaItem[], number]> {
		const page = Math.max(1, query.page ?? 1);
		const limit = Math.min(200, Math.max(1, query.limit ?? 50));
		const builder = this.createQueryBuilder('item');

		if (query.serviceId !== undefined) {
			builder.andWhere('item.serviceId = :serviceId', { serviceId: query.serviceId });
		}

		if (query.libraryId !== undefined) {
			builder.andWhere('item.libraryId = :libraryId', { libraryId: query.libraryId });
		}

		if (query.kind !== undefined) {
			builder.andWhere('item.kind = :kind', { kind: query.kind });
		}

		if (query.parentId !== undefined) {
			builder.andWhere('item.parentId = :parentId', { parentId: query.parentId });
		}

		if (query.states !== undefined && query.states.length > 0) {
			builder.andWhere('item.syncState IN (:...states)', { states: query.states });
		}

		if (query.search !== undefined && query.search !== '') {
			// Matched against the normalised title, which is what the search box is
			// compared with everywhere else: searching the displayed title would miss
			// `Amelie` typed without its accent.
			builder.andWhere('item.normalizedTitle LIKE :search', {
				search: `%${query.search.toLowerCase()}%`,
			});
		}

		const direction = query.direction === 'desc' ? 'DESC' : 'ASC';

		builder.orderBy(EPISODE_ORDER[0], direction).addOrderBy(EPISODE_ORDER[1], direction);

		return builder
			.addOrderBy(sortColumn(query.sort), direction)
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();
	}

	/**
	 * The handful of rows worth scoring against an item we are trying to correlate.
	 *
	 * Comparing everything with everything is quadratic and, on a catalogue of tens of
	 * thousands of episodes, simply never finishes. The normalised title plus the
	 * episode coordinates cut it down to a few rows, and the composite index on those
	 * three columns is what makes that lookup cheap.
	 */
	public findCandidatesForMatch(
		normalizedTitle: string,
		seasonNumber: number | null,
		episodeNumber: number | null,
		excludeServiceId?: string,
	): Promise<MediaItem[]> {
		const builder = this.createQueryBuilder('item')
			.where('item.normalizedTitle = :normalizedTitle', { normalizedTitle });

		builder.andWhere(
			seasonNumber === null ? 'item.seasonNumber IS NULL' : 'item.seasonNumber = :seasonNumber',
			seasonNumber === null ? {} : { seasonNumber },
		);
		builder.andWhere(
			episodeNumber === null
				? 'item.episodeNumber IS NULL'
				: 'item.episodeNumber = :episodeNumber',
			episodeNumber === null ? {} : { episodeNumber },
		);

		if (excludeServiceId !== undefined) {
			builder.andWhere('item.serviceId != :excludeServiceId', { excludeServiceId });
		}

		return builder.getMany();
	}

	/**
	 * Every season's name and the series it hangs from, and nothing else.
	 *
	 * Three scalar columns for the whole index, because the question it answers — does
	 * any series have seasons named like shows — is about names and has to look at all
	 * of them. Reading entities instead would pull `file`, `quality`, `externalIds` and
	 * `overview` for thousands of rows to compare a string.
	 *
	 * A season whose parent is unknown is left out: it cannot be attributed to a series,
	 * and a hint that cannot name the series it is about is a hint nobody can act on.
	 */
	public findSeasonNames(): Promise<SeasonName[]> {
		return this.createQueryBuilder('item')
			.select('item.id', 'id')
			.addSelect('item.parentId', 'parentId')
			.addSelect('item.title', 'title')
			.addSelect('item.seasonNumber', 'seasonNumber')
			.addSelect('item.childCount', 'childCount')
			.where('item.kind = :kind', { kind: MediaKind.SEASON })
			.andWhere('item.parentId IS NOT NULL')
			.getRawMany<SeasonName>();
	}

	/**
	 * Every series, season and episode one service holds, as places rather than media.
	 *
	 * Films are left out because nothing about them is filed: a film has no season to
	 * belong to and no children to lose, so carrying them would double the rows read
	 * for a pass that could do nothing with them.
	 *
	 * `synthetic` comes back because the pass has to tell a season the gateway invented
	 * from one a server reports, and the two are treated differently when they end up
	 * empty — ours is deleted, the server's is kept and simply stops being drawn.
	 */
	public findPlacements(serviceId: string): Promise<Placement[]> {
		return this.createQueryBuilder('item')
			.select('item.id', 'id')
			.addSelect('item.parentId', 'parentId')
			.addSelect('item.kind', 'kind')
			.addSelect('item.seasonNumber', 'seasonNumber')
			.addSelect('item.synthetic', 'synthetic')
			.where('item.serviceId = :serviceId', { serviceId })
			.andWhere('item.kind IN (:...kinds)', {
				kinds: [MediaKind.SERIES, MediaKind.SEASON, MediaKind.EPISODE],
			})
			.getRawMany<Placement>();
	}

	public countByLibrary(libraryId: string): Promise<number> {
		return this.count({ where: { libraryId } });
	}

	public countByService(serviceId: string): Promise<number> {
		return this.count({ where: { serviceId } });
	}

	/** How many items sit in each synchronisation state, for the dashboard counters. */
	public async countByState(serviceId?: string): Promise<Record<SyncState, number>> {
		const builder = this.createQueryBuilder('item')
			.select('item.syncState', 'state')
			.addSelect('COUNT(1)', 'total')
			.groupBy('item.syncState');

		if (serviceId !== undefined) {
			builder.where('item.serviceId = :serviceId', { serviceId });
		}

		const rows = await builder.getRawMany<{ state: SyncState; total: string | number }>();
		const counts = Object.values(SyncState).reduce<Record<SyncState, number>>(
			(accumulator, state) => ({ ...accumulator, [state]: 0 }),
			{} as Record<SyncState, number>,
		);

		for (const row of rows) {
			counts[row.state] = Number(row.total);
		}

		return counts;
	}

	public async setSyncState(ids: string[], syncState: SyncState): Promise<void> {
		if (ids.length === 0) {
			return;
		}

		await this.update({ id: In(ids) }, { syncState });
	}

	/**
	 * Items a scan no longer reported, which is how a deletion is detected.
	 *
	 * A media service never tells anyone that a file is gone; it simply stops listing
	 * it. Comparing what a full scan saw against what the index holds is the only way
	 * to notice.
	 *
	 * Synthetic rows are excluded, and that exclusion is not an optimisation. A season
	 * the gateway created to hold a corrected episode was never reported by anybody and
	 * never will be, so it is missing from every walk by construction — the plain rule
	 * would delete it at the end of the very next scan and file the episode back where
	 * the service says it belongs. The correction would undo itself on a timer, which
	 * is the failure mode this whole flag exists to prevent.
	 */
	public findStale(libraryId: string, seenExternalIds: string[]): Promise<MediaItem[]> {
		return seenExternalIds.length === 0
			? this.find({ where: { libraryId, synthetic: false } })
			: this.find({
				where: { libraryId, synthetic: false, externalId: Not(In(seenExternalIds)) },
			});
	}

	/**
	 * Items of one library that hold a file with no content identity yet.
	 *
	 * The filter cannot be pushed into SQL: the file lives in a `simple-json` column
	 * that neither engine can look inside, and adding a column for it would mean a
	 * migration and a second place for the same truth to be wrong. A library is
	 * thousands of rows, not millions, and this runs once per file in its lifetime.
	 */
	public async findFingerprintable(libraryId: string): Promise<MediaItem[]> {
		const items = await this.find({ where: { libraryId } });

		return items.filter(
			(item) =>
				item.file !== null &&
				item.file.path !== '' &&
				(item.file.quickHash === null || item.file.quickHash === ''),
		);
	}

	/**
	 * The rows a grouped listing starts from, narrow and in order.
	 *
	 * Runs `SELECT id, serviceId, libraryId, parentId, kind, syncState, ignored FROM
	 * media_items`
	 * with the caller's filters and the usual `ORDER BY`, and no `LIMIT`. The limit is
	 * missing on purpose: several rows collapse into one group, so a page of rows is
	 * not a page of groups and slicing here would hand back a short page with a total
	 * that contradicts it. What is bounded instead is the width — seven scalar columns,
	 * never the JSON ones.
	 *
	 * The identifier is the last `ORDER BY` term so that two rows sharing a title come
	 * back in the same order every time; without it the group a page starts on depends
	 * on whatever the engine felt like.
	 */
	public async findGroupSeeds(query: GroupSeedQuery): Promise<MediaItemDigest[]> {
		const builder = this._digestQuery();

		/*
		 * An empty list is a filter nothing satisfies, not the absence of one.
		 *
		 * Asking for a friend nobody has linked, or a service that does not exist, must
		 * answer nothing — and `length > 0` answered the whole library instead, which is
		 * the one way of getting this wrong that looks like the filter being ignored.
		 * `IN ()` is not valid SQL on either engine, so the impossible condition is
		 * written out rather than passed through.
		 */
		if (query.serviceIds !== undefined) {
			if (query.serviceIds.length === 0) {
				builder.andWhere('1 = 0');
			} else {
				builder.andWhere('item.serviceId IN (:...serviceIds)', { serviceIds: query.serviceIds });
			}
		}

		/*
		 * The column already holds the effective library.
		 *
		 * A reclassified item has had `libraryId` rewritten, with the service's answer
		 * kept in `reported`, so a filter here needs no knowledge of overrides at all —
		 * which is the point of resolving them on write rather than on read.
		 */
		if (query.libraryIds !== undefined) {
			if (query.libraryIds.length === 0) {
				// A category nobody has, for the same reason as above.
				builder.andWhere('1 = 0');
			} else {
				builder.andWhere('item.libraryId IN (:...libraryIds)', { libraryIds: query.libraryIds });
			}
		}

		if (query.kind !== undefined) {
			builder.andWhere('item.kind = :kind', { kind: query.kind });
		}

		if (query.rootsOnly === true) {
			// The top of each tree, whatever the library holds. A library screen wants
			// posters, not every episode of every show laid beside its series — and a
			// library of concerts or audiobooks has no kind this model names, so a
			// filter derived from the kind would show it parents and children together.
			builder.andWhere('item.parentId IS NULL');
		}

		if (query.parentIds !== undefined) {
			builder.andWhere('item.parentId IN (:...parentIds)', { parentIds: query.parentIds });
		}

		if (query.search !== undefined && query.search !== '') {
			// Against the normalised title, like every other search in the application:
			// the displayed title would miss `Amelie` typed without its accent.
			builder.andWhere('item.normalizedTitle LIKE :search', {
				search: `%${query.search.toLowerCase()}%`,
			});
		}

		const direction = query.direction === 'desc' ? 'DESC' : 'ASC';
		const rows = await builder
			.orderBy(EPISODE_ORDER[0], direction)
			.addOrderBy(EPISODE_ORDER[1], direction)
			.addOrderBy(sortColumn(query.sort), direction)
			.addOrderBy('item.id', 'ASC')
			.getRawMany<MediaItemDigest>();

		return MediaItemRepository._digests(rows);
	}

	/** The same projection, for identifiers a component pulled in from outside the filter. */
	public async findDigests(ids: string[]): Promise<MediaItemDigest[]> {
		return MediaItemRepository._digests(
			await this._chunked(ids, (chunk) =>
				this._digestQuery()
					.andWhere('item.id IN (:...ids)', { ids: chunk })
					.getRawMany<MediaItemDigest>(),
			),
		);
	}

	/** The same projection for everything under a set of parents, which is what a group's children are. */
	public async findChildDigests(parentIds: string[]): Promise<MediaItemDigest[]> {
		return MediaItemRepository._digests(
			await this._chunked(parentIds, (chunk) =>
				this._digestQuery()
					.andWhere('item.parentId IN (:...parentIds)', { parentIds: chunk })
					.getRawMany<MediaItemDigest>(),
			),
		);
	}

	/**
	 * Rows whose stored file blob contains a piece of text, as a prefilter and nothing
	 * more.
	 *
	 * `file` is a `simple-json` column, which both engines hold as text, so the only
	 * thing available without a dialect-specific JSON operator is a substring test.
	 * That is enough for what it is for — narrowing tens of thousands of rows to the
	 * handful worth deserialising when looking for the item a downloaded file became.
	 *
	 * **It is never the answer.** A substring can match another field, another row's
	 * path, or nothing at all when a value happened to need JSON escaping; the caller
	 * re-reads the deserialised blob and compares properly. Treating this result as a
	 * match would file a media under whichever row happened to share a filename.
	 *
	 * Capped, because an unlucky hint — a common episode name, an empty string — must
	 * cost a page of rows rather than the whole index.
	 */
	public findByFileHint(hint: string): Promise<MediaItem[]> {
		if (hint === '') {
			return Promise.resolve([]);
		}

		return this.createQueryBuilder('item')
			.where('item.file LIKE :hint', { hint: `%${hint}%` })
			.take(100)
			.getMany();
	}

	/** Full rows, for the one page a grouped listing actually renders. */
	public findByIds(ids: string[]): Promise<MediaItem[]> {
		return this._chunked(ids, (chunk) => this.find({ where: { id: In(chunk) } }));
	}

	/**
	 * Raw rows carry the engine's idea of a boolean, so it is normalised once here.
	 *
	 * `getRawMany` skips the entity layer that would have converted it, and the two
	 * engines disagree: SQLite hands back `0` and `1`, PostgreSQL `false` and `true`.
	 * `0` is falsy and `1` is truthy, so a plain `if` would work on both and a
	 * `=== true` would silently be false on SQLite for every ignored item — the filter
	 * would simply appear not to work, on the engine that ships by default.
	 */
	private static _digests(rows: MediaItemDigest[]): MediaItemDigest[] {
		return rows.map((row) => ({ ...row, ignored: row.ignored === true || Number(row.ignored) === 1 }));
	}

	private _digestQuery(): SelectQueryBuilder<MediaItem> {
		return this.createQueryBuilder('item')
			.select('item.id', 'id')
			.addSelect('item.serviceId', 'serviceId')
			.addSelect('item.libraryId', 'libraryId')
			.addSelect('item.parentId', 'parentId')
			.addSelect('item.kind', 'kind')
			.addSelect('item.syncState', 'syncState')
			.addSelect('item.ignored', 'ignored');
	}

	private async _chunked<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
		const unique = [...new Set(ids)];
		const rows: T[] = [];

		for (let start = 0; start < unique.length; start += ID_CHUNK) {
			rows.push(...(await read(unique.slice(start, start + ID_CHUNK))));
		}

		return rows;
	}
}
