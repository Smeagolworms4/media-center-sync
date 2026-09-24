import { BadRequestException } from '@nestjs/common';
import { IsRootMappings } from './media-service.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
	ValidateNested,
} from 'class-validator';
import {
	DownloadClientType,
	ErrorKey,
	IndexerType,
	MAX_PEER_MAX_DEPTH,
	type ReleasePreferenceSettings,
	RELEASE_PREFERENCE_DIMENSIONS,
	type RootMapping,
	NamingScheme,
	PlacementStrategy,
	RequestSourceType,
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
					/*
					 * A library identifier, or one of that library's own roots.
					 *
					 * It was identifiers alone, on the argument that a path can point
					 * somewhere no media server ever scans — true of a path somebody
					 * typed, and false of a root the service itself declared. A library is
					 * not one folder: a shelf called `Series TV` can be five directories on
					 * five disks, and naming the library named only the first, so every
					 * pull landed there and nothing said why.
					 *
					 * The shape is checked here and the meaning where the libraries are:
					 * this decorator cannot ask the database whether a path is a root, and
					 * a rule that accepted any absolute path would be no rule at all. See
					 * `SettingsService`.
					 */
					if (typeof entry !== 'string' || entry === '') {
						return refuse(propertyName);
					}

					if (!isUUID(entry, '4') && !entry.startsWith('/')) {
						return refuse(propertyName);
					}
				}

				return true;
			},
		},
	});
};

/**
 * How much of a release preference the API will take, and why there is a ceiling.
 *
 * The preference is one settings row, read whole on every search, and it arrives from a
 * browser: without bounds a body carrying a hundred thousand values would be accepted,
 * written, and then folded value by value against every release of every search for
 * ever. The numbers are far past a real opinion — nobody ranks forty resolutions, and a
 * value is a tag off a tracker (`WEB-DL`, `NTb`) rather than a sentence — so anything
 * beyond them is a mistake or an attack and neither is worth storing.
 */
const PREFERENCE_VALUE_MAX = 60;
const PREFERENCE_VALUES_LIMIT = 40;
const PREFERENCE_CATEGORY_KEY_MAX = 120;
const PREFERENCE_CATEGORY_LIMIT = 200;

const PREFERENCE_DIMENSIONS = new Set<string>(RELEASE_PREFERENCE_DIMENSIONS);

/**
 * One order over dimensions and over the values inside each, or a refusal.
 *
 * Empty is accepted twice over, and both are the point rather than an oversight. A
 * preference with no ranks separates nothing and leaves a search exactly as it arrived,
 * which is what a gateway nobody has configured must do; and a rank with no values says
 * "I have no opinion in this dimension", which is how a category silences one the
 * household order cares about. See `isEmptyReleasePreference` — absent and empty are two
 * different sentences, and refusing the empty one would make the second unsayable.
 *
 * A dimension may appear once. Twice is not a stricter preference but an ambiguous one:
 * the comparator walks the ranks in order and the second occurrence would be dead
 * weight, silently ignored, with the screen showing two rows that disagree.
 *
 * Keys are checked as well as values, because `whitelist` stops at this property. The
 * pipe strips what a DTO does not declare, but a custom validator owns the whole subtree
 * — so anything this function does not refuse is written into the row verbatim and read
 * back on every search, and no route removes a settings row.
 */
const isReleasePreference = (value: unknown): boolean => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const keys = Object.keys(value);

	if (keys.some((key) => key !== 'ranks')) {
		return false;
	}

	const { ranks } = value as { ranks?: unknown };

	if (!Array.isArray(ranks) || ranks.length > RELEASE_PREFERENCE_DIMENSIONS.length) {
		return false;
	}

	const seen = new Set<string>();

	for (const rank of ranks) {
		if (typeof rank !== 'object' || rank === null || Array.isArray(rank)) {
			return false;
		}

		if (Object.keys(rank).some((key) => key !== 'dimension' && key !== 'values')) {
			return false;
		}

		const { dimension, values } = rank as { dimension?: unknown; values?: unknown };

		if (typeof dimension !== 'string' || !PREFERENCE_DIMENSIONS.has(dimension)) {
			return false;
		}

		if (seen.has(dimension)) {
			return false;
		}

		seen.add(dimension);

		if (!Array.isArray(values) || values.length > PREFERENCE_VALUES_LIMIT) {
			return false;
		}

		if (values.some((one) => typeof one !== 'string' || one.length > PREFERENCE_VALUE_MAX)) {
			return false;
		}
	}

	return true;
};

/**
 * The household order and the per-category ones, in one value.
 *
 * Both halves are required, which is the one rule here that is about storage rather than
 * about taste. The row is replaced wholesale and read back through a shape guard that
 * only asks whether it is still an object — so a body carrying `global` alone would be
 * stored, come back with no `byCategory`, and turn the first category lookup of the next
 * search into a thrown error. There is nothing to merge against either: a table's
 * entries are removals as much as additions, and cancelling an override *is* the missing
 * key.
 *
 * Keyed like `categoryTargets` and bounded like it, for the same reason: categories are
 * folded from library names and have no row of their own, so a key is a short identifier
 * we produced and never a name somebody typed.
 */
const IsReleasePreferences = (): PropertyDecorator => (target, propertyName) => {
	registerDecorator({
		name: 'isReleasePreferences',
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

				if (Object.keys(value).some((key) => key !== 'global' && key !== 'byCategory')) {
					return refuse(propertyName);
				}

				const { global, byCategory } = value as {
					global?: unknown;
					byCategory?: unknown;
				};

				if (!isReleasePreference(global)) {
					return refuse(propertyName);
				}

				if (typeof byCategory !== 'object' || byCategory === null || Array.isArray(byCategory)) {
					return refuse(propertyName);
				}

				const keys = Object.keys(byCategory);

				if (keys.length > PREFERENCE_CATEGORY_LIMIT) {
					return refuse(propertyName);
				}

				for (const key of keys) {
					if (key === '' || key.length > PREFERENCE_CATEGORY_KEY_MAX) {
						return refuse(propertyName);
					}

					if (!isReleasePreference((byCategory as Record<string, unknown>)[key])) {
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
/**
 * One indexer, as the settings screen sends it.
 *
 * The key is optional on the way in and never sent back out: a form cannot show what
 * is stored, so an empty box is the ordinary state of somebody editing the address
 * beside it — taking it literally would silently unauthenticate their indexer.
 */
export class IndexerDto {
	@ApiProperty({ enum: IndexerType })
	@IsEnum(IndexerType)
	public type!: IndexerType;

	@ApiProperty({ example: 'http://prowlarr:9696' })
	@IsString()
	@MaxLength(500)
	public baseUrl!: string;

	@ApiPropertyOptional({ description: 'Write-only. Blank keeps the stored key.' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public apiKey?: string | null;

	@ApiProperty()
	@IsBoolean()
	public enabled!: boolean;
}

/** One row of the client's path correspondence. The same shape a service uses. */
class ClientRootMappingDto implements RootMapping {
	@ApiProperty({ example: '/downloads' })
	public remoteRoot!: string;

	@ApiProperty({ example: '/share/torrents' })
	public localRoot!: string;
}

/** One download client. See `IndexerDto` for why the password is write-only. */
export class DownloadClientDto {
	@ApiProperty({ enum: DownloadClientType })
	@IsEnum(DownloadClientType)
	public type!: DownloadClientType;

	@ApiProperty({ example: 'http://qbittorrent:8080' })
	@IsString()
	@MaxLength(500)
	public baseUrl!: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(200)
	public username?: string | null;

	@ApiPropertyOptional({ description: 'Write-only. Blank keeps the stored password.' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public password?: string | null;

	/**
	 * Where the client's folders are, for us — the same statement a service makes.
	 *
	 * A client in its own container writes to `/downloads` and the gateway reaches the
	 * same directory at `/share/torrents`, which is word for word what `RootMapping`
	 * exists for. The same type, the same validator and the same field names, so a
	 * refusal lands under the input that is wrong exactly as it does on a server.
	 */
	@ApiProperty({ type: [ClientRootMappingDto] })
	// Without it, implicit conversion reads the declared array type and turns every
	// entry into an array of its own — see `CreateMediaServiceDto.rootMappings`.
	@Type(() => ClientRootMappingDto)
	@IsRootMappings()
	public rootMappings!: RootMapping[];

	@ApiPropertyOptional({
		description:
			'Where the client is told to write, in its own spelling. Defaults to the first '
			+ 'mapping’s remote root, which is what a client already configured needs.',
	})
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public savePath?: string | null;

	@ApiProperty()
	@IsBoolean()
	public enabled!: boolean;
}

/**
 * Where the household asks for things. See `IndexerDto` for why the key is write-only.
 *
 * Exactly the same convention, deliberately: this is the third secret on one screen, and
 * a second convention for the same problem is how one of the three ends up cleared by
 * somebody editing the address beside it.
 */
export class RequestSourceDto {
	@ApiProperty({ enum: RequestSourceType })
	@IsEnum(RequestSourceType)
	public type!: RequestSourceType;

	@ApiProperty({ example: 'http://jellyseerr:5055' })
	@IsString()
	@MaxLength(500)
	public baseUrl!: string;

	@ApiPropertyOptional({ description: 'Write-only. Blank keeps the stored key.' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	public apiKey?: string | null;

	@ApiProperty()
	@IsBoolean()
	public enabled!: boolean;
}

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
		additionalProperties: { type: 'string' },
		description:
			'Where a pull lands, per category: a category key to a library identifier or to one '
			+ 'of that library’s own roots. A category with no entry falls through to the default '
			+ 'target library.',
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
		description:
			'The indexer to search for releases nobody you know holds. The key is write-only: '
			+ 'leave it blank to keep the stored one.',
		type: () => IndexerDto,
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => IndexerDto)
	public indexer?: IndexerDto | null;

	@ApiPropertyOptional({
		description:
			'The torrent client that moves the bytes. The password is write-only, like the '
			+ 'indexer key.',
		type: () => DownloadClientDto,
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => DownloadClientDto)
	public downloadClient?: DownloadClientDto | null;

	/**
	 * Declared here or unreachable, like the two above it: the pipe runs with
	 * `whitelist`, so a key the DTO does not name is stripped before anything sees it.
	 * The screen would save, the answer would come back without the source, and the only
	 * symptom would be a request list that stays empty.
	 */
	@ApiPropertyOptional({
		description:
			'Where the household asks for things — a Seerr, Overseerr or Jellyseerr. The key is '
			+ 'write-only: leave it blank to keep the stored one.',
		type: () => RequestSourceDto,
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => RequestSourceDto)
	public requestSource?: RequestSourceDto | null;

	/**
	 * What a better copy is, as an order over dimensions and an order inside each.
	 *
	 * Checked by a validator of its own rather than by a nested DTO, for the reason
	 * `categoryTargets` is: half of the value is a table keyed by a category, which
	 * `@ValidateNested` cannot describe. The rules it enforces are in
	 * `IsReleasePreferences`, and the one worth knowing here is that an empty order and
	 * an empty rank are both accepted — they are answers, not unfinished forms.
	 */
	@ApiPropertyOptional({
		type: 'object',
		additionalProperties: true,
		description:
			'The order releases are offered in: one for the household and one per category. '
			+ 'Both halves have to be sent, because the row is replaced rather than merged.',
	})
	@IsReleasePreferences()
	public releasePreferences?: ReleasePreferenceSettings;

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
