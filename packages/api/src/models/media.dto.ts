import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	IsArray,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Max,
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

	/**
	 * One state value is read as a list of one.
	 *
	 * `?states=missing` and `?states=missing&states=outdated` mean the same kind of
	 * thing to whoever typed them, and a query string cannot tell them apart: the
	 * first arrives as a string, the second as an array. Without the transform the
	 * common case — a single state chip selected — answers 400, and the filter simply
	 * looks broken.
	 *
	 * The bracket form `states[]=…` is refused by `forbidNonWhitelisted`, on purpose:
	 * accepting two spellings of the same parameter means two code paths to keep in
	 * step. Clients send repeated `states=` keys.
	 */
	@ApiPropertyOptional({ enum: SyncState, isArray: true })
	@IsOptional()
	@Transform(({ value }) => (Array.isArray(value) ? (value as SyncState[]) : [value as SyncState]))
	@IsArray()
	@IsEnum(SyncState, { each: true })
	public states?: SyncState[];

	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	public page?: number;

	/**
	 * Capped here as well as in the manager.
	 *
	 * The manager clamps, so nothing breaks without this — but a caller asking for a
	 * hundred thousand rows would get a 200 carrying two hundred, which reads as the
	 * API quietly ignoring the request. A 400 says what actually happened.
	 */
	@ApiPropertyOptional({ default: 50, maximum: 200 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200)
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
