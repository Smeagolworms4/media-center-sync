import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, Not, Repository, type SelectQueryBuilder } from 'typeorm';
import type { MediaGroupQuery, MediaKind, MediaSearchQuery } from '@mcs/shared';
import { SyncState } from '@mcs/shared';
import { MediaItem } from '@/entities';

/** The columns a list may be ordered by, and the only ones. */
const SORTABLE = {
	title: 'item.title',
	year: 'item.year',
	addedAt: 'item.addedAt',
} as const;

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

		return builder
			.orderBy(SORTABLE[query.sort ?? 'title'], query.direction === 'desc' ? 'DESC' : 'ASC')
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
	 */
	public findStale(libraryId: string, seenExternalIds: string[]): Promise<MediaItem[]> {
		return seenExternalIds.length === 0
			? this.find({ where: { libraryId } })
			: this.find({ where: { libraryId, externalId: Not(In(seenExternalIds)) } });
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

		const rows = await builder
			.orderBy(SORTABLE[query.sort ?? 'title'], query.direction === 'desc' ? 'DESC' : 'ASC')
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
