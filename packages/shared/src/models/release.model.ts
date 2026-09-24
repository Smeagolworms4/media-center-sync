import type { MediaOrigin, QualitySummary } from './media.model';
import type { MediaServiceType, RootMapping } from './service.model';

/**
 * Answering "what could satisfy this", from everywhere that could answer it.
 *
 * The screen asks one question and there are two kinds of answer to it. A **tracker
 * release** is a name on an indexer: it claims to be the episode, nothing has verified
 * that it is, and fetching it means handing a magnet to a download client. A **peer
 * copy** is a file that already exists on a gateway we are linked to, at a quality this
 * gateway has read off the file itself, and fetching it means a sync run through the
 * transfer machinery that moves every other byte in this product.
 *
 * They are shown side by side and they are never folded into one shape. A peer copy has
 * a service and a path and no seeders, no magnet and no download client; a tracker
 * release has seeders and a magnet and no service and no path. Dressing them as one type
 * would mean a row whose half the fields are null and — far worse — a single "fetch"
 * that has to guess which machinery to use. So the result set is a discriminated union,
 * `ReleaseSuggestion`, and the discriminator is what picks the action: see
 * `SuggestionSource`.
 *
 * On the tracker side, two pieces kept apart because they fail separately and are
 * replaced separately: an **indexer** finds releases and knows nothing about downloading
 * them, and a **download client** moves bytes and knows nothing about what they are.
 * Prowlarr and qBittorrent are the first of each, and neither name appears outside its
 * own implementation.
 */

/** The indexers this gateway knows how to ask. */
export enum IndexerType {
	/**
	 * Prowlarr, which is itself an aggregator.
	 *
	 * One address and one key reach every tracker somebody has configured there, and
	 * its search API already normalises the categories — so the alternative, speaking
	 * Torznab to a list of trackers, would mean re-implementing the thing that exists
	 * precisely to be spoken to once.
	 */
	PROWLARR = 'prowlarr',
}

/** The download clients this gateway knows how to drive. */
export enum DownloadClientType {
	QBITTORRENT = 'qbittorrent',
}

/**
 * What a release turned out to be, worked out from its name.
 *
 * The distinction that matters on a series page: a pack holds a whole season and one
 * file holds one episode, and grabbing the wrong one is either eleven files nobody
 * wanted or one of the twelve somebody needed.
 */
export enum ReleaseKind {
	MOVIE = 'movie',
	EPISODE = 'episode',
	SEASON_PACK = 'season_pack',
	/** A name nothing could be read off. Shown, never filed automatically. */
	UNKNOWN = 'unknown',
}

/** Where a grab has got to, from the gateway's point of view rather than the client's. */
export enum GrabState {
	/** Handed to the download client, which has not said anything yet. */
	SENT = 'sent',
	DOWNLOADING = 'downloading',
	/** The client has the whole thing; the gateway has not filed it yet. */
	FETCHED = 'fetched',
	/** Copied into the library. The torrent is left alone — see `ReleaseGrab.copied`. */
	PLACED = 'placed',
	FAILED = 'failed',
	/** Removed from the client by somebody, or never accepted by it. */
	CANCELLED = 'cancelled',
}

/**
 * What a release would bring, which is the question the whole feature turns on.
 *
 * Trackers carry the same show three ways — one episode, a season pack, the complete
 * run — and those are not three presentations of one thing: they are three different
 * answers to "what am I missing". Somebody short of four episodes of a season wants
 * either four single releases or one pack with four files taken out of it, and a screen
 * that cannot tell the two apart can offer neither.
 *
 * A pack's real contents are unknowable until it is added: a torrent's file list does
 * not exist until a client has its metadata. So a pack *claims* a season and the claim
 * is checked when the files appear — which is why `wholeSeason` is a flag rather than
 * an enumeration of what it holds.
 */
export interface ReleaseCoverage {
	seasonNumber: number | null;
	/**
	 * The episodes the name spells out. `S01E01-E03` is three; a pack is none.
	 *
	 * Empty and `wholeSeason` false means the name said nothing useful, which is common
	 * and is shown rather than guessed at.
	 */
	episodeNumbers: number[];
	/** A season pack: every episode of `seasonNumber`, whatever they turn out to be. */
	wholeSeason: boolean;
	/** A complete-series pack: every season, and the file list is the only truth. */
	wholeSeries: boolean;
}

/** One episode of ours, as a plan and a partial grab name it. */
export interface EpisodeRef {
	itemId: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
	title: string;
}

/** One result from one indexer. */
export interface Release {
	/**
	 * Stable for the same release across two searches, so a row keeps its place.
	 *
	 * Built from the indexer and the release's own identifier rather than generated:
	 * a fresh identifier per search would make every re-search redraw the list and
	 * lose which line somebody had their pointer on.
	 */
	id: string;
	title: string;
	indexer: string;
	/** Bytes, as the indexer reported them. Null where it reported nothing. */
	size: number | null;
	seeders: number | null;
	leechers: number | null;
	publishedAt: string | null;
	/**
	 * What to hand the download client: a magnet, or a `.torrent` to fetch.
	 *
	 * Both are carried because indexers give one or the other and the client takes
	 * either, and choosing between them is the client's business rather than the
	 * interface's.
	 */
	magnetUrl: string | null;
	downloadUrl: string | null;
	kind: ReleaseKind;
	seasonNumber: number | null;
	episodeNumber: number | null;
	/** `1080p`, `2160p`… read off the name, never from the indexer's own fields. */
	quality: string | null;
	/** What the name says about the source: `WEB-DL`, `BluRay`, `HDTV`. */
	source: string | null;
	/** Language tags read off the name, in the order they appeared. */
	languages: string[];
	/** What it would bring. See `ReleaseCoverage`. */
	coverage: ReleaseCoverage;
	/** True when this gateway already holds a file of that exact size. */
	heldAlready: boolean;
}

/**
 * Releases that are the same thing to grab, folded into one line.
 *
 * A search for one episode comes back as forty rows, of which four are genuinely
 * different files and the rest are the same release re-listed by every tracker that
 * carries it. Folding them on what the name resolves to — the coordinate, the quality,
 * the source — leaves the list somebody can actually read, and the seeders add up
 * across the trackers rather than being compared between them.
 */
export interface ReleaseGroup {
	key: string;
	title: string;
	kind: ReleaseKind;
	seasonNumber: number | null;
	episodeNumber: number | null;
	quality: string | null;
	source: string | null;
	languages: string[];
	/** The largest reported size in the group: they differ by a few kilobytes at most. */
	size: number | null;
	/** Summed over the group, because a release on four trackers really is better seeded. */
	seeders: number | null;
	/** Every copy, best seeded first. The first is what a grab takes. */
	releases: Release[];
	coverage: ReleaseCoverage;
	/**
	 * The episodes of ours this would fill, worked out against what we hold.
	 *
	 * Empty on a line that brings nothing new — a release of an episode already on the
	 * disk — which is what sinks it to the bottom of the list rather than hiding it.
	 */
	fills: EpisodeRef[];
	/**
	 * Episodes this release names that no server here has ever reported.
	 *
	 * The other half of what an indexer is for, and the half a catalogue cannot supply.
	 * A gap is an episode somebody's server knows about and nobody holds; this is an
	 * episode that aired since the last scan and exists on no server here at all — so it
	 * is not missing, because nothing says it should be there. Only an indexer can say
	 * it exists, and a search that could not report it would leave a running show
	 * permanently one season behind.
	 *
	 * No `itemId`: there is no row to point at. Fetching one creates it.
	 */
	brings: { seasonNumber: number | null; episodeNumber: number | null }[];
	heldAlready: boolean;
}

/**
 * Whether a search is looking for a film or for a show.
 *
 * It decides the categories the indexer is asked for, and getting it wrong is the worst
 * kind of defect this feature produces: a film searched under the television category
 * answers nothing, reports no error, and looks exactly like a film no tracker carries.
 * So it is part of the query rather than something the indexer guesses from the terms.
 *
 * A search built from a media reads it off the media and needs nobody to say it. A
 * free-text search has no media to read it off, which is precisely the case that used to
 * default to television and silently find nothing for every film anybody typed.
 */
export enum ReleaseSearchKind {
	MOVIE = 'movie',
	SHOW = 'show',
}

export interface ReleaseSearchQuery {
	/** The media this search is for, which is what builds the query terms. */
	itemId?: string;
	/** Free text, for when the title the indexers know is not the title we hold. */
	term?: string;
	seasonNumber?: number;
	episodeNumber?: number;
	/** Ask for the whole season rather than one episode. */
	seasonPack?: boolean;
	/**
	 * Film or show. Read off the media when one is named, and only then optional.
	 *
	 * See `ReleaseSearchKind`: a free-text search that does not say is a search of the
	 * television categories, which answers nothing at all for a film.
	 */
	kind?: ReleaseSearchKind;
}

/**
 * Which kind of thing a suggestion is, and therefore what pressing it does.
 *
 * The discriminator of `ReleaseSuggestion`, and it exists to make one mistake
 * unwriteable: a peer copy handed to the download client and a magnet handed to the
 * transfer engine are both silent failures — the first has no magnet to add and the
 * second has no file to read — and neither reports anything anybody would connect to the
 * press that caused it.
 */
export enum SuggestionSource {
	/** A name on a tracker. A claim, grabbed by the download client. */
	INDEXER = 'indexer',
	/** A file that exists, on a gateway we are linked to. Pulled by a sync run. */
	PEER = 'peer',
}

/**
 * A copy somebody we are linked to already holds, offered as a suggestion.
 *
 * This is not a second peer system: it is the holdings the index already has — the same
 * rows `MediaGroup.sources` is built from — asked a different question. The sources list
 * on a media answers "where are the copies of this"; a suggestion answers "what would
 * fill the gap", which for a season somebody is four episodes short of is one offer over
 * four rows rather than four offers.
 *
 * So one of these is **one holder and one season**: every row on that service that would
 * fill a gap, folded together, because that is the unit somebody acts on and the unit a
 * season pack competes with. A film or a single episode folds to one row holding one.
 *
 * Fetched through the ordinary transfer machinery, by naming `itemIds` to a sync run.
 * Nothing here goes near a download client, and there is deliberately no magnet, no
 * seeder count and no release name to tempt anything into trying.
 */
export interface PeerCopy {
	/**
	 * Stable for the same holder and season across two searches, so a row keeps its
	 * place — and prefixed, so an identifier from this half of the list can never be
	 * mistaken for a release the download client would accept. `grab` refuses it by that
	 * prefix rather than by failing to find it in the search cache, which is the same
	 * refusal arrived at by accident.
	 */
	id: string;
	/**
	 * The holder's own catalogue rows, which is what a pull is named by.
	 *
	 * Theirs and never ours: the transfer planner is told which copy to read from, and
	 * naming our own row would plan a pull from the disk the file is missing off.
	 */
	itemIds: string[];
	/** What to call it on screen: the media's title, with the coordinate it covers. */
	title: string;
	serviceId: string;
	serviceName: string;
	serviceType: MediaServiceType;
	/** Null on a remote service of our own rather than one reached through a friend. */
	peerId: string | null;
	peerName: string | null;
	/**
	 * How far away the holder is, which is half of what makes one offer better than
	 * another.
	 *
	 * Answered here rather than left to the interface because `friend_of_friend` cannot
	 * be told from `friend` without the peer's trust, and a screen that drew them the
	 * same would erase the one distinction nobody in the household agreed to.
	 */
	origin: MediaOrigin;
	seasonNumber: number | null;
	/** Null on a folded season, which covers several. */
	episodeNumber: number | null;
	/** Summed over `itemIds`, so a four-episode offer says what four episodes cost. */
	size: number | null;
	/**
	 * What the gateway measured, not what a name claimed.
	 *
	 * The whole reason a peer copy beats a tracker release of the same resolution: this
	 * was read off the file. `mixed` across a folded season is an honest answer and the
	 * same one the library shows for it.
	 */
	quality: QualitySummary | null;
	/**
	 * The holder's own spelling of the file, when there is one file.
	 *
	 * Null on a folded season. Shown because it is what somebody recognises the copy by,
	 * and it is the field a tracker release structurally cannot have.
	 */
	path: string | null;
	/** The episodes of ours this would fill. Empty means it brings nothing new. */
	fills: EpisodeRef[];
}

/** One tracker line: a folded group of releases, grabbed by the download client. */
export interface IndexerSuggestion {
	source: SuggestionSource.INDEXER;
	/** The group's key, which is also the row's identity on screen. */
	key: string;
	release: ReleaseGroup;
}

/** One peer line: a copy that exists, pulled by the transfer machinery. */
export interface PeerSuggestion {
	source: SuggestionSource.PEER;
	key: string;
	copy: PeerCopy;
}

/**
 * One row of the results, whichever kind it is.
 *
 * A union and not a wide interface with optional halves, because the compiler is the
 * cheapest place to catch the failure mode: `suggestion.release.magnetUrl` does not exist
 * on a peer row and `suggestion.copy.itemIds` does not exist on a tracker row, so the two
 * actions cannot be crossed without the build saying so.
 */
export type ReleaseSuggestion = IndexerSuggestion | PeerSuggestion;

export const isIndexerSuggestion = (one: ReleaseSuggestion): one is IndexerSuggestion =>
	one.source === SuggestionSource.INDEXER;

export const isPeerSuggestion = (one: ReleaseSuggestion): one is PeerSuggestion =>
	one.source === SuggestionSource.PEER;

/**
 * The prefix every peer suggestion identifier carries.
 *
 * Exported so the refusal in `grab` and the identifier that provokes it are built from
 * one constant. Two spellings of it is a guard that passes its own test and lets the real
 * thing through.
 */
export const PEER_SUGGESTION_PREFIX = 'peer:';

export interface ReleaseSearchResult {
	/** What was actually asked of the indexer, so a fruitless search can be corrected. */
	query: string;
	/**
	 * Everything that could satisfy this, tracker and peer, in one order.
	 *
	 * One list rather than two, because "what are my options" is one question and a
	 * screen with two lists makes somebody compare across a heading. Each row says which
	 * kind it is; see `SuggestionSource` for why they are not folded into one shape, and
	 * `orderSuggestions` for why a peer copy sorts above a tracker release.
	 */
	suggestions: ReleaseSuggestion[];
	/**
	 * The episodes under this media that no copy of ours holds.
	 *
	 * Answered with the search rather than looked up separately, because every question
	 * on that screen is asked against it: which lines are worth anything, whether a pack
	 * is worth taking for two files, and whether the whole thing can be covered at all.
	 */
	missing: EpisodeRef[];
	/** Indexers that answered with an error, named so the fault is attributable. */
	failed: { indexer: string; error: string }[];
}

/**
 * A way of covering everything that is missing, made of several releases.
 *
 * The answer to "I am short four episodes of this season". One pack covering all four
 * beats four single releases — one torrent, one connection, one thing to watch — and
 * four singles beat a pack when no pack exists, which on an older show is most of the
 * time. Neither is always right, so the plan is *shown* and grabbed on a press rather
 * than decided quietly.
 */
export interface CoveragePlan {
	steps: CoverageStep[];
	/** What nothing on offer can fill. Named, because a plan that silently skips lies. */
	uncovered: EpisodeRef[];
}

export interface CoverageStep {
	releaseId: string;
	title: string;
	kind: ReleaseKind;
	size: number | null;
	seeders: number | null;
	/** The episodes this step is being taken for, which is also what will be fetched. */
	covers: EpisodeRef[];
	/**
	 * True when the release holds more than is wanted.
	 *
	 * A season pack taken for two episodes: the client is told to fetch those two files
	 * and to leave the rest at zero priority, so the disk pays for what was asked for
	 * rather than for the whole season.
	 */
	partial: boolean;
}

export interface GrabRequest {
	releaseId: string;
	/** The media it is for. What the file is filed as, once it has arrived. */
	itemId: string;
	/**
	 * Where it should land, when somebody has said so.
	 *
	 * The same answer a redirected transfer carries, and consulted by the same rule: a
	 * library, optionally a folder inside it. Omitted means the ordinary placement chain
	 * decides — a series we already hold keeps its folder, then the category, then the
	 * default. Naming one here is the case of a media whose home is not where the rules
	 * would put it, said before a byte moves rather than corrected after.
	 */
	libraryId?: string | null;
	folder?: string | null;
	/**
	 * Only these episodes, out of a release that holds more.
	 *
	 * The other half of the feature: a season pack is added paused, its file list is
	 * read, everything that is not wanted is set to zero priority and only then is it
	 * started. Omitted means the whole release, which is what a single episode always
	 * is.
	 */
	wanted?: EpisodeRef[];
}

/** One thing handed to the download client, with where it has got to. */
export interface ReleaseGrab {
	id: string;
	itemId: string;
	title: string;
	indexer: string;
	state: GrabState;
	/** The client's own identifier for it — an info hash for a torrent. */
	clientId: string | null;
	bytesDone: number;
	bytesTotal: number;
	/** Bytes per second, live from the client. Zero for anything not moving. */
	rate: number;
	/** Where the client is writing, as this gateway sees it. */
	savePath: string | null;
	/** Where the file ended up in the library, once it has been filed. */
	targetPath: string | null;
	/** The library it was aimed at, when somebody chose one rather than the rules. */
	targetLibraryId: string | null;
	/** A folder inside it, when somebody chose one. */
	targetFolder: string | null;
	/**
	 * The episodes this grab was taken for, and where each one landed.
	 *
	 * A pack brings several files and each is filed against its own episode, so one path
	 * could not say where anything went. A single-file grab has one entry.
	 */
	placements: GrabPlacement[];
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface GrabPlacement {
	itemId: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
	title: string;
	/** Inside the download, as the client spells it. Null until the file list is known. */
	fileName: string | null;
	/** Where it was filed in the library, once it has been. */
	targetPath: string | null;
}

/** What the settings hold for one indexer. */
export interface IndexerSettings {
	type: IndexerType;
	baseUrl: string;
	/** Never sent back to the interface: the API answers whether one is set. */
	apiKey?: string | null;
	hasApiKey?: boolean;
	enabled: boolean;
}

/** What the settings hold for one download client. */
export interface DownloadClientSettings {
	type: DownloadClientType;
	baseUrl: string;
	username?: string | null;
	password?: string | null;
	hasPassword?: boolean;
	/**
	 * Where the client's folders are, for us: one row per disk, exactly as for a server.
	 *
	 * This is the same statement a media service makes and it is deliberately the same
	 * shape: a torrent client in its own container writes to `/downloads` while this
	 * gateway reaches the same directory at `/share/torrents`, which is word for word
	 * the problem `RootMapping` exists for. Two flat fields would have been a second
	 * vocabulary for one idea — and the day somebody's client writes to two disks, the
	 * flat pair can only describe it by mapping `/` onto `/`.
	 *
	 * Getting it wrong succeeds at every step: the torrent completes, the client is
	 * happy, and the file is never filed. So the gateway checks it can read the local
	 * side before it accepts a grab.
	 */
	rootMappings: RootMapping[];
	/**
	 * Where the client is told to write, in its own spelling.
	 *
	 * The first mapping's remote root unless somebody names something else, which is
	 * the ordinary case: a client already configured to put everything in `/downloads`
	 * needs no second opinion from us.
	 */
	savePath?: string | null;
	enabled: boolean;
}
