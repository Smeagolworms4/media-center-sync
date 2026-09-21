import {
	MediaServiceType,
	Right,
	type DirectorySignIn,
	type DiscoveredServer,
	type RegisterDiscoveredResult,
	type SessionUser,
} from '@mcs/shared';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseEnumPipe,
	ParseUUIDPipe,
	Post,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Granted } from '@/decorators';
import { DirectoryManager } from '@/managers';
import { RegisterDiscoveredDto } from '@/models';

/**
 * Finding media servers through the account service that knows them — plex.tv — and
 * registering them without anybody typing an address.
 *
 * No route here returns the account token plex.tv hands back on approval. It stays on
 * the gateway: in the cache while somebody is in the dialog, then on each registered
 * service in a column no ordinary read selects.
 */
@ApiTags('directories')
@ApiBearerAuth()
@Controller('directories')
export class DirectoryController {
	public constructor(private readonly _directories: DirectoryManager) {}

	@Get()
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({ summary: 'The service types that can be signed in to and asked for their servers' })
	@ApiOkResponse({ description: 'MediaServiceType[]' })
	public types(): MediaServiceType[] {
		return this._directories.types();
	}

	@Post(':type/sign-ins')
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({
		summary: 'Open a sign-in: the person approves it on the directory’s own page',
		description: 'The password is typed on plex.tv, never here. Poll the sign-in until it is approved.',
	})
	@ApiOkResponse({ description: 'DirectorySignIn' })
	public start(
		@Param('type', new ParseEnumPipe(MediaServiceType)) type: MediaServiceType,
		@CurrentUser() user: SessionUser,
	): Promise<DirectorySignIn> {
		return this._directories.startSignIn(type, user.id);
	}

	@Get('sign-ins/:id')
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({ summary: 'Where a sign-in stands: pending, approved or expired' })
	@ApiOkResponse({ description: 'DirectorySignIn' })
	public read(
		@Param('id', ParseUUIDPipe) id: string,
		@CurrentUser() user: SessionUser,
	): Promise<DirectorySignIn> {
		return this._directories.readSignIn(id, user.id);
	}

	@Delete('sign-ins/:id')
	@Granted(Right.SERVICE_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Forget a sign-in, and the account token with it' })
	@ApiNoContentResponse()
	public cancel(
		@Param('id', ParseUUIDPipe) id: string,
		@CurrentUser() user: SessionUser,
	): Promise<void> {
		return this._directories.cancelSignIn(id, user.id);
	}

	@Get('sign-ins/:id/servers')
	@Granted(Right.SERVICE_MANAGE)
	@ApiOperation({
		summary: 'The servers of the signed-in account, probed from here',
		description: 'Its own and those shared with it, each with the best path that answered.',
	})
	@ApiOkResponse({ description: 'DiscoveredServer[]' })
	public servers(
		@Param('id', ParseUUIDPipe) id: string,
		@CurrentUser() user: SessionUser,
	): Promise<DiscoveredServer[]> {
		return this._directories.servers(id, user.id);
	}

	@Post('sign-ins/:id/servers')
	@Granted(Right.SERVICE_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Register some of those servers',
		description: 'Each on its own: one that cannot come in is reported by name and holds nobody back.',
	})
	@ApiOkResponse({ description: 'RegisterDiscoveredResult' })
	public register(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: RegisterDiscoveredDto,
		@CurrentUser() user: SessionUser,
	): Promise<RegisterDiscoveredResult> {
		return this._directories.register(id, user.id, body.identifiers);
	}
}
