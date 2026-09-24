import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
	IsBoolean,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUrl,
	Max,
	MaxLength,
	Min,
	registerDecorator,
} from 'class-validator';
import {
	ErrorKey,
	findRootMappingFault,
	MediaServiceType,
	ROOT_MAPPING_LIMIT,
	ROOT_MAPPING_PATH_MAX,
	type RootMapping,
} from '@mcs/shared';

/**
 * Refuse a list of mappings by key, on the one input that is wrong.
 *
 * Thrown from inside the validator rather than returned as false, and that is the
 * point of this decorator. The pipe's own refusal is a list of English sentences
 * naming `rootMappings` as a whole; the form renders one input per side of each row,
 * so a sentence about the list lands on no input at all and somebody presses save
 * against a screen that shows nothing wrong. `{ key, field }` names the side of the
 * row — `rootMappings.1.remoteRoot` — which is exactly the input the form declared.
 *
 * `undefined` is a request that says nothing about the mappings, which on an update
 * leaves the stored list alone. `null` is refused rather than read as "clear": an
 * empty list already says that, and two spellings for one instruction is how a
 * client ends up sending the one nobody tested.
 */
// Exported, because a download client makes the very same statement about the very
// same kind of path — see `settings.dto`. A second copy of this rule would drift, and
// the day it did the two screens would disagree about what a valid mapping is.
export const IsRootMappings = (): PropertyDecorator => (target, propertyName) => {
	registerDecorator({
		name: 'isRootMappings',
		target: target.constructor,
		propertyName: propertyName as string,
		validator: {
			validate(value: unknown): boolean {
				if (value === undefined) {
					return true;
				}

				const field = String(propertyName);
				const refuse = (key: string, at: string = field): never => {
					throw new BadRequestException({ key, field: at });
				};

				if (!Array.isArray(value) || value.length > ROOT_MAPPING_LIMIT) {
					return refuse(ErrorKey.SERVICE_MAPPING_INVALID);
				}

				for (const [index, entry] of (value as unknown[]).entries()) {
					const pair = entry as Record<string, unknown> | null;
					const shaped = typeof pair === 'object' && pair !== null && !Array.isArray(pair)
						&& Object.keys(pair).every((key) => key === 'remoteRoot' || key === 'localRoot');

					if (!shaped) {
						return refuse(ErrorKey.SERVICE_MAPPING_INVALID, `${field}.${index}`);
					}

					for (const side of ['remoteRoot', 'localRoot'] as const) {
						const path = pair[side] ?? '';

						if (typeof path !== 'string' || path.length > ROOT_MAPPING_PATH_MAX) {
							return refuse(ErrorKey.SERVICE_MAPPING_INVALID, `${field}.${index}.${side}`);
						}
					}
				}

				const fault = findRootMappingFault(
					(value as Partial<RootMapping>[]).map((pair) => ({
						remoteRoot: pair.remoteRoot ?? '',
						localRoot: pair.localRoot ?? '',
					})),
				);

				if (fault !== null) {
					return refuse(fault.key, `${field}.${fault.index}.${fault.side}`);
				}

				return true;
			},
		},
	});
};

/** The shape of one mapping, for the API description only: validation is above. */
class RootMappingDto implements RootMapping {
	@ApiProperty({ example: '/data/movies' })
	public remoteRoot!: string;

	@ApiProperty({ example: '/mnt/nas1/movies' })
	public localRoot!: string;
}

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
	 * Where the service's disks are, for us: one server prefix and one local directory
	 * per disk.
	 *
	 * Stated once per disk so that every library under the service derives its own
	 * local path, instead of six libraries being six paths to type. A library's own
	 * `localPath` still wins: that field is for the exceptions this cannot express.
	 * Omitted on an update leaves the stored list alone; an empty list withdraws it.
	 */
	@ApiPropertyOptional({ type: [RootMappingDto] })
	// Without it, implicit conversion reads the declared array type and turns every
	// entry into an array of its own — `[{ remoteRoot }]` arrives as `[[]]`, and the
	// validator below refuses a perfectly good body as malformed.
	@Type(() => RootMappingDto)
	@IsRootMappings()
	public rootMappings?: RootMapping[];
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

/**
 * Which part of a media server's own filesystem to describe.
 *
 * `path` carries a path that belongs to the *server*, so nothing here validates its
 * shape: a Plex on Windows answers `D:\Media\Shows`, and an absolute-POSIX rule would
 * refuse the very string the server itself handed us one request earlier. It is never
 * opened, joined or resolved on this side — it goes back to the handler that produced
 * it — so the length cap is all this layer can honestly assert.
 */
export class ServerStructureDto {
	@ApiPropertyOptional({ description: 'Restrict the roots to one library, by its external id.' })
	@IsOptional()
	@IsString()
	@MaxLength(255)
	public libraryExternalId?: string;

	@ApiPropertyOptional({ description: 'Walk into this directory, as the server spells it.' })
	@IsOptional()
	@IsString()
	@MaxLength(4096)
	public path?: string;
}
