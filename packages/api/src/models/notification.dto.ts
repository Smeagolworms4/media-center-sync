import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
	ArrayUnique,
	IsBoolean,
	IsEnum,
	IsNotEmpty,
	IsObject,
	IsOptional,
	IsString,
	MaxLength,
} from 'class-validator';
import { NotificationChannelType, NotificationEvent } from '@mcs/shared';

/**
 * Adding a channel.
 *
 * `config` is validated as "an object" and no further, which looks lax and is the
 * whole design: what an ntfy channel requires and what an SMTP one requires have
 * nothing in common, and a DTO that knew both would have to grow a branch for every
 * channel type ever added — in the layer that is supposed to be the one place a new
 * channel does not touch. The handler refuses its own settings and names the field,
 * because it is the only thing that knows what it needs.
 */
export class CreateNotificationChannelDto {
	@ApiProperty({ enum: NotificationChannelType })
	@IsEnum(NotificationChannelType)
	public type!: NotificationChannelType;

	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	public name!: string;

	@ApiPropertyOptional({ description: 'On by default.' })
	@IsOptional()
	@IsBoolean()
	public enabled?: boolean;

	/**
	 * Which events go out here. Empty, or absent, means every event.
	 *
	 * `ArrayUnique` rather than a silent deduplication: a list with the same event
	 * twice is a form that misbehaved, and accepting it would send two notifications
	 * for one thing on that channel and nowhere else — a difference nobody would ever
	 * trace back to a duplicated checkbox.
	 */
	@ApiPropertyOptional({ enum: NotificationEvent, isArray: true })
	@IsOptional()
	@IsEnum(NotificationEvent, { each: true })
	@ArrayUnique()
	public events?: NotificationEvent[];

	@ApiProperty({ description: 'Shaped by the type. The handler refuses what it cannot use.' })
	@IsObject()
	public config!: Record<string, unknown>;
}

/** A field that is not sent is not changed, secrets included. */
export class UpdateNotificationChannelDto extends CreateNotificationChannelDto {
	@ApiPropertyOptional({ enum: NotificationChannelType })
	@IsOptional()
	@IsEnum(NotificationChannelType)
	public declare type: NotificationChannelType;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	public declare name: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsObject()
	public declare config: Record<string, unknown>;
}
