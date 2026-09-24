import type { IndexerSettings, Release, ReleaseSearchKind } from '@mcs/shared';

/**
 * What a search asks for, in terms an indexer understands.
 *
 * A title and a coordinate, never a media identifier: an indexer has never heard of
 * our catalogue, and handing it one would be the leak the layers exist to prevent.
 */
export interface IndexerQuery {
	/** The words to search for. Already the series' title for an episode, not its own. */
	term: string;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	/** Whether to ask for a whole season rather than one episode. */
	seasonPack?: boolean;
	/**
	 * Narrows the categories asked for, and is the difference between a film and a show.
	 *
	 * Required rather than optional, and that is the point of it: a caller that does not
	 * know which it is asking for cannot be allowed to fall through to one of the two —
	 * whichever default were chosen, half of all searches would answer nothing and report
	 * no fault. The manager reads it off the media, or off the query when there is none.
	 */
	kind: ReleaseSearchKind;
}

/**
 * One way of finding releases.
 *
 * Deliberately one method. An indexer answers what it has and decides nothing: whether
 * a release is worth grabbing, whether we already hold it, which of two copies is
 * better — all of that is the manager's, because all of it depends on the catalogue and
 * on settings this layer has never heard of.
 */
export interface ReleaseIndexer {
	/**
	 * Ask, and answer what came back.
	 *
	 * Throws rather than answering an empty list when the indexer could not be reached:
	 * "nothing found" and "nobody answered" are opposite answers, and a search screen
	 * that shows the first for the second sends somebody hunting for a better search
	 * term while their key is wrong.
	 */
	search(settings: IndexerSettings, query: IndexerQuery): Promise<Release[]>;

	/** Whether the address and key work, for the settings screen to say so. */
	probe(settings: IndexerSettings): Promise<boolean>;
}
