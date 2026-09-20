import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MediaKind, PlacedBy, SyncJobItemState } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * One line of a run, so a job can be opened rather than only watched.
 *
 * A job that reports "412 of 900" and nothing else is a number, not something anybody
 * can act on: the two questions people actually have are which item is stuck and where
 * it is being written, and a total answers neither. The lines are written when the run
 * is planned — before the first transfer exists — so a run that fails on its third
 * item still says what the other 897 were going to be.
 *
 * They duplicate what the transfer rows hold, on purpose. A transfer is deleted when
 * its history is pruned and never exists at all for an item a ceiling dropped, and a
 * job detail assembled by joining transfers would lose exactly the lines somebody
 * opens the page to understand.
 */
@Entity('sync_job_items')
export class SyncJobItem extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Index()
	@Column({ type: 'varchar' })
	public jobId!: string;

	/**
	 * The order the plan put them in, and the order they are served in.
	 *
	 * Stored rather than derived from the timestamps: five hundred rows are inserted
	 * inside the same second, and a page ordered on `createdAt` would shuffle between
	 * two reads — which, on a paginated list, silently drops and repeats lines.
	 */
	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public position!: number;

	@ApiProperty()
	@Column({ type: 'varchar' })
	public itemId!: string;

	@ApiProperty()
	@Column({ type: 'varchar' })
	public title!: string;

	@ApiProperty({ enum: MediaKind })
	@Column({ type: 'varchar' })
	public kind!: MediaKind;

	@ApiProperty()
	@Column({ type: 'varchar' })
	public sourceServiceId!: string;

	/** Copied, because the service may be unregistered before anybody reads the run. */
	@ApiProperty()
	@Column({ type: 'varchar', default: '' })
	public sourceServiceName!: string;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public targetLibraryId!: string | null;

	@ApiProperty()
	@Column({ type: 'varchar' })
	public targetPath!: string;

	/**
	 * Which step of the placement rule chose that path, as the plan decided it.
	 *
	 * On the line as well as on the transfer because the two outlive each other: a
	 * transfer is pruned with its history and never exists at all for an item a ceiling
	 * dropped, and a run opened next month would otherwise have no way of saying where
	 * its files went or why.
	 */
	@ApiProperty({ enum: PlacedBy, nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public placedBy!: PlacedBy | null;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytes!: number;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytesDone!: number;

	@ApiProperty({ enum: SyncJobItemState })
	@Index()
	@Column({ type: 'varchar', default: SyncJobItemState.PENDING })
	public state!: SyncJobItemState;

	/**
	 * The transfer moving it, when one is running.
	 *
	 * This is what makes a progress bar openable: the line names the transfer, and the
	 * transfer is where the bytes, the sources and the chunk map live.
	 */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public transferId!: string | null;

	/** An `ErrorKey`, never a sentence. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public error!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public startedAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public finishedAt!: Date | null;
}
