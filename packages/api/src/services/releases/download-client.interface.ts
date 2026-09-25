import type { DownloadClientSettings } from '@mcs/shared';

/** What the gateway hands a client, which is a magnet or a file to fetch. */
export interface GrabOrder {
	/** Either of these; the client takes whichever it prefers. */
	magnetUrl: string | null;
	downloadUrl: string | null;
	/**
	 * The `.torrent` itself, fetched by the gateway rather than by the client.
	 *
	 * **A client is never asked to fetch a link.** An indexer builds its download link
	 * from the `Host` of the request that asked for it, so a search made by this gateway
	 * yields `http://localhost:9696/…`; handed to a client in its own container,
	 * `localhost` is the client. It fetches nothing, adds nothing, and answers no error —
	 * and the only symptom, several layers away, is a refusal saying the client took
	 * something and produced no torrent. Half the private trackers serve a file rather
	 * than a magnet, so this is not an edge: it is the other half of the feature.
	 *
	 * Null when the release offered a magnet, which needs no fetching, or when the fetch
	 * failed — and then `downloadUrl` is passed on as a last resort, because a tracker
	 * whose link the client *can* reach is a case that works.
	 */
	torrentFile?: Uint8Array | null;
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
	/**
	 * Stopped by somebody rather than by a fault.
	 *
	 * Told apart from `failed` because the two are opposite news: one is a download
	 * waiting to be let go again, the other is one that needs somebody. Decided by the
	 * client, whose words these are — qBittorrent says `pausedDL` on 4 and `stoppedDL` on
	 * 5, and a manager that knew either would be wrong on the other.
	 */
	paused: boolean;
	/** The client's own state word, kept for the log rather than for a decision. */
	state: string;
	/**
	 * The client has given up on this one, in its own judgement.
	 *
	 * Decided by the client rather than here, because the words are its own: qBittorrent
	 * says `error` and `missingFiles`, another will say something else, and a manager that
	 * knew those words would have to learn every client's.
	 *
	 * It matters because the failure is otherwise invisible. A torrent the client cannot
	 * write — the save path it was given is not one it may write into, which is a
	 * configuration nobody validates — sits at zero bytes for ever, and the row says
	 * "downloading" for as long as anybody cares to look. The reason is the client's own
	 * and is put in front of somebody rather than left in its log.
	 */
	failed: boolean;
	/** What the client says about it, when it says anything. */
	failedReason: string | null;
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

	/**
	 * Where every download of ours has got to, in one request rather than one each.
	 *
	 * `hashes`, when given, is asked for **instead of** the category and not on top of it.
	 * A torrent this gateway adopted rather than added — one the client already held — is
	 * filed under whatever category its owner chose, and a poll that only ever asked about
	 * ours never saw it: the row stayed on `sent` for ever while the download it was
	 * following finished. The category remains the question to ask when the caller wants
	 * the list of what is ours rather than the state of rows it already knows.
	 */
	statuses(
		settings: DownloadClientSettings,
		category: string,
		hashes?: string[],
	): Promise<DownloadStatus[]>;

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

	/**
	 * Stop a running download without giving it up.
	 *
	 * The other half of `start`, and it was missing: a torrent could be added stopped and
	 * set going, and never stopped again from here. Somebody wanting to free a line or a
	 * disk for an hour had to go and find it in the client's own interface, which is the
	 * thing this screen exists to spare them.
	 *
	 * The bytes already fetched are kept — that is what makes it a pause rather than a
	 * cancellation.
	 */
	pause(settings: DownloadClientSettings, clientId: string): Promise<void>;

	/** Whether the address and credentials work, for the settings screen to say so. */
	probe(settings: DownloadClientSettings): Promise<boolean>;

	/**
	 * Where this client writes when nobody tells it otherwise.
	 *
	 * Asked rather than assumed, because the assumption was wrong on the gateway it
	 * mattered on: with no save path configured here, the first root mapping's remote
	 * root was handed over as the folder to write into — and a mapping is a translation
	 * between two spellings of a path, not a statement that either end is writable. The
	 * client was told to write into `/home/elewendyl`, which exists on nobody's disk
	 * inside its container; it answered `Permission denied`, sat in `error` at zero
	 * bytes, and the only account of it was in its own log.
	 *
	 * Its own default cannot have that problem: it is the folder it uses for everything
	 * else it downloads.
	 *
	 * Null when the client will not say — an older version, a route this build does not
	 * have — and then the caller falls back to what it did before. A capability that is
	 * absent is not a failure.
	 */
	defaultSavePath(settings: DownloadClientSettings): Promise<string | null>;
}
