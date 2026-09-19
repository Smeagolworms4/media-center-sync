import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { NamingScheme, PlacementStrategy } from '@mcs/shared';

/**
 * Settings.
 *
 * The bounds are not decoration. `maxConnectionsPerSource` above a handful makes a
 * home server refuse connections and looks like a broken transfer; a `chunkSize`
 * under a megabyte turns a large file into hundreds of thousands of rows. The
 * interface offers sensible values, and this stops the rest from reaching the engine.
 */
export class UpdateSettingsDto {
	@ApiPropertyOptional({ enum: PlacementStrategy })
	@IsOptional()
	@IsEnum(PlacementStrategy)
	public placement?: PlacementStrategy;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public fixedPath?: string | null;

	@ApiPropertyOptional({ enum: NamingScheme })
	@IsOptional()
	@IsEnum(NamingScheme)
	public naming?: NamingScheme;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public pullMetadata?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public preferSourceMetadata?: boolean;

	@ApiPropertyOptional({ minimum: 1, maximum: 32 })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(32)
	public maxParallelTransfers?: number;

	@ApiPropertyOptional({
		minimum: 0,
		maximum: 1099511627776,
		description:
			'Free space the gateway will not knowingly eat into. A run that would cross it is ' +
			'reported as tight and has to be acknowledged; one that would not fit at all is refused. ' +
			'0 means fill the disk to the last byte.',
	})
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(1099511627776)
	public diskReserveBytes?: number;

	@ApiPropertyOptional({ minimum: 1, maximum: 16 })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(16)
	public maxConnectionsPerSource?: number;

	@ApiPropertyOptional({ minimum: 1048576, maximum: 134217728 })
	@IsOptional()
	@IsInt()
	@Min(1048576)
	@Max(134217728)
	public chunkSize?: number;

	@ApiPropertyOptional({ description: 'Bytes per second. 0 means no cap.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	public downloadRateLimit?: number;

	@ApiPropertyOptional({ description: 'Bytes per second. 0 means no cap.' })
	@IsOptional()
	@IsInt()
	@Min(0)
	public uploadRateLimit?: number;

	@ApiPropertyOptional({ minimum: 0, maximum: 1 })
	@IsOptional()
	@Min(0)
	@Max(1)
	public matchThreshold?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public allowFriendsOfFriends?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public allowSwarm?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(512)
	public rendezvousUrl?: string | null;

	@ApiPropertyOptional({ minimum: 0, maximum: 365 })
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(365)
	public transferHistoryDays?: number;

	@ApiPropertyOptional({ minimum: 1, maximum: 1440 })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(1440)
	public refreshIntervalMinutes?: number;

	@ApiPropertyOptional({ description: 'Empty disables the scheduled full rescan.' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	public fullScanCron?: string | null;

	@ApiPropertyOptional({ minimum: 0, maximum: 3600 })
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(3600)
	public cacheTtlSeconds?: number;
}
