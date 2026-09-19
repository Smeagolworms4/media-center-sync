import {
	Right,
	type MediaGroup,
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
	Put,
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
	ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Granted } from '@/decorators';
import { MediaGroupManager, MediaManager } from '@/managers';
import {
	ConfirmMatchDto,
	MediaGroupQueryDto,
	MediaOverrideDto,
	MediaSearchDto,
} from '@/models';

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
	public constructor(
		private readonly _media: MediaManager,
		private readonly _groups: MediaGroupManager,
	) {}

	@Get()
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'One page of the index, filtered' })
	@ApiOkResponse({ description: 'ResultList<MediaItem>' })
	public search(@Query() query: MediaSearchDto): Promise<ResultList<MediaItem>> {
		return this._media.search(query);
	}

	/**
	 * One page of the grouped view: one entry per media, whoever holds it.
	 *
	 * Declared before `:id`, and the order is load-bearing. Nest matches routes in
	 * declaration order, so with `:id` first a request for `/media/groups` is read as
	 * an item whose identifier is `groups` and answered with a validation error about
	 * a UUID — a 400 that says nothing about the route being shadowed.
	 */
	@Get('groups')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'One page of media, grouped across the services that hold them',
		description:
			'Two rows join only when a match was applied: a proposal below the threshold stays ' +
			'two entries, which is the honest rendering of “we are not sure these are the same ' +
			'thing”.',
	})
	@ApiOkResponse({ description: 'ResultList<MediaGroup>' })
	public groups(@Query() query: MediaGroupQueryDto): Promise<ResultList<MediaGroup>> {
		return this._groups.groups(query);
	}

	@Get('groups/:id')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'One group, addressed by its representative item' })
	@ApiOkResponse({ description: 'MediaGroup' })
	public group(@Param('id', ParseUUIDPipe) id: string): Promise<MediaGroup> {
		return this._groups.group(id);
	}

	@Get('groups/:id/children')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'The children of every copy in a group, merged into child groups',
		description:
			'What makes a series page work when the seasons live on different servers.',
	})
	@ApiOkResponse({ description: 'ResultList<MediaGroup>' })
	public groupChildren(
		@Param('id', ParseUUIDPipe) id: string,
		@Query() query: MediaGroupQueryDto,
	): Promise<ResultList<MediaGroup>> {
		return this._groups.groupChildren(id, query);
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
		@Query() query: MediaSearchDto,
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

	@Put(':id/override')
	@Granted(Right.MEDIA_WRITE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Correct what a media server got wrong, locally',
		description:
			'Reclassify it, rename the show, reassign a season or an episode number. Written into ' +
			'the fields everything reads, so the correction reaches correlation and filing, and ' +
			'kept as an instruction so the next rescan re-applies it rather than undoing it.',
	})
	@ApiOkResponse({ description: 'MediaItem' })
	public override(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: MediaOverrideDto,
	): Promise<MediaItem> {
		return this._media.setOverride(id, body);
	}

	@Delete(':id/override')
	@Granted(Right.MEDIA_WRITE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Put back what the service reported',
		description: 'Every corrected field returns to the media server’s own answer.',
	})
	@ApiOkResponse({ description: 'MediaItem' })
	public clearOverride(@Param('id', ParseUUIDPipe) id: string): Promise<MediaItem> {
		return this._media.setOverride(id, null);
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
