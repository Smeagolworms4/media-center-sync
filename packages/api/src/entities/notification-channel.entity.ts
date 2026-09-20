import { ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { NotificationChannelType, type NotificationEvent } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * One way of telling somebody something happened while they were not looking.
 *
 * A row rather than a setting, and that is the point: a household has a phone topic
 * and a shared mailbox, two people want different events, and one of them turns
 * theirs off for a week. None of that fits a key/value setting, and all of it is
 * ordinary.
 */
@Entity('notification_channels')
export class NotificationChannel extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ApiProperty({ enum: NotificationChannelType })
	@Column({ type: 'varchar' })
	public type!: NotificationChannelType;

	@ApiProperty()
	@Column()
	public name!: string;

	@ApiProperty()
	@Column({ default: true })
	public enabled!: boolean;

	/** Which events go out here. Empty means every event, as the contract says. */
	@ApiProperty({ type: [String] })
	@Column({ type: 'simple-json', default: '[]' })
	public events!: NotificationEvent[];

	/**
	 * The channel's own settings, shaped by its type and opaque to everything here.
	 *
	 * Never returned as it is stored: it holds an ntfy token or a mailbox password,
	 * and a credential that leaves through a list endpoint is one somebody else now
	 * has, with nothing in the response saying so. The handler strips its own secrets
	 * on the way out — it is the only thing that knows which keys are credentials —
	 * and `@Exclude()` here is the second net, for the day somebody returns an entity
	 * directly rather than through a mapper.
	 *
	 * `select: false`, as `MediaService.token` uses, was rejected on purpose: the
	 * other half of `config` is the host, the port and the topic, and those are what
	 * the edit form prefills. A form that cannot show the URL is a form people retype
	 * the whole channel into, secret included, every time they rename it.
	 */
	@Exclude()
	@Column({ type: 'simple-json', default: '{}' })
	public config!: Record<string, unknown>;

	/**
	 * What the last attempt said when it failed, in the far end's own words.
	 *
	 * Kept as prose rather than as one of our keys because no key could carry
	 * "invalid access token" or "550 sender not allowed", and those sentences are the
	 * whole diagnosis. Cleared on the first send that works, so a channel showing an
	 * error is one that is failing now and not one that failed in March.
	 */
	@ApiProperty({ nullable: true })
	@Column({ type: 'varchar', length: 1024, nullable: true })
	public lastError!: string | null;

	/** Null until something has actually been delivered here — never on creation. */
	@ApiProperty({ nullable: true })
	@Column({ type: 'datetime', nullable: true })
	public lastSentAt!: Date | null;
}
