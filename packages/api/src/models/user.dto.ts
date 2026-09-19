import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@mcs/shared';

export class UpdateUserDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public displayName?: string | null;

	@ApiPropertyOptional()
	@IsOptional()
	@IsEmail()
	@MaxLength(255)
	public email?: string | null;

	@ApiPropertyOptional({ enum: UserRole })
	@IsOptional()
	@IsEnum(UserRole)
	public role?: UserRole;
}
