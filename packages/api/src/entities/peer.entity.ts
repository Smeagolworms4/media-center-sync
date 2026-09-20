import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PeerDirection, PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * Another gateway, run by somebody else.
 *
 * The identity is the public key fingerprint, never the address: a friend behind a
 * dynamic IP is the same friend tomorrow. A friend both ends already have is what
 * introduces them, and the address is only remembered as a hint for the next direct
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

	/**
	 * The protocol version agreed with them, and what they said they can do.
	 *
	 * Stored rather than recomputed because it answers a question asked between
	 * conversations: whether a peer can be offered a feature at all. Null until a
	 * handshake has happened — an invited peer that has never answered has no version,
	 * which is not the same as speaking version zero.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public protocol!: number | null;

	/** Named features they advertised. Empty means the floor of their version. */
	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public capabilities!: string[];

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

	/**
	 * How many introductions away they are. 1 is somebody we linked to ourselves.
	 *
	 * Stored rather than walked from `viaPeerId` on demand, because the chain can be
	 * cut: removing a middle friend leaves the peers they introduced, and a walk would
	 * then report them as unreachable or as direct friends depending on which way the
	 * code happened to fail. The distance was true when they arrived and stays the
	 * record of how they arrived.
	 */
	@ApiProperty()
	@Column({ type: 'int', default: 1 })
	public depth!: number;

	/**
	 * How far introductions coming through this peer may travel, or null to follow
	 * the gateway's own ceiling.
	 *
	 * Per peer because the circles behind two friends are not comparable: one runs a
	 * gateway for a household, the other for a club of forty. Raising the reach for
	 * the first is harmless, and doing it for the second by raising one global number
	 * is how a friends-and-family index quietly becomes a public one.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'int', nullable: true })
	public maxDepth!: number | null;

	/**
	 * They stay a peer, the link stays open, and they are served nothing of ours.
	 *
	 * On the peer row rather than in the share policies because it is a statement
	 * about the person and not about a library: `SharePolicy.deniedPeerIds` is per
	 * library, so cutting somebody off with it meant editing every policy — and
	 * missing the one written next week. Honoured in exactly one place,
	 * `ShareManager.visiblePolicies`, which every peer-facing route already reads.
	 *
	 * It does not close the socket, and that is the correction it exists to make.
	 * The status it replaces did, which cut both directions at once: punishing
	 * somebody also took away our own access to their library.
	 */
	@ApiProperty()
	@Column({ type: 'boolean', default: false })
	public readingForbidden!: boolean;

	/**
	 * Met through an introduction, and not being kept.
	 *
	 * A column rather than a flag held in memory, because the thing that has to survive
	 * is the *undoing*: the row is deleted when the link closes, and a gateway killed
	 * mid-transfer would otherwise come back with a peer nobody invited, dialled at
	 * every restart, with nothing anywhere able to say where it came from.
	 * `PeerManager` sweeps these at boot for exactly that reason.
	 *
	 * False for everything that existed before this column, which is correct: every one
	 * of those rows was invited, accepted or introduced back when an introduction meant
	 * a permanent peer.
	 */
	@ApiProperty()
	@Column({ type: 'boolean', default: false })
	public discovered!: boolean;

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
