import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Timestampable } from './timestampable.entity';

/**
 * A one-shot invitation to link.
 *
 * It expires and it burns on use. An invitation that never expired would be a
 * credential left lying around in a chat log, and whoever found it would be a
 * friend as far as the gateway is concerned.
 */
@Entity('peer_invites')
export class PeerInvite extends Timestampable {
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@Index({ unique: true })
	@Column()
	public code!: string;

	/** Hash of the shared secret; the secret itself only exists in the invite URL. */
	@Column()
	public secretHash!: string;

	@Column({ type: 'datetime' })
	public expiresAt!: Date;

	@Column({ type: 'datetime', nullable: true })
	public usedAt!: Date | null;

	@Column({ type: 'uuid', nullable: true })
	public peerId!: string | null;
}
