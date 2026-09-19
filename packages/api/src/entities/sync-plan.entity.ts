import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { SyncFilter, SyncScope } from '@mcs/shared';
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

	/**
	 * What this plan covers, stated rather than implied.
	 *
	 * A column of its own rather than a subtree identifier, because "synchronise" on
	 * its own honestly reads as "move an entire media library" and that is measured in
	 * terabytes. An empty object is deliberately not "everything is fine": it is the
	 * unbounded case, which needs acknowledging before the plan can be enabled.
	 */
	@ApiProperty()
	@Column({ type: 'simple-json', default: '{}' })
	public scope!: SyncScope;

	@ApiProperty()
	@Column({ type: 'simple-json', default: '{}' })
	public filter!: SyncFilter;

	/**
	 * A ceiling on one run, so a schedule cannot run away.
	 *
	 * Null means no ceiling. That is a choice somebody has to make rather than the
	 * default reading of an empty field, which is why the form asks for it.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public maxItemsPerRun!: number | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'bigint', nullable: true })
	public maxBytesPerRun!: number | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastRunAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public nextRunAt!: Date | null;
}
