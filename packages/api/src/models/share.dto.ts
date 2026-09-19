import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ShareVisibility } from '@mcs/shared';

/**
 * What a library exposes.
 *
 * Every field is optional so a change can be one field wide. The absence of a policy
 * means private — a library is never shared by having been forgotten, and this
 * endpoint is the only thing that can change that.
 */
export class UpdateSharePolicyDto {
	@ApiPropertyOptional({ enum: ShareVisibility })
	@IsOptional()
	@IsEnum(ShareVisibility)
	public visibility?: ShareVisibility;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	public allowedPeerIds?: string[];

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	public deniedPeerIds?: string[];

	@ApiPropertyOptional({ description: 'Catalogue only: titles and artwork, never the files.' })
	@IsOptional()
	@IsBoolean()
	public metadataOnly?: boolean;

	@ApiPropertyOptional({ description: 'Bytes per second. 0 means no cap.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	public rateLimit?: number;
}
