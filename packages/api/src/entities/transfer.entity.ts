import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TransferErrorKind, TransferState } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * One file on its way here.
 *
 * The row is the truth about progress, not the cache: a gateway restarted mid-pull
 * has to know which pieces it already holds, and a queue rebuilt from memory would
 * restart a forty-gigabyte season from zero. The cache only carries what is cheap
 * to lose — instant rates, which worker holds which piece.
 */
@Entity('transfers')
export class Transfer extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public jobId!: string | null;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public itemId!: string;

	/** Swarm identifier: peers advertise what they hold by this value. */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public contentId!: string | null;

	@ApiProperty()
	@Column()
	public title!: string;

	@ApiProperty({ enum: TransferState })
	@Index()
	@Column({ type: 'varchar', default: TransferState.QUEUED })
	public state!: TransferState;

	/** Where it will land once complete. Held from the start so the plan is auditable. */
	@ApiProperty()
	@Column()
	public targetPath!: string;

	/** Where the pieces accumulate until verification passes. */
	@ApiProperty()
	@Column()
	public workPath!: string;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytesTotal!: number;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytesDone!: number;

	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public chunkSize!: number;

	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public chunksTotal!: number;

	/** Pieces re-fetched across every repair pass. A rising count means a bad source. */
	@ApiProperty()
	@Column({ type: 'int', default: 0 })
	public chunksRepaired!: number;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public error!: string | null;

	@ApiProperty({ enum: TransferErrorKind, nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public errorKind!: TransferErrorKind | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastVerifiedAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public startedAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public finishedAt!: Date | null;
}
