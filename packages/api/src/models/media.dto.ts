import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayUnique,
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
	ValidateNested,
} from 'class-validator';
import {
	MediaKind,
	MediaOrigin,
	MediaResolution,
	RELEASE_PREFERENCE_DIMENSIONS,
	ReleasePreferenceDimension,
	SyncState,
} from '@mcs/shared';

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

	/**
	 * One merged category — every library of that name, across every service.
	 *
	 * This is what a library screen filters on; `libraryId` still names exactly one
	 * library, which is the question a diagnostic screen asks. A field the manager
	 * understands but the DTO does not is refused outright by the whitelisting
	 * validation, with a 400 that blames the caller for a parameter the API documents.
	 */
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public categoryKey?: string;

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

	/**
	 * Drop what we already hold in full.
	 *
	 * Arrives as the string `true` from a query string, so it is transformed before it
	 * is validated — exactly as `rootsOnly` is, and for the same reason: without it
	 * the filter works from code and silently fails from a browser.
	 */
	@ApiPropertyOptional({ description: 'Hide media held locally with no gap beneath them.' })
	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true' || value === '1')
	@IsBoolean()
	public hideOwned?: boolean;

	/**
	 * What the files actually are, not what they are called.
	 *
	 * A closed set, because the gateway derives these five labels and stores no others:
	 * a value outside it could only ever answer an empty wall, and a 400 naming the five
	 * is a better way to be told a link was mistyped. One value is read as a list of
	 * one, as `states` is.
	 */
	@ApiPropertyOptional({ enum: MediaResolution, isArray: true })
	@IsOptional()
	@Transform(({ value }) =>
		Array.isArray(value) ? (value as MediaResolution[]) : [value as MediaResolution])
	@IsArray()
	@IsEnum(MediaResolution, { each: true })
	public resolutions?: MediaResolution[];

	/**
	 * Free strings rather than an enum, and the spellings are folded behind this.
	 *
	 * `MEDIA_VIDEO_CODECS` is what the control offers and not what the API accepts: a
	 * media server can report any codec name at all, and refusing the unusual ones here
	 * would make a library holding them unfilterable. `x265`, `hevc` and `h265` all
	 * arrive intact and mean the same thing by the time they reach a query.
	 */
	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@Transform(({ value }) => (Array.isArray(value) ? (value as string[]) : [value as string]))
	@IsArray()
	@IsString({ each: true })
	@MaxLength(40, { each: true })
	public videoCodecs?: string[];

	/**
	 * Only what a sync plan keeps in step.
	 *
	 * Arrives as the string `true` from a query string, so it is transformed before it
	 * is validated — exactly as `rootsOnly` and `hideOwned` are.
	 */
	@ApiPropertyOptional({ description: 'Only media a sync plan covers.' })
	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true' || value === '1')
	@IsBoolean()
	public followed?: boolean;

	/** Only what there is something to do about. Transformed like the two booleans above. */
	@ApiPropertyOptional({ description: 'Only media with a gap beneath them or something newer elsewhere.' })
	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true' || value === '1')
	@IsBoolean()
	public actionable?: boolean;

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
 * How much of one media's search order the API will take, and why there is a ceiling.
 *
 * The preference rides in the overrides blob of a row that is read on every search for
 * that media, and it arrives from a browser: without bounds a body carrying a hundred
 * thousand values would be accepted, written, and then folded value by value against
 * every release of every search for ever. The numbers match the ones the settings
 * validator uses for the household and category orders, because they are the same
 * sentence at a third level and two different ceilings would be a difference nobody
 * could explain.
 */
const PREFERENCE_VALUE_MAX = 60;
const PREFERENCE_VALUES_LIMIT = 40;

/** One dimension and the values somebody prefers in it, best first. */
export class ReleasePreferenceRankDto {
	@ApiProperty({ enum: ReleasePreferenceDimension })
	@IsEnum(ReleasePreferenceDimension)
	public dimension!: ReleasePreferenceDimension;

	/**
	 * Empty is accepted, and that is the point rather than an oversight.
	 *
	 * A rank with no values says "I have no opinion in this dimension", which is how
	 * one media silences a dimension the category order cares about. See
	 * `isEmptyReleasePreference`: absent and empty are two different sentences, and
	 * refusing the empty one would make the second unsayable — the only way to say it
	 * would be to list every value in the order they already arrive in.
	 */
	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMaxSize(PREFERENCE_VALUES_LIMIT)
	@IsString({ each: true })
	@MaxLength(PREFERENCE_VALUE_MAX, { each: true })
	public values!: string[];
}

/**
 * This one media's own order over dimensions, and over the values inside each.
 *
 * An empty `ranks` is accepted too: a preference with no ranks separates nothing and
 * leaves a search exactly as it arrived. It is still a different sentence from having no
 * preference at all — see `resolveReleasePreference`, which chooses a level on presence
 * and never on emptiness — so it must be storable.
 *
 * A dimension may appear once. Twice is not a stricter preference but an ambiguous one:
 * the comparator walks the ranks in order, so the second occurrence would be dead weight
 * silently ignored, with the screen showing two rows that disagree.
 */
export class MediaReleasePreferenceDto {
	@ApiProperty({ type: [ReleasePreferenceRankDto] })
	@IsArray()
	@ArrayMaxSize(RELEASE_PREFERENCE_DIMENSIONS.length)
	@ArrayUnique((rank: ReleasePreferenceRankDto) => rank.dimension)
	@ValidateNested({ each: true })
	@Type(() => ReleasePreferenceRankDto)
	public ranks!: ReleasePreferenceRankDto[];
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

	/**
	 * Stop this item counting: a special, a recap, a panel filed as an episode.
	 *
	 * It stays visible and stays labelled. What changes is that it is excluded from a
	 * season's missing count, from what a sync plans, and from ever being called
	 * missing — so a complete season stops reading as incomplete for ever.
	 */
	@ApiPropertyOptional({ description: 'Exclude from gap counts and from what a sync plans.' })
	@IsOptional()
	@IsBoolean()
	public ignored?: boolean;

	/**
	 * This one media's own search order, and `null` cancels it.
	 *
	 * Validated here rather than left to the manager because the whole subtree comes
	 * from a browser and is stored verbatim: whitelisting stops at a property the DTO
	 * does not describe, so an undeclared preference would have travelled into the blob
	 * unread and been folded against every release of every search afterwards.
	 *
	 * `null` is a different instruction from leaving the field out, exactly as it is for
	 * every other field here — except that here the cancelled value is a whole level:
	 * writing null puts this media back under its category's order, which is what
	 * `resolveReleasePreference` does with an absent level.
	 */
	@ApiPropertyOptional({
		type: MediaReleasePreferenceDto,
		nullable: true,
		description: 'Order this media’s searches on its own. Null puts the category’s order back.',
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => MediaReleasePreferenceDto)
	public releasePreference?: MediaReleasePreferenceDto | null;
}
