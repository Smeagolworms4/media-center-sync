import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MediaServiceStatus, MediaServiceType, type RootMapping } from '@mcs/shared';
import { Peer } from './peer.entity';
import { Timestampable } from './timestampable.entity';

/**
 * A registered media service.
 *
 * There is no distinguished "our server": a gateway holds a list of services, some
 * whose libraries it can write into and some it only reads over HTTP. Syncs are
 * triggered between any two of them, which is why nothing here says which one is the
 * target.
 *
 * Two separate questions used to share one `scope` column, and that is the mistake
 * this row is shaped to prevent: whether we share it is a decision (`shared`) and
 * whether we hold its files is a fact (`filesMounted`). One field answering both made
 * every answer to one of them wrong.
 */
@Entity('media_services')
@Index(['baseUrl', 'peerId'], { unique: true })
export class MediaService extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Column()
	public name!: string;

	@ApiProperty({ enum: MediaServiceType })
	@Column({ type: 'varchar' })
	public type!: MediaServiceType;

	/**
	 * Whether this service's libraries are offered to peers.
	 *
	 * Declared, and the only declared half of what used to be one overloaded `scope`
	 * column. It carries no level of its own: on means `defaultShareVisibility`
	 * applies to the libraries nobody has overridden, off means private.
	 *
	 * Defaulted true at the column so that a row written by a path that forgot the
	 * field shares rather than hides — the same reasoning as the setting shipping as a
	 * real level. Linking a peer overrides it to false on purpose.
	 */
	@ApiProperty()
	@Column({ default: true })
	public shared!: boolean;

	/**
	 * Whether this gateway reaches this service's files on disk.
	 *
	 * Derived and stored, never typed. Derived because asking produced the wrong
	 * answer every time: the question reads as a statement about the network and the
	 * consequences — no destination, no placement — surface screens later. Stored
	 * because `serviceMode` is pure and synchronous and read on hot paths; making it
	 * probe the filesystem would make every caller async and every list a burst of
	 * `stat` calls.
	 *
	 * It is a statement about a **mapping being declared**, not about a disk being up
	 * right now. A NAS that goes offline must not silently stop being ours: the
	 * library check exists to report a path that cannot be reached, and it can only do
	 * that for services it still counts as ours.
	 *
	 * Written by `LibraryManager.refreshMount`, which every path that can move the
	 * answer calls — registering, probing, setting the root mappings, and setting
	 * or clearing a library's own path.
	 */
	@ApiProperty()
	@Column({ default: false })
	public filesMounted!: boolean;

	@ApiProperty()
	@Column()
	public baseUrl!: string;

	/**
	 * Never returned. A token that leaks through a list endpoint is a token that
	 * opens somebody's whole library, and nothing in the response would say so.
	 */
	@Exclude()
	@Column({ type: 'varchar', nullable: true, select: false })
	public token!: string | null;

	@Exclude()
	@Column({ type: 'varchar', nullable: true, select: false })
	public username!: string | null;

	@Exclude()
	@Column({ type: 'varchar', nullable: true, select: false })
	public password!: string | null;

	@ApiProperty({ enum: MediaServiceStatus })
	@Column({ type: 'varchar', default: MediaServiceStatus.UNKNOWN })
	public status!: MediaServiceStatus;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public version!: string | null;

	/**
	 * Where this service's disks are, as this gateway reaches them.
	 *
	 * Stated once per disk so that every library under the service derives its own
	 * local path, instead of six libraries being six paths to type and six chances to
	 * get one wrong. A library's explicit `localPath` still wins: that field exists for
	 * the exceptions no mapping can express. See `MediaService.rootMappings` in the
	 * shared contract for why this is a list.
	 *
	 * `simple-json` in a `text` column, because that is the only structured shape
	 * both engines store the same way, and one list replaces the two scalar columns it
	 * grew from rather than sitting beside them: two ways of saying where the files are
	 * is how the two would come to disagree.
	 */
	@ApiProperty({
		type: 'array',
		items: {
			type: 'object',
			properties: { remoteRoot: { type: 'string' }, localRoot: { type: 'string' } },
		},
	})
	@Column({ type: 'simple-json', default: '[]' })
	public rootMappings!: RootMapping[];

	/** Set when this service also authenticates users of the gateway. */
	@ApiProperty()
	@Column({ default: false })
	public authProvider!: boolean;

	/** Consulted lowest first when the same media is available from several. */
	@ApiProperty()
	@Column({ type: 'int', default: 100 })
	public priority!: number;

	@ManyToOne(() => Peer, { onDelete: 'CASCADE', nullable: true })
	public peer!: Peer | null;

	@ApiProperty({ nullable: true })
	@Index()
	@Column({ type: 'uuid', nullable: true })
	public peerId!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastProbeAt!: Date | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastScanAt!: Date | null;
}
