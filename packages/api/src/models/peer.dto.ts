import { MAX_PEER_MAX_DEPTH } from '@mcs/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
	IsBoolean,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
	ValidateIf,
} from 'class-validator';

/**
 * Accept an invitation.
 *
 * The whole URL is accepted as well as the bare code, because that is what people
 * actually paste. Making them extract the code from a link they were sent is a
 * pointless step that will be got wrong.
 */
export class AcceptPeerInviteDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(2048)
	public invite!: string;

	@ApiPropertyOptional({ description: 'What to call them locally. Defaults to what they announce.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public name?: string;
}

/**
 * Linking by fingerprint.
 *
 * The address is optional because the rendezvous can find a peer by fingerprint;
 * given, it is tried first, since a direct address is faster and involves nobody else.
 */
export class AddPeerDto {
	@ApiProperty({ description: "The peer's public key fingerprint, as their gateway shows it." })
	@IsString()
	@IsNotEmpty()
	@MaxLength(255)
	public fingerprint!: string;

	@ApiPropertyOptional({ description: 'What to call them here. Defaults to what they announce.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public name?: string;

	@ApiPropertyOptional({ description: 'Where to reach them, when you know.' })
	@IsOptional()
	@IsString()
	@MaxLength(512)
	public address?: string;
}

export class CreatePeerInviteDto {
	@ApiPropertyOptional({ description: 'Minutes before the invitation expires. Default 60.' })
	@IsOptional()
	@IsInt()
	@Min(5)
	@Max(10080)
	public ttlMinutes?: number;
}

export class RenamePeerDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	public name!: string;
}

/**
 * Unlink, with the option of refusing the key for good.
 *
 * The ban rides on the removal rather than being a separate call, because that is
 * where the decision is made: somebody ejecting a peer is deciding whether they may
 * come back, and asking them again on another screen is asking them to remember.
 */
export class RemovePeerDto {
	@ApiPropertyOptional({
		description: 'Also refuse this fingerprint for good. Default false.',
	})
	@IsOptional()
	@IsBoolean()
	public ban?: boolean;

	@ApiPropertyOptional({ description: 'Why, for whoever reads the ban list later.' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public reason?: string;
}

export class BanPeerDto {
	@ApiPropertyOptional({ description: 'Why, for whoever reads the ban list later.' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public reason?: string;
}

/**
 * Ban a fingerprint that was never linked here.
 *
 * The case is being told about a key to refuse before it has asked, which is exactly
 * when refusing it is worth anything.
 */
export class BanFingerprintDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	public fingerprint!: string;

	@ApiPropertyOptional({ description: 'A label for the list. They are hex strings otherwise.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public name?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public reason?: string;
}

/**
 * How far introductions through this peer may travel.
 *
 * Nullable on purpose, and that is the whole shape of it: null means "follow the
 * gateway's ceiling", which is what clearing the box means — not a limit of zero, and
 * not whatever number happened to be the default that day.
 */
export class PeerMaxDepthDto {
	@ApiPropertyOptional({
		nullable: true,
		description: 'Hops allowed through this peer, or null to follow the gateway setting.',
	})
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsInt()
	@Min(1)
	@Max(MAX_PEER_MAX_DEPTH)
	public maxDepth!: number | null;
}
