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
