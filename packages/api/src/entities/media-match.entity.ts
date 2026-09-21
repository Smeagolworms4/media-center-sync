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

	/**
	 * The near side of the pair: the item the correlation pass happened to be walking.
	 *
	 * Not "the copy we hold", however much the name reads that way, and the difference
	 * is worth a paragraph because the name has already cost somebody a diagnosis. A
	 * pass runs over whichever service was just scanned, ours or a friend's alike, so
	 * two copies sitting on two foreign servers produce a row whose `localItemId` is on
	 * one of those foreign servers. Twenty-eight of the owner's hundred and twenty-eight
	 * rows are exactly that, pairing one friend's Jellyfin with another's Plex and
	 * nothing of ours. Read as "ours", the column makes two posters for one film look
	 * like correlation refusing to relate remote copies to each other, which it has
	 * never refused to do — the veto in `MatchingService._separateCuts` is what splits
	 * such a pair, and that is where to look.
	 *
	 * Nullable because `confirmMatch` lets a person detach the near side of a pair they
	 * are re-pointing. Correlation itself never writes null, so a null row is a human's
	 * doing; every reader that joins on the column — `findAppliedPairs`, `MatchGraph`
	 * through it, `SyncManager._counterparts` — already guards for it.
	 */
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
