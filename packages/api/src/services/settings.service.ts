import { isAbsolute } from 'node:path';
import {
	DEFAULT_PEER_MAX_DEPTH,
	ErrorKey,
	MAX_PEER_MAX_DEPTH,
	NamingScheme,
	PlacementStrategy,
	type ErrorKeyValue,
	type Settings,
	type SettingsView,
	type UpdateSettingsRequest,
	ShareVisibility,
} from '@mcs/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PeersConfig } from '@/config/configuration';
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
	// Off: writing into somebody's library is not something to start doing unasked,
	// and a household that curates its own documents would find them replaced by ours.
	writeNfo: false,
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
	peerMaxDepth: DEFAULT_PEER_MAX_DEPTH,
	allowSwarm: true,
	rendezvousUrl: null,
	// A real level rather than silence, and it applies only to libraries on our own
	// services: a gateway whose libraries are all invisible until somebody visits a
	// screen looks broken to the friend who linked to it. See `effectiveVisibility`,
	// which resolves it per library at read time — nothing writes it into a row.
	defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS,
	instanceName: null,
	// Null, and deliberately not guessed from the first request that arrives: behind a
	// reverse proxy `Host` is whatever the proxy chose to forward, so a guess would be
	// wrong exactly on the installations that need this set. The interface offers its
	// own origin instead, where somebody can see it before accepting it.
	publicUrl: null,
	peerAddress: null,
	defaultTargetPath: null,
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
	// One is direct friends only, which has to stay reachable: it is the setting
	// somebody picks the day they stop wanting a wider circle. The ceiling is not a
	// round number chosen for looks — past it the set of gateways that may hear an
	// announcement stops resembling a circle of friends and starts resembling a
	// public index, which is a different thing to be running.
	peerMaxDepth: { min: 1, max: MAX_PEER_MAX_DEPTH },
};

/**
 * A refusal that names the field it is about.
 *
 * The field travels with the key because these are all saved from one form: without
 * it the interface can only put "something was refused" above the whole screen, and
 * the person has four boxes and no idea which one to change.
 */
const refuse = (field: keyof Settings, key: ErrorKeyValue): BadRequestException =>
	new BadRequestException({ key, field });

/**
 * An empty box is somebody clearing the setting, not a setting whose value is
 * nothing. A form hands back `''` for a field that was emptied, and storing that
 * leaves a value that is neither set nor unset — an empty path joined to a filename
 * is a relative path, and an empty origin concatenated to a share link is a link to
 * this gateway's own interface.
 */
const cleared = (value: string | null | undefined): string | null => value?.trim() || null;

/**
 * The origin of the public URL, and nothing else.
 *
 * Everything downstream concatenates onto this — the invitation, the share link, the
 * torrent announce — so a trailing slash or a path stored here becomes a double slash
 * or a wrong path in every one of them. Normalising once, here, is the only place
 * that can be got right: normalising at each use is how two of them end up disagreeing.
 */
export const normalisePublicUrl = (value: string | null | undefined): string | null => {
	const candidate = cleared(value);

	if (candidate === null) {
		return null;
	}

	let parsed: URL;

	try {
		parsed = new URL(candidate);
	} catch {
		// `mcs.example.org` with no scheme lands here, which is what most people type.
		throw refuse('publicUrl', ErrorKey.SETTINGS_PUBLIC_URL_INVALID);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw refuse('publicUrl', ErrorKey.SETTINGS_PUBLIC_URL_INVALID);
	}

	// `origin` drops the path, the query and a default port, and keeps a non-default
	// one — which is exactly the shape the rest of the application expects.
	return parsed.origin;
};

/**
 * `host:port`, with a port that has to be written out.
 *
 * A scheme is the usual slip here — peer traffic is not HTTP and has no default port
 * to fall back on — so `https://host:4210` is refused rather than quietly stripped:
 * silently accepting it teaches somebody a shape that is wrong everywhere else.
 */
const PEER_ADDRESS = new RegExp(
	'^(?:' +
		// A bracketed IPv6 literal, or a hostname or IPv4 address in labels.
		'\\[[0-9a-f:.]+\\]' +
		'|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*' +
		'):(\\d{1,5})$',
	'i',
);

export const normalisePeerAddress = (value: string | null | undefined): string | null => {
	const candidate = cleared(value);

	if (candidate === null) {
		return null;
	}

	const match = PEER_ADDRESS.exec(candidate);
	const port = match === null ? 0 : Number(match[1]);

	if (port < 1 || port > 65_535) {
		throw refuse('peerAddress', ErrorKey.SETTINGS_PEER_ADDRESS_INVALID);
	}

	// Lowercased because a hostname is case-insensitive and two rows that differ only
	// in case would otherwise read as two different gateways.
	return candidate.toLowerCase();
};

/**
 * An absolute path with no trailing slash and no way out of itself.
 *
 * Relative is refused for the reason a library path is: it resolves against whatever
 * directory the process was started in, which is not the same one in a container, in
 * a development shell and in a command. `..` is refused because a fallback target
 * that can climb out of where it was pointed is a fallback that can write anywhere.
 */
export const normaliseTargetPath = (value: string | null | undefined): string | null => {
	const candidate = cleared(value);

	if (candidate === null) {
		return null;
	}

	const segments = candidate.split('/');

	if (!isAbsolute(candidate) || segments.includes('..') || candidate.includes('\0')) {
		throw refuse('defaultTargetPath', ErrorKey.SETTINGS_TARGET_PATH_INVALID);
	}

	return candidate.length > 1 ? candidate.replace(/\/+$/, '') || '/' : candidate;
};

/**
 * The text settings that are stored in a shape rather than as typed.
 *
 * Kept as a table so that the write path and the read path cannot drift: one refuses
 * what does not normalise, the other falls back to the default, and both ask the same
 * question.
 */
const TEXT_NORMALISERS = {
	publicUrl: normalisePublicUrl,
	peerAddress: normalisePeerAddress,
	defaultTargetPath: normaliseTargetPath,
} as const;

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

	/**
	 * Settings the environment has taken out of the interface's hands.
	 *
	 * Resolved once at construction rather than read per request, for the reason
	 * nothing else reads `process.env` either: a pin that could change under a running
	 * process would let two requests in the same second disagree about whether a field
	 * is editable.
	 */
	private readonly _pinned: Partial<Settings>;

	public constructor(
		private readonly _settings: SettingRepository,
		private readonly _cache: CacheService,
		config: ConfigService,
	) {
		this._pinned = this._resolvePins(config.get<PeersConfig>('peers') ?? { maxDepth: null });
	}

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

		// Refused rather than ignored. Dropping a pinned field silently would let the
		// screen report a successful save for a value that did not move, which is the
		// one outcome nobody can debug: the form redisplays the stored value, somebody
		// concludes they mistyped it, and tries again.
		for (const field of this.pinnedFields) {
			const submitted = patch[field];

			if (submitted !== undefined && submitted !== current[field]) {
				throw new BadRequestException({ key: ErrorKey.SETTINGS_PINNED, field });
			}
		}

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

		const pinned = this._applyPins(next);

		this._cached = pinned;
		this._cache.setDefaultTtl(pinned.cacheTtlSeconds);

		return pinned;
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

		// Pins are applied last, over the clamped value. A pinned field that is also out
		// of bounds is a contradiction the deployment created, and the bound wins: a
		// gateway that refused to start over its own environment would be unfixable
		// from the only screen that could fix it.
		return this._applyPins(this._clamp(merged));
	}

	/**
	 * Which settings the environment decided, and to what.
	 *
	 * Each pin is bounded here rather than trusted, because an environment variable is
	 * as capable of holding nonsense as a form is, and a pinned nonsense value cannot
	 * be corrected from the interface — which is the whole point of pinning it.
	 */
	private _resolvePins(peers: PeersConfig): Partial<Settings> {
		const pinned: Partial<Settings> = {};

		if (peers.maxDepth !== null) {
			const bounds = NUMERIC_BOUNDS.peerMaxDepth!;

			pinned.peerMaxDepth = Math.min(Math.max(Math.trunc(peers.maxDepth), bounds.min), bounds.max);

			if (pinned.peerMaxDepth !== peers.maxDepth) {
				this._logger.warn(
					`MCS_PEER_MAX_DEPTH=${peers.maxDepth} is out of range, using ${pinned.peerMaxDepth}`,
				);
			}
		}

		return pinned;
	}

	private _applyPins(settings: Settings): Settings {
		return { ...settings, ...this._pinned };
	}

	/** The field names the interface must show as read-only. */
	public get pinnedFields(): (keyof Settings)[] {
		return Object.keys(this._pinned) as (keyof Settings)[];
	}

	/**
	 * The settings as a screen needs them: values, plus what it may not offer to change.
	 *
	 * A separate method rather than widening `get()`, because everything else in the
	 * application wants the values and would have to remember to ignore a field that
	 * only means something to a form.
	 */
	public async view(): Promise<SettingsView> {
		return { ...(await this.get()), pinned: this.pinnedFields as string[] };
	}

	private _validate(candidate: Settings): Settings {
		const normalised = { ...candidate };

		// Normalised on the way in rather than on the way out, so the row holds the
		// shape everything downstream assumes and no reader has to re-derive it.
		for (const [key, normalise] of Object.entries(TEXT_NORMALISERS)) {
			(normalised as Record<string, unknown>)[key] = normalise(
				candidate[key as keyof typeof TEXT_NORMALISERS],
			);
		}

		return this._checkBounds(normalised);
	}

	private _checkBounds(candidate: Settings): Settings {
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

		// The same rule one type over. A public URL that got into the table some other
		// way — a hand-edited row, a downgrade — would otherwise be held against every
		// later write, and the screen where somebody would have corrected it is the
		// screen that saves them all at once.
		for (const [key, normalise] of Object.entries(TEXT_NORMALISERS)) {
			try {
				(clamped as Record<string, unknown>)[key] = normalise(
					clamped[key as keyof typeof TEXT_NORMALISERS],
				);
			} catch {
				this._logger.warn(`Setting "${key}" is not usable, falling back to its default`);

				(clamped as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key as keyof Settings];
			}
		}

		return clamped;
	}
}
