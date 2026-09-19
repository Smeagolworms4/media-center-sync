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

	/**
	 * Agreement to pass on a library that sits on somebody else's service.
	 *
	 * Declared here because the whitelist refuses whatever this class does not name:
	 * the entity, the shared `UpdateSharePolicyRequest` and the manager all carried
	 * `relay` while this DTO did not, so the one field that can lift the relay refusal
	 * answered `400 property relay should not exist` — which left a remote library
	 * impossible to share through the API that documents how to share it.
	 *
	 * There is deliberately no `relays` counterpart: that is a fact about where the
	 * library lives, read from the service's scope, and a caller must not be able to
	 * assert it.
	 */
	@ApiPropertyOptional({
		description: 'Agree to serve a library that is not on one of our own services.',
	})
	@IsOptional()
	@IsBoolean()
	public relay?: boolean;

	@ApiPropertyOptional({ description: 'Bytes per second. 0 means no cap.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	public rateLimit?: number;
}
