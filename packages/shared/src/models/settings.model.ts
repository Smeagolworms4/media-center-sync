/** Where pulled media goes when nothing more specific says otherwise. */
export enum PlacementStrategy {
	/**
	 * Next to our own copy of the same series or collection. Keeps a library that
	 * is already tidy tidy, which is what most people want.
	 */
	BESIDE_EXISTING = 'beside_existing',
	/** Always into the library marked as the default target for that kind. */
	DEFAULT_LIBRARY = 'default_library',
	/** Into a fixed path, whatever the media is. */
	FIXED_PATH = 'fixed_path',
}

/** How the file is named once placed. */
export enum NamingScheme {
	/** Keep the name the source used. */
	SOURCE = 'source',
	/** Rename to match what our own library already does. */
	LOCAL = 'local',
	/** `Show (Year)/Season 01/Show - S01E02 - Title.ext` */
	STANDARD = 'standard',
}

export interface Settings {
	placement: PlacementStrategy;
	fixedPath: string | null;
	naming: NamingScheme;
	/** Also copy artwork, subtitles and `.nfo` files alongside the media. */
	pullMetadata: boolean;
	/** Overwrite local metadata with the source's when it is richer. */
	preferSourceMetadata: boolean;
	/** How many transfers run at once. */
	maxParallelTransfers: number;
	/**
	 * Free space the gateway will not knowingly eat into.
	 *
	 * A disk filled to the last byte does not fail politely: the transfer dies at
	 * ninety per cent with `ENOSPC`, the media server indexes the truncated file as a
	 * real one, and whoever notices does so days later from a film that stops halfway.
	 * A run that would cross this floor is reported as tight and needs saying so out
	 * loud; one that would not fit at all is refused outright.
	 */
	diskReserveBytes: number;
	/** How many connections a single transfer opens against one source. */
	maxConnectionsPerSource: number;
	chunkSize: number;
	/** Global cap in bytes per second. 0 means no cap. */
	downloadRateLimit: number;
	uploadRateLimit: number;
	/** Below this score a correlation is proposed but not applied. */
	matchThreshold: number;
	/** Let friends of friends reach us at all. */
	allowFriendsOfFriends: boolean;
	/** Use the encapsulated swarm when several peers hold the same file. */
	allowSwarm: boolean;
	rendezvousUrl: string | null;
	/** Keep finished transfers in the list for this many days. */
	transferHistoryDays: number;

	/**
	 * How often the gateway asks a service what changed, in minutes.
	 *
	 * The interface never queries a media service directly: it reads the gateway's
	 * own index, which is what makes a library of forty thousand episodes browsable
	 * at all. That index is kept current by asking each service for its own list of
	 * recent additions — a few dozen rows — rather than by re-reading everything.
	 */
	refreshIntervalMinutes: number;

	/**
	 * Cron expression for the full rescan.
	 *
	 * A refresh only sees what a service reports as new. Files moved, deleted or
	 * re-encoded in place go unnoticed, so a full pass still has to happen — rarely,
	 * at an hour nobody is watching. Empty disables it; the button in the interface
	 * always works.
	 */
	fullScanCron: string | null;

	/**
	 * How long a service answer stays good, in seconds.
	 *
	 * Short enough that a freshly added episode shows up, long enough that ten open
	 * tabs cost one request instead of ten.
	 */
	cacheTtlSeconds: number;
}

export type UpdateSettingsRequest = Partial<Settings>;
