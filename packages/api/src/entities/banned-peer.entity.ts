import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Timestampable } from './timestampable.entity';

/**
 * A fingerprint this gateway refuses, whether or not a peer row exists for it.
 *
 * It is a separate table on purpose, and the reason is a defect this fixes: removing
 * a peer used to be the *weaker* of the two ejection actions. Blocking set a status
 * on a row we kept, so it held; removing deleted the row, and with it the only thing
 * that had been refusing them — the next request from the same key arrived as a fresh
 * introduction to accept. Somebody ejecting a peer means to be rid of them, not to
 * reset the relationship.
 *
 * Keyed by fingerprint rather than by peer, because that is the part that survives. A
 * name is a label we chose, an address changes, and a node identifier is
 * self-declared; the fingerprint is the identity, and it is what an incoming request
 * presents before anything else about it is known.
 */
@Entity('banned_peers')
export class BannedPeer extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Index({ unique: true })
	@Column()
	public fingerprint!: string;

	/**
	 * What they were called here when the ban was recorded.
	 *
	 * Kept because the peer row is gone: without it this screen is a list of hex
	 * strings, and nobody can tell which one was the person who had to go. It is a
	 * record of what we called them, never used to match anything.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public name!: string | null;

	/** Why, for whoever reads this list a year from now. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', length: 500, nullable: true })
	public reason!: string | null;
}
