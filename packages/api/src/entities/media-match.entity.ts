import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MatchStrategy, SyncState } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * The claim that two items are the same media.
 *
 * Kept as its own row, with the strategy and the score that produced it, so that a
 * wrong match can be explained and undone. A correlation that only exists as a
 * field on one side is one you cannot audit: you see the result, never the reason.
 */
@Entity('media_matches')
@Index(['localItemId', 'remoteItemId'], { unique: true })
export class MediaMatch extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	/** Null when the media is only known remotely — that is what `MISSING` means. */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public localItemId!: string | null;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public remoteItemId!: string;

	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public remoteServiceId!: string;

	@ApiProperty({ nullable: true })
	@Column({ type: 'uuid', nullable: true })
	public remotePeerId!: string | null;

	@ApiProperty({ enum: MatchStrategy })
	@Column({ type: 'varchar' })
	public strategy!: MatchStrategy;

	/** 0 to 1. Below the configured threshold the match is proposed, not applied. */
	@ApiProperty()
	@Column({ type: 'float', default: 0 })
	public confidence!: number;

	@ApiProperty({ enum: SyncState })
	@Column({ type: 'varchar', default: SyncState.UNKNOWN })
	public state!: SyncState;

	/** Why the remote version wins, when it does — resolution, codec, size. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public reason!: string | null;

	/** Set when a human accepted a match the score alone would not have applied. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public confirmedAt!: Date | null;
}
