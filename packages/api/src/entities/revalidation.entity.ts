import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { MediaFileInfo } from '@mcs/shared';
import { RevalidationAction, RevalidationOutcome, TransferErrorKind } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * The record of asking the far end to check itself.
 *
 * Kept rather than resolved in memory because it is the only trace of why a
 * transfer changed its mind: a source dropped, a path followed, a version
 * abandoned. Without it the queue shows a result nobody can account for.
 */
@Entity('revalidations')
export class Revalidation extends Timestampable {
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@Index()
	@Column({ type: 'uuid' })
	public transferId!: string;

	@Column({ type: 'uuid' })
	public sourceServiceId!: string;

	@Column({ type: 'varchar' })
	public cause!: TransferErrorKind;

	@Column({ type: 'datetime' })
	public requestedAt!: Date;

	@Column({ type: 'datetime', nullable: true })
	public answeredAt!: Date | null;

	@Column({ type: 'varchar', nullable: true })
	public outcome!: RevalidationOutcome | null;

	@Column({ type: 'simple-json', nullable: true })
	public remoteFile!: MediaFileInfo | null;

	@Column({ type: 'varchar', nullable: true })
	public action!: RevalidationAction | null;

	@Column({ type: 'varchar', nullable: true })
	public note!: string | null;
}
