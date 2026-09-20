import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PEER_MAX_DEPTH, NamingScheme, PlacementStrategy, ShareVisibility } from '@mcs/shared';

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

	/**
	 * A distance in hops, not a yes or no. One means direct friends only.
	 *
	 * Bounded here as well as in the service because the pipe can name the field that
	 * is wrong, while the service can only clamp: somebody asking for ten hops would
	 * otherwise watch the value come back as the maximum with nothing said about why.
	 */
	@ApiPropertyOptional({ minimum: 1, maximum: MAX_PEER_MAX_DEPTH })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(MAX_PEER_MAX_DEPTH)
	public peerMaxDepth?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public allowSwarm?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(512)
	public rendezvousUrl?: string | null;

	/**
	 * Declared here or unreachable over HTTP.
	 *
	 * The validation pipe runs with `whitelist`, so a key the DTO does not name is
	 * stripped from the body before anything sees it: the request answers 200, the
	 * settings come back unchanged, and nothing anywhere reports a problem. It has
	 * happened three times in this repository — `alias`, `position`, `relay` — and each
	 * time the setting looked implemented everywhere except where it was used.
	 *
	 * The shape of the three values is checked in the service rather than here, because
	 * an empty string has to mean "cleared" and `@IsUrl` would refuse it.
	 */
	/**
	 * Empty means "no name of my own", and the hostname stands. It is not a rejection.
	 */
	/**
	 * Only a real visibility. There is no "unset" here: leaving the field out keeps
	 * whatever is stored, which is what every other setting does.
	 */
	@ApiPropertyOptional({ enum: ShareVisibility })
	@IsOptional()
	@IsEnum(ShareVisibility)
	public defaultShareVisibility?: ShareVisibility;

	@ApiPropertyOptional({ description: 'What this gateway calls itself to other people.' })
	@IsOptional()
	@IsString()
	@MaxLength(80)
	public instanceName?: string | null;

	@ApiPropertyOptional({
		description:
			'How this gateway is reached from outside. Any http or https URL is accepted and ' +
			'stored as its origin — no path, no trailing slash. Empty clears it.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(512)
	public publicUrl?: string | null;

	@ApiPropertyOptional({
		description:
			'host:port for peer traffic. Empty derives it from the public URL and the ' +
			'configured peer port.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public peerAddress?: string | null;

	@ApiPropertyOptional({
		description:
			'Absolute path a pull lands in when nothing else decides. Probed, and refused ' +
			'when it cannot be written. Empty clears it.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public defaultTargetPath?: string | null;

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
