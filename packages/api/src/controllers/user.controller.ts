import { Right, type User } from '@mcs/shared';
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
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiForbiddenResponse,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { UserManager } from '@/managers';
import { UpdateUserDto } from '@/models';

/**
 * Accounts.
 *
 * An account mirrored from a media service cannot have its username or its password
 * changed here — the gateway does not own them, and changing one would leave a name
 * that no longer resolves to anybody. Its role can, because that is ours: it says what
 * this gateway lets somebody do, and nothing outside knows about it.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UserController {
	public constructor(private readonly _users: UserManager) {}

	@Get()
	@Granted(Right.USER_MANAGE)
	@ApiOperation({ summary: 'Every account, whatever authenticated it' })
	@ApiOkResponse({ description: 'User[]' })
	public list(): Promise<User[]> {
		return this._users.list();
	}

	@Get(':id')
	@Granted(Right.USER_MANAGE)
	@ApiOperation({ summary: 'One account' })
	@ApiOkResponse({ description: 'User' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
		return this._users.read(id);
	}

	@Patch(':id')
	@Granted(Right.USER_MANAGE)
	@ApiOperation({ summary: 'Change an account’s profile or role' })
	@ApiOkResponse({ description: 'User' })
	@ApiForbiddenResponse({ description: 'error.auth.forbidden on a mirrored account' })
	@ApiConflictResponse({ description: 'error.auth.forbidden when it is the last administrator' })
	public update(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateUserDto,
	): Promise<User> {
		return this._users.update(id, body);
	}

	@Delete(':id')
	@Granted(Right.USER_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({
		summary: 'Delete an account and its sessions',
		description:
			'Refused for the last administrator: there is no screen for recovering from a gateway ' +
			'nobody can configure any more.',
	})
	@ApiNoContentResponse()
	public remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._users.remove(id);
	}
}
