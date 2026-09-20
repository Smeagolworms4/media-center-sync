import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** What a directory browse may ask for. Read-only: there is nothing else to send. */
export class BrowseDirectoriesDto {
	/**
	 * The directory to list. Absent starts at the first allowed root.
	 *
	 * Deliberately not validated as an absolute path: `..` and a relative path are not
	 * refused here but resolved and then checked for containment, which is the only
	 * test that cannot be talked around. A pattern here would look like the guard and
	 * be none, and the length cap is all this layer can honestly assert.
	 */
	@ApiPropertyOptional({ description: 'Absolute path of the directory to list.' })
	@IsOptional()
	@IsString()
	@MaxLength(4096)
	public path?: string;

	/**
	 * Show dot directories.
	 *
	 * Arrives as the string `true` from a query string, which `@IsBoolean` would
	 * refuse — so it is transformed before it is validated, exactly as the media
	 * filters are. Without it the flag works from code and silently fails from a
	 * browser.
	 */
	@ApiPropertyOptional({ description: 'Include dot directories, hidden by default.' })
	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true' || value === '1')
	@IsBoolean()
	public includeHidden?: boolean;
}
