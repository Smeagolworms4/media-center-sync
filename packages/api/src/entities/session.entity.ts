import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Timestampable } from './timestampable.entity';
import { User } from './user.entity';

/**
 * A live session, one row per refresh token.
 *
 * The access token is short and checked against this table on every call. Keeping
 * sessions in the database is what makes signing out immediate: a stateless JWT
 * would stay valid until it expired, whatever the user pressed.
 */
@Entity('sessions')
export class Session extends Timestampable {
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
	public user!: User;

	@Index()
	@Column()
	public userId!: string;

	/** Hash of the refresh token. The token itself is only ever held by the client. */
	@Index({ unique: true })
	@Column()
	public refreshTokenHash!: string;

	@Column({ type: 'datetime' })
	public expiresAt!: Date;

	@Column({ type: 'varchar', nullable: true })
	public userAgent!: string | null;

	@Column({ type: 'varchar', nullable: true })
	public address!: string | null;

	@Column({ type: 'datetime', nullable: true })
	public revokedAt!: Date | null;
}
