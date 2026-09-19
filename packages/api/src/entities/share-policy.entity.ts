import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ShareVisibility } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * What one library exposes to peers.
 *
 * Per library rather than per service: somebody may want their series visible and
 * their home videos not, and both live on the same Jellyfin. The absence of a row
 * means private — a library is never shared by having been forgotten.
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
