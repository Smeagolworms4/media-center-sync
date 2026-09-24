import type { DownloadClientSettings } from '@mcs/shared';

/** What the gateway hands a client, which is a magnet or a file to fetch. */
export interface GrabOrder {
	/** Either of these; the client takes whichever it prefers. */
	magnetUrl: string | null;
	downloadUrl: string | null;
	/** The release name, so the client's own list is readable by a human. */
	title: string;
	/** Where the client should write, in the client's own spelling of the path. */
	savePath: string;
	/** A tag the client puts on it, so our downloads are tellable from everybody else's. */
	category: string;
	/**
	 * Add it stopped, so the files can be chosen before a byte is fetched.
	 *
	 * The whole of partial grabbing rests on this. A torrent's file list does not exist
	 * until the client has its metadata, so "take two episodes out of this season pack"
	 * can only be said *after* it has been added — and if it is downloading by then, the
	 * disk is already paying for the eight nobody asked for.
	 */
	paused?: boolean;
}

/** One file inside a download, as the client lists it. */
export interface DownloadFile {
	index: number;
	/** Relative to the torrent's own root, which is what the name has to be read off. */
	name: string;
	size: number;
	/** Zero means the client will not fetch it. */
	priority: number;
}

/** Where one download has got to, as the client sees it. */
export interface DownloadStatus {
	clientId: string;
	name: string;
	bytesDone: number;
	bytesTotal: number;
	rate: number;
	/** True once every byte is on the client's disk. */
	complete: boolean;
	/** The client's own state word, kept for the log rather than for a decision. */
	state: string;
	/** Where the files are, in the client's spelling. */
	savePath: string | null;
	/** The one file, or the folder, the torrent produced. Relative to `savePath`. */
	contentPath: string | null;
}

/**
 * One way of moving bytes we have no source for.
 *
 * The client is told what to fetch and where to put it, and is asked where it got to.
 * It is never told what the file is: naming, placement and the library are the
 * manager's, and a client that knew about them would be a second placement rule nobody
 * could see.
 */
export interface DownloadClient {
	/**
	 * Hand it a release. Answers the identifier it will be known by afterwards.
	 *
	 * The identifier is the client's own — an info hash — rather than one we generate,
	 * because it is what survives the client being restarted and what somebody can
	 * search for in the client's own interface when something has gone wrong.
	 */
	grab(settings: DownloadClientSettings, order: GrabOrder): Promise<string>;

	/** Where every download of ours has got to, in one request rather than one each. */
	statuses(settings: DownloadClientSettings, category: string): Promise<DownloadStatus[]>;

	/**
	 * What is inside one download.
	 *
	 * Answered only once the client has the metadata, which for a magnet is a moment
	 * after it was added and not before. A caller that wants to choose files has to be
	 * prepared to ask again.
	 */
	files(settings: DownloadClientSettings, clientId: string): Promise<DownloadFile[]>;

	/**
	 * Fetch these files and leave the rest alone.
	 *
	 * The indices are the client's own, from `files`. Everything not named is set to
	 * zero priority, which is the difference between taking two episodes out of a season
	 * pack and taking the season.
	 */
	selectFiles(
		settings: DownloadClientSettings,
		clientId: string,
		wantedIndices: number[],
	): Promise<void>;

	/** Let a stopped download run. */
	start(settings: DownloadClientSettings, clientId: string): Promise<void>;

	/** Whether the address and credentials work, for the settings screen to say so. */
	probe(settings: DownloadClientSettings): Promise<boolean>;
}
