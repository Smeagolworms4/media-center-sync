import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import type { MediaSearchQuery } from '@mcs/shared';
import { SyncState } from '@mcs/shared';
import { MediaItem } from '@/entities';

/** The columns a list may be ordered by, and the only ones. */
const SORTABLE = {
	title: 'item.title',
	year: 'item.year',
	addedAt: 'item.addedAt',
} as const;

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
}
