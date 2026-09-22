import {
	Right,
	type CategoryKeyword,
	type Library,
	type LibraryCheck,
	type LibraryHint,
	type MediaCategory,
} from '@mcs/shared';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { LibraryManager } from '@/managers';
import { AddCategoryKeywordDto, MoveCategoryKeywordDto, UpdateLibraryDto } from '@/models';

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

	/**
	 * Declared before `:id` like its neighbours, and read with `LIBRARY_READ`.
	 *
	 * Both hints answer a question somebody is already asking while looking at the
	 * library — why is everything missing, why does this show have forty seasons — so
	 * the right to see them is the right to see the library.
	 */
	@Get('hints')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({
		summary: 'Ways this gateway is set up that make the library read wrongly',
		description:
			'No server with its folders declared, so every row reads missing; and a series '
			+ 'that looks like a folder of shows the media server took for one show. '
			+ 'Suspicions to check, never verdicts, and dismissed through the settings.',
	})
	@ApiOkResponse({ description: 'LibraryHint[]' })
	public hints(): Promise<LibraryHint[]> {
		return this._libraries.hints();
	}

	/**
	 * Declared before `:id` for the same reason `check` and `categories` are.
	 *
	 * Read with `LIBRARY_READ` and not `LIBRARY_MANAGE`: a guest browsing the wall sees
	 * the categories the keywords produced, and a screen that cannot say why two
	 * shelves are one band is a screen that looks broken.
	 */
	@Get('keywords')
	@Granted(Right.LIBRARY_READ)
	@ApiOperation({
		summary: 'The names plugged into each category',
		description:
			'A library whose name matches one of these is read as part of that category, on '
			+ "whoever's server it sits — which is how a newly discovered peer's shelves file "
			+ 'themselves with nobody touching anything.',
	})
	@ApiOkResponse({ description: 'CategoryKeyword[]' })
	public keywords(): Promise<CategoryKeyword[]> {
		return this._libraries.keywords();
	}

	@Post('categories/:key/keywords')
	@Granted(Right.LIBRARY_MANAGE)
	@ApiOperation({
		summary: 'Plug a name into a category',
		description:
			'Applies to every library there is and every library there will be. Answers the '
			+ 'existing keyword when this category already has it, and refuses one another '
			+ 'category holds — two categories claiming the same name would file a shelf into '
			+ 'whichever row came back first.',
	})
	@ApiOkResponse({ description: 'CategoryKeyword' })
	@ApiConflictResponse({ description: 'error.library.keyword_taken' })
	public addKeyword(
		@Param('key') key: string,
		@Body() body: AddCategoryKeywordDto,
	): Promise<CategoryKeyword> {
		return this._libraries.addKeyword(key, body.keyword);
	}

	@Patch('keywords/:id')
	@Granted(Right.LIBRARY_MANAGE)
	@ApiOperation({ summary: 'File this name into another category from now on' })
	@ApiOkResponse({ description: 'CategoryKeyword' })
	public moveKeyword(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: MoveCategoryKeywordDto,
	): Promise<CategoryKeyword> {
		return this._libraries.moveKeyword(id, body.categoryKey);
	}

	/**
	 * The undo.
	 *
	 * Exact, because adding a keyword wrote nothing on the libraries it folded: they go
	 * back to reading as their own names in the very next request.
	 */
	@Delete('keywords/:id')
	@HttpCode(204)
	@Granted(Right.LIBRARY_MANAGE)
	@ApiOperation({ summary: 'Unplug a name from its category' })
	@ApiNoContentResponse({ description: 'Unplugged' })
	public removeKeyword(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._libraries.removeKeyword(id);
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
