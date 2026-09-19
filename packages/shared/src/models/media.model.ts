import type { MediaServiceScope, MediaServiceType } from './service.model';
import type { SyncState } from './sync.model';

export enum MediaKind {
	MOVIE = 'movie',
	SERIES = 'series',
	SEASON = 'season',
	EPISODE = 'episode',
	COLLECTION = 'collection',
}

/**
 * Identifiers from the metadata providers.
 *
 * They are what makes correlation reliable: two libraries name the same episode
 * `S01E02`, `1x02` or `102`, but they agree on a TVDB identifier. Titles are only
 * a fallback, and a scored one.
 */
export interface ExternalIds {
	tvdb?: string;
	tmdb?: string;
	imdb?: string;
	musicbrainz?: string;
	/** Identifier inside the service that reported the item. */
	provider?: string;
}

export interface MediaFileInfo {
	path: string;
	size: number;
	container: string | null;
	videoCodec: string | null;
	audioCodec: string | null;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	/**
	 * Bits per second, always.
	 *
	 * The unit has to be stated because the services disagree: Jellyfin reports
	 * bits per second and Plex kilobits, so a handler that passes either through
	 * untouched makes the quality comparator rank every Plex copy a thousand times
	 * below every Jellyfin one — silently, and in a way that looks like a scoring
	 * bug rather than a unit.
	 */
	bitrate: number | null;
	/**
	 * Cheap fingerprint: a few sampled ranges plus the exact size, SHA-256, prefixed
	 * with the sampling version.
	 *
	 * The prefix matters: two gateways must never compare values produced by two
	 * different sampling schemes. Changing what is sampled changes the prefix, and
	 * old values simply stop matching instead of matching wrongly.
	 *
	 * Hashing a forty-gigabyte episode to find out whether a friend has the same one
	 * would cost more than downloading it. Sampling the head, the middle and the tail
	 * and folding in the byte count identifies a file well enough to match on, for the
	 * price of three reads.
	 */
	quickHash: string | null;

	/**
	 * The swarm identifier, derived from `quickHash` and the size.
	 *
	 * Two gateways that hold the same file compute the same value without ever
	 * exchanging anything, which is what lets them find each other. The torrent
	 * itself — the piece hashes — is generated on the fly when a swarm transfer
	 * starts, and never stored: it is a function of the file, not a document about it.
	 */
	contentId: string | null;

	/**
	 * Full hash. Computed only when a transfer is verified, because that is the only
	 * moment it is worth its cost. Correlation prefers it over every other signal
	 * when it happens to be there.
	 */
	checksum: string | null;
}

/**
 * One distinct encoding found under a node.
 *
 * `label` is what the tooltip lists, already assembled — the interface should not
 * have to know that a missing codec means "unknown" rather than an empty string.
 */
export interface QualityVariant {
	label: string;
	videoCodec: string | null;
	/** `2160p`, `1080p`, `720p`… derived from the height, not from the title. */
	resolution: string | null;
	/**
	 * `HDR10`, `DV`, `HLG`, when it can be told at all.
	 *
	 * Neither service reports it as a field, so it is read off the filename. That
	 * makes it a hint worth showing and never a signal worth ranking on: a release
	 * named `HDR` that is not is common enough to matter.
	 */
	hdr: string | null;
	audioCodec: string | null;
	/** `5.1`, `7.1`, `2.0` — read off the filename too, and just as untrustworthy. */
	audioChannels: string | null;
	container: string | null;
	/** How many files under this node carry exactly this encoding. */
	count: number;
	bytes: number;
}

/**
 * What a series, a season or a collection looks like at a glance.
 *
 * A library is rarely uniform: a season ripped twice, three episodes re-encoded,
 * one left in 720p. Showing the dominant encoding and saying `mixed` when there is
 * more than one is the only summary that does not lie — and the variants are right
 * there in the tooltip for the moment you need to know which episode is the odd one.
 */
export interface QualitySummary {
	/** `x265 · 1080p`, or `mixed` when the variants disagree. */
	label: string;
	mixed: boolean;
	/** The most common variant, which `label` describes when `mixed` is false. */
	dominant: QualityVariant | null;
	/** Every distinct encoding under the node, most common first. */
	variants: QualityVariant[];
	fileCount: number;
	totalBytes: number;
}

/**
 * What sits beside a media file, and whether we have it.
 *
 * A media server reads far more than the video: the `.nfo` carries the titles,
 * the overview and the identifiers that stop it guessing; the poster and the fanart
 * are what a library looks like; the subtitles are what makes it watchable. A file
 * pulled without them is a file that arrives correctly and then shows up as an
 * unnamed episode with a grey rectangle where the artwork should be.
 *
 * Knowing what is missing is therefore worth a column, not a guess — and it is what
 * lets the interface offer to fetch only the companions, without moving the video
 * again.
 */
export interface MediaCompanions {
	nfo: boolean;
	poster: boolean;
	fanart: boolean;
	/** How many subtitle files sit beside it, in any language. */
	subtitles: number;
	/**
	 * Present on a source and absent here, by extension or role.
	 *
	 * Empty does not mean complete: it means nothing better is known to exist. The
	 * difference matters before a scan has ever read the other side.
	 */
	missing: string[];
	/** When this was last read off the disk. Null while never inspected. */
	checkedAt: string | null;
}

export interface MediaItem {
	id: string;
	serviceId: string;
	libraryId: string;
	parentId: string | null;
	kind: MediaKind;
	title: string;
	/** Title reduced for comparison: lowercase, no accent, no article, no noise. */
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	externalIds: ExternalIds;
	overview: string | null;
	artworkUrl: string | null;
	file: MediaFileInfo | null;
	/**
	 * Aggregated over everything under this node — the node's own file for an
	 * episode, every episode for a season or a series. Null while unscanned.
	 */
	quality: QualitySummary | null;
	/**
	 * What sits beside the file. Null until the gateway has read the directory, which
	 * it can only do for a library somebody told it where to find.
	 */
	companions: MediaCompanions | null;
	addedAt: string | null;
	/** Correlation result against the other registered services. */
	sync: SyncState;
	createdAt: string;
	updatedAt: string;
}

/** A node of the browsing tree: a series with its seasons, a season with its episodes. */
export interface MediaNode extends MediaItem {
	children?: MediaNode[];
	childCount: number;
}

/**
 * One copy of a grouped media, and who holds it.
 *
 * `local` is what the interface needs to answer the only question that matters on a
 * poster: do I have this, or is it on somebody else's server?
 */
export interface MediaGroupSource {
	itemId: string;
	serviceId: string;
	serviceName: string;
	serviceType: MediaServiceType;
	/** `local` when the gateway can write into that service's libraries. */
	scope: MediaServiceScope;
	peerId: string | null;
	peerName: string | null;
	quality: QualitySummary | null;
	companions: MediaCompanions | null;
	bytes: number | null;
	local: boolean;
	/**
	 * This copy's own state.
	 *
	 * The group says the media is outdated; only this says which copy is the old one.
	 * Without it an interface can tell somebody something is out of date and not where
	 * to pull the better version from, which is the next thing they will ask.
	 */
	sync: SyncState;
}

/**
 * One media, whoever holds it.
 *
 * The index keeps a row per service — the same episode on three servers is three rows
 * — because merging them would mean choosing whose title, whose artwork and whose file
 * size survive, and losing the differences a sync exists to show. Browsing wants the
 * opposite: one poster per media, with the servers that hold it underneath.
 *
 * A group is that second view, computed from the match graph rather than stored. It
 * never replaces the rows it is built from, and two rows only join when a match was
 * actually applied — a proposal below the threshold leaves them as two posters, which
 * is the honest rendering of "we are not sure these are the same thing".
 */
export interface MediaGroup {
	/** The representative item's identifier. Stable as long as the group is. */
	id: string;
	kind: MediaKind;
	title: string;
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	externalIds: ExternalIds;
	overview: string | null;
	/**
	 * Whose artwork to show — the local copy when there is one.
	 *
	 * Preferring the local copy is not cosmetic: a poster is fetched through the
	 * service that reported it, and a friend's server may be asleep. Ours is the one
	 * that answers.
	 */
	artworkItemId: string | null;
	/** The group's state, in the same vocabulary a single item uses. */
	sync: SyncState;
	/**
	 * Aggregated over every source, so the chip says what exists rather than what one
	 * server happens to hold.
	 */
	quality: QualitySummary | null;
	sources: MediaGroupSource[];
	childCount: number;
	/** Children known somewhere and absent here — what a season card shows at a glance. */
	missingCount: number;
	/** The representative's library, so a client can say where it sits without a second call. */
	libraryId: string | null;
	/** The representative's parent, which is what a breadcrumb walks up. */
	parentId: string | null;
	/** Most recent addition among the sources, which is what `sort=addedAt` orders on. */
	addedAt: string | null;
}

export interface MediaGroupQuery {
	/** Restrict to what one service holds, without ungrouping the rest. */
	serviceId?: string;
	libraryId?: string;
	kind?: MediaKind;
	/** Children of this group, addressed by the parent's representative item. */
	parentId?: string;
	/**
	 * Only media that sit at the top of their tree — a series, a film, a collection.
	 *
	 * A library screen wants posters, not every episode of every show laid out beside
	 * its series. Deriving it from the library's kind works for films and shows and
	 * breaks on anything else: a library of concerts or audiobooks has no kind this
	 * model names, so it would show its parents and its children together. Asking for
	 * roots says what is actually wanted and works whatever the library holds.
	 */
	rootsOnly?: boolean;
	search?: string;
	states?: SyncState[];
	page?: number;
	limit?: number;
	sort?: 'title' | 'year' | 'addedAt';
	direction?: 'asc' | 'desc';
}

/**
 * What fetching the companions of one item did.
 *
 * Separate from a sync because the two answer different questions. A sync moves what
 * we do not have; this fills in what arrived bare — an episode already on the disk
 * whose `.nfo`, poster or subtitles never came with it. Asking somebody to re-pull a
 * forty-gigabyte file to get a description file beside it is not an answer.
 */
export interface CompanionPullResult {
	itemId: string;
	title: string;
	/** Files written beside the media. */
	copied: string[];
	/** Files already there and left alone, unless the settings say the source wins. */
	kept: string[];
	/** Error key when nothing could be fetched for this item. */
	error: string | null;
}

export interface MediaSearchQuery {
	serviceId?: string;
	libraryId?: string;
	kind?: MediaKind;
	parentId?: string;
	search?: string;
	/** Keep only items in one of these states. */
	states?: SyncState[];
	page?: number;
	limit?: number;
	sort?: 'title' | 'year' | 'addedAt';
	direction?: 'asc' | 'desc';
}
