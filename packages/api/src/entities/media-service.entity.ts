import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MediaServiceScope, MediaServiceStatus, MediaServiceType } from '@mcs/shared';
import { Peer } from './peer.entity';
import { Timestampable } from './timestampable.entity';

/**
 * A registered media service.
 *
 * There is no distinguished "our server": a gateway holds a list of services, some
 * local — whose libraries it can write into — and some remote. Syncs are triggered
 * between any two of them, which is why nothing here says which one is the target.
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

	@ApiProperty({ enum: MediaServiceScope })
	@Column({ type: 'varchar' })
	public scope!: MediaServiceScope;

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
