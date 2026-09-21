import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, MaxLength } from 'class-validator';
import type { RegisterDiscoveredRequest } from '@mcs/shared';

/**
 * Register some of the servers a sign-in found.
 *
 * Capped well above any real account — a household sees its own server and a handful
 * of friends' — so that the cap only ever refuses a hand-written body. Each entry is
 * checked against the account's own list before anything is written, so nothing here
 * has to trust what an identifier looks like.
 */
export class RegisterDiscoveredDto implements RegisterDiscoveredRequest {
	@ApiProperty({ type: [String], description: 'Server identifiers, as the sign-in listed them.' })
	@IsArray()
	@ArrayNotEmpty()
	@ArrayMaxSize(100)
	@IsString({ each: true })
	@MaxLength(255, { each: true })
	public identifiers!: string[];
}
