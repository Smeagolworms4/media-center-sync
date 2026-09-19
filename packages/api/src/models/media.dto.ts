import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Max,
	MaxLength,
	Min,
} from 'class-validator';
import { MediaKind, MediaOrigin, SyncState } from '@mcs/shared';

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

/**
 * Browsing the same index one media at a time instead of one row at a time.
 *
 * The same fields and the same bounds as `MediaSearchDto`, and a separate class
 * rather than a subclass on purpose: the two are the same shape today and answer
 * different questions, so a field added to one should have to be added to the other
 * deliberately. What differs is what the fields mean — every one of them filters
 * groups, not rows, and `serviceId` narrows which groups appear without ungrouping
 * the ones that survive.
 */
export class MediaGroupQueryDto {
	/**
	 * Several services, because comparing two friends' shelves is the ordinary case.
	 *
	 * A single value arrives as a string from a query string and a list as an array;
	 * both mean the same thing to whoever typed them, so the scalar is read as a list
	 * of one — exactly as `states` is, and for the same reason.
	 */
	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@Transform(({ value }) => (Array.isArray(value) ? (value as string[]) : [value as string]))
	@IsArray()
	@IsUUID('4', { each: true })
	public serviceIds?: string[];

	/**
	 * Where copies come from, which is a different question to which server.
	 *
	 * "Show me what my friends have" is one filter; naming six servers to express it
	 * is not the same thing, and stops being true the moment somebody links a seventh.
	 */
	@ApiPropertyOptional({ enum: MediaOrigin, isArray: true })
	@IsOptional()
	@Transform(({ value }) =>
		Array.isArray(value) ? (value as MediaOrigin[]) : [value as MediaOrigin])
	@IsArray()
	@IsEnum(MediaOrigin, { each: true })
	public origins?: MediaOrigin[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public libraryId?: string;

	@ApiPropertyOptional({ enum: MediaKind })
	@IsOptional()
	@IsEnum(MediaKind)
	public kind?: MediaKind;

	/** The parent group, addressed by its representative item. */
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public parentId?: string;

	/**
	 * Only media at the top of their tree.
	 *
	 * Arrives as the string `true` from a query string, which `@IsBoolean` would
	 * reject — so it is transformed before it is validated. The alternative is a
	 * filter that works from code and silently fails from a browser.
	 */
	@ApiPropertyOptional()
	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true' || value === '1')
	@IsBoolean()
	public rootsOnly?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public search?: string;

	/** One state value is read as a list of one, for the reason `MediaSearchDto` states. */
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

/**
 * A correction to one item, field by field.
 *
 * Every field is optional and `null` is meaningful: absent leaves the service's answer
 * alone, `null` clears it. That distinction is how somebody removes a year a scraper
 * invented, so the two cannot be collapsed however tempting the shorter validation
 * would be.
 */
export class MediaOverrideDto {
	@ApiPropertyOptional({ description: 'Reclassify into another library.' })
	@IsOptional()
	@IsUUID()
	public libraryId?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public title?: string | null;

	@ApiPropertyOptional({ description: "The show's name, for an episode." })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public seriesTitle?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1800)
	@Max(2999)
	public year?: number | null;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(999)
	public seasonNumber?: number | null;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(9999)
	public episodeNumber?: number | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(5000)
	public overview?: string | null;

	@ApiPropertyOptional({ description: 'Merged with what the service reported, not replacing it.' })
	@IsOptional()
	@IsObject()
	public externalIds?: Record<string, string>;
}
