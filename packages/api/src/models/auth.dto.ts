import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

/**
 * The first administrator, created once on a gateway that has no account.
 *
 * The route behind it is open, which is only safe because it refuses the moment an
 * account exists. The password floor is the one place this API is opinionated about
 * credentials, and it is there because this account will often be the only one on a
 * machine somebody later exposes to the internet.
 */
export class SetupDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@MaxLength(255)
	public username!: string;

	@ApiProperty({ minLength: 8 })
	@IsString()
	@MinLength(8)
	@MaxLength(255)
	public password!: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public displayName?: string;
}
