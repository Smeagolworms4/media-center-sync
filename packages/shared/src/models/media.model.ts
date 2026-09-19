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
	bitrate: number | null;
	/** Set once computed; correlation prefers it over every other signal. */
	checksum: string | null;
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
