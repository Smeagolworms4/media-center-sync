import {
	Right,
	SyncState,
	type MediaItem,
	type MediaMatch,
	type MediaNode,
	type ResultList,
} from '@mcs/shared';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Res,
	StreamableFile,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiProduces,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { Granted } from '@/decorators';
import { MediaManager } from '@/managers';
import { ConfirmMatchDto, MediaSearchDto } from '@/models';

/**
 * The browsing query, with one state value read as a list of one.
 *
 * `?states=missing` and `?states=missing&states=outdated` mean the same kind of thing
 * to whoever typed them, and a query string cannot tell them apart: the first arrives
 * as a string and the second as an array. Without this the common case — one state
 * chip selected — answers `400` and the filter simply looks broken.
 */
class MediaSearchQueryDto extends MediaSearchDto {
	@ApiPropertyOptional({ enum: SyncState, isArray: true })
	@IsOptional()
	@Transform(({ value }) => (Array.isArray(value) ? (value as SyncState[]) : [value as SyncState]))
	@IsArray()
	@IsEnum(SyncState, { each: true })
	public declare states?: SyncState[];
}

/** How long a browser may keep a poster. Artwork changes on a rescan, not on a reload. */
const ARTWORK_CACHE_SECONDS = 3600;

/**
 * Browsing the index.
 *
 * Every read here is served from the gateway's own rows: the interface never queries a
 * media service, which is what makes a library of forty thousand episodes browsable at
 * all. The one exception is artwork, and it is an exception for a reason an `<img>`
 * tag makes unavoidable.
 */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
	public constructor(private readonly _media: MediaManager) {}

	@Get()
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'One page of the index, filtered' })
	@ApiOkResponse({ description: 'ResultList<MediaItem>' })
	public search(@Query() query: MediaSearchQueryDto): Promise<ResultList<MediaItem>> {
		return this._media.search(query);
	}

	@Get(':id')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'One item with the children it has' })
	@ApiOkResponse({ description: 'MediaNode' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<MediaNode> {
		return this._media.node(id);
	}

	@Get(':id/children')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'One page of an item’s children' })
	@ApiOkResponse({ description: 'ResultList<MediaItem>' })
	public children(
		@Param('id', ParseUUIDPipe) id: string,
		@Query() query: MediaSearchQueryDto,
	): Promise<ResultList<MediaItem>> {
		return this._media.children(id, query);
	}

	@Get(':id/matches')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'Every correlation this item takes part in, from both sides' })
	@ApiOkResponse({ description: 'MediaMatch[]' })
	public matches(@Param('id', ParseUUIDPipe) id: string): Promise<MediaMatch[]> {
		return this._media.matches(id);
	}

	/**
	 * Artwork, proxied rather than linked.
	 *
	 * The remote URL usually needs the service's token and an `<img>` tag carries no
	 * `Authorization` header, so the browser fetching it directly would be an anonymous
	 * request against a server that wants one. The gateway fetches it and caches it.
	 */
	@Get(':id/artwork')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'The item’s poster, fetched and cached by the gateway' })
	@ApiProduces('image/*')
	@ApiOkResponse({ description: 'Image bytes' })
	public async artwork(
		@Param('id', ParseUUIDPipe) id: string,
		@Res({ passthrough: true }) response: Response,
	): Promise<StreamableFile> {
		const artwork = await this._media.artwork(id);

		response.setHeader('Content-Type', artwork.contentType);
		response.setHeader('Cache-Control', `private, max-age=${ARTWORK_CACHE_SECONDS}`);

		return new StreamableFile(artwork.body);
	}

	@Post(':id/matches/:matchId/confirm')
	@Granted(Right.SYNC_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Accept a correlation the score alone would not have applied',
		description: 'Recorded: a correlation nobody can account for is one nobody will trust.',
	})
	@ApiOkResponse({ description: 'MediaMatch' })
	public confirm(
		@Param('id', ParseUUIDPipe) id: string,
		@Param('matchId', ParseUUIDPipe) matchId: string,
		@Body() body: ConfirmMatchDto,
	): Promise<MediaMatch> {
		return this._media.confirmMatch(id, matchId, body.localItemId);
	}

	@Delete(':id/matches/:matchId')
	@Granted(Right.SYNC_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Undo a correlation' })
	@ApiNoContentResponse()
	public deleteMatch(
		@Param('id', ParseUUIDPipe) id: string,
		@Param('matchId', ParseUUIDPipe) matchId: string,
	): Promise<void> {
		return this._media.deleteMatch(id, matchId);
	}
}
