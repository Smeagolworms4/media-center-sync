import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayNotEmpty,
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
 * What a sync covers.
 *
 * Every field is a list, and they intersect: naming both a category and a subtree means
 * the part of that subtree in that category. An empty scope is not a mistake the
 * validation can catch — it means "everything", which is a legitimate thing to ask for
 * once and a dangerous thing to schedule, so it is the manager that insists on an
 * acknowledgement rather than this class.
 *
 * The array sizes are bounded because each entry becomes an `IN (…)` of its own, and a
 * body carrying ten thousand identifiers is a query no engine plans well.
 */
export class SyncScopeDto {
	@ApiPropertyOptional({
		type: [String],
		description: 'Merged categories, which is the unit people think in.',
	})
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(50)
	@IsString({ each: true })
	@MaxLength(120, { each: true })
	public categoryKeys?: string[];

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(50)
	@IsUUID('4', { each: true })
	public libraryIds?: string[];

	@ApiPropertyOptional({ type: [String], description: 'Subtrees: a show, a season, a collection.' })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(50)
	@IsUUID('4', { each: true })
	public rootItemIds?: string[];

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(500)
	@IsUUID('4', { each: true })
	public itemIds?: string[];
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

	/**
	 * The library this plan would rather its files went to. See `SyncPlan`.
	 *
	 * An identifier and never a path, as everywhere a destination is chosen: a library
	 * is a directory this gateway has probed and one of our own media servers is known
	 * to scan, while a path is a string somebody typed — and a file written where no
	 * server looks is a pull that succeeds and produces nothing.
	 */
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public preferredLibraryId?: string | null;

	@ApiPropertyOptional({ type: SyncScopeDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => SyncScopeDto)
	public scope?: SyncScopeDto;

	@ApiPropertyOptional({ type: SyncFilterDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => SyncFilterDto)
	public filter?: SyncFilterDto;

	@ApiPropertyOptional({
		nullable: true,
		description: 'A ceiling on one run. Null means none, which is a choice, not the default.',
	})
	@IsOptional()
	@IsInt()
	@Min(0)
	public maxItemsPerRun?: number | null;

	@ApiPropertyOptional({ nullable: true })
	@IsOptional()
	@IsInt()
	@Min(0)
	public maxBytesPerRun?: number | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public enabled?: boolean;

	@ApiPropertyOptional({
		description:
			'Enable a plan whose scope names nothing, knowingly. Refused without it, because ' +
			'"synchronise everything, every night" is what an empty form produces.',
	})
	@IsOptional()
	@IsBoolean()
	public acknowledgeUnbounded?: boolean;
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

	@ApiPropertyOptional({ type: SyncScopeDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => SyncScopeDto)
	public scope?: SyncScopeDto;

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

	@ApiPropertyOptional({ nullable: true })
	@IsOptional()
	@IsInt()
	@Min(0)
	public maxItemsPerRun?: number | null;

	@ApiPropertyOptional({ nullable: true })
	@IsOptional()
	@IsInt()
	@Min(0)
	public maxBytesPerRun?: number | null;

	@ApiPropertyOptional({
		description:
			'Start although a destination is tight or could not be probed. Never lets a refusal ' +
			'through: that one is arithmetic.',
	})
	@IsOptional()
	@IsBoolean()
	public acknowledgeSpace?: boolean;
}

/**
 * Fetch only what sits beside files we already hold.
 *
 * Bounded like a plan is, and for the same reason: two hundred directory reads across
 * a sleeping NAS is a request that times out rather than one that fails.
 */
export class PullCompanionsDto {
	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayNotEmpty()
	@ArrayMaxSize(500)
	@IsUUID('4', { each: true })
	public itemIds!: string[];
}
