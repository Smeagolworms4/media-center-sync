import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
	IsBoolean,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUrl,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
} from 'class-validator';
import { MediaServiceType } from '@mcs/shared';

/**
 * A path that means the same thing to every process that reads it.
 *
 * A relative root resolves against whatever directory the process was started in,
 * which is not the same one in a container, in a development shell and in a command —
 * so the same stored value would designate three different directories and only one
 * of them would be the one somebody meant.
 */
const ABSOLUTE_PATH = /^\//;

/**
 * Whether this registration says anything about a root mapping at all.
 *
 * The two roots are one statement in two halves — a prefix and what to replace it
 * with — and either half on its own derives nothing whatsoever: there is no prefix to
 * match, or nothing to rewrite it to. Storing half of it would leave a service that
 * looks configured on screen and behaves exactly like one that is not, which is the
 * failure this feature exists to remove rather than to reproduce one level up.
 *
 * So both are validated as soon as one is stated, and the missing half is refused by
 * name while somebody is still looking at the form. A caller changing one side must
 * send the pair, which is what the interface does; sending neither leaves the stored
 * mapping alone, and sending both as null clears it.
 */
const statesRootMapping = (dto: {
	remoteRoot?: string | null;
	localRoot?: string | null;
}): boolean => (dto.remoteRoot ?? null) !== null || (dto.localRoot ?? null) !== null;

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

	/**
	 * Share this service's libraries. Absent means yes.
	 *
	 * Optional rather than required, and the default is the permissive one, for the
	 * same reason `defaultShareVisibility` ships as a real level: a gateway that shares
	 * nothing until somebody has been through a second screen shows its friends an
	 * empty shelf and they conclude the link failed.
	 */
	@ApiPropertyOptional({ description: 'Offer this service\'s libraries to peers.' })
	@IsOptional()
	@IsBoolean()
	public shared?: boolean;

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

	/**
	 * The prefix the service reports, and the same directory as the gateway reaches it.
	 *
	 * Stated once here so that every library under the service derives its own local
	 * path instead of six libraries being six paths to type. A library's own
	 * `localPath` still wins: that field is for the exceptions this cannot express.
	 *
	 * 1024 matches the column and is well past any path a filesystem will accept, so
	 * the limit only ever catches a field somebody pasted a document into.
	 */
	@ApiPropertyOptional({ example: '/media' })
	@ValidateIf(statesRootMapping)
	@IsString()
	@IsNotEmpty()
	@MaxLength(1024)
	@Matches(ABSOLUTE_PATH)
	public remoteRoot?: string | null;

	@ApiPropertyOptional({ example: '/mnt/nas' })
	@ValidateIf(statesRootMapping)
	@IsString()
	@IsNotEmpty()
	@MaxLength(1024)
	@Matches(ABSOLUTE_PATH)
	public localRoot?: string | null;
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

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public declare shared: boolean;

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
