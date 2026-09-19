import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PeerDirection, PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * Another gateway, run by somebody else.
 *
 * The identity is the public key fingerprint, never the address: a friend behind a
 * dynamic IP is the same friend tomorrow. The rendezvous introduces the two ends by
 * fingerprint, and the address is only remembered as a hint for the next direct
 * attempt.
 */
@Entity('peers')
export class Peer extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Column()
	public name!: string;

	@ApiProperty()
	@Index({ unique: true })
	@Column()
	public fingerprint!: string;

	/**
	 * Their node identifier, learned when the link was established.
	 *
	 * It is what lets an announcement be recognised as one we have already seen, so a
	 * catalogue travelling through a friend of a friend does not come back to us and
	 * start a conversation with itself.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public nodeId!: string | null;

	@Exclude()
	@Column({ type: 'text', nullable: true, select: false })
	public publicKey!: string | null;

	@ApiProperty({ enum: PeerStatus })
	@Column({ type: 'varchar', default: PeerStatus.PENDING })
	public status!: PeerStatus;

	/**
	 * Who asked, while the link is pending.
	 *
	 * It is the difference between a request waiting on somebody else and one waiting
	 * on you, and rendering both the same way is how an incoming request sits
	 * unanswered for a week. Null once the link is settled, because it stops meaning
	 * anything then.
	 */
	@ApiProperty({ enum: PeerDirection, nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public direction!: PeerDirection | null;

	@ApiProperty({ enum: PeerTrust })
	@Column({ type: 'varchar', default: PeerTrust.FRIEND })
	public trust!: PeerTrust;

	@ApiProperty({ enum: PeerLinkMode, nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public linkMode!: PeerLinkMode | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public address!: string | null;

	/** The friend who introduced them, for a friend of a friend. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'uuid', nullable: true })
	public viaPeerId!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastSeenAt!: Date | null;
}
