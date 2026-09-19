import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Sign-in.
 *
 * `provider` is one of the keys `GET /auth/providers` returned — `internal`, or
 * `service:<uuid>` for a registered media service. The interface never guesses it:
 * which ways in exist depends on what has been registered, and a gateway with no
 * service yet must still let its administrator in.
 */
export class LoginDto {
	@ApiProperty({ example: 'internal' })
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	public provider!: string;

	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(255)
	public username!: string;

	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(255)
	public password!: string;
}

export class RefreshDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	public refreshToken!: string;
}

export class ChangePasswordDto {
	@ApiPropertyOptional({ description: 'Omitted when an administrator resets another account.' })
	@IsString()
	@IsNotEmpty()
	public currentPassword!: string;

	@ApiProperty()
	@IsString()
	@MaxLength(255)
	public newPassword!: string;
}
