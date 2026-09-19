import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { LibraryKind } from '@mcs/shared';
import { MediaService } from './media-service.entity';
import { Timestampable } from './timestampable.entity';

/**
 * A library of a registered service.
 *
 * `paths` is what the service reports about itself; `localPath` is where the
 * gateway can write the same files. They differ as soon as the service runs in its
 * own container — Jellyfin says `/media/Shows`, the gateway sees `/mnt/nas/Shows` —
 * and a library where the two do not designate the same directory accepts
 * transfers the service will never notice.
 */
@Entity('libraries')
@Index(['serviceId', 'externalId'], { unique: true })
export class Library extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ManyToOne(() => MediaService, { onDelete: 'CASCADE', nullable: false })
	public service!: MediaService;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public serviceId!: string;

	@ApiProperty()
	@Column()
	public externalId!: string;

	@ApiProperty()
	@Column()
	public name!: string;

	@ApiProperty({ enum: LibraryKind })
	@Column({ type: 'varchar', default: LibraryKind.OTHER })
	public kind!: LibraryKind;

	/** `simple-json`: an array of strings, and the only JSON shape both engines share. */
	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public paths!: string[];

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public localPath!: string | null;

	/** Probed, never assumed: see the note on `localPath`. */
	@ApiProperty()
	@Column({ default: false })
	public writable!: boolean;

	@ApiProperty()
	@Column({ default: false })
	public isDefaultTarget!: boolean;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastScanAt!: Date | null;

	/**
	 * Where the incremental refresh left off, in whatever form the handler needs —
	 * a timestamp for Jellyfin, an `updatedAt` watermark for Plex.
	 *
	 * This is what keeps the gateway from re-reading a whole library to find three
	 * new episodes. A full scan clears it; a refresh advances it. Opaque on purpose:
	 * only the handler that wrote it knows how to read it.
	 */
	@Column({ type: 'varchar', nullable: true })
	public scanCursor!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastRefreshAt!: Date | null;

	/** Items held, kept on the row so a list does not count rows per library. */
	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public itemCount!: number;
}
