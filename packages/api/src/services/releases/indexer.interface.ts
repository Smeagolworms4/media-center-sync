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

	/**
	 * The trackers behind this indexer, by the names its results carry.
	 *
	 * For the one screen that has to name a tracker without having searched: the order
	 * a household writes says "this one before that one", and the values it is written
	 * with are matched against what a result reports. Typed by hand they are a guess —
	 * `Generation-Free` is not `Generation-Free (API)`, and a preference naming the
	 * first silently orders nothing at all, which is the failure this whole product
	 * keeps producing.
	 *
	 * An empty list where the indexer cannot say, never a throw: this feeds suggestions
	 * on a settings screen, and a screen that refused to open because a tracker list
	 * could not be fetched would be worse than one offering none.
	 */
	trackers(settings: IndexerSettings): Promise<string[]>;
}
