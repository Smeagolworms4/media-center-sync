import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { ExternalIds, MediaCompanions, MediaFileInfo, QualitySummary } from '@mcs/shared';
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

	/** Identifier inside the reporting service. */
	@ApiProperty()
	@Column()
	public externalId!: string;

	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public parentId!: string | null;

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
