import { Right, type ShareAudit, type SharePolicy } from '@mcs/shared';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Put,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { ShareManager } from '@/managers';
import { UpdateSharePolicyDto } from '@/models';

/**
 * What this gateway exposes to peers.
 *
 * `PUT` rather than `POST`: a library has at most one policy, the identifier in the
 * path is the library's, and saving twice has to be the same as saving once. Deleting
 * a policy is not "make it private": it hands the library back to the gateway default,
 * which on one of our own services is usually a level of sharing. Private for one
 * library alone is a policy saying `private`, and it survives a change of the default.
 */
@ApiTags('shares')
@ApiBearerAuth()
@Controller('shares')
export class ShareController {
	public constructor(private readonly _shares: ShareManager) {}

	@Get()
	@Granted(Right.SHARE_MANAGE)
	@ApiOperation({
		summary: 'Every library, with what it exposes today',
		description:
			'Includes libraries nobody has configured: `overridden` is false on those and '
			+ '`visibility` is the gateway default resolved for them.',
	})
	@ApiOkResponse({ description: 'SharePolicy[]' })
	public list(): Promise<SharePolicy[]> {
		return this._shares.list();
	}

	/** Before `:libraryId`, which would otherwise swallow `audit`. */
	@Get('audit/:peerId')
	@Granted(Right.SHARE_MANAGE)
	@ApiOperation({
		summary: 'What this peer would see of us',
		description: 'Computed with the same visibility test the peer-facing routes run.',
	})
	@ApiOkResponse({ description: 'ShareAudit' })
	public audit(@Param('peerId', ParseUUIDPipe) peerId: string): Promise<ShareAudit> {
		return this._shares.audit(peerId);
	}

	@Put(':libraryId')
	@Granted(Right.SHARE_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Set what one library exposes' })
	@ApiOkResponse({ description: 'SharePolicy' })
	public put(
		@Param('libraryId', ParseUUIDPipe) libraryId: string,
		@Body() body: UpdateSharePolicyDto,
	): Promise<SharePolicy> {
		return this._shares.put(libraryId, body);
	}

	@Delete(':libraryId')
	@Granted(Right.SHARE_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Drop the override, so the library follows the gateway default again' })
	@ApiNoContentResponse()
	public remove(@Param('libraryId', ParseUUIDPipe) libraryId: string): Promise<void> {
		return this._shares.remove(libraryId);
	}
}
