import { Right, type DirectoryListing } from '@mcs/shared';
import { Controller, Get, Query } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { FilesystemManager } from '@/managers';
import { BrowseDirectoriesDto } from '@/models';

@ApiTags('filesystem')
@ApiBearerAuth()
@Controller('filesystem')
export class FilesystemController {
	public constructor(private readonly _filesystem: FilesystemManager) {}

	/**
	 * Behind `SETTINGS_MANAGE`, which is the existing right over this gateway's own
	 * paths — the fixed placement path and the fallback target are settings, and a
	 * service's local root and a library's local path are the same statement about the
	 * same filesystem. No new right was invented for it: what this route reveals is
	 * the deployment's own layout, which is exactly what that right already covers,
	 * and every role that may set any of those paths carries it.
	 */
	@Get('directories')
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({
		summary: 'Directories under one directory, with read and write rights',
		description:
			'Read-only, directories only, and never outside the configured roots — the check is ' +
			'made on the resolved path, so `..` and a symlink are refused like any other path ' +
			'outside them. Hidden entries take a flag, and the listing is capped: the answer ' +
			'says when it was.',
	})
	@ApiOkResponse({ description: 'DirectoryListing' })
	@ApiForbiddenResponse({ description: 'error.filesystem.path_outside_root' })
	@ApiNotFoundResponse({ description: 'error.filesystem.path_not_found' })
	public directories(@Query() query: BrowseDirectoriesDto): Promise<DirectoryListing> {
		return this._filesystem.browse({ path: query.path, includeHidden: query.includeHidden });
	}
}
