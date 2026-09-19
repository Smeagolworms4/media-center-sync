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
