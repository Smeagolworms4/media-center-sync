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
	exists: boolean;
	readable: boolean;
	writable: boolean;
	freeBytes: number | null;
	error: string | null;
}
