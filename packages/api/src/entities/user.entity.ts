import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { UserRole } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * An account that can sign in to the gateway.
 *
 * Most accounts are not ours: they are mirrors of a Jellyfin or Plex user, created
 * the first time that person signs in through the service. `passwordHash` is then
 * null, and stays null — the gateway never holds a password it did not issue.
 */
@Entity('users')
@Index(['provider', 'providerUserId'], { unique: true, where: '"providerUserId" IS NOT NULL' })
export class User extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty()
	@Column({ unique: true })
	public username!: string;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public displayName!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public email!: string | null;

	@ApiProperty({ enum: UserRole })
	@Column({ type: 'varchar', default: UserRole.USER })
	public role!: UserRole;

	/** `internal`, or `service:<uuid>` when a media service authenticated them. */
	@ApiProperty()
	@Column({ default: 'internal' })
	public provider!: string;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public providerUserId!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', nullable: true })
	public avatarUrl!: string | null;

	/**
	 * Excluded from every response.
	 *
	 * Without the serialisation interceptor this hash goes out in the sign-in
	 * response, which is how it usually happens: nothing fails, nothing is logged,
	 * and it is simply there in the payload.
	 */
	@Exclude()
	@Column({ type: 'varchar', nullable: true, select: false })
	public passwordHash!: string | null;

	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastSeenAt!: Date | null;
}
