/**
 * Another gateway, run by somebody else.
 *
 * A peer is not a media service: it is a machine that holds services and decides
 * what it shows us. Linking to a peer gives us a catalogue; what we may pull from
 * it is what its owner shared.
 */
export enum PeerStatus {
	/** Asked for, or asked of us, and not accepted yet. */
	PENDING = 'pending',
	LINKED = 'linked',
	/** Linked, but unreachable at the moment. */
	UNREACHABLE = 'unreachable',
	BLOCKED = 'blocked',
}

/**
 * How far from us the peer is.
 *
 * A friend of a friend is reachable, and useful — they may hold the same episode
 * and widen the swarm — but they are not someone we invited. The interface says so,
 * and the sharing rules can exclude them.
 *
 * Kept as a two-value distinction because that is what sharing decisions actually
 * turn on: a library is offered to people we chose, or to the wider circle. The
 * precise distance is `Peer.depth`, and beyond the second hop there is no third word
 * anybody would recognise — "friend of a friend of a friend" is a number pretending
 * to be a name.
 */
export enum PeerTrust {
	FRIEND = 'friend',
	FRIEND_OF_FRIEND = 'friend_of_friend',
}

/**
 * How far introductions may travel, counted in hops.
 *
 * 1 is people we linked to ourselves, 2 their friends, 3 one step further. The
 * default is 3: far enough that a popular release usually has several holders —
 * which is the whole point of letting the circle widen at all — and close enough
 * that every gateway in it is two introductions from somebody we chose.
 *
 * It is a ceiling, never a target. The effective distance of any peer is the
 * smallest budget any hop along the chain allowed, so raising this here cannot pull
 * in a gateway whose own owner set a shorter reach. A limit that only the receiving
 * side enforced would protect nobody: it would stop us *listing* distant peers while
 * our own announcements kept travelling.
 */
export const DEFAULT_PEER_MAX_DEPTH = 3;

/**
 * The hard ceiling, whatever anybody sets.
 *
 * Each hop multiplies the gateways that may hear an announcement, and none of them
 * were chosen by us. Past this the set stops resembling a circle of friends and
 * starts resembling a public index — which is a different product, with different
 * consequences for whoever runs it.
 */
export const MAX_PEER_MAX_DEPTH = 6;

/**
 * Which side asked.
 *
 * Only meaningful while a peer is pending, and it decides what the interface shows:
 * one is a request waiting on somebody else, the other is a request waiting on you.
 * Rendering both the same way is how an incoming request sits unanswered for a week.
 */
export enum PeerDirection {
	/** We asked them. Nothing to do here until they accept. */
	OUTGOING = 'outgoing',
	/** They asked us. This is the one that needs a decision. */
	INCOMING = 'incoming',
}

/** How the link is carried, once negotiated. */
export enum PeerLinkMode {
	/** Direct connection, after the rendezvous introduced both ends. */
	DIRECT = 'direct',
	/** Through the rendezvous, when no direct path could be opened. */
	RELAY = 'relay',
}

export interface Peer {
	id: string;
	name: string;
	/** Their node identifier, learned when the link was established. */
	nodeId: string | null;
	/** The protocol version agreed with them, and the features they advertised. */
	protocol: number | null;
	capabilities: string[];
	/** Public key fingerprint. This is the identity; the address can change. */
	fingerprint: string;
	status: PeerStatus;
	/** Who asked, while the link is pending. Null once it is settled. */
	direction: PeerDirection | null;
	trust: PeerTrust;
	/**
	 * How many introductions away they are. 1 is somebody we linked to ourselves.
	 *
	 * This is the number the source order and the swarm reason about — nearer peers
	 * first, all else equal — and the one a screen can state plainly. `trust` collapses
	 * everything past the first hop into one word, which is enough to decide sharing
	 * and not enough to decide anything else.
	 */
	depth: number;
	/**
	 * How far introductions coming through *this* peer may travel, overriding the
	 * gateway's own ceiling. Null follows the default.
	 *
	 * Per peer rather than global because the circles behind two friends are not
	 * comparable: one runs a gateway for a household, the other for a club of forty.
	 * Widening the reach for the first is harmless; doing it for the second, by
	 * raising one number that applies to both, is how a friends-and-family index
	 * quietly becomes a public one.
	 */
	maxDepth: number | null;
	linkMode: PeerLinkMode | null;
	/** Last address a link was established on. Informational only. */
	address: string | null;
	/** The friend who introduced them, for a friend of a friend. */
	viaPeerId: string | null;
	viaPeerName: string | null;
	serviceCount: number;
	sharedItemCount: number;
	lastSeenAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Linking by fingerprint, with nothing secret in transit.
 *
 * The invitation below is a convenience, not a requirement — and it is worth being
 * clear about which is which. What a link actually needs is that each side knows the
 * other's public key fingerprint and has said, once, that it trusts it. An invitation
 * bundles that into a single code so one person can do the whole thing; this does the
 * same work in the open, the way people already pair devices: you paste your friend's
 * fingerprint, they get a request showing yours, they accept.
 *
 * It costs one more action and buys three things a code cannot: nothing secret travels
 * through a chat log, nothing expires, and the person accepting sees exactly who is
 * asking before agreeing to anything.
 */
export interface AddPeerRequest {
	/** Their public key fingerprint, as their own gateway displays it. */
	fingerprint: string;
	/** What to call them here. Defaults to what they announce. */
	name?: string;
	/**
	 * Where to reach them, when you know.
	 *
	 * Optional because the rendezvous can find them by fingerprint. Given, it is tried
	 * first — a direct address is faster and involves nobody else.
	 */
	address?: string;
}

/**
 * What you hand to a friend so they can link to you.
 *
 * It carries the fingerprint, the rendezvous to meet at, and a one-shot secret. It
 * expires: an invitation that never expires is a credential left lying around.
 */
export interface PeerInvite {
	code: string;
	fingerprint: string;
	rendezvous: string;
	expiresAt: string;
	/** Ready to copy and paste, encoding everything above. */
	url: string;
}

export interface AcceptPeerInviteRequest {
	/** The code or the whole URL — both are accepted. */
	invite: string;
	name?: string;
}

/**
 * One row of what a peer exposes to us.
 *
 * Deliberately thinner than a `MediaItem`: a peer tells us what it holds, not how it
 * files it. Paths, library identifiers and internal item identifiers are theirs and
 * stay theirs — sending them would leak the shape of somebody's disk for no gain, and
 * would tempt us into addressing their library by path rather than by content.
 */
export interface CatalogueEntry {
	/** Their identifier for the item. Opaque to us; we hand it back to ask for bytes. */
	externalId: string;
	/**
	 * Which of their shared libraries this row belongs to, as `catalogue.libraries`
	 * named it.
	 *
	 * It is their library row identifier and nothing else — never a path, never the
	 * identifier the media server underneath uses. Publishing it is what lets a peer's
	 * three shared libraries arrive here as three libraries rather than as one bag:
	 * categories, missing counts and sync scopes are all expressed per library, and a
	 * peer whose rows have no library at all can only ever be one.
	 *
	 * Optional rather than required, and that is the wire compatibility: a gateway
	 * running an older image sends rows without the key, and a required field would
	 * make every one of them fail to parse.
	 */
	libraryId?: string | null;
	kind: string;
	title: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	parentExternalId: string | null;
	externalIds: Record<string, string>;
	/** Present only when they share the files, absent when they share the catalogue. */
	contentId: string | null;
	size: number | null;
	quality: string | null;
}

/**
 * One library a peer shares with us.
 *
 * Thinner than our own `Library` for the same reason `CatalogueEntry` is thinner than
 * a `MediaItem`: the paths, the local path and the scan cursor are facts about
 * somebody else's disk, and neither half of this exchange has any use for them. What
 * crosses is what a library is from the outside — a name, a kind, and how much is in
 * it.
 */
export interface PeerLibrary {
	/** Their library row identifier, which is what a catalogue row is filed under. */
	externalId: string;
	name: string;
	/** The same enum a library of ours carries; `other` when they do not say. */
	kind: string;
	/** What they hold in it, for a screen that wants to say so before a scan. */
	itemCount: number;
}

/** This gateway's own identity, shown in the peers screen. */
export interface PeerIdentity {
	/**
	 * A stable identifier for this gateway across the whole shared network.
	 *
	 * Generated once and never derived from anything: a key can be rotated and an
	 * address changes, and neither should make a gateway look like a new participant.
	 *
	 * It exists to stop announcements going round in circles. A friend of a friend
	 * propagates what it hears, so without a name to recognise itself by, a gateway
	 * receives its own catalogue back through a third party, answers it, and two
	 * households spend their evening telling each other about the same file.
	 */
	nodeId: string;
	fingerprint: string;
	name: string;
	rendezvous: string;
	/** Address peers can reach directly, when the port is forwarded. */
	directAddress: string | null;
	/** False when only relayed links are possible. */
	directReachable: boolean;
}


/**
 * A fingerprint this gateway refuses, whether or not a peer row exists for it.
 *
 * Blocking sets a status on a peer we still keep; banning outlives the row. The
 * distinction exists because removing a peer used to be the *weaker* of the two
 * actions: it deleted the row, and with it the only thing that had been refusing
 * them, so the next request from the same key arrived as a fresh introduction to
 * accept. Somebody ejecting a peer means to be rid of them, not to reset the
 * relationship.
 *
 * Keyed by fingerprint rather than by peer, because that is the part that survives:
 * a name is a label we chose, an address changes, and a node identifier is
 * self-declared. The key is the identity.
 */
export interface BannedPeer {
	/** The public key fingerprint being refused. */
	fingerprint: string;
	/** What they were called here when the ban was recorded, for a readable list. */
	name: string | null;
	/** Why, for whoever reads this list a year from now. */
	reason: string | null;
	bannedAt: string;
}

export interface BanPeerRequest {
	fingerprint: string;
	name?: string;
	reason?: string;
}

/**
 * Unlinking, with or without a ban.
 *
 * Defaulting `ban` to false keeps the ordinary case ordinary — a peer removed
 * because a friend rebuilt their gateway should be able to come back by asking. The
 * interface offers the ban as a checkbox on the removal, where the decision belongs,
 * rather than as a second action somebody has to know to take afterwards.
 */
export interface RemovePeerRequest {
	ban?: boolean;
	reason?: string;
}
