import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MediaLandingState } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * A file the gateway has put in a library folder, before any media server knows.
 *
 * The row exists because of a gap nothing else covers. Between the moment a transfer
 * finishes moving bytes into the destination folder and the moment the media server
 * has indexed them, the gateway knows something no other party does — this media is on
 * this disk, at this path. Nothing was written down, so every screen went on reading
 * the media as `missing`, which is how the same episode gets pulled twice.
 *
 * **It is persisted and not held in memory**, and that is the whole point of a table
 * rather than a `Map`. The gap is measured in minutes normally and in hours when a
 * server only scans on a schedule; restarting the container is an ordinary thing to do
 * in that window, and an in-memory record would evaporate and put the interface back to
 * offering a download of a file that is already there — the exact bug, returned, and
 * now only reproducible by restarting.
 *
 * The row is deleted the moment a scan of ours finds a real item for the file. What it
 * is *not* is a permanent annotation: see `MediaLandingState` and `LandingManager` for
 * the bounded life of one that is never indexed.
 */
@Entity('media_landings')
export class MediaLanding extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	/**
	 * The item the bytes were pulled from — a copy on somebody else's server.
	 *
	 * This is the row every screen is already looking at when it says `missing`: the
	 * media is known because a remote service reported it, and we hold nothing. So the
	 * landing is keyed on it, and the state it produces lands on exactly the poster
	 * somebody was about to press download on.
	 *
	 * Unique, because a second pull of the same source replaces the first rather than
	 * queueing behind it — two rows would mean two answers to "is this indexed yet".
	 */
	@ApiProperty()
	@Index({ unique: true })
	@Column({ type: 'uuid' })
	public itemId!: string;

	/** The transfer that put it there, kept so the row can explain where it came from. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'uuid', nullable: true })
	public transferId!: string | null;

	/**
	 * The destination library, when the file landed in one.
	 *
	 * Null for the fallback folder outside every registered library, and that is a
	 * meaningful null rather than missing data: such a file will never be indexed by
	 * anybody, so the landing is expected to go stale and saying so is the useful
	 * answer.
	 */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public libraryId!: string | null;

	/** Absolute path as the gateway sees it, which is the path the move actually wrote. */
	@ApiProperty()
	@Column()
	public path!: string;

	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public bytes!: number;

	/**
	 * The swarm identity of those bytes, when the transfer knew one.
	 *
	 * The second way a landing is recognised after a scan, and the one that survives the
	 * first being wrong: a media server that renames or re-containers a file on import
	 * leaves nothing at the path we wrote, and matching on the path alone would strand
	 * the row until it went stale. Our own scan computes this value off the bytes, so it
	 * is the same number on either side of the rename.
	 */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public contentId!: string | null;

	@ApiProperty({ enum: MediaLandingState })
	@Index()
	@Column({ type: 'varchar', default: MediaLandingState.WAITING })
	public state!: MediaLandingState;

	/**
	 * When patience runs out and the row becomes a reported problem.
	 *
	 * Stored rather than derived from `createdAt` plus a constant so that the deadline a
	 * row was given survives a change to that constant. A gateway that had waited eleven
	 * hours must not be sent back to the start of a twelve-hour clock because somebody
	 * shortened it, nor declared stale retroactively because somebody lengthened it.
	 */
	@ApiProperty()
	@Column({ type: 'datetime' })
	public expiresAt!: Date;

	/** What we asked the media server to do about it, for the log and for the tests. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public rescanOutcome!: string | null;
}
