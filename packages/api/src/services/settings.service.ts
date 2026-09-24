import { isAbsolute } from 'node:path';
import {
	DEFAULT_RELEASE_PREFERENCES,
	DEFAULT_NAMING_ORDER,
	DEFAULT_PEER_MAX_DEPTH,
	ErrorKey,
	isNamingConvention,
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
	// Empty, because a category nobody has answered for has no right answer: guessing
	// one would file somebody's first anime in whichever library happened to carry the
	// default-target flag, which is exactly the silent wrong destination this table was
	// added to stop. With no entry the preference order below still lands the file
	// somewhere a media server scans.
	categoryTargets: {},
	// Null, so nothing changes for a gateway that never opens the screen. Defaulting it
	// to the library that happens to be marked as the default target would look like the
	// same behaviour and then diverge the day somebody moves that flag.
	defaultTargetLibraryId: null,
	// The source name first, because that is what every gateway already does and a
	// default that renamed files would rename them on somebody who never asked. See
	// `DEFAULT_NAMING_ORDER`, and `migrateNamingOrder` for what happens to a gateway
	// that chose one of the old exclusive schemes.
	namingOrder: [...DEFAULT_NAMING_ORDER],
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
	// Off: a gateway that kept a peer for every file it ever pulled from a friend of a
	// friend would end up linked to a circle nobody chose, dialling all of them at
	// every restart. The link is opened for the transfer and closes with it, and
	// keeping one is a deliberate click.
	keepDiscoveredPeers: false,
	// Off: carrying a link between two friends spends this household's upload on a
	// transfer it gets nothing from, and every byte of it crosses this machine in
	// plaintext. A gateway that did that unasked would be a bad neighbour, and the
	// capability is only advertised once somebody has said yes — see `relayForPeers`.
	relayForPeers: false,
	allowSwarm: true,
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
	defaultTargetPath: null,
	// Nothing configured, which is the honest default: an indexer is somebody else's
	// server and a download client is somebody else's daemon, and guessing at either
	// would be a search that fails for a reason nobody can see.
	// Nothing ranked, so a gateway nobody configured leaves the order exactly as it
	// arrives: seeders and size, which is what it was before anybody could say otherwise.
	releasePreferences: DEFAULT_RELEASE_PREFERENCES,
	indexer: null,
	downloadClient: null,
	// The same, and for a third reason: a gateway that guessed at a request source would
	// be reading somebody's household's asks without having been asked to.
	requestSource: null,
	transferHistoryDays: 30,
	// Six months, against thirty days for what succeeded. A failure is the only record
	// that a file was ever attempted, and the person who needs it is looking months
	// later at a series with a hole in it — which is exactly the moment a thirty-day
	// window would have removed the row that explains the hole.
	failedHistoryDays: 180,
	refreshIntervalMinutes: 15,
	fullScanCron: '0 4 * * *',
	cacheTtlSeconds: 60,
	// Nothing dismissed, because nothing has been shown yet. Kept as a list of keys
	// rather than a flag per hint so that a hint added in a later version simply has no
	// key here and appears, instead of arriving already silenced.
	dismissedLibraryHints: [],
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
	failedHistoryDays: { min: 0, max: 3650 },
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
 * The naming order as the rest of the application is allowed to assume it is.
 *
 * Null rather than a thrown refusal, because the two callers want opposite things
 * from the same question: a write is rejected so the person sees which field was
 * wrong, and a read falls back to the default so a gateway whose table somebody
 * hand-edited still starts — starting is how it gets fixed.
 *
 * The rules are what make the chain a chain. A step that appears twice is a step
 * that can never run the second time, and a convention anywhere but at the end kills
 * every step behind it: both are orders somebody wrote meaning something the gateway
 * would not do, and an order that quietly does less than it says is the defect this
 * whole rebuild exists to end. The last step has to be a convention because a chain
 * whose every step may hand on has no answer, and "no answer" arrives at the end of a
 * completed download.
 */
export const checkedNamingOrder = (value: unknown): NamingScheme[] | null => {
	if (!Array.isArray(value) || value.length === 0) {
		return null;
	}

	const steps = value as NamingScheme[];
	const known = Object.values(NamingScheme);

	if (steps.some((step) => !known.includes(step)) || new Set(steps).size !== steps.length) {
		return null;
	}

	if (!isNamingConvention(steps[steps.length - 1]) || steps.slice(0, -1).some((step) => isNamingConvention(step))) {
		return null;
	}

	return steps;
};

/**
 * The order a gateway that chose one of the old exclusive schemes should keep.
 *
 * Settings are key/value rows, so an upgraded gateway simply has no `namingOrder`
 * row and would take the default — which for somebody who deliberately picked
 * `standard` means every future pull is suddenly named after its source instead.
 * That is a setting changing itself during an upgrade, discovered from files, so the
 * old row is read once and turned into the chain that does what it used to do.
 *
 * `source` maps to the full default rather than to `[SOURCE, STANDARD]`: what it
 * gains is imitation for the one case the old scheme had no answer for — a peer that
 * sent metadata and no path — and landing that file beside its siblings rather than
 * under a template name is the behaviour the old scheme was reaching for anyway.
 */
export const namingOrderFromScheme = (legacy: unknown): NamingScheme[] | null => {
	switch (legacy) {
		case NamingScheme.SOURCE:
			return [...DEFAULT_NAMING_ORDER];

		case NamingScheme.LOCAL:
			return [NamingScheme.LOCAL, NamingScheme.STANDARD];

		case NamingScheme.STANDARD:
			return [NamingScheme.STANDARD];

		default:
			return null;
	}
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
	defaultTargetPath: normaliseTargetPath,
	// An emptied select hands back `''`, and storing that leaves a library identifier
	// that is neither set nor unset: it matches nothing, so placement would report the
	// configured library as gone and say so on every transfer.
	defaultTargetLibraryId: cleared,
} as const;

/**
 * Is a stored value the shape its default says it should be?
 *
 * A stored value of the wrong shape is ignored rather than coerced: a `chunkSize` of
 * `"8MB"` coerced to `NaN` would produce a transfer plan of zero chunks, which fails
 * much later and much less clearly.
 *
 * The null default is the case worth spelling out. Comparing `typeof` against the
 * default alone answers `object` for every setting that defaults to null — which is
 * every optional string we have — so a stored `publicUrl`, `instanceName` or
 * `defaultTargetLibraryId` was dropped on the way out of the database. Nothing
 * reported it, because the write path keeps its own copy in memory and answers every
 * read from it: the value came back correctly until the process restarted, and then
 * it was simply gone.
 */
const fitsTheShapeOf = (value: unknown, fallback: unknown): boolean => {
	// A list before a table, because an array is an object and would otherwise be
	// refused by the branch below — which is how the naming order, whose whole value is
	// that it is an order, would have been dropped on the way out of the database and
	// come back as the default after every restart.
	if (Array.isArray(fallback)) {
		return Array.isArray(value);
	}

	// A table has no sensible "unset": every reader indexes into it, so a stored null
	// would turn the first lookup into a thrown error, where an empty table already
	// says that nothing has been answered for.
	if (fallback !== null && typeof fallback === 'object') {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	if (value === null) {
		return true;
	}

	// Null says what a setting is not worth, never what it holds, so there is no type
	// to compare against — and every setting that defaults to null holds a string.
	// Refusing anything else is what keeps this guard worth having.
	if (fallback === null) {
		return typeof value === 'string';
	}

	return typeof value === typeof fallback;
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

			if (value === undefined) {
				continue;
			}

			if (fitsTheShapeOf(value, DEFAULT_SETTINGS[key])) {
				(merged as Record<string, unknown>)[key] = value;
			}
		}

		// A gateway upgraded from the single naming scheme has no order row at all, and
		// taking the default there would silently rename every future pull for somebody
		// who had deliberately chosen otherwise.
		if (stored.namingOrder === undefined) {
			merged.namingOrder = namingOrderFromScheme(stored.naming) ?? merged.namingOrder;
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
	/**
	 * Takes only the field it reads, so the fallback below does not have to invent
	 * values for the rest of `PeersConfig` — none of which pins a setting.
	 */
	private _resolvePins(peers: Pick<PeersConfig, 'maxDepth'>): Partial<Settings> {
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

		if (checkedNamingOrder(candidate.namingOrder) === null) {
			throw new BadRequestException({ key: ErrorKey.SETTINGS_INVALID, field: 'namingOrder' });
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

		// An order that does not hold together is repaired rather than obeyed: a chain
		// ending on a step that can hand on would leave a finished transfer with no name,
		// which fails far from here and looks like a transfer bug.
		const order = checkedNamingOrder(clamped.namingOrder);

		if (order === null) {
			this._logger.warn('Setting "namingOrder" is not a usable chain, falling back to its default');

			clamped.namingOrder = [...DEFAULT_NAMING_ORDER];
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
