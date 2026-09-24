import {
	MediaKind,
	MediaRequestState,
	Right,
	type MediaRequest,
	type MediaRequestView,
} from '@mcs/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	MaxLength,
	Min,
} from 'class-validator';
import { Granted } from '@/decorators';
import { RequestManager } from '@/managers/request.manager';

/** What a listing asks for. Both optional: no state means the open ones. */
class RequestQueryDto {
	@ApiPropertyOptional({ enum: MediaRequestState })
	@IsOptional()
	@IsEnum(MediaRequestState)
	public state?: MediaRequestState;

	@ApiPropertyOptional({ description: 'How many rows at most. The source decides its own ceiling.' })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	public take?: number;
}

/**
 * What to ask the source for: one of our media, or a bare identifier.
 *
 * `tmdbId` is a string although it is a number over there, for the reason every external
 * identifier in this product is one: they are names, never quantities, and a JSON number
 * loses a leading zero the moment somebody's provider starts using one.
 */
class RequestCreateDto {
	@ApiPropertyOptional({ description: 'Our own media, when the ask is pushed from a media page.' })
	@IsOptional()
	@IsUUID()
	public itemId?: string;

	@ApiPropertyOptional({ description: 'Used directly when no media of ours is named.' })
	@IsOptional()
	@IsString()
	@MaxLength(64)
	public tmdbId?: string;

	@ApiPropertyOptional({ enum: [MediaKind.MOVIE, MediaKind.SERIES] })
	@IsOptional()
	@IsEnum(MediaKind)
	public kind?: MediaKind.MOVIE | MediaKind.SERIES;

	@ApiPropertyOptional({
		type: [Number],
		description: 'Seasons, for a show. Left out asks for every season the source knows of.',
	})
	@IsOptional()
	@IsArray()
	@Type(() => Number)
	@IsInt({ each: true })
	@Min(0, { each: true })
	public seasons?: number[];
}

/**
 * Closing an ask, and the one case where saying so is not a lie.
 *
 * Empty in the ordinary case. `force` exists because the household holds things this
 * catalogue has never been told about — a disc, a copy on a machine nobody registered —
 * and the person who knows that has to be able to close the ask. It is opt-in precisely
 * so that it cannot happen by accident: the interface never sends it, and a caller that
 * does had to decide to.
 */
class FulfilRequestDto {
	@ApiPropertyOptional({
		description: 'Close it even though nothing of ours answers it.',
	})
	@IsOptional()
	@IsBoolean()
	public force?: boolean;
}

/**
 * What the household asked for, and what became of it.
 *
 * Under `MEDIA_READ` to read the list and `TRANSFER_MANAGE` to write anything back, the
 * same split as the release routes and for the same reason: seeing what has been asked
 * for is reading, while closing somebody's request or pushing a new one changes what the
 * household sees on its own screen.
 *
 * Nothing here fetches anything. The view carries the search each request would imply and
 * that is as far as it goes — running it is a separate press on a separate route, so that
 * an account on somebody else's Seerr cannot spend this gateway's disk.
 */
@ApiTags('requests')
@ApiBearerAuth()
@Controller('requests')
export class RequestController {
	public constructor(private readonly _requests: RequestManager) {}

	@Get()
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'What has been asked for, and whether we already hold it',
		description:
			'Each ask is matched to our catalogue on its TMDB and TVDB identifiers, so the list '
			+ 'says which requests are already satisfied — most of a year’s asks arrive by some '
			+ 'other route, and a list that could not tell is a list nobody can act on. It also '
			+ 'carries the search each unsatisfied one would imply, which nothing here runs.',
	})
	@ApiOkResponse({ description: 'MediaRequestView[]' })
	@ApiConflictResponse({ description: 'error.request_source.not_configured' })
	public list(@Query() query: RequestQueryDto): Promise<MediaRequestView[]> {
		return this._requests.list({ state: query.state, take: query.take });
	}

	@Post(':id/fulfilled')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Tell the source the ask is answered',
		description:
			'Marks the media behind the request available, which is what stops it being open '
			+ 'in the place the household looks. Refused for an ask nothing of ours answers, and '
			+ 'for a show we are still short seasons of — told an ask is complete, the household '
			+ 'stops asking, so closing one that delivered nothing ends the asking and delivers '
			+ 'nothing. `force` says it anyway, for the copy that exists somewhere this '
			+ 'catalogue was never told about.',
	})
	@ApiOkResponse({ description: 'MediaRequestView' })
	@ApiNotFoundResponse({ description: 'error.request.not_found' })
	@ApiConflictResponse({
		description: 'error.request.not_held, error.request_source.not_configured',
	})
	public fulfilled(
		// No `ParseUUIDPipe`, unlike every other route here: a request identifier belongs
		// to the source and Seerr's are small integers, so validating it as a UUID would
		// refuse every request in existence.
		@Param('id') id: string,
		@Body() body: FulfilRequestDto,
	): Promise<MediaRequestView> {
		return this._requests.markFulfilled(id, body.force === true);
	}

	@Post()
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Ask for something over there',
		description:
			'How "we are following this here" gets said in the place the household already '
			+ 'looks. A media of ours is resolved to the TMDB identifier the source addresses '
			+ 'works by; naming a season pushes that season. Answers nothing when the source '
			+ 'already had the same ask open, which is a success and not a failure.',
	})
	@ApiOkResponse({ description: 'MediaRequest, or nothing when the ask was already open' })
	@ApiNotFoundResponse({ description: 'error.media.not_found' })
	@ApiConflictResponse({ description: 'error.request_source.not_configured' })
	public create(@Body() body: RequestCreateDto): Promise<MediaRequest | null> {
		return this._requests.create(body);
	}
}
