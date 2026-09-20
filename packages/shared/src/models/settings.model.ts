import { ShareVisibility } from './share.model';
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
	/**
	 * How far introductions may travel, in hops. 1 is direct friends only.
	 *
	 * Replaces the earlier yes/no on friends of friends, which could only say "one
	 * hop" or "unlimited" and meant the second in practice: there was no number to
	 * stop at, so an announcement propagated as far as the network happened to reach.
	 *
	 * This is a ceiling over the whole gateway. Each peer carries its own
	 * `maxDepth` for the circle behind them, and the effective distance is the
	 * smallest budget any hop allowed — so lowering this is always safe and raising
	 * it never overrules somebody else's choice.
	 *
	 * See `DEFAULT_PEER_MAX_DEPTH` and `MAX_PEER_MAX_DEPTH`.
	 */
	peerMaxDepth: number;
	/** Use the encapsulated swarm when several peers hold the same file. */
	allowSwarm: boolean;
	rendezvousUrl: string | null;

	/**
	 * How this gateway is reached from outside, origin only — `https://mcs.example.org`.
	 *
	 * The gateway had no idea of its own address, so an invitation handed a friend an
	 * identity and no way to use it: they had to be told where we live out of band,
	 * which is the step people get wrong. It is also what a share link and a torrent
	 * announce have to carry, and neither can be built from a request that arrived
	 * through a reverse proxy — `Host` is whatever the proxy chose to forward.
	 *
	 * Null means nobody has set it, and the interface offers its own origin as the
	 * default, because the browser reached this gateway somehow and that address is
	 * almost always the right answer. Almost, not always: a gateway administered over
	 * `http://192.168.0.12:4200` and reached by friends over a domain name would
	 * otherwise announce a private address, so it is offered and never assumed.
	 */
	/**
	 * What this gateway calls itself to other people.
	 *
	 * Falls back to the machine's hostname, which is why it exists: in a container the
	 * hostname is a random hex string, so friends were being shown `d9b90135` where
	 * they expected "Living room" or "The NAS". A name is the only part of an identity
	 * a person actually reads — the fingerprint is what the software compares, and
	 * nobody recognises a friend by it.
	 *
	 * Null means nobody chose one, and the hostname stands. It is deliberately not
	 * defaulted to a pretty string at install time: a gateway called "Media Center
	 * Sync" on both ends of a link is worse than two hostnames.
	 */
	/**
	 * What a library of ours is visible to before anybody configures it.
	 *
	 * A gateway whose libraries are all invisible until somebody visits a screen is a
	 * gateway that appears broken to the friend who linked to it — they see an empty
	 * shelf and conclude the link failed. The default is therefore a real level, not
	 * silence.
	 *
	 * **It applies only to libraries on our own services.** A library on a remote
	 * Jellyfin or Plex stays private whatever this says, because sharing one of those
	 * makes us the conduit for it — our bandwidth, and an access granted to us rather
	 * than to the people we would be handing it to. That is consent
	 * (`SharePolicy.relay`), and a default is not consent.
	 */
	defaultShareVisibility: ShareVisibility;

	instanceName: string | null;

	publicUrl: string | null;

	/**
	 * Where peers connect, when that is not the public URL's host and the peer port.
	 *
	 * `host:port`. Peer traffic does not go through the web server — it is its own
	 * listener on its own port — so a gateway behind a reverse proxy, or with the peer
	 * port forwarded to a different external one, cannot have this derived from the
	 * URL above. Null means: take the public URL's host and the configured peer port,
	 * which is right whenever somebody has not gone out of their way.
	 */
	peerAddress: string | null;

	/**
	 * Where a pull lands when nothing else decides.
	 *
	 * Distinct from `fixedPath`, which only applies under the fixed-path strategy and
	 * means "everything goes here whatever it is". This is the fallback for the
	 * ordinary strategies: a media whose category has no writable library, or a
	 * library whose local path is not set, has to land somewhere nameable rather than
	 * failing at the end of a completed download.
	 */
	defaultTargetPath: string | null;
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

/**
 * Settings, plus what the deployment has taken out of the interface's hands.
 *
 * A field named here is pinned by the environment: the stored value is ignored, the
 * API refuses to change it, and the interface shows it disabled with a word about
 * why. Without this the screen would offer a control that silently did nothing —
 * somebody raises a limit, saves, sees a success notice, and the limit has not
 * moved, which is the worst of the three possible behaviours.
 *
 * It exists for whoever runs a gateway for other people: a ceiling set in the
 * container's environment is one the account holders cannot quietly lift.
 */
export interface SettingsView extends Settings {
	/** Field names pinned by the environment, and therefore read-only. */
	pinned: string[];
}
