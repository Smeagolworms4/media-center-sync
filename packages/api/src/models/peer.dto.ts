import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
