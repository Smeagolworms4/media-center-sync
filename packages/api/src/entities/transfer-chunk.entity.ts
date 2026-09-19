import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ChunkState } from '@mcs/shared';

/**
 * One piece of one transfer.
 *
 * Rows rather than a bitmap, because a piece carries more than done-or-not: which
 * source served it, how many times it was retried, what hash it should have. That
 * is what turns a failure into a repair of two megabytes instead of a restart.
 *
 * No timestamps: there is one row per piece and a season can be thousands, so the
 * two extra columns would cost more than they ever tell anyone.
 */
@Entity('transfer_chunks')
@Index(['transferId', 'index'], { unique: true })
export class TransferChunk {
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@Index()
	@Column({ type: 'uuid' })
	public transferId!: string;

	@Column({ type: 'int' })
	public index!: number;

	@Column({ type: 'bigint' })
	public start!: number;

	@Column({ type: 'bigint' })
	public end!: number;

	@Column({ type: 'varchar', default: ChunkState.PENDING })
	public state!: ChunkState;

	@Column({ type: 'bigint', default: 0 })
	public bytesDone!: number;

	@Column({ type: 'uuid', nullable: true })
	public sourceServiceId!: string | null;

	@Column({ type: 'int', default: 0 })
	public attempts!: number;

	/** Expected hash, when the source could tell us one. */
	@Column({ type: 'varchar', nullable: true })
	public checksum!: string | null;
}
