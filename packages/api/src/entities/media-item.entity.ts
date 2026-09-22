import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type {
	ExternalIds,
	MediaCompanions,
	MediaFileInfo,
	MediaOverride,
	MediaReported,
	QualitySummary,
} from '@mcs/shared';
import { MediaKind, SyncState } from '@mcs/shared';
import { Library } from './library.entity';
import { MediaService } from './media-service.entity';
import { Timestampable } from './timestampable.entity';

/**
 * One item as a service reports it: a film, a series, a season, an episode.
 *
 * Every service gets its own rows — the same episode held by three friends is three
 * items. What ties them together is a match, not a shared row: merging them would
 * mean choosing whose title, whose artwork and whose file size to keep, and losing
 * the very differences a sync exists to show.
 */
@Entity('media_items')
@Index(['serviceId', 'externalId'], { unique: true })
@Index(['normalizedTitle', 'seasonNumber', 'episodeNumber'])
export class MediaItem extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ManyToOne(() => MediaService, { onDelete: 'CASCADE', nullable: false })
	public service!: MediaService;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public serviceId!: string;

	@ManyToOne(() => Library, { onDelete: 'CASCADE', nullable: false })
	public library!: Library;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public libraryId!: string;

	/**
	 * Identifier inside the reporting service — or, on a synthetic row, one we minted.
	 *
	 * It is never null, because the unique index on `(serviceId, externalId)` is what
	 * keeps a scan from writing the same item twice; a nullable half would let a
	 * gateway accumulate duplicates of every row no service ever named. A synthetic
	 * row therefore carries a value of ours, prefixed so that no media server's own
	 * identifier can ever collide with it. `synthetic` is what says which it is —
	 * never the shape of the string.
	 */
	@ApiProperty()
	@Column()
	public externalId!: string;

	/**
	 * A row the gateway invented, that no service ever reported.
	 *
	 * Exactly one thing creates these today: correcting an episode into a season that
	 * does not exist. The season has to exist for the episode to hang from it — the
	 * whole product navigates by parent — and the service will never report it,
	 * because as far as that server is concerned the episode is still in season one.
	 *
	 * The flag has to be a column rather than a guess about the identifier because the
	 * stale pass reads it: a scan compares what the walk saw against what we hold, and
	 * a row the service could not have listed would be deleted on the very next scan
	 * as a row the service dropped. That is the correction undoing itself on a timer,
	 * with nothing anywhere reporting an error.
	 */
	@ApiProperty()
	@Column({ type: 'boolean', default: false })
	public synthetic!: boolean;

	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public parentId!: string | null;

	/**
	 * The parent as the service names it, kept beside the link it produces.
	 *
	 * `parentId` can only be filled once the parent has a row of ours, and whether it
	 * does at that moment depends on the order the service enumerated in — an order no
	 * media server guarantees anything about. This column is the fact the service
	 * actually stated, so the link can be made whenever the parent turns up instead of
	 * only if it happened to arrive first. Without it a child written too early is
	 * unrepairable: nothing left on the row says what it was supposed to hang from.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public parentExternalId!: string | null;

	@ApiProperty({ enum: MediaKind })
	@Column({ type: 'varchar' })
	public kind!: MediaKind;

	@ApiProperty()
	@Column()
	public title!: string;

	/**
	 * The title reduced for comparison: lowercase, unaccented, leading article
	 * dropped, punctuation and release noise removed.
	 *
	 * Stored rather than computed on the fly because correlation joins on it, and a
	 * function call in a `WHERE` clause cannot use an index.
	 */
	@ApiProperty()
	@Column()
	public normalizedTitle!: string;

	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public year!: number | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public seasonNumber!: number | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public episodeNumber!: number | null;

	@ApiProperty()
	@Column({ type: 'simple-json', default: '{}' })
	public externalIds!: ExternalIds;

	@ApiProperty({ nullable: true })
	@Column({ type: 'text', nullable: true })
	public overview!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public artworkUrl!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'simple-json', nullable: true })
	public file!: MediaFileInfo | null;

	/**
	 * Aggregated over everything below this item, recomputed when a child changes.
	 *
	 * Kept on the row rather than derived per request: a series page shows the
	 * summary of every season, and walking the whole subtree for each one turns a
	 * list of thirty series into thousands of queries.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'simple-json', nullable: true })
	public quality!: QualitySummary | null;

	/**
	 * What sits beside the file: the `.nfo`, the poster, the subtitles.
	 *
	 * Read off the disk, so it only exists for a library somebody told us where to
	 * find. Null means never inspected, which is not the same as nothing there — the
	 * interface has to be able to tell those apart or it will report a complete
	 * library as missing everything.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'simple-json', nullable: true })
	public companions!: MediaCompanions | null;

	/**
	 * What somebody corrected by hand.
	 *
	 * Kept apart from the columns it corrects, and both halves matter. The columns hold
	 * the effective values, because everything downstream has to see the correction: a
	 * season reassigned by hand must change what correlates with what and which folder
	 * a pull lands in, or it is a label rather than a correction. This record is what
	 * lets a rescan re-apply it instead of overwriting it with the service's answer
	 * again — which is what "the next scan undoes my edits" looks like from outside.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'simple-json', nullable: true })
	public overrides!: MediaOverride | null;

	/**
	 * The overridable fields as the service last reported them.
	 *
	 * Null when nothing was ever corrected — there is no point storing a copy of what
	 * the columns already say. It exists so the interface can show what was changed,
	 * and so clearing an override can put back what was there rather than leaving a
	 * hole.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'simple-json', nullable: true })
	public reported!: MediaReported | null;

	/**
	 * Excluded from every count, resolved from the override on write.
	 *
	 * A column rather than a read of `overrides.ignored` because it is read by
	 * aggregates — the missing count of a season, what a sync plans — and those run
	 * over thousands of rows. Reaching into a JSON blob to decide whether each one
	 * counts turns a grouped query into a scan, and the number it produces is the one
	 * a poster shows.
	 */
	@ApiProperty()
	@Column({ type: 'boolean', default: false })
	public ignored!: boolean;

	@ApiProperty({ enum: SyncState })
	@Column({ type: 'varchar', default: SyncState.UNKNOWN })
	public syncState!: SyncState;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public addedAt!: Date | null;

	/** Direct children count, kept so a list does not have to count rows per item. */
	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public childCount!: number;
}
