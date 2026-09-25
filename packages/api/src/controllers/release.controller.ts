import {
	ReleaseSearchKind,
	Right,
	type CoveragePlan,
	type EpisodeRef,
	type ReleaseGrab,
	type ReleaseSearchResult,
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
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiNoContentResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	IsBoolean,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';
import { Granted } from '@/decorators';
import { ReleaseManager } from '@/managers';

/** What a search asks for. Everything optional but one of `itemId` and `term`. */
class ReleaseSearchDto {
	@ApiPropertyOptional({ description: 'The media to search for, which builds the terms.' })
	@IsOptional()
	@IsUUID()
	public itemId?: string;

	@ApiPropertyOptional({
		description:
			'Words to search for instead of the media’s title, for a show the trackers know '
			+ 'under another name.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(200)
	public term?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	public seasonNumber?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	public episodeNumber?: number;

	@ApiPropertyOptional({ description: 'Ask for the whole season rather than one episode.' })
	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	public seasonPack?: boolean;

	/**
	 * Film or show, which picks the categories the indexer is asked for.
	 *
	 * Optional because a search naming a media reads it off that media, and validated
	 * against the enum because the alternative is a free string reaching the category
	 * table: an unknown value there is an undefined lookup, a request with no categories
	 * at all, and a search that answers the whole tracker.
	 */
	@ApiPropertyOptional({
		enum: ReleaseSearchKind,
		description:
			'Film or show. Read off the media when one is named. A free-text search that '
			+ 'omits it is searched as a show, which finds nothing at all for a film.',
	})
	@IsOptional()
	@IsEnum(ReleaseSearchKind)
	public kind?: ReleaseSearchKind;
}

/** One episode a partial grab is being taken for. */
class WantedEpisodeDto implements EpisodeRef {
	@ApiProperty()
	@IsUUID()
	public itemId!: string;

	// Nullable rather than optional: the coordinate is what a file is matched on, and a
	// body that simply left it out would be a wanted episode nothing can recognise.
	@ApiProperty({ nullable: true })
	@IsOptional()
	@IsInt()
	public seasonNumber!: number | null;

	@ApiProperty({ nullable: true })
	@IsOptional()
	@IsInt()
	public episodeNumber!: number | null;

	@ApiProperty()
	@IsString()
	@MaxLength(500)
	public title!: string;
}

class GrabDto {
	@ApiProperty({ description: 'From the last search. Releases exist nowhere else.' })
	@IsString()
	@MaxLength(500)
	public releaseId!: string;

	@ApiProperty({ description: 'The media it is for, and what it will be filed as.' })
	@IsUUID()
	public itemId!: string;

	@ApiPropertyOptional({ description: 'Where it should land, when the rules are not what is wanted.' })
	@IsOptional()
	@IsUUID()
	public libraryId?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public folder?: string | null;

	@ApiPropertyOptional({
		type: [WantedEpisodeDto],
		description:
			'Only these episodes, out of a release that holds more. The pack is added '
			+ 'stopped, its file list is read, everything else is set to zero priority and '
			+ 'only then is it started — so the disk pays for what was asked for.',
	})
	@IsOptional()
	@ValidateNested({ each: true })
	@Type(() => WantedEpisodeDto)
	public wanted?: WantedEpisodeDto[];
}

/** Where a torrent should land. Both optional: clearing them gives it back to the rules. */
class GrabDestinationDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public libraryId?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public folder?: string | null;
}

class PlacementQueryDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public libraryId?: string;
}

class DownloadsQueryDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID()
	public itemId?: string;
}

/**
 * Searching for a copy nobody we know holds, and fetching it.
 *
 * Under `MEDIA_READ` to search and `TRANSFER_MANAGE` to grab, and the split is the
 * point: looking at what exists on a tracker is reading, while handing one to a
 * download client spends a disk and puts a file in somebody's library. A guest may do
 * the first and not the second.
 */
@ApiTags('releases')
@ApiBearerAuth()
@Controller('releases')
export class ReleaseController {
	public constructor(private readonly _releases: ReleaseManager) {}

	@Get('search')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'What could satisfy this media, from the trackers and from the peers',
		description:
			'Built from the media when one is named: an episode is searched for by its series’ '
			+ 'title and coordinate, because that is what release names carry. Tracker results '
			+ 'are folded on what each name resolves to, so one file listed by six trackers is '
			+ 'one line — and the copies our own peers already hold come back in the same '
			+ 'list, marked for what they are, because a file that exists beats a name on a '
			+ 'tracker. Each row says its kind, and the kind decides what fetching it means: a '
			+ 'release goes to the download client, a peer copy to a sync run.',
	})
	@ApiOkResponse({ description: 'ReleaseSearchResult' })
	@ApiConflictResponse({ description: 'error.indexer.not_configured' })
	public search(@Query() query: ReleaseSearchDto): Promise<ReleaseSearchResult> {
		return this._releases.search(query);
	}

	@Post('plan')
	@Granted(Right.MEDIA_READ)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'A way of covering every gap',
		description:
			'The answer to "I am short four episodes of this season". One pack covering all '
			+ 'four beats four singles — one torrent, one connection, one thing to watch — and '
			+ 'four singles beat a pack when no pack exists. What nothing on offer can cover is '
			+ 'named rather than silently dropped.',
	})
	@ApiOkResponse({ description: 'CoveragePlan' })
	@ApiConflictResponse({ description: 'error.indexer.not_configured' })
	public plan(@Body() body: ReleaseSearchDto): Promise<CoveragePlan> {
		return this._releases.plan(body);
	}

	@Post('grab')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Hand a release to the download client',
		description:
			'The gateway remembers which media it is for, which is the only thing that lets it '
			+ 'be filed when it arrives — a torrent client has never heard of your catalogue. '
			+ 'Refused before a byte moves if the folder the client writes into is not one this '
			+ 'gateway can read.',
	})
	@ApiOkResponse({ description: 'ReleaseGrab' })
	@ApiNotFoundResponse({ description: 'error.release.not_found, error.media.not_found' })
	@ApiConflictResponse({
		description:
			'error.download_client.not_configured, error.download_client.path_unreadable, '
			+ 'error.download_client.refused',
	})
	public grab(@Body() body: GrabDto): Promise<ReleaseGrab> {
		return this._releases.grab(body);
	}

	@Post('downloads/:id/destination')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Send a torrent somewhere else',
		description:
			'The same answer a redirected transfer takes. Nothing is copied: the '
			+ 'destination is read when the download finishes, so changing it before then '
			+ 'costs one row write. Refused once the file is in the library.',
	})
	@ApiOkResponse({ description: 'ReleaseGrab' })
	@ApiNotFoundResponse({ description: 'error.grab.not_found' })
	@ApiConflictResponse({ description: 'error.transfer.not_resumable' })
	public destination(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: GrabDestinationDto,
	): Promise<ReleaseGrab> {
		return this._releases.setDestination(id, body.libraryId ?? null, body.folder ?? null);
	}

	@Get('placement/:itemId')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'Where a file for this media would be filed',
		description:
			'Runs the placement rule without placing anything, so a screen can open its '
			+ 'folder field on the answer the gateway would give — a series already held '
			+ 'keeps its folder, then the category, then the default. Answers null when '
			+ 'nothing can be worked out, which is a folder nobody has chosen yet rather '
			+ 'than a fault.',
	})
	@ApiOkResponse({ description: 'PlannedFolder' })
	@ApiNotFoundResponse({ description: 'error.media.not_found' })
	public async placement(
		@Param('itemId', ParseUUIDPipe) itemId: string,
		@Query() query: PlacementQueryDto,
	): Promise<{ folder: string | null }> {
		return { folder: await this._releases.plannedFolderFor(itemId, query.libraryId ?? null) };
	}

	@Post('downloads/:id/retry')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Look again at a download that failed',
		description:
			'Nothing is re-sent: the client still holds the torrent, so the row is re-opened '
			+ 'and the next poll carries on from whatever state the client reports. What this '
			+ 'is for is the repair somebody has just made — a root mapping corrected, a '
			+ 'folder made writable — after which there was otherwise nothing to press.',
	})
	@ApiOkResponse({ description: 'ReleaseGrab' })
	@ApiNotFoundResponse({ description: 'error.grab.not_found' })
	@ApiConflictResponse({ description: 'error.grab.not_retryable' })
	public retry(@Param('id', ParseUUIDPipe) id: string): Promise<ReleaseGrab> {
		return this._releases.retry(id);
	}

	@Post('downloads/:id/pause')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Stop a download without giving it up',
		description: 'The bytes already fetched are kept, and the row keeps being watched.',
	})
	@ApiOkResponse({ description: 'ReleaseGrab' })
	@ApiNotFoundResponse({ description: 'error.grab.not_found' })
	@ApiConflictResponse({ description: 'error.grab.not_retryable' })
	public pause(@Param('id', ParseUUIDPipe) id: string): Promise<ReleaseGrab> {
		return this._releases.pause(id);
	}

	@Post('downloads/:id/resume')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Let a stopped download run again' })
	@ApiOkResponse({ description: 'ReleaseGrab' })
	@ApiNotFoundResponse({ description: 'error.grab.not_found' })
	@ApiConflictResponse({ description: 'error.grab.not_retryable' })
	public resume(@Param('id', ParseUUIDPipe) id: string): Promise<ReleaseGrab> {
		return this._releases.resume(id);
	}

	@Delete('downloads/:id')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({
		summary: 'Take a download off the queue',
		description:
			'The row and nothing else: the torrent stays in the client, seeding or stopped '
			+ 'as it was, and a file already filed stays in its library.',
	})
	@ApiNoContentResponse({ description: 'Archived' })
	@ApiNotFoundResponse({ description: 'error.grab.not_found' })
	public archive(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._releases.archive(id);
	}

	@Get('trackers')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'The trackers behind the configured indexer',
		description:
			'For the search-order screen, which has to name a tracker without having searched. '
			+ 'Suggestions only — any value can be written — and an empty list when nothing is '
			+ 'configured or the indexer will not answer, because a settings screen that refused '
			+ 'to open over a tracker list would be worse than one offering none.',
	})
	@ApiOkResponse({ description: 'string[]' })
	public trackers(): Promise<string[]> {
		return this._releases.trackers();
	}

	@Get('downloads')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({ summary: 'What has been grabbed, and where it has got to' })
	@ApiOkResponse({ description: 'ReleaseGrab[]' })
	public downloads(@Query() query: DownloadsQueryDto): Promise<ReleaseGrab[]> {
		return this._releases.downloads(query.itemId);
	}
}
