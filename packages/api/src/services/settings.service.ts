import {
	ErrorKey,
	NamingScheme,
	PlacementStrategy,
	type Settings,
	type UpdateSettingsRequest,
} from '@mcs/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SettingRepository } from '@/repositories';
import { CacheService } from './cache.service';

/**
 * What a gateway does before anybody has configured it.
 *
 * Every one of these is a defensible answer on a home machine with one media
 * server and a domestic connection — four parallel transfers and four connections
 * each saturate a gigabit link without making the media server unusable, and the
 * source naming scheme changes nothing about files somebody already has.
 */
export const DEFAULT_SETTINGS: Settings = {
	placement: PlacementStrategy.BESIDE_EXISTING,
	fixedPath: null,
	naming: NamingScheme.SOURCE,
	pullMetadata: true,
	preferSourceMetadata: false,
	maxParallelTransfers: 3,
	// Five gigabytes, which is roughly one film and comfortably more than the
	// companions, the thumbnails and the filesystem's own bookkeeping. Low enough that
	// it does not refuse a run on a modest disk, high enough that a library filled to
	// this floor still leaves the machine able to write its logs — a disk at exactly
	// zero free bytes takes everything else on the host down with it, not just the
	// transfer.
	diskReserveBytes: 5 * 1024 * 1024 * 1024,
	maxConnectionsPerSource: 4,
	chunkSize: 8 * 1024 * 1024,
	downloadRateLimit: 0,
	uploadRateLimit: 0,
	matchThreshold: 0.8,
	allowFriendsOfFriends: false,
	allowSwarm: true,
	rendezvousUrl: null,
	transferHistoryDays: 30,
	refreshIntervalMinutes: 15,
	fullScanCron: '0 4 * * *',
	cacheTtlSeconds: 60,
};

/** Bounds that keep a typo from taking the gateway, or the media server, down. */
const NUMERIC_BOUNDS: Partial<Record<keyof Settings, { min: number; max: number }>> = {
	maxParallelTransfers: { min: 1, max: 32 },
	// Zero is allowed and means "fill it to the last byte", which is a decision
	// somebody may legitimately make on a disk that holds nothing else. The ceiling is
	// a terabyte: past that the reserve is larger than most libraries, and every run
	// would be refused for room that is never going to be used.
	diskReserveBytes: { min: 0, max: 1024 * 1024 * 1024 * 1024 },
	maxConnectionsPerSource: { min: 1, max: 16 },
	chunkSize: { min: 64 * 1024, max: 256 * 1024 * 1024 },
	downloadRateLimit: { min: 0, max: Number.MAX_SAFE_INTEGER },
	uploadRateLimit: { min: 0, max: Number.MAX_SAFE_INTEGER },
	matchThreshold: { min: 0, max: 1 },
	transferHistoryDays: { min: 0, max: 3650 },
	refreshIntervalMinutes: { min: 1, max: 1440 },
	cacheTtlSeconds: { min: 1, max: 3600 },
};

/**
 * The settings, as key/value rows with the defaults filled in.
 *
 * Stored one row per key rather than one row of everything so that a setting added
 * in a later version has a default instead of a migration, and so two screens saving
 * at the same time cannot overwrite each other's unrelated fields.
 */
@Injectable()
export class SettingsService {
	private readonly _logger = new Logger(SettingsService.name);

	/**
	 * Read far too often to go to the database each time — every transfer tick, every
	 * placement decision — and small enough to hold. Invalidated on write, which is
	 * the only way it changes, this being a single gateway rather than a cluster.
	 */
	private _cached: Settings | null = null;

	public constructor(
		private readonly _settings: SettingRepository,
		private readonly _cache: CacheService,
	) {}

	public async get(): Promise<Settings> {
		if (this._cached) {
			return this._cached;
		}

		const rows = await this._settings.findAllAsMap();
		const stored: Record<string, unknown> = {};

		for (const [key, raw] of rows) {
			try {
				stored[key] = JSON.parse(raw);
			} catch {
				// A row written by hand, or by an older version. The default is a better
				// answer than refusing to start.
				this._logger.warn(`Setting "${key}" is not readable, using the default`);
			}
		}

		const merged = this._merge(stored);

		this._cached = merged;
		this._cache.setDefaultTtl(merged.cacheTtlSeconds);

		return merged;
	}

	public async getValue<K extends keyof Settings>(key: K): Promise<Settings[K]> {
		return (await this.get())[key];
	}

	public async update(patch: UpdateSettingsRequest): Promise<Settings> {
		const current = await this.get();
		const next = this._validate({ ...current, ...patch });
		const rows: Record<string, string> = {};

		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) {
				continue;
			}

			// Stored as JSON rather than as a raw string so a boolean comes back a
			// boolean and a null stays distinguishable from the string "null". Only the
			// keys that were sent are written: the table is sparse, and a key with no
			// row is a key still on its default.
			rows[key] = JSON.stringify(next[key as keyof Settings]);
		}

		await this._settings.putMany(rows);

		this._cached = next;
		this._cache.setDefaultTtl(next.cacheTtlSeconds);

		return next;
	}

	/** Drops the cached copy. For the tests, and for a restore from a backup. */
	public invalidate(): void {
		this._cached = null;
	}

	private _merge(stored: Record<string, unknown>): Settings {
		const merged = { ...DEFAULT_SETTINGS };

		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
			const value = stored[key];

			// A stored value of the wrong shape is ignored rather than coerced: a
			// `chunkSize` of `"8MB"` coerced to `NaN` would produce a transfer plan of
			// zero chunks, which fails much later and much less clearly.
			if (value === undefined) {
				continue;
			}

			if (value === null || typeof value === typeof DEFAULT_SETTINGS[key]) {
				(merged as Record<string, unknown>)[key] = value;
			}
		}

		return this._clamp(merged);
	}

	private _validate(candidate: Settings): Settings {
		if (
			candidate.placement === PlacementStrategy.FIXED_PATH &&
			!candidate.fixedPath?.trim()
		) {
			// Accepting this would leave the gateway with a placement strategy it cannot
			// execute, discovered only when a transfer finishes and has nowhere to go.
			throw new BadRequestException({
				key: ErrorKey.SETTINGS_INVALID,
				field: 'fixedPath',
			});
		}

		if (!Object.values(PlacementStrategy).includes(candidate.placement)) {
			throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: 'placement' });
		}

		if (!Object.values(NamingScheme).includes(candidate.naming)) {
			throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: 'naming' });
		}

		for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
			const value = candidate[key as keyof Settings];

			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: key });
			}

			if (value < bounds.min || value > bounds.max) {
				throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: key });
			}
		}

		return candidate;
	}

	/**
	 * Bring a stored value back inside its bounds instead of refusing to boot.
	 *
	 * Writes are validated and rejected; reads are clamped. A row that got out of
	 * range some other way — an edited database, a downgrade — must not stop the
	 * gateway from starting, because starting is how somebody fixes it.
	 */
	private _clamp(settings: Settings): Settings {
		const clamped = { ...settings };

		for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
			const value = clamped[key as keyof Settings];

			if (typeof value !== 'number' || !Number.isFinite(value)) {
				(clamped as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key as keyof Settings];

				continue;
			}

			(clamped as Record<string, unknown>)[key] = Math.min(
				Math.max(value, bounds.min),
				bounds.max,
			);
		}

		return clamped;
	}
}
