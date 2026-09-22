import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
	ArrayMaxSize,
	ArrayNotEmpty,
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	isUUID,
	Max,
	MaxLength,
	Min,
	registerDecorator,
} from 'class-validator';
import {
	ErrorKey,
	MAX_PEER_MAX_DEPTH,
	NamingScheme,
	PlacementStrategy,
	ShareVisibility,
} from '@mcs/shared';

/**
 * The naming order can never be longer than the steps there are.
 *
 * Bounded here rather than left to the rule below so that a body carrying ten
 * thousand steps is refused before anything walks it — the rule that matters runs in
 * the service, and this only keeps the cheap refusal cheap.
 */
const NAMING_STEP_LIMIT = Object.keys(NamingScheme).length;

/**
 * How many dismissed hints are kept, and how long a key may be.
 *
 * Bounded because the list arrives whole from a browser and is stored as one row: a
 * body carrying a hundred thousand keys would be accepted, written, and read back on
 * every settings request for ever. Five hundred is far past the number of series a
 * gateway could plausibly produce a hint for, and a key is an identifier with a short
 * prefix, never a name somebody typed.
 */
const DISMISSED_HINT_LIMIT = 500;
const HINT_KEY_MAX = 80;

/**
 * Refuse from inside the validator, rather than letting the pipe word it.
 *
 * Every other refusal on this screen answers `{ key, field }`, which is what puts the
 * message under the control that is wrong instead of above the whole form. The pipe's
 * own shape is a list of English sentences with no field on them, so a validator that
 * merely returned false would be the one setting whose error the interface could not
 * place.
 */
const refuse = (field: string | symbol): never => {
	throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: String(field) });
};

/**
 * A destination library, or no choice at all.
 *
 * `undefined` is a field the request left out and `''` is a select somebody emptied —
 * both mean "no choice", and the service turns the second into null. Anything else has
 * to be a real identifier: a destination naming a library that cannot exist is only
 * discovered at the end of a download that has already finished.
 */
const isLibraryChoice = (value: unknown): boolean =>
	value === undefined ||
	value === null ||
	value === '' ||
	(typeof value === 'string' && isUUID(value, '4'));

/**
 * A category key to a library identifier, and nothing else in either position.
 *
 * Null is refused rather than taken as a clearing, which the two nullable settings
 * beside it do allow. Every reader of this table indexes into it, so a stored null
 * turns the first placement lookup of the next pull into a thrown error — and an empty
 * table already says "no category has been answered for".
 */
const IsCategoryTargets = (): PropertyDecorator => (target, propertyName) => {
	registerDecorator({
		name: 'isCategoryTargets',
		target: target.constructor,
		propertyName: propertyName as string,
		validator: {
			validate(value: unknown): boolean {
				if (value === undefined) {
					return true;
				}

				if (typeof value !== 'object' || value === null || Array.isArray(value)) {
					return refuse(propertyName);
				}

				for (const entry of Object.values(value)) {
					// A library identifier and not a path: a path can point somewhere no
					// media server ever scans, which is the failure this whole area
					// exists to prevent.
					if (!isLibraryChoice(entry) || entry === null || entry === '') {
						return refuse(propertyName);
					}
				}

				return true;
			},
		},
	});
};

/** One library identifier, nothing, or a refusal naming the field. */
const IsLibraryChoice = (): PropertyDecorator => (target, propertyName) => {
	registerDecorator({
		name: 'isLibraryChoice',
		target: target.constructor,
		propertyName: propertyName as string,
		validator: {
			validate: (value: unknown): boolean =>
				isLibraryChoice(value) ? true : refuse(propertyName),
		},
	});
};

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

	/**
	 * Declared here or unreachable: the validation pipe runs with `whitelist`, so a key
	 * the DTO does not name is stripped from the body before anything sees it — the
	 * request answers 200, the settings come back unchanged, and nothing reports a
	 * problem. That has happened three times in this repository.
	 */
	@ApiPropertyOptional({
		type: 'object',
		additionalProperties: { type: 'string', format: 'uuid' },
		description:
			'Which library receives a pull, per category: a category key to a library identifier. ' +
			'A category with no entry falls through to the default target library.',
	})
	@IsCategoryTargets()
	public categoryTargets?: Record<string, string>;

	@ApiPropertyOptional({
		format: 'uuid',
		description:
			'The library that receives anything no category names. Empty clears it.',
	})
	@IsLibraryChoice()
	public defaultTargetLibraryId?: string | null;

	/**
	 * The naming chain, in the order the steps are tried.
	 *
	 * An array and not a scheme, because a single value could only say "rename like
	 * this" and never "keep the source name, and follow my own library when it has
	 * something to follow". The shape is all this can check — that the order holds
	 * together, one convention and only at the end, is a rule and lives in the
	 * service, which answers `{ key, field }` the same way this does.
	 */
	@ApiPropertyOptional({
		isArray: true,
		enum: NamingScheme,
		description:
			'How a placed file is named, as the order the steps are tried in. The first step ' +
			'that can answer wins, and the last one has to be a convention because it always ' +
			'answers.',
	})
	@IsOptional()
	@IsArray()
	@ArrayNotEmpty()
	@ArrayMaxSize(NAMING_STEP_LIMIT)
	@IsEnum(NamingScheme, { each: true })
	public namingOrder?: NamingScheme[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public pullMetadata?: boolean;

	@ApiPropertyOptional({
		description: 'Write an .nfo from what we know when the source sent none.',
	})
	@IsOptional()
	@IsBoolean()
	public writeNfo?: boolean;

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

	/**
	 * Whether a peer met while pulling from a friend of a friend is kept.
	 *
	 * Declared here or unreachable: the validation pipe runs with `whitelist`, so a key
	 * the DTO does not name is stripped before anything sees it and the request answers
	 * 200 with nothing changed.
	 */
	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public keepDiscoveredPeers?: boolean;

	/**
	 * Whether this gateway carries a link between two friends who cannot meet.
	 *
	 * Declared here or unreachable, like the one above: the validation pipe runs with
	 * `whitelist`, so a key the DTO does not name is stripped before anything sees it.
	 * The switch would appear to save, the capability would never be advertised, and
	 * the only symptom would be a friend still reporting somebody as unreachable.
	 */
	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public relayForPeers?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	public allowSwarm?: boolean;

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
			'Absolute path a pull lands in when nothing else decides. Probed, and refused ' +
			'when it cannot be written. Empty clears it.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(1024)
	public defaultTargetPath?: string | null;

	@ApiPropertyOptional({
		description:
			'How long finished work that succeeded is kept, in days. Covers sync runs as well ' +
			'as transfers. Zero keeps none of it.',
		minimum: 0,
		maximum: 3650,
	})
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(3650)
	public transferHistoryDays?: number;

	@ApiPropertyOptional({
		description:
			'How long finished work that failed or was cancelled is kept, in days. Longer than ' +
			'the window for successes, because a failure is the evidence of why something ' +
			'never arrived.',
		minimum: 0,
		maximum: 3650,
	})
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(3650)
	public failedHistoryDays?: number;

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

	@ApiPropertyOptional({
		description:
			'Keys of the organisation hints somebody has read and does not want again. ' +
			'Sent whole: the list replaces the stored one, so dismissing a hint means ' +
			'sending the list with its key added.',
		type: [String],
	})
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(DISMISSED_HINT_LIMIT)
	@IsString({ each: true })
	@MaxLength(HINT_KEY_MAX, { each: true })
	public dismissedLibraryHints?: string[];
}
