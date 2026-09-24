import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PlacedBy, TransferErrorKind, TransferState } from '@mcs/shared';
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

	/**
	 * The library that path belongs to, when it belongs to one.
	 *
	 * Null for a fallback folder outside every registered library, which is precisely
	 * the case worth showing somebody. Stored rather than derived from the path: two
	 * libraries can nest, a library's path can be corrected afterwards, and a screen
	 * that had to guess would name the wrong one on exactly the gateways this matters
	 * on.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public targetLibraryId!: string | null;

	/**
	 * Which step of the placement rule chose that path.
	 *
	 * The whole point of the column: three of the seven steps mean nobody chose, and
	 * without this there is nothing anywhere that can tell them from the four that did.
	 * The transfer succeeds either way, so no error, no state and no log would ever
	 * mention it — the library simply grows a folder somebody did not plan.
	 *
	 * Null on rows written before this existed. Readers treat that as "not known"
	 * rather than as "fine", which is why it is nullable instead of defaulted.
	 */
	@ApiProperty({ enum: PlacedBy, nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public placedBy!: PlacedBy | null;

	/**
	 * The thing somebody pressed download on, which this file is one part of.
	 *
	 * A film, a series, a season or an episode — the subtree root the item was reached
	 * through when the run was planned. The planner has always decided it, in order to
	 * pin every file of one lot under the same root, but the decision only lived as long
	 * as the plan did: nothing stored it, so everything downstream had to group on
	 * `jobId` instead, and that is a different question. A season pulled over three
	 * nights is one lot and three runs, and grouping on the run showed it as three
	 * unrelated blocks going to the same folder; a run that named three shows is one run
	 * and three lots, and grouping on the run fused them into a block nothing could take
	 * apart.
	 *
	 * Not derived on read, either. The lot is a property of the scope the run was
	 * started with, and walking the parent chain again months later would answer
	 * differently the moment somebody corrects an episode into another season — the
	 * files on the disk would not have moved, and the block on screen would split.
	 *
	 * Null on rows written before this existed, and never back-filled for that same
	 * reason. A reader must take null to mean "this transfer is its own lot"; a shared
	 * null would collapse the whole history of a gateway into one enormous download,
	 * which is why the column is nullable rather than defaulted to the empty string.
	 *
	 * Indexed because it is what the move reads by: redirecting a lot has to find every
	 * file of it, including the ones an earlier run already landed, and without an index
	 * that is a scan of every transfer the gateway has ever run.
	 */
	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public lot!: string | null;

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
