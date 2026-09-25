import type {
	MediaKind,
	RequestDetails,
	RequestEpisode,
	MediaRequest,
	RequestOrder,
	RequestQuery,
	RequestSourceSettings,
} from '@mcs/shared';

/**
 * One place the household asks for things.
 *
 * It reads requests and writes back how far along they are, and that is all. Whether we
 * hold what was asked for, whether a request is worth fulfilling, which of our media
 * answers it: every one of those depends on the catalogue, which this layer has never
 * heard of. A source that matched anything to anything would be a second, invisible
 * correlation rule — see `ReleaseIndexer`, which is deliberately the same shape and
 * deliberately just as ignorant.
 *
 * Nothing here fetches media. A request source hands over no bytes; it is read, and
 * somebody presses something on a screen.
 */
export interface RequestSource {
	/**
	 * What has been asked for.
	 *
	 * Throws rather than answering an empty list when the source could not be reached.
	 * "Nobody has asked for anything" and "your request server is down" are opposite
	 * answers, and a screen that shows the first for the second quietly tells a
	 * household that nothing is outstanding.
	 */
	list(settings: RequestSourceSettings, query: RequestQuery): Promise<MediaRequest[]>;

	/** One request by its own identifier, or null when the source has no such row. */
	find(settings: RequestSourceSettings, requestId: string): Promise<MediaRequest | null>;

	/**
	 * Tell the source the media is held, which is what closes an open ask.
	 *
	 * Takes the **media** identifier and not the request's: they are two different rows
	 * with two different sequences, both small integers on a fresh install, so passing
	 * the wrong one succeeds and completes somebody else's request. `MediaRequest`
	 * carries both for exactly this reason.
	 */
	markAvailable(settings: RequestSourceSettings, mediaId: string): Promise<void>;

	/**
	 * Ask for something, so the household's own screen shows it as followed here.
	 *
	 * Answers the request the source created, when it says which — a source that
	 * already had the same ask open may answer nothing at all, and that is a success.
	 */
	create(settings: RequestSourceSettings, order: RequestOrder): Promise<MediaRequest | null>;

	/**
	 * What the thing asked for actually is — its title, its year, its seasons.
	 *
	 * **A request row carries no title.** Overseerr's media table holds identifiers and
	 * statuses and nothing readable, so a listing of asks is a column of numbers: for
	 * anything a library of ours already holds, our own copy supplies the name, and for
	 * everything else — which is precisely what somebody is asking for — there is
	 * nothing to show and nothing to spell into a tracker query either.
	 *
	 * The source knows, because it is sitting on the metadata service the household
	 * browses. Asking it is one request against a screen that would otherwise be blank
	 * exactly where it matters most.
	 *
	 * Null when the source cannot name it. That is an answer rather than a failure: a
	 * metadata provider that has been renamed or withdrawn leaves a request nobody can
	 * label, and a listing that refused to load for it would hide every other ask too.
	 */
	details(
		settings: RequestSourceSettings,
		kind: MediaKind.MOVIE | MediaKind.SERIES,
		providerId: string,
	): Promise<RequestDetails | null>;

	/**
	 * Which episodes one season of a show has, as the source's metadata provider knows it.
	 *
	 * The one thing no media server here can answer. Our index is a mirror of what the
	 * servers declare, so an episode that aired last night and that nobody holds exists
	 * nowhere — no row, nothing counting it as missing, and a season screen that reads as
	 * complete. The source is already sitting on the metadata provider the household
	 * browses, and it was only ever asked which *seasons* exist.
	 *
	 * An empty list when the season is unknown, and an empty list rather than a throw when
	 * the source will not answer: this fills a catalogue in, and a metadata provider having
	 * a bad afternoon must not turn a media page into an error.
	 */
	episodes(
		settings: RequestSourceSettings,
		providerId: string,
		seasonNumber: number,
	): Promise<RequestEpisode[]>;

	/** Whether the address and key work, for the settings screen to say so. */
	probe(settings: RequestSourceSettings): Promise<boolean>;
}
