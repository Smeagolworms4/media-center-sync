/**
 * The third rung: a friend carries a link between two gateways that cannot meet.
 *
 * `peer-introduction.model.ts` describes the second rung and says plainly that this
 * one is where the design stops being free. Read that first. This file is the wire
 * format for the case it leaves open: A and C are both behind routers, neither can be
 * dialled, and B is the one friend they have in common.
 *
 * **Why an envelope at all.** A dials B — B is reachable, that is why it was asked to
 * introduce them in the first place — and the socket B needs in order to reach C is
 * the one C already opened to B. B cannot open a second one: if it could, so could A,
 * and none of this would exist. So the relayed bytes have to travel back down a link
 * that is already carrying the ordinary peer protocol, which means frames that can be
 * told apart from it and a session identifier so two relayed links and a catalogue
 * request share one socket without interleaving into nonsense.
 *
 * **The envelope, and why it is shaped like this.** A relay frame is a binary message
 * on the peer link whose first four bytes are `RELAY_CHANNEL_MARKER` — a request
 * identifier that can never occur, because identifiers start at one and count up.
 * That is the whole trick, and it is what makes this addition safe: an ordinary
 * binary frame carries the identifier of the request that asked for those bytes, a
 * gateway that has never heard of relaying looks that identifier up, finds nothing
 * pending and drops the frame. It does not fail, it does not close the link, it
 * simply never answers — and the carrier gives up on `RELAY_OPEN_TIMEOUT_MS` and
 * refuses the dial. An older friend is a friend who cannot carry, which is exactly
 * what it was before this existed.
 *
 * ```
 * 0      4      5           9          13
 * +------+------+-----------+-----------+-----------------+
 * | 0xFF…| op   | session   | length    | payload         |
 * +------+------+-----------+-----------+-----------------+
 * ```
 *
 * The length is there although a WebSocket message already has one. It costs four
 * bytes and it buys two things: a reader can refuse an oversized frame before
 * allocating for it, and the decoder is defined over a byte stream rather than over
 * message boundaries — so it cannot silently mis-parse the day anything buffers two
 * frames together or hands it half of one.
 *
 * **What the intermediary sees.** Everything. It holds both halves of the link in
 * plaintext, it can read every frame it carries and it could tamper with them. There
 * is no application-level encryption here and adding one was considered and rejected:
 * it would be a second key exchange, a second thing to get wrong, and it would not
 * change the fact that the carrier chooses whether the bytes arrive at all. This is
 * the reason a direct link is tried first, the reason the peers screen says in one
 * line when a link is relayed, and the reason relaying is off until somebody says yes.
 * Nothing here should be read as privacy.
 *
 * **What it cannot do.** It cannot invent a peer. The relayed link carries the same
 * upgrade credential and the same hello the direct one would — A's key, A's signed
 * challenge, and the introduction token B itself minted — and C admits it through
 * exactly the authority that admits a direct link. C then proves its own key to A
 * before a catalogue row crosses. B is a pipe with an opinion about whether to exist,
 * not a party to the handshake.
 */

/** Where a relayed dial lands, appended to the ordinary link path. */
export const PEER_RELAY_PATH_SUFFIX = '/relay';

/**
 * The request identifier that means "this is not a request at all".
 *
 * Unreachable rather than merely unlikely: identifiers are allocated from one, one at
 * a time, per link, and a socket would have to carry four billion requests to arrive
 * here. Reserving it is what lets relayed traffic share the binary channel with the
 * byte ranges without a protocol version bump.
 */
export const RELAY_CHANNEL_MARKER = 0xffffffff;

/** What a relay frame is for. Anything else is a frame to drop. */
export const RelayOpcode = {
	/** The carrier asks the holder to accept a link, with the dialler's credential. */
	OPEN: 1,
	/** The holder took it. Bytes may flow. */
	ACCEPT: 2,
	/** The holder will not take it, or the carrier will not carry it. */
	REFUSE: 3,
	/**
	 * One text message of the carried link.
	 *
	 * Text and binary are two opcodes rather than one with a flag because the carried
	 * protocol means different things by them — JSON requests one way, byte ranges the
	 * other — and a relay that collapsed the distinction would deliver a chunk of a
	 * film to a JSON parser.
	 */
	TEXT: 4,
	/** One binary message of the carried link. */
	BINARY: 5,
	/** Either end let go. Carries no payload and is never answered. */
	CLOSE: 6,
} as const;

export type RelayOpcodeValue = (typeof RelayOpcode)[keyof typeof RelayOpcode];

/** Marker, opcode, session, length. */
export const RELAY_FRAME_HEADER_BYTES = 13;

/**
 * The largest single message a relayed link may carry: eight megabytes.
 *
 * Far above anything the carried protocol produces — a byte range is pumped one read
 * at a time, which is sixty-four kilobytes — and small enough that a frame header
 * claiming a preposterous length is refused before a buffer that size is allocated.
 * A frame over it closes the session rather than being truncated: a relay that
 * delivered part of a message would corrupt the carried link in a way neither end
 * could attribute.
 */
export const RELAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * How many links this gateway will carry at once: four.
 *
 * A bound, because an unbounded relay is a gateway somebody else can saturate. Four
 * is the same order as the default parallel transfers, which is the other number that
 * says how much of this machine is in use at once — and a household that agreed to
 * help two friends meet did not agree to hold twenty sockets open for strangers it
 * introduced. Past it the upgrade is refused and the dialler reports the peer as
 * unreachable, which is what it was before anybody offered to carry.
 */
export const RELAY_MAX_SESSIONS = 4;

/**
 * How many bytes one carried session may have waiting to be written: four megabytes.
 *
 * Relaying joins two connections with different speeds, and the slower one decides.
 * Without a ceiling, a holder feeding a fast uplink into a dialler on a slow one has
 * the carrier buffering the difference until the process dies — which is the failure
 * an unbounded relay really has, rather than the bandwidth everybody expects. Over
 * it the session is closed, and closed loudly: both ends see a link drop and redial,
 * where a silently stalled one would look like a transfer that stopped for no reason.
 */
export const RELAY_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * How long the carrier waits for the holder to accept: ten seconds.
 *
 * It is the answer to a frame sent down a link that is already open, so it costs one
 * round trip between two households and nothing else. It is deliberately shorter than
 * the fifteen-second connect timeout above it: the dialler is holding a socket open
 * on this gateway while it runs, and a holder from before relaying existed never
 * answers at all.
 */
export const RELAY_OPEN_TIMEOUT_MS = 10_000;

/**
 * Why a relayed session was refused, for the log of whoever is writing one.
 *
 * The dialler is told nothing but that the upgrade failed, for the reason an
 * introduction gives one flat refusal: somebody able to tell "I do not carry" from
 * "I do not know that holder" could map out a gateway's friends and its settings by
 * dialling it.
 */
export enum RelayRefusal {
	/** Nobody here agreed to carry anything. The setting is off. */
	NOT_CARRYING = 'not_carrying',
	/** Already carrying as many as this gateway offered to. */
	AT_CAPACITY = 'at_capacity',
	/** The token names a holder we have no live link to. */
	NO_ROUTE = 'no_route',
	/** The token is not ours, is spent, or names somebody else as its subject. */
	NOT_ADDRESSED = 'not_addressed',
	/** The holder itself said no. */
	DECLINED = 'declined',
	/** More bytes waiting than a carried session is allowed to hold. */
	OVERFLOW = 'overflow',
	/** The link that was carrying it went away. */
	LINK_LOST = 'link_lost',
}

/**
 * What the carrier hands the holder so it can admit the dialler.
 *
 * It is the upgrade credential, verbatim: the same four values a direct dial puts in
 * its headers, plus the introduction token that says whose friend this is. Passed on
 * rather than vouched for — the holder checks the signature itself, against the key
 * the credential carries and the introducer key it already holds, and the carrier's
 * word is worth nothing in that check.
 *
 * `address` is the carrier's view of where the dialler came from. It is a hint for a
 * log and for a peer row, never an authorisation: on a relayed link it is the address
 * of somebody else's uplink as seen by somebody else's machine.
 */
export interface RelayOpenPayload {
	fingerprint: string;
	publicKey: string;
	challenge: string;
	signature: string;
	introduction: string | null;
	address: string | null;
}
