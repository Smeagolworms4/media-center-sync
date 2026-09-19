import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateLibraryDto {
	@ApiPropertyOptional({
		description:
			'Where the gateway can write the same files the service reads. Absolute path.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public localPath?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public isDefaultTarget?: boolean;

	/**
	 * What this household calls the library, whatever the service calls it.
	 *
	 * This is how `Films` and `Movies` become one category: the alias is what the
	 * merge reads, so renaming one library here folds it into another's category
	 * without touching the media server. `null` drops the alias and the service's own
	 * name applies again.
	 *
	 * Declared here because the whitelist refuses anything it does not declare: the
	 * column, the model and the documentation all carried `alias` while this class did
	 * not, so the request answered `400 property alias should not exist` — a field the
	 * API documents, refused by the API.
	 */
	@ApiPropertyOptional({ description: 'Local name, used for merging libraries into categories.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public alias?: string | null;

	/** Lowest wins when several libraries of the same name disagree on kind or order. */
	@ApiPropertyOptional({ description: 'Sort order among categories; lowest first.' })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(9999)
	public position?: number;
}
