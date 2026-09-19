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
 */
export enum PeerTrust {
	FRIEND = 'friend',
	FRIEND_OF_FRIEND = 'friend_of_friend',
}

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
	/** Public key fingerprint. This is the identity; the address can change. */
	fingerprint: string;
	status: PeerStatus;
	/** Who asked, while the link is pending. Null once it is settled. */
	direction: PeerDirection | null;
	trust: PeerTrust;
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
