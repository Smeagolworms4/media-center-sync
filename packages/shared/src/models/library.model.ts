export enum LibraryKind {
	MOVIES = 'movies',
	SHOWS = 'shows',
	MUSIC = 'music',
	OTHER = 'other',
}

/**
 * A library of a registered service.
 *
 * `paths` is what the service reports. `localPath` is where the gateway can write
 * the same files — they differ whenever the service runs in its own container. A
 * library whose two paths do not point at the same directory accepts transfers
 * that the service will never see, which is why `writable` is probed rather than
 * assumed.
 */
export interface Library {
	id: string;
	serviceId: string;
	externalId: string;
	name: string;
	/**
	 * What we call it here, when the name the service gave it is not the useful one.
	 *
	 * A friend's `Video2` is not a category anybody can navigate, and renaming it on
	 * their server is not ours to do. The alias is local and never leaves this gateway;
	 * `name` stays whatever the service reports, so a rescan cannot undo it.
	 */
	alias: string | null;
	/**
	 * Where this library sits in the gateway's own order, lowest first.
	 *
	 * It decides which category wins when the same media is filed in two of them —
	 * a series in both `Shows` and `Animes` belongs to whichever comes first — and
	 * without it that answer would depend on the order rows came back in.
	 */
	position: number;
	kind: LibraryKind;
	paths: string[];
	localPath: string | null;
	writable: boolean;
	/** Default destination for media pulled into this kind of library. */
	isDefaultTarget: boolean;
	itemCount: number;
	lastScanAt: string | null;
	/** Last incremental refresh — cheap, frequent, driven by what the service reports. */
	lastRefreshAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface UpdateLibraryRequest {
	localPath?: string | null;
	isDefaultTarget?: boolean;
	alias?: string | null;
	position?: number;
}

/** What `make library/check` and the settings screen report. */
export interface LibraryCheck {
	libraryId: string;
	name: string;
	localPath: string | null;
	/**
	 * Whether that path was typed for this library or worked out from the service's
	 * root mapping.
	 *
	 * Stated because the two fail differently and are fixed in different places. A
	 * typed path is wrong on its own; a derived one is wrong for every library of the
	 * service at once, and somebody who cannot see which they are looking at will
	 * correct the library six times instead of the mapping once.
	 */
	derived: boolean;
	exists: boolean;
	readable: boolean;
	writable: boolean;
	freeBytes: number | null;
	error: string | null;
}

/**
 * Libraries of the same name, seen as one thing.
 *
 * A household with two servers has two libraries called `Shows`, and a friend makes a
 * third. They are one category to the person looking at them, and showing three bands
 * called `Shows` is showing them the plumbing. So libraries merge on their name —
 * their alias when one is set, since that is the name somebody chose — and the
 * category is what a library screen is built from.
 *
 * `position` is the lowest of the merged libraries', which is what decides the order
 * categories appear in, and which one wins when the same media is filed in two.
 */
export interface MediaCategory {
	/** Derived from the merged name: stable across restarts, usable in a URL. */
	key: string;
	/** The alias when one was set, otherwise the name the services report. */
	name: string;
	kind: LibraryKind;
	position: number;
	libraryIds: string[];
	serviceIds: string[];
	itemCount: number;
	/** True when at least one of the merged libraries is one we can write into. */
	local: boolean;
}

/**
 * The folded form two library names are compared on.
 *
 * One function, used for the key of a merged category and for matching a keyword
 * against a library name, because those two readings of a name have to agree: a
 * keyword stored under one folding and looked up under another matches nothing and
 * reports no error, which looks exactly like a keyword nobody saved.
 *
 * Case, accents, punctuation and runs of whitespace all collapse, so `Series TV`,
 * `Séries TV` and `series-tv` are one shelf — which is what they are to a person.
 * The folding stops there on purpose: no stemming, no distance, no fuzzy score. A
 * near-match that fires wrongly files somebody's `Films d'animation` into `Films`
 * and there is nothing on screen that says why, whereas a keyword that does not
 * fire is visible the moment they look at the pool.
 *
 * The result is safe in a URL, which is what lets a category key be a query
 * parameter without being escaped.
 */
export const categoryKeyOf = (name: string): string =>
	name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'library';

/**
 * A library name that files itself into one of our categories.
 *
 * The problem it solves: a friend's gateway brings twenty shelves called `Séries`,
 * `Series TV`, `TV` and `Émissions TV`, and folding each of them into our `Shows`
 * meant opening the libraries screen and typing the same alias once per library,
 * again for every peer that ever appears. A keyword is that sentence written once:
 * any library whose name folds to `normalized` is read as part of the category,
 * whoever's server it sits on, the moment it is discovered.
 *
 * The row is anchored on a library rather than on `MediaCategory.key`, and that is
 * the one structural decision here. A category is derived from library names, so
 * its key changes the instant somebody renames the library it was named after — a
 * list stored under `shows` would be orphaned by the rename it is meant to survive.
 * A library identifier survives both a rename and a rescan, because a rescan
 * matches rows on `(serviceId, externalId)` and updates them in place.
 */
export interface CategoryKeyword {
	id: string;
	/** The category it currently files into, as `MediaCategory.key` reads today. */
	categoryKey: string;
	/** That category's name, so a keyword can be shown away from its row. */
	categoryName: string;
	/** What somebody typed or dropped, kept as they wrote it. */
	keyword: string;
	/** The folded form actually compared against a library name. */
	normalized: string;
	/** The libraries this keyword files right now, by identifier. */
	libraryIds: string[];
}

export interface AddCategoryKeywordRequest {
	keyword: string;
}

export interface MoveCategoryKeywordRequest {
	/** The category it should file into from now on. */
	categoryKey: string;
}
