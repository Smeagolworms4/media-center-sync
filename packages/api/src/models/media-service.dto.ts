import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
	IsBoolean,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUrl,
	Max,
	MaxLength,
	Min,
} from 'class-validator';
import { MediaServiceScope, MediaServiceType } from '@mcs/shared';

/**
 * Registering a service.
 *
 * `require_tld: false` on the URL is not laxity: the whole point is to reach
 * `http://192.168.0.10:8096` or `http://jellyfin:8096`, and the default rules reject
 * both. Rejecting the only addresses that matter would make the field unusable.
 */
export class CreateMediaServiceDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	public name!: string;

	@ApiProperty({ enum: MediaServiceType })
	@IsEnum(MediaServiceType)
	public type!: MediaServiceType;

	@ApiProperty({ enum: MediaServiceScope })
	@IsEnum(MediaServiceScope)
	public scope!: MediaServiceScope;

	@ApiProperty({ example: 'http://192.168.0.10:8096' })
	@IsUrl({ require_tld: false, protocols: ['http', 'https'] })
	public baseUrl!: string;

	@ApiPropertyOptional({ description: 'API key. Write-only: never returned.' })
	@IsOptional()
	@IsString()
	@MaxLength(512)
	public token?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public username?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public password?: string;

	@ApiPropertyOptional({ description: 'Also authenticate gateway users against it.' })
	@IsOptional()
	@IsBoolean()
	public authProvider?: boolean;

	@ApiPropertyOptional({ description: 'Consulted lowest first. Default 100.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(10000)
	public priority?: number;
}

export class UpdateMediaServiceDto extends CreateMediaServiceDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public declare name: string;

	@ApiPropertyOptional({ enum: MediaServiceType })
	@IsOptional()
	@IsEnum(MediaServiceType)
	public declare type: MediaServiceType;

	@ApiPropertyOptional({ enum: MediaServiceScope })
	@IsOptional()
	@IsEnum(MediaServiceScope)
	public declare scope: MediaServiceScope;

	@ApiPropertyOptional()
	@IsOptional()
	@IsUrl({ require_tld: false, protocols: ['http', 'https'] })
	public declare baseUrl: string;
}

/** Test a connection before committing to it. */
export class ProbeMediaServiceDto {
	@ApiProperty({ enum: MediaServiceType })
	@IsEnum(MediaServiceType)
	public type!: MediaServiceType;

	@ApiProperty()
	@IsUrl({ require_tld: false, protocols: ['http', 'https'] })
	public baseUrl!: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	public token?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	public username?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	public password?: string;
}
