import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUUID,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';
import { MediaKind, SyncTrigger } from '@mcs/shared';

export class SyncFilterDto {
	@ApiPropertyOptional({ enum: MediaKind, isArray: true })
	@IsOptional()
	@IsArray()
	@IsEnum(MediaKind, { each: true })
	public kinds?: MediaKind[];

	@ApiPropertyOptional({ description: 'Never replace an existing local file.' })
	@IsOptional()
	@IsBoolean()
	public missingOnly?: boolean;

	@ApiPropertyOptional({ description: 'Also replace a local file when the remote one is better.' })
	@IsOptional()
	@IsBoolean()
	public replaceOutdated?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsInt()
	public minYear?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@IsInt()
	@Min(0)
	public maxBytes?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public titleMatches?: string;
}

/**
 * A standing intent.
 *
 * `sourceServiceIds` left empty is not an oversight: it means "follow the priority
 * set once in the administration screen". Pinning the list into every plan would
 * mean editing them all the day a friend's server moves.
 */
export class CreateSyncPlanDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	public name!: string;

	@ApiProperty({ enum: SyncTrigger })
	@IsEnum(SyncTrigger)
	public trigger!: SyncTrigger;

	@ApiPropertyOptional({ description: 'Cron expression, when the trigger is a schedule.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public schedule?: string | null;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	public sourceServiceIds?: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public targetLibraryId?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public rootItemId?: string | null;

	@ApiPropertyOptional({ type: SyncFilterDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => SyncFilterDto)
	public filter?: SyncFilterDto;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public enabled?: boolean;
}

export class UpdateSyncPlanDto extends CreateSyncPlanDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public declare name: string;

	@ApiPropertyOptional({ enum: SyncTrigger })
	@IsOptional()
	@IsEnum(SyncTrigger)
	public declare trigger: SyncTrigger;
}

/** A one-off run: a plan, a subtree, or a handful of items. */
export class RunSyncDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public planId?: string;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	public itemIds?: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public rootItemId?: string;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	public sourceServiceIds?: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public targetLibraryId?: string | null;

	@ApiPropertyOptional({ type: SyncFilterDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => SyncFilterDto)
	public filter?: SyncFilterDto;
}
