import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SyncJobState, SyncTrigger } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * One execution.
 *
 * A plan has many; a one-off sync has a job with no plan behind it. Counters are
 * kept on the row and updated as transfers finish, so reopening the page after two
 * hours shows where a run got to without walking every transfer it spawned.
 */
@Entity('sync_jobs')
export class SyncJob extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public planId!: string | null;

	@ApiProperty({ enum: SyncJobState })
	@Index()
	@Column({ type: 'varchar', default: SyncJobState.PENDING })
	public state!: SyncJobState;

	@ApiProperty({ enum: SyncTrigger })
	@Column({ type: 'varchar', default: SyncTrigger.MANUAL })
	public trigger!: SyncTrigger;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public startedAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public finishedAt!: Date | null;

	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public itemsPlanned!: number;

	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public itemsDone!: number;

	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public itemsFailed!: number;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytesPlanned!: number;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytesDone!: number;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public error!: string | null;
}
