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

	/**
	 * Agreement to relay a library that is not ours.
	 *
	 * Stored rather than inferred, because it is consent and not a property: whether a
	 * library sits on a remote service is a fact we can read at any moment, whether
	 * somebody agreed to pass it on is not. Without it, a remote library stays private
	 * however its visibility is set — which is the safe half of the choice, and the
	 * only acceptable default for something that spends our bandwidth and re-shares an
	 * access granted to us rather than to our friends.
	 */
	@ApiProperty()
	@Column({ default: false })
	public relay!: boolean;

	/** Bytes per second this library will serve. 0 means no cap. */
	@ApiProperty()
	@Column({ type: 'bigint', default: 0 })
	public rateLimit!: number;
}
