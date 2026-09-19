import {
	Right,
	type Library,
	type LibraryCheck,
	type MediaCategory,
} from '@mcs/shared';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { LibraryManager } from '@/managers';
import { UpdateLibraryDto } from '@/models';

@ApiTags('libraries')
@ApiBearerAuth()
@Controller('libraries')
export class LibraryController {
	public constructor(private readonly _libraries: LibraryManager) {}

	@Get()
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({ summary: 'Every library of every registered service' })
	@ApiOkResponse({ description: 'Library[]' })
	public list(): Promise<Library[]> {
		return this._libraries.list();
	}

	/**
	 * Declared before `:id`, which would otherwise swallow `check`.
	 *
	 * The route answers the failure that reports nothing: a library where the gateway's
	 * path and the media server's path do not designate the same directory accepts
	 * transfers the server will never see, and nothing anywhere reports an error.
	 */
	@Get('categories')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({
		summary: 'Libraries of the same name, merged into one category',
		description:
			'A household with two servers has two libraries called Shows, and a friend makes a ' +
			'third. They are one category to whoever is looking at them, and this is what a ' +
			'library screen is built from.',
	})
	@ApiOkResponse({ description: 'MediaCategory[]' })
	public categories(): Promise<MediaCategory[]> {
		return this._libraries.categories();
	}

	@Get('check')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({ summary: 'Probe every declared local path: exists, readable, writable, free' })
	@ApiOkResponse({ description: 'LibraryCheck[]' })
	public check(): Promise<LibraryCheck[]> {
		return this._libraries.check();
	}

	@Get(':id')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({ summary: 'One library' })
	@ApiOkResponse({ description: 'Library' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<Library> {
		return this._libraries.read(id);
	}

	@Patch(':id')
	@Granted(Right.LIBRARY_MANAGE)
	@ApiOperation({
		summary: 'Set where the gateway writes, or mark a default target',
		description:
			'The path is re-probed and refused when it cannot be written. Accepting one that ' +
			'cannot is how a sync silently does nothing.',
	})
	@ApiOkResponse({ description: 'Library' })
	@ApiConflictResponse({ description: 'error.library.path_not_writable' })
	public update(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateLibraryDto,
	): Promise<Library> {
		return this._libraries.update(id, body);
	}
}
