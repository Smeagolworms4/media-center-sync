/**
 * When the gateway decides where a pulled file goes, and when it asks.
 *
 * The tension is real: asking every time is unusable on a sync of two hundred
 * episodes, and never asking puts somebody's anime season in their films library
 * with nothing said. The middle is the only honest setting — decide when there is a
 * precedent, ask when there genuinely is not, and remember the answer so the same
 * question is never asked twice.
 */
export enum PlacementDecision {
	/** Never ask. An ambiguous item goes to the best guess, and the run says so. */
	AUTOMATIC = 'automatic',
	/** Ask only when nothing in the library already answers the question. */
	ASK_WHEN_UNCLEAR = 'ask_when_unclear',
	/** Ask for every show the gateway has not been told about yet. */
	ALWAYS_ASK = 'always_ask',
}

/**
 * How sure the gateway is about a destination.
 *
 * `RESOLVED` is not "we picked one": it means the answer came from something real —
 * a copy of this show already filed somewhere, or a remembered rule, or exactly one
 * library that could take it. Anything else is `AMBIGUOUS`, and the difference is
 * what decides whether a person is interrupted.
 */
export enum PlacementConfidence {
	RESOLVED = 'resolved',
	AMBIGUOUS = 'ambiguous',
	/** Nothing writable can hold it. Asking would offer a choice between no options. */
	IMPOSSIBLE = 'impossible',
}

/** Why a destination is proposed, so the reason can be read rather than inferred. */
export enum PlacementReason {
	/** We already hold part of this show, and it lives here. */
	EXISTING_COPY = 'existing_copy',
	/** Somebody answered this question before, for this show or this source. */
	REMEMBERED = 'remembered',
	/** The library marked as the default target for this kind. */
	DEFAULT_TARGET = 'default_target',
	/** The only library that could take it. */
	ONLY_CANDIDATE = 'only_candidate',
	/** A plausible library of the right kind, among others. */
	CANDIDATE = 'candidate',
	/** The fixed path from the settings. */
	FIXED_PATH = 'fixed_path',
}

export interface PlacementOption {
	libraryId: string;
	libraryName: string;
	serviceId: string;
	serviceName: string;
	/** Absolute directory the file would land in, folders included. */
	directory: string;
	reason: PlacementReason;
	/** Room left, so a choice is made against something real rather than a name. */
	freeBytes: number | null;
	writable: boolean;
	recommended: boolean;
}

/** What the gateway worked out for one item, and what it would offer instead. */
export interface PlacementProposal {
	confidence: PlacementConfidence;
	/** Null only when nothing is writable. */
	chosen: PlacementOption | null;
	options: PlacementOption[];
}

/**
 * An item a run will not start until somebody says where it goes.
 *
 * It carries enough to be answered without loading anything else: what it is, where
 * it came from, and every destination that could take it.
 */
export interface PendingPlacement {
	itemId: string;
	title: string;
	kind: string;
	/** The show or collection the question is really about. */
	groupTitle: string | null;
	sourceServiceId: string;
	sourceServiceName: string;
	peerName: string | null;
	bytes: number;
	options: PlacementOption[];
}

/** What a rule applies to. Narrow first: a rule nobody remembers making is a trap. */
export enum PlacementRuleScope {
	/** This show, wherever it comes from. What people mean by "put this series there". */
	SERIES = 'series',
	/** Everything arriving from one source library — a friend's anime shelf. */
	SOURCE_LIBRARY = 'source_library',
	/** Everything arriving from one peer. */
	PEER = 'peer',
	/** Everything of one kind, which is the settings' default by another name. */
	KIND = 'kind',
}

export interface PlacementRule {
	id: string;
	scope: PlacementRuleScope;
	/** Normalised series title, library id, peer id or media kind, per the scope. */
	key: string;
	/** Shown in the settings, because a rule keyed on an identifier is unreadable. */
	label: string;
	targetLibraryId: string;
	targetLibraryName: string;
	/** How many times it answered a question, so a stale rule can be spotted. */
	useCount: number;
	lastUsedAt: string | null;
	createdAt: string;
}

/** Answering a pending placement, and saying whether to remember the answer. */
export interface PlacementAnswer {
	itemId: string;
	libraryId: string;
	/**
	 * Remember it, and at what breadth.
	 *
	 * Omitted means answer this once. A rule is offered rather than imposed because
	 * the breadth is a judgement only the person can make: this season, this show, or
	 * everything this friend ever sends.
	 */
	remember?: PlacementRuleScope;
}
