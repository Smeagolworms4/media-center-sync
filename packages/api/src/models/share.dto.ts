import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ShareVisibility } from '@mcs/shared';

/**
 * What a library exposes.
 *
 * Every field is optional so a change can be one field wide. A library with no policy
 * follows the gateway default, so writing one here is an override: the fields this
 * request does not name keep whatever was in force a moment ago, and the library stops
 * moving when the default moves.
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

	@ApiPropertyOptional({ description: 'Bytes per second. 0 means no cap.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	public rateLimit?: number;
}
