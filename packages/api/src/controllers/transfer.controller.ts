import {
	HistoryView,
	TransferSort,
	Right,
	TransferState,
	type ResultList,
	type Revalidation,
	type Transfer,
	type TransferChunk,
	type TransferQueueStats,
	type TransferVerification,
	type UnconfiguredPlacement,
} from '@mcs/shared';
import {
	Body,
	Controller,
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
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Granted } from '@/decorators';
import { TransferManager } from '@/managers';

/** The query string of the queue list, and nothing else speaks it. */
class TransferQueryDto {
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

	@ApiPropertyOptional({ enum: TransferState })
	@IsOptional()
	@IsEnum(TransferState)
	public state?: TransferState;

	/**
	 * Which half of the queue to answer with. Everything, unless asked otherwise.
	 *
	 * A paused transfer counts as live: somebody stopped it and it resumes when they
	 * say so, and a queue view that filed it under history would lose it.
	 */
	@ApiPropertyOptional({ enum: HistoryView, default: HistoryView.ALL })
	@IsOptional()
	@IsEnum(HistoryView)
	public view?: HistoryView;

	/**
	 * What is moving comes first unless somebody asks otherwise.
	 *
	 * Newest first put a queue of eighty behind whatever finished a minute ago, so the
	 * rows being watched were on page two.
	 */
	@ApiPropertyOptional({ enum: TransferSort, default: TransferSort.ACTIVITY })
	@IsOptional()
	@IsEnum(TransferSort)
	public sort?: TransferSort;
}

/**
 * Where a transfer should go instead.
 *
 * A library identifier and nothing else. A path was deliberately not accepted: a
 * library is a directory this gateway has probed and one of our own media servers is
 * known to scan, while a path is a string somebody typed — and a file written where
 * no server looks is a transfer that succeeds and produces nothing.
 */
class ChangeDestinationDto {
	@ApiProperty()
	@IsUUID()
	public libraryId!: string;

	@ApiPropertyOptional({
		description:
			'A folder inside that library. Refused unless it sits under one of the library’s own '
			+ 'roots, and not created here — the directory appears when the bytes are written.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public folder?: string | null;
}

/**
 * The queue.
 *
 * `verify` and `repair` are two routes rather than one because they answer two
 * questions. Verifying re-reads what is on disk and reports; repairing acts on it.
 * Keeping them apart is what lets somebody ask the question without committing to the
 * answer, which matters when the answer is "fetch nine gigabytes again".
 *
 * Nothing here carries a live rate. Rates are measured over a window of seconds inside
 * the engine and pushed as `transfer.progress` frames; a REST answer carrying a stale
 * one would be worse than one carrying none.
 */
@ApiTags('transfers')
@ApiBearerAuth()
@Controller('transfers')
export class TransferController {
	public constructor(private readonly _transfers: TransferManager) {}

	@Get()
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({ summary: 'One page of the queue' })
	@ApiOkResponse({ description: 'ResultList<Transfer>' })
	public list(@Query() query: TransferQueryDto): Promise<ResultList<Transfer>> {
		return this._transfers.list(query);
	}

	/** Before `:id`, which would otherwise read `stats` as an identifier. */
	@Get('stats')
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({ summary: 'Queue counters, with the rate the engine is measuring' })
	@ApiOkResponse({ description: 'TransferQueueStats' })
	public stats(): Promise<TransferQueueStats> {
		return this._transfers.stats();
	}

	/** Before `:id` as well, for the same reason `stats` is. */
	@Get('unconfigured')
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({
		summary: 'What landed on a step of the placement rule nobody configured',
		description:
			'The global destination, the fallback folder and the last-resort walk of whatever is ' +
			'writable all mean nobody chose. Nothing else reports them: the transfer succeeded.',
	})
	@ApiOkResponse({ description: 'UnconfiguredPlacement[]' })
	public unconfigured(): Promise<UnconfiguredPlacement[]> {
		return this._transfers.unconfigured();
	}

	@Get(':id')
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({ summary: 'One transfer' })
	@ApiOkResponse({ description: 'Transfer' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.read(id);
	}

	@Get(':id/chunks')
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({ summary: 'Its pieces: range, state, which source served them' })
	@ApiOkResponse({ description: 'TransferChunk[]' })
	public chunks(@Param('id', ParseUUIDPipe) id: string): Promise<TransferChunk[]> {
		return this._transfers.chunks(id);
	}

	@Get(':id/revalidations')
	@Granted(Right.TRANSFER_READ)
	@ApiOperation({
		summary: 'Why this transfer changed its mind',
		description: 'Which source was asked, what it said, and what was decided.',
	})
	@ApiOkResponse({ description: 'Revalidation[]' })
	public revalidations(@Param('id', ParseUUIDPipe) id: string): Promise<Revalidation[]> {
		return this._transfers.revalidations(id);
	}

	@Post('pause')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Stop everything that is moving',
		description:
			'Pausing a queue row by row cannot work: by the time the fourth is paused the engine '
			+ 'has started a fifth. Queued transfers are paused too — one left queued starts the '
			+ 'moment a slot frees. Answers how many were stopped.',
	})
	@ApiOkResponse({ description: 'How many transfers were paused' })
	public async pauseAll(): Promise<{ paused: number }> {
		return { paused: await this._transfers.pauseAll() };
	}

	@Post(':id/pause')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Pause it, queued or running',
		description:
			'A queued transfer can be paused too: one that could not would start the moment a slot ' +
			'freed, which is what pressing pause is trying to prevent.',
	})
	@ApiOkResponse({ description: 'Transfer' })
	@ApiConflictResponse({ description: 'error.transfer.not_resumable' })
	public pause(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.pause(id);
	}

	@Post(':id/resume')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Put it back in the queue, from where it stopped' })
	@ApiOkResponse({ description: 'Transfer' })
	@ApiConflictResponse({ description: 'error.transfer.not_resumable' })
	public resume(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.resume(id);
	}

	@Post(':id/cancel')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Stop it and drop the partial file' })
	@ApiOkResponse({ description: 'Transfer' })
	public cancel(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.cancel(id);
	}

	@Post(':id/retry')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Start a failed or cancelled transfer over',
		description: 'Its pieces are reset: a cancelled transfer no longer has the bytes it held.',
	})
	@ApiOkResponse({ description: 'Transfer' })
	@ApiConflictResponse({ description: 'error.transfer.not_resumable' })
	public retry(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.retry(id);
	}

	@Post(':id/verify')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Re-read what is on disk and report. Changes nothing.' })
	@ApiOkResponse({ description: 'TransferVerification' })
	public verify(@Param('id', ParseUUIDPipe) id: string): Promise<TransferVerification> {
		return this._transfers.verify(id);
	}

	@Post(':id/repair')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Fetch the pieces that failed verification again',
		description: 'Only those pieces, and preferably from another source.',
	})
	@ApiOkResponse({ description: 'Transfer' })
	public repair(@Param('id', ParseUUIDPipe) id: string): Promise<Transfer> {
		return this._transfers.repair(id);
	}

	@Post(':id/destination')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Send it somewhere else',
		description:
			'While it is still downloading this rewrites a target path and costs nothing — the ' +
			'bytes are in the scratch directory. Once the file has landed it is a real move, ' +
			'reported as `placing` on the progress stream.',
	})
	@ApiOkResponse({ description: 'Transfer' })
	@ApiNotFoundResponse({ description: 'error.library.not_found' })
	@ApiConflictResponse({
		description:
			'error.transfer.destination_invalid, error.library.path_not_writable, ' +
			'error.transfer.target_occupied',
	})
	public destination(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: ChangeDestinationDto,
	): Promise<Transfer> {
		return this._transfers.changeDestination(id, body);
	}

	@Post('jobs/:jobId/destination')
	@Granted(Right.TRANSFER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Send a whole run somewhere else',
		description:
			'Every file of the run, the ones that have already landed included — those are moved '
			+ 'for real, reported as `placing`. Folders the run leaves empty behind it are '
			+ 'removed, and a folder that still holds anything at all is kept. Refused whole if '
			+ 'any one file cannot go, so a run is never split across two libraries.',
	})
	@ApiOkResponse({ description: 'The transfers that moved' })
	@ApiNotFoundResponse({ description: 'error.library.not_found, error.transfer.not_found' })
	@ApiConflictResponse({
		description:
			'error.transfer.destination_invalid, error.library.path_not_writable, '
			+ 'error.transfer.target_occupied, error.transfer.being_placed',
	})
	public jobDestination(
		@Param('jobId', ParseUUIDPipe) jobId: string,
		@Body() body: ChangeDestinationDto,
	): Promise<Transfer[]> {
		return this._transfers.changeJobDestination(jobId, body);
	}
}
