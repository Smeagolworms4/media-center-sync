import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ShareVisibility } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * What one library exposes to peers.
 *
 * Per library rather than per service: somebody may want their series visible and
 * their home videos not, and both live on the same Jellyfin.
 *
 * A row here is an **override**, and only libraries somebody has decided about have
 * one. What a library with no row exposes is resolved at read time by
 * `effectiveVisibility` — the gateway default when the service's sharing switch is on,
 * private when it is off. Nothing backfills these rows when a scan finds a library, on
 * purpose: a row written by the software would freeze today's default into the library
 * for good and be indistinguishable from a decision somebody made.
 */
@Entity('share_policies')
export class SharePolicy extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Index({ unique: true })
	@Column({ type: 'uuid' })
	public libraryId!: string;

	@ApiProperty({ enum: ShareVisibility })
	@Column({ type: 'varchar', default: ShareVisibility.PRIVATE })
	public visibility!: ShareVisibility;

	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public allowedPeerIds!: string[];

	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public deniedPeerIds!: string[];

	/** Bytes per second this library will serve. 0 means no cap. */
	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public rateLimit!: number;
}
