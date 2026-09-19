import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	IsArray,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	MaxLength,
	Min,
} from 'class-validator';
import { MediaKind, SyncState } from '@mcs/shared';

/**
 * Browsing the index.
 *
 * `limit` is capped rather than trusted. A library holds tens of thousands of
 * episodes, and an uncapped page size turns one request into a response nobody can
 * render and a query nobody can serve.
 */
export class MediaSearchDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public serviceId?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public libraryId?: string;

	@ApiPropertyOptional({ enum: MediaKind })
	@IsOptional()
	@IsEnum(MediaKind)
	public kind?: MediaKind;

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public parentId?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public search?: string;

	@ApiPropertyOptional({ enum: SyncState, isArray: true })
	@IsOptional()
	@IsArray()
	@IsEnum(SyncState, { each: true })
	public states?: SyncState[];

	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	public page?: number;

	@ApiPropertyOptional({ default: 50, maximum: 200 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	public limit?: number;

	@ApiPropertyOptional({ enum: ['title', 'year', 'addedAt'] })
	@IsOptional()
	@IsEnum(['title', 'year', 'addedAt'])
	public sort?: 'title' | 'year' | 'addedAt';

	@ApiPropertyOptional({ enum: ['asc', 'desc'] })
	@IsOptional()
	@IsEnum(['asc', 'desc'])
	public direction?: 'asc' | 'desc';
}

/** Accept or reject a correlation the score alone would not have applied. */
export class ConfirmMatchDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public localItemId?: string | null;
}
