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
}

export type UpdateSettingsRequest = Partial<Settings>;
