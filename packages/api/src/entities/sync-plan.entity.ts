import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { SyncFilter } from '@mcs/shared';
import { SyncTrigger } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * A standing intent: what to pull, from where, to where.
 *
 * `sourceServiceIds` is ordered and may be empty. Empty means "follow the priority
 * set in the administration screen", which is what most people want and what the
 * interface shows as the default order — pinning the list into every plan would
 * mean editing them all the day a friend's server moves.
 */
@Entity('sync_plans')
export class SyncPlan extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Column()
	public name!: string;

	@ApiProperty()
	@Column({ default: true })
	public enabled!: boolean;

	@ApiProperty({ enum: SyncTrigger })
	@Column({ type: 'varchar', default: SyncTrigger.MANUAL })
	public trigger!: SyncTrigger;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public schedule!: string | null;

	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public sourceServiceIds!: string[];

	/** Empty means: beside our own copy, or into the default library for the kind. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'uuid', nullable: true })
	public targetLibraryId!: string | null;

	/** Restrict to a subtree — one series, one collection. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'uuid', nullable: true })
	public rootItemId!: string | null;

	@ApiProperty()
	@Column({ type: 'simple-json', default: '{}' })
	public filter!: SyncFilter;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastRunAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public nextRunAt!: Date | null;
}
