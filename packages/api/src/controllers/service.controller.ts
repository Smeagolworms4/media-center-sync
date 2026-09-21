import {
	Right,
	type Library,
	type MediaService,
	type MediaServiceProbe,
	type ServerStructure,
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
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { ServiceManager } from '@/managers';
import {
	CreateMediaServiceDto,
	ProbeMediaServiceDto,
	ServerStructureDto,
	UpdateMediaServiceDto,
} from '@/models';

/**
 * Registering media services.
 *
 * Nothing here returns a token. They are excluded on the entity and never read into
 * the shapes the manager hands back — a token that leaks through a list endpoint opens
 * somebody's whole library, and nothing in the response would say so.
 */
@ApiTags('services')
@ApiBearerAuth()
@Controller('services')
export class ServiceController {
	public constructor(private readonly _services: ServiceManager) {}

	@Get()
	@Granted(Right.SERVICE_READ)
	@ApiOperation({ summary: 'Every registered service, in the order syncs consult them' })
	@ApiOkResponse({ description: 'MediaService[]' })
	public list(): Promise<MediaService[]> {
		return this._services.list();
	}

	@Post()
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({ summary: 'Register a service' })
	@ApiOkResponse({ description: 'MediaService' })
	@ApiConflictResponse({ description: 'error.service.duplicate' })
	public create(@Body() body: CreateMediaServiceDto): Promise<MediaService> {
		return this._services.create(body);
	}

	/**
	 * Declared before `:id` on purpose.
	 *
	 * Express matches in declaration order, so `probe` reaching the parameterised route
	 * first would be read as an identifier — and the failure is a 404 that names a
	 * service nobody asked for.
	 */
	@Post('probe')
	@Granted(Right.SERVICE_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Test a connection before registering it',
		description:
			'Answers rather than throws: an unreachable server and a wrong token are both ordinary ' +
			'results a form renders while somebody is still typing.',
	})
	@ApiOkResponse({ description: 'MediaServiceProbe' })
	public probeUnregistered(@Body() body: ProbeMediaServiceDto): Promise<MediaServiceProbe> {
		return this._services.probeUnregistered(body);
	}

	@Get(':id')
	@Granted(Right.SERVICE_READ)
	@ApiOperation({ summary: 'One registered service' })
	@ApiOkResponse({ description: 'MediaService' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<MediaService> {
		return this._services.read(id);
	}

	@Patch(':id')
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({
		summary: 'Change a registration',
		description: 'A field that is not sent is not changed, secrets included.',
	})
	@ApiOkResponse({ description: 'MediaService' })
	public update(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateMediaServiceDto,
	): Promise<MediaService> {
		return this._services.update(id, body);
	}

	@Delete(':id')
	@Granted(Right.SERVICE_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Forget a service, its libraries and everything it indexed' })
	@ApiNoContentResponse()
	public remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._services.remove(id);
	}

	@Post(':id/probe')
	@Granted(Right.SERVICE_READ)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Test a registered connection and record what it said' })
	@ApiOkResponse({ description: 'MediaServiceProbe' })
	public probe(@Param('id', ParseUUIDPipe) id: string): Promise<MediaServiceProbe> {
		return this._services.probe(id);
	}

	/**
	 * `202`, not `200`.
	 *
	 * A full scan of a large library takes minutes. A request that waited for it would
	 * time out in a proxy somewhere in the middle, leaving the scan running and the
	 * caller with an error about something that is working. Progress goes out as
	 * `scan.progress` on the event stream.
	 */
	@Post(':id/scan')
	@Granted(Right.SERVICE_MANAGE)
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Re-read everything this service holds' })
	@ApiAcceptedResponse({ description: 'Reported through `scan.progress` events.' })
	public scan(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._services.scan(id);
	}

	@Post(':id/refresh')
	@Granted(Right.SERVICE_READ)
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Ask this service what changed since the last cursor' })
	@ApiAcceptedResponse({ description: 'Reported through `scan.progress` events.' })
	public refresh(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._services.refresh(id);
	}

	@Get(':id/libraries')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({ summary: 'The libraries this service reports' })
	@ApiOkResponse({ description: 'Library[]' })
	public libraries(@Param('id', ParseUUIDPipe) id: string): Promise<Library[]> {
		return this._services.libraries(id);
	}

	/**
	 * Behind `SERVICE_MANAGE`, and that is a wider right than it first looks.
	 *
	 * What it answers is the shape of a media server's own filesystem, one directory
	 * at a time — more than the library paths `GET /services/:id/libraries` already
	 * reports under a read right. Whoever is entitled to see it is whoever configures
	 * where this gateway writes, and every role that may set a library's local path or
	 * a service's local root carries this right.
	 *
	 * `includeFiles` is deliberately not exposed. The picker has no use for files, and
	 * the one caller that does — the marker proof in `LibraryManager.check()` — reaches
	 * the handler from inside. A route that listed the files in somebody's media
	 * directories would answer a question nobody on this side of it needs to ask.
	 */
	@Get(':id/structure')
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({
		summary: 'The folders this service reports as its own, as it spells them',
		description:
			'The authoritative half of the mapping: the server says `/data/media/shows`, this '
			+ 'gateway sees `/mnt/nas/shows`. A service with no way to say — a peer always, a '
			+ 'server whose build has no browse route — answers `support: unsupported` with no '
			+ 'entries rather than failing, because "cannot tell you" and "is not answering" '
			+ 'are fixed in different places.',
	})
	@ApiOkResponse({ description: 'ServerStructure' })
	public structure(
		@Param('id', ParseUUIDPipe) id: string,
		@Query() query: ServerStructureDto,
	): Promise<ServerStructure> {
		return this._services.structure(id, {
			libraryExternalId: query.libraryExternalId,
			path: query.path,
		});
	}
}
