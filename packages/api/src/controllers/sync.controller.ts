import {
	HistoryView,
	Right,
	SyncJobState,
	type ResultList,
	type CompanionPullResult,
	type SyncEstimate,
	type SyncJob,
	type SyncJobItem,
	type SyncPlan,
	type SyncPreview,
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
	Patch,
	Post,
	Query,
} from '@nestjs/common';
import {
	ApiAcceptedResponse,
	ApiBearerAuth,
	ApiConflictResponse,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiPropertyOptional,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { Granted } from '@/decorators';
import { SyncManager } from '@/managers';
import {
	CreateSyncPlanDto,
	PullCompanionsDto,
	RunSyncDto,
	UpdateSyncPlanDto,
} from '@/models';

/**
 * Paging, for the two lists this controller serves.
 *
 * Declared here rather than in `models/` because it is the shape of one query string
 * and nothing else speaks it. The validation pipe rejects anything the class does not
 * declare, so it has to exist even though it holds two fields.
 */
class PageQueryDto {
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
}

class SyncJobQueryDto extends PageQueryDto {
	@ApiPropertyOptional({ enum: SyncJobState })
	@IsOptional()
	@IsEnum(SyncJobState)
	public state?: SyncJobState;

	/**
	 * Which half of the history to answer with. Everything, unless asked otherwise.
	 *
	 * Not defaulted to `live`, although that is what the sync screen wants: the home
	 * screen reads this same route for the last few runs whatever state they are in,
	 * and a default that dropped them would have emptied it without a word.
	 */
	@ApiPropertyOptional({ enum: HistoryView, default: HistoryView.ALL })
	@IsOptional()
	@IsEnum(HistoryView)
	public view?: HistoryView;
}

/**
 * Plans, previews and runs.
 *
 * `/sync/preview` takes exactly the same body as `/sync/run` and changes nothing. The
 * symmetry is the point: what somebody was shown is what happens, because the same
 * code computed both.
 */
@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
	public constructor(private readonly _sync: SyncManager) {}

	@Get('plans')
	@Granted(Right.SYNC_READ)
	@ApiOperation({ summary: 'Every standing plan' })
	@ApiOkResponse({ description: 'SyncPlan[]' })
	public listPlans(): Promise<SyncPlan[]> {
		return this._sync.listPlans();
	}

	@Post('plans')
	@Granted(Right.SYNC_MANAGE)
	@ApiOperation({
		summary: 'Create a plan',
		description:
			'An empty `sourceServiceIds` is not an oversight: it means follow the service priority ' +
			'set in the administration screen.',
	})
	@ApiOkResponse({ description: 'SyncPlan' })
	public createPlan(@Body() body: CreateSyncPlanDto): Promise<SyncPlan> {
		return this._sync.createPlan(body);
	}

	@Get('plans/:id')
	@Granted(Right.SYNC_READ)
	@ApiOperation({ summary: 'One plan' })
	@ApiOkResponse({ description: 'SyncPlan' })
	public readPlan(@Param('id', ParseUUIDPipe) id: string): Promise<SyncPlan> {
		return this._sync.readPlan(id);
	}

	@Patch('plans/:id')
	@Granted(Right.SYNC_MANAGE)
	@ApiOperation({ summary: 'Change a plan, or enable and disable it' })
	@ApiOkResponse({ description: 'SyncPlan' })
	public updatePlan(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateSyncPlanDto,
	): Promise<SyncPlan> {
		return this._sync.updatePlan(id, body);
	}

	/**
	 * A `POST` although it changes nothing, and that is deliberate.
	 *
	 * Working out what a scope comes to walks every source and probes a placement per
	 * item. That is not something a `GET` on the plan should pay for on every read of a
	 * list of six, and it is not something a browser or a proxy should feel free to
	 * cache: the answer is only worth anything at the moment it is taken. `SyncPlan.estimate`
	 * is null everywhere else for the same reason — an estimate from last month would
	 * not be stale, it would be believed.
	 */
	@Post('plans/:id/estimate')
	@Granted(Right.SYNC_READ)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'What this plan’s scope currently comes to',
		description: 'Recomputed on the spot, never read back from storage. Changes nothing.',
	})
	@ApiOkResponse({ description: 'SyncEstimate' })
	public estimate(@Param('id', ParseUUIDPipe) id: string): Promise<SyncEstimate> {
		return this._sync.estimatePlan(id);
	}

	@Delete('plans/:id')
	@Granted(Right.SYNC_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Delete a plan and unschedule it' })
	@ApiNoContentResponse()
	public deletePlan(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._sync.deletePlan(id);
	}

	@Post('preview')
	@Granted(Right.SYNC_READ)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'What a run would do, without doing it',
		description: 'Same body and same planning code as `/sync/run`. Changes nothing.',
	})
	@ApiOkResponse({ description: 'SyncPreview' })
	public preview(@Body() body: RunSyncDto): Promise<SyncPreview> {
		return this._sync.preview(body);
	}

	/**
	 * `202`: the job is accepted, not finished.
	 *
	 * A run creates transfers and hands them to the engine; waiting for the bytes would
	 * be a request open for hours. The job row comes back immediately, and progress
	 * arrives as `job.state` and `transfer.progress` events.
	 */
	@Post('run')
	@Granted(Right.SYNC_RUN)
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Start a run' })
	@ApiAcceptedResponse({ description: 'SyncJob' })
	@ApiConflictResponse({ description: 'error.sync.already_running' })
	public run(@Body() body: RunSyncDto): Promise<SyncJob> {
		return this._sync.run(body);
	}

	@Post('companions')
	@Granted(Right.SYNC_RUN)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Fetch only the companions of files already held',
		description:
			'The .nfo, the poster, the subtitles, beside media already on the disk. A sync moves ' +
			'what is missing; this fills in what arrived bare, without moving the video again.',
	})
	@ApiOkResponse({ description: 'CompanionPullResult[]' })
	public companions(@Body() body: PullCompanionsDto): Promise<CompanionPullResult[]> {
		return this._sync.pullCompanions(body.itemIds);
	}

	@Get('jobs')
	@Granted(Right.SYNC_READ)
	@ApiOperation({ summary: 'One page of the run history' })
	@ApiOkResponse({ description: 'ResultList<SyncJob>' })
	public jobs(@Query() query: SyncJobQueryDto): Promise<ResultList<SyncJob>> {
		return this._sync.jobs(query);
	}

	@Get('jobs/:id')
	@Granted(Right.SYNC_READ)
	@ApiOperation({ summary: 'One run' })
	@ApiOkResponse({ description: 'SyncJob' })
	public readJob(@Param('id', ParseUUIDPipe) id: string): Promise<SyncJob> {
		return this._sync.readJob(id);
	}

	/**
	 * The lines of a run, so a progress bar can be opened.
	 *
	 * Paginated because a run carries up to five hundred of them, and each line names
	 * the transfer moving it — which is what lets a screen follow the bytes on the event
	 * stream instead of asking this route again.
	 */
	@Get('jobs/:id/items')
	@Granted(Right.SYNC_READ)
	@ApiOperation({ summary: 'One page of a run, line by line' })
	@ApiOkResponse({ description: 'ResultList<SyncJobItem>' })
	public jobItems(
		@Param('id', ParseUUIDPipe) id: string,
		@Query() query: PageQueryDto,
	): Promise<ResultList<SyncJobItem>> {
		return this._sync.jobItems(id, query);
	}

	@Post('jobs/:id/cancel')
	@Granted(Right.SYNC_RUN)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Stop a run and every transfer it started',
		description:
			'The transfers go too: a cancelled job whose transfers kept running would be a stop ' +
			'button that stops the bookkeeping and not the downloads.',
	})
	@ApiOkResponse({ description: 'SyncJob' })
	public cancel(@Param('id', ParseUUIDPipe) id: string): Promise<SyncJob> {
		return this._sync.cancel(id);
	}
}
