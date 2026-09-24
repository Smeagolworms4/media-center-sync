import type { ReleasePreferenceSettings } from './preference.model';
import type { DownloadClientSettings, IndexerSettings } from './release.model';
import type { RequestSourceSettings } from './request.model';
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

/**
 * One step of the chain that names a placed file.
 *
 * These were three exclusive values behind a single select, which could not say what
 * people actually want — "keep the source name, but follow my own library when it has
 * something to follow" is an order, not a choice — and hid the fallbacks: `LOCAL` with
 * no sibling to imitate silently produced a standard name that nobody had asked for.
 * Each value is now a step that either answers or hands on to the next.
 *
 * Only the folders are not negotiable. Where a file goes is the placement rule's
 * question and is decided before any of this; these decide what it is called.
 */
export enum NamingScheme {
	/**
	 * Keep the name the source used. Answers unless the source sent no path at all.
	 *
	 * The safe one, and the reason it is first by default: it chooses nothing. The
	 * folder above already tells both media servers what the file is, so renaming it
	 * buys little and every renaming scheme encodes an assumption that is wrong on
	 * some library. See the doc block on `NamingService`.
	 */
	SOURCE = 'source',
	/**
	 * Rename to match what our own library already does. Answers when it has a
	 * sibling file to imitate, and hands on when it has none.
	 */
	LOCAL = 'local',
	/** `Show - S01E02 - Title.ext` — the spaced convention. Always answers. */
	STANDARD = 'standard',
	/**
	 * `Show.Year.S01E03.Title.ext` — the dotted convention scene releases use and a
	 * great many Plex libraries are filled with. Always answers.
	 */
	DOTTED = 'dotted',
}

/**
 * The steps that cannot fail to produce a name, so one of them has to come last.
 *
 * A chain whose last step may hand on has no answer for the case where every step
 * does, and "no answer" at the end of a completed download is a file with nowhere to
 * land. Kept beside the enum rather than spelled out in the service, the validator
 * and the settings screen, because three copies would disagree the day a convention
 * is added.
 */
export const NAMING_CONVENTIONS: NamingScheme[] = [NamingScheme.STANDARD, NamingScheme.DOTTED];

/** Whether a step always answers, and therefore may only appear last. */
export const isNamingConvention = (step: NamingScheme): boolean =>
	NAMING_CONVENTIONS.includes(step);

/**
 * Keep the source name; failing that follow our own library; failing that the spaced
 * convention.
 *
 * The source name stays first because that is what every gateway already does and
 * changing it would rename files somebody is not expecting to be renamed. What the
 * middle step adds is the case that had no good answer before: a peer that sent
 * metadata and no path used to get a template-built name even when the library right
 * there had a dozen episodes to copy the spelling from.
 */
export const DEFAULT_NAMING_ORDER: NamingScheme[] = [
	NamingScheme.SOURCE,
	NamingScheme.LOCAL,
	NamingScheme.STANDARD,
];

export interface Settings {
	placement: PlacementStrategy;
	fixedPath: string | null;
	/**
	 * Which library receives a pull, per category. Category key to library id.
	 *
	 * This is the answer to "where does a new series land", and it had none: the
	 * gateway picked from whichever library carried `isDefaultTarget` for the right
	 * kind, which is one answer for every category of that kind. A household with
	 * `Films`, `Animés` and `Documentaires` on three disks could not say so, and the
	 * strategy select on the settings screen did not mention any of it — so a first
	 * pull of an unknown series landed somewhere no setting named.
	 *
	 * The destination is a **library**, not a path: a library is a real directory the
	 * gateway has already probed for write access, and it is what the media server
	 * scans. A raw path could be somewhere no server ever looks, which is the failure
	 * this whole area exists to prevent.
	 *
	 * It only ever decides where something *new* goes. A series we already hold is
	 * filed beside its own episodes, whatever this says — see `NamingScheme.LOCAL`
	 * and the sibling path. Overruling that would split a season across two folders,
	 * which is worse than either answer on its own.
	 *
	 * A category with no entry falls to `defaultTargetPath`, and a key whose category
	 * no longer exists is ignored rather than cleaned up: categories are derived from
	 * library names, so one disappears the moment a service is offline, and dropping
	 * the row would lose a deliberate choice to a temporary outage.
	 */
	categoryTargets: Record<string, string>;
	/**
	 * The library that receives anything no category names. The global answer.
	 *
	 * A library rather than a path, for the reason `categoryTargets` is: a library is
	 * a directory the gateway has probed and the media server scans, while a path is
	 * a string somebody typed that may be somewhere no server ever looks. Most people
	 * will set only this one and never open the table.
	 *
	 * `defaultTargetPath` stays underneath it, for the case this cannot express — a
	 * staging folder outside every library, which somebody deliberately wants. Tried
	 * in that order: category, then this, then the path, then whatever is writable.
	 */
	defaultTargetLibraryId: string | null;
	/**
	 * How a placed file is named, as the order the steps are tried in.
	 *
	 * An order rather than one chosen scheme, for the reason the destination is a
	 * chain and not a strategy: the honest answer to "how should this be named" is
	 * "like this, and like that when the first has nothing to go on". The old single
	 * value could not express it and hid what it did instead — `LOCAL` with no sibling
	 * fell through to a standard name with nothing on screen saying so.
	 *
	 * The first step that can answer wins. `SOURCE` answers unless the source sent no
	 * path, `LOCAL` answers only when there is a sibling file to imitate, and the
	 * conventions always answer — which is why one of them has to be last and why a
	 * convention anywhere else is refused: every step behind it would be dead.
	 *
	 * Imitation belongs ahead of a convention whenever both are on, because a library
	 * somebody has already tidied should stay tidy: a convention applied over it
	 * produces one file spelled differently from its neighbours, which is how a season
	 * ends up looking like two.
	 *
	 * See `DEFAULT_NAMING_ORDER` for what a gateway nobody has configured does.
	 */
	namingOrder: NamingScheme[];
	/** Also copy artwork, subtitles and `.nfo` files alongside the media. */
	pullMetadata: boolean;
	/**
	 * Write an `.nfo` ourselves from what we know, when the source did not send one.
	 *
	 * Distinct from `pullMetadata`, which only copies the companions that exist. A
	 * source often has rich metadata in its own database and no `.nfo` on disk at all —
	 * Plex keeps everything in its library, Jellyfin can be configured either way — so
	 * copying gives us the file and none of the facts. The local media server then
	 * re-identifies the episode from its filename, which is how a pull of a correctly
	 * named episode ends up filed under the wrong series.
	 *
	 * Off by default: writing into somebody's library is not something to start doing
	 * unasked, and a household that curates its own `.nfo` files would find them
	 * replaced by ours.
	 */
	writeNfo: boolean;
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
	 * **It is a consent, not a lookup setting.** Since a friend of a friend is reached
	 * by being introduced to them — the middle gateway hands out a token and steps out
	 * of the way — this number is also how far away somebody may be and still open a
	 * link to this gateway. Lowering it to save bandwidth does not narrow a search: it
	 * narrows who can reach you, and nobody beyond it is ever introduced.
	 *
	 * See `DEFAULT_PEER_MAX_DEPTH` and `MAX_PEER_MAX_DEPTH`.
	 */
	peerMaxDepth: number;
	/**
	 * Keep a peer met while pulling from a friend of a friend. Off by default.
	 *
	 * Pulling something a friend's friend holds opens a real link between the two
	 * gateways — they are introduced and then talk directly, with nobody in the middle.
	 * The question this answers is what happens to that link afterwards: off, it closes
	 * with the transfer and the row goes with it; on, the peer joins the list like any
	 * other and their catalogue is imported.
	 *
	 * Off, because a gateway that quietly accumulated a peer for every file it ever
	 * pulled would end up linked to a circle nobody chose, each of them dialled at every
	 * restart. Keeping one is a decision, and it is one click.
	 */
	keepDiscoveredPeers: boolean;
	/**
	 * Carry a link between two of your friends who cannot reach each other. Off.
	 *
	 * Two gateways both behind routers have no way to open a socket to each other. The
	 * only thing left is a friend they have in common holding both halves and passing
	 * the bytes across — which costs that friend their upload, for a transfer they get
	 * nothing from, and puts every byte of somebody else's film through their machine
	 * in plaintext. It is a neighbourly thing to do on purpose and never a thing to do
	 * by accident, so it is off until somebody says yes.
	 *
	 * **It is one switch for the whole gateway, deliberately, and not one per peer.**
	 * The cost is the household's uplink, which is one resource and one decision. More
	 * than that: agreeing is advertised, once, as `PeerCapability.RELAY` in the
	 * handshake, and the rule the whole protocol rests on is that a capability is a
	 * promise. A per-peer answer could not be advertised honestly — the hello would
	 * offer relaying to everyone and the refusal would arrive fifteen seconds later, at
	 * the one moment it mattered.
	 *
	 * Turning it on affects links opened afterwards: a friend already connected learns
	 * it at their next handshake, because that is when capabilities are exchanged.
	 *
	 * What it is bounded by is in `peer-relay.model.ts`: four carried links at once,
	 * and the bytes are inside `uploadRateLimit` rather than beside it.
	 */
	relayForPeers: boolean;
	/** Use the encapsulated swarm when several peers hold the same file. */
	allowSwarm: boolean;

	/**
	 * What a library of ours is visible to before anybody configures it.
	 *
	 * A gateway whose libraries are all invisible until somebody visits a screen is a
	 * gateway that appears broken to the friend who linked to it — they see an empty
	 * shelf and conclude the link failed. The default is therefore a real level, not
	 * silence.
	 *
	 * **It applies to every library on a service whose sharing switch is on**, whether
	 * or not this gateway holds the files. Sharing a service we only reach over HTTP
	 * means our friends pull through us, and that is what turning the switch on says:
	 * the switch is the consent, and this setting is only the level it grants. The two
	 * used to be conflated — the default reached our own disks and nothing else, and a
	 * separate per-library agreement had to be given for anything else — which left the
	 * commonest case, a perfectly ordinary Jellyfin nobody had mapped folders for,
	 * silently private with the fix on a screen that had no control for it.
	 *
	 * Libraries reached through a linked peer are the one exception and are never
	 * shared onward, whatever this says. See `ShareManager`.
	 */
	defaultShareVisibility: ShareVisibility;

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
	instanceName: string | null;

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
	publicUrl: string | null;


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
	/**
	 * The indexer this gateway asks for releases nobody we know holds, if any.
	 *
	 * One rather than a list, and that is not a placeholder: Prowlarr is itself the
	 * aggregator, so a second one would be a second aggregator. The shape is an object
	 * rather than three flat keys so that adding another kind of indexer costs a value
	 * in `IndexerType` and nothing here.
	 */
	/**
	 * What a better copy is, so a search answers in this household's order.
	 *
	 * Seeders are the only order a gateway can produce on its own, and they are the
	 * wrong one for everybody: the best-seeded release of an episode is routinely a
	 * 720p re-encode from a group somebody would never choose. This orders and never
	 * hides — anything unranked stays on the list, last, so the only copy of last
	 * night's episode is still reachable when it comes from a group nobody named.
	 *
	 * Per category as well as globally, because the answer differs by shelf: 2160p for
	 * films and 1080p for a series that runs to ten seasons is an ordinary opinion. A
	 * single media's own override lives on the media rather than here — a map of media
	 * identifier to preference in a settings row would grow for ever and keep entries
	 * for media that no longer exist.
	 */
	releasePreferences: ReleasePreferenceSettings;
	indexer: IndexerSettings | null;
	/**
	 * The torrent client that moves the bytes, if any.
	 *
	 * Kept apart from the indexer because they fail apart: a tracker that stops
	 * answering and a client that will not accept a magnet are two different mornings,
	 * and a single "torrents are broken" would send somebody to the wrong one.
	 */
	downloadClient: DownloadClientSettings | null;
	/**
	 * Where the household asks for things, if anywhere.
	 *
	 * Kept apart from the indexer and the client for the same reason those two are kept
	 * apart from each other: it fails on its own, and it is not part of fetching
	 * anything. A request source hands over no bytes — it is read, and somebody presses
	 * something.
	 */
	requestSource: RequestSourceSettings | null;
	/**
	 * How long finished work that succeeded is kept, in days.
	 *
	 * It governs finished sync runs as well as finished transfers, deliberately as one
	 * number rather than two. A run and the transfers it created are one piece of
	 * history: two windows would eventually delete a run whose transfers are still
	 * listed, or leave a run pointing at transfers that no longer exist, and neither is
	 * a state anybody could read. The name is kept because it is what is already stored
	 * and shown; what it covers is what this comment says.
	 *
	 * Zero means never keep them — the daily cleanup then removes anything already
	 * finished. That is a real choice on a gateway somebody watches live, not an
	 * accident, so it is allowed.
	 */
	transferHistoryDays: number;

	/**
	 * How long finished work that failed or was cancelled is kept, in days.
	 *
	 * Its own window, and a much longer default, because a failure is evidence. A
	 * transfer that failed three weeks ago is the answer to "why is this series
	 * incomplete", and a retention that treated it like a success would have destroyed
	 * the answer before anybody thought to ask the question. Successes carry no such
	 * information: the file is in the library, which says everything the row did.
	 *
	 * Independent of `transferHistoryDays` and not clamped against it. Setting this
	 * lower is somebody saying they do not want the evidence, which is theirs to say.
	 */
	failedHistoryDays: number;

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

	/**
	 * The organisation hints somebody has read and does not want again, by key.
	 *
	 * A setting rather than something kept in the browser, because a hint is about the
	 * gateway and not about whoever happened to be looking at it: dismissed on the
	 * laptop and back on the phone is a notice that cannot be got rid of, which is
	 * worse than one that was never shown. Settings are key/value rows, so this costs a
	 * write and not a migration.
	 *
	 * Keys nothing produces any more are kept rather than pruned. A series stops being
	 * reported the moment a service is offline, and dropping its key would bring the
	 * hint back the next time that server answered — undoing a decision to a temporary
	 * outage, which is the one way a dismissal can fail that nobody would connect to
	 * the outage.
	 */
	dismissedLibraryHints: string[];
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
