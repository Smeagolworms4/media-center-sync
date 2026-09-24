import type { MediaKind } from './media.model';

/**
 * What the household asked for, read from where it asked.
 *
 * Every other source in this product answers "where is this file": a library of ours, a
 * friend's gateway, a tracker. A request source answers a question none of them can —
 * *what does anybody actually want* — because it is the screen the household already
 * types into. It hands over no bytes and is not a media source: it is where the asking
 * happens, and this gateway is what fulfils it.
 *
 * That makes the loop worth stating, because it is the whole feature: somebody asks in
 * Seerr, the gateway reads the ask and says whether we hold it, and when we do somebody
 * marks it complete so the request stops being open. A media of ours can also be pushed
 * the other way, which is how "we are following this here" gets said in the place the
 * household looks.
 *
 * Nothing in here fetches anything. A request is read and shown; a download is a
 * separate press on a separate screen. Wiring the two together would mean a stranger
 * with a Seerr account spending this gateway's disk, and it was rejected for that
 * reason and not for want of the plumbing.
 */

/** The request sources this gateway knows how to read. */
export enum RequestSourceType {
	/**
	 * Seerr, and with it the Overseerr and Jellyseerr it descends from.
	 *
	 * One value for the three because they are one API: the v1 routes, the `X-Api-Key`
	 * header and the status numbers are the same in all of them, and a gateway that
	 * asked people which fork they run would be asking a question it cannot act on.
	 * A genuinely different request API earns its own value here and nothing else.
	 */
	SEERR = 'seerr',
}

/**
 * Where a request has got to, in the source's own terms.
 *
 * Two lives are folded into one word here and the distinction is deliberate: a request
 * is approved or declined by a person, and the media behind it is then processed and
 * becomes available. Both are read as "how far along is this", which is the only
 * question anybody asks of the list — so they are one scale, ordered from nothing has
 * happened to there is nothing left to do.
 */
export enum MediaRequestState {
	/** Asked for, and nobody has said yes yet. */
	PENDING = 'pending',
	APPROVED = 'approved',
	DECLINED = 'declined',
	/** Somebody or something is working on it. */
	PROCESSING = 'processing',
	/** Some of what was asked for exists — a show a few seasons short of the ask. */
	PARTIAL = 'partial',
	/** The source considers it held, which is what marking one complete produces. */
	AVAILABLE = 'available',
	/** A state this build has no word for. Shown as-is, never acted on. */
	UNKNOWN = 'unknown',
}

/** One season of a request, because a show is asked for a season at a time. */
export interface RequestedSeason {
	seasonNumber: number;
	state: MediaRequestState;
}

/**
 * One request, as the source holds it.
 *
 * `id` and `mediaId` are both carried and they are not interchangeable — see
 * `RequestSource.markAvailable`. Everything a source cannot answer is null rather than
 * guessed: this is somebody else's API over a version nobody pins.
 */
export interface MediaRequest {
	/** The request's own identifier, which is what a route addresses. */
	id: string;
	/**
	 * The media behind the request, which is a different row with a different number.
	 *
	 * Marking a request complete is an operation on this and not on `id`, and the two
	 * are both small integers on a fresh install — so a mix-up completes somebody
	 * else's request and looks like it worked.
	 */
	mediaId: string;
	/** A film or a show. The only two a request source deals in. */
	kind: MediaKind.MOVIE | MediaKind.SERIES;
	/** What the source calls it, when it says. Requests often carry no title at all. */
	title: string | null;
	/** The metadata identifiers, which are the only thing a catalogue can be matched on. */
	tmdbId: string | null;
	tvdbId: string | null;
	state: MediaRequestState;
	/** Empty for a film, and for a show asked for whole. */
	seasons: RequestedSeason[];
	/** Who asked, for the list to be readable by the person who has to decide. */
	requestedBy: string | null;
	requestedAt: string | null;
}

/** One copy of ours that answers a request. */
export interface RequestHolding {
	itemId: string;
	title: string;
	/** The service it sits on, so "we hold it" can be traced to a machine. */
	serviceId: string;
	/** The seasons under it that exist here, for a show. Empty for a film. */
	seasonNumbers: number[];
}

/**
 * A request with what this gateway can say about it.
 *
 * The verdict is the point of the whole screen: a household asks for forty things over
 * a year and most of them arrive by some other route, so a list of open requests with
 * no idea which are already satisfied is a list nobody can act on.
 */
export interface MediaRequestView extends MediaRequest {
	/** Every copy of ours that answers it. Empty when we hold nothing. */
	holdings: RequestHolding[];
	/** True when at least one copy of ours answers it. */
	heldAlready: boolean;
	/**
	 * Whether marking it complete would be telling the truth.
	 *
	 * False on a request the source already considers available — there is nothing to
	 * say — and false on one we hold nothing for. For a show it means every season
	 * asked for, not merely one: a request for seasons two and three is not fulfilled
	 * by holding two, and a screen that said it was would close the ask on half of it.
	 */
	fulfillable: boolean;
	/** The seasons asked for that nothing here holds. Empty for a film. */
	missingSeasons: number[];
	/** The search this request is worth running, for somebody to press. Never run here. */
	suggestion: RequestSuggestion | null;
	/**
	 * What the source says the work is, for a request no library of ours matches.
	 *
	 * Null when we hold it — our own row is the better name for something we have, and
	 * asking the source about forty requests to re-learn titles we already hold is forty
	 * round trips for nothing — and null when the source cannot say.
	 */
	details: RequestDetails | null;
}

/**
 * The search a request implies, worked out and handed over rather than run.
 *
 * This is the whole of the pre-search: the gateway says what it would look for, and a
 * person presses it. Running it on the strength of somebody having asked in Seerr would
 * be a stranger with an account spending this gateway's disk, and that is the one thing
 * the feature was built not to do.
 *
 * Null when there is nothing to look for — we hold everything asked for — and null when
 * the work cannot be named, which is commoner than it sounds: Seerr's request rows carry
 * metadata identifiers and no title, so a request for something no library of ours holds
 * has nothing to spell into a tracker search. Naming it then needs a metadata lookup,
 * which is the interface's to make.
 */
export interface RequestSuggestion {
	/** What to search for: the work's title, never an episode's. */
	term: string;
	kind: MediaKind.MOVIE | MediaKind.SERIES;
	/** The seasons worth searching for, which are the missing ones. Empty for a film. */
	seasonNumbers: number[];
}

/** What a listing asks for. */
export interface RequestQuery {
	/** Only requests in this state. Omitted means the open ones, which is the default. */
	state?: MediaRequestState;
	/** How many rows at most. The source decides its own ceiling. */
	take?: number;
}

/**
 * Pushing a request the other way: this is what we are following here.
 *
 * Addressed by TMDB identifier rather than by one of ours, because that is the only
 * name a request source has for a work it has never been asked about. Naming one of our
 * media instead is a convenience the manager resolves — and a media of ours carrying no
 * TMDB identifier simply cannot be pushed, which is a fact about the catalogue rather
 * than a fault here.
 */
export interface RequestOrder {
	kind: MediaKind.MOVIE | MediaKind.SERIES;
	tmdbId: string;
	/** Seasons, for a show. Omitted asks for every season the source knows of. */
	seasons?: number[];
}

/** What the route accepts, which is either one of our media or a bare identifier. */
export interface RequestCreate {
	/** Our own media, when the request is pushed from a media page. */
	itemId?: string;
	/** Used directly when no media of ours was named. */
	tmdbId?: string;
	/** Read from the media when one was named, and required when none was. */
	kind?: MediaKind.MOVIE | MediaKind.SERIES;
	seasons?: number[];
}

/** What the settings hold for the request source. */
/**
 * What the request source can say about the thing asked for.
 *
 * The answer to a listing that is otherwise a column of numbers: Overseerr's own media
 * rows carry identifiers and statuses and nothing readable, so anything the household
 * does not already hold — which is exactly what somebody is asking for — has no name on
 * screen and no words to spell into a tracker query.
 */
export interface RequestDetails {
	title: string;
	year: number | null;
	overview: string | null;
	/** Poster or backdrop, as the source serves it. Shown, never fetched by the gateway. */
	artworkUrl: string | null;
	/** Which seasons exist, for a show. Empty for a film, and empty when unknown. */
	seasonNumbers: number[];
}

export interface RequestSourceSettings {
	type: RequestSourceType;
	baseUrl: string;
	/** Never sent back to the interface: the API answers whether one is set. */
	apiKey?: string | null;
	hasApiKey?: boolean;
	enabled: boolean;
}
