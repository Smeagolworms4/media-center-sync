import {
	Right,
	TransferState,
	type ResultList,
	type Revalidation,
	type Transfer,
	type TransferChunk,
	type TransferQueueStats,
	type TransferVerification,
} from '@mcs/shared';
import {
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
	ApiOkResponse,
	ApiOperation,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
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
}
