import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
