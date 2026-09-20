/**
 * Introducing two peers, rather than standing between them.
 *
 * I am a friend of A and a friend of C. A and C have never met. A wants something C
 * holds, and found out about it because I answered an announcement on C's behalf.
 *
 * There are two ways to finish that sentence, and they are not variations of one idea:
 *
 * - **Relaying**: A asks me, I ask C, I pass the bytes back. Every byte crosses my
 *   machine. It costs my upload, it makes me a bottleneck for a transfer I get nothing
 *   from, and it puts every title A asks for in my logs.
 * - **Introducing**: I tell A where C is and hand A something C will accept, then I
 *   step out. A and C talk directly, and my part is over after one small answer.
 *
 * **For peers this gateway does the second one, and never the first.** Relaying stays
 * real, and stays the whole arrangement, for a remote Jellyfin or Plex that somebody
 * shares: that server does not speak this protocol, the friend being shared with has
 * no account on it, and the only reason they see anything at all is that we have an
 * account and are willing to stand in front of it. There is no introduction to make
 * there. Between two gateways there always is.
 *
 * **The token is the whole protocol.** There is no signalling session to invent and no
 * state for anybody to hold: I sign a short statement, A carries it to C as a header on
 * the WebSocket upgrade, and C checks the signature against my public key — which it
 * has, because I am its peer. C does not have to know A in advance, and that is the
 * entire point. It follows the shape of the two mechanisms already here: the upgrade
 * credential in `PeerGatewayService` (fingerprint, key, signed challenge, signature)
 * and the expiring one-shot invitation in `PeerManager`.
 *
 * **Nobody is asked for extra consent.** C is not prompted, and no row waits for
 * somebody to approve it — being discoverable at that distance *is* the agreement.
 * `Settings.peerMaxDepth` and each peer's `maxDepth` are that agreement written down:
 * they decide how far an introduction may travel, which is the same sentence as how
 * far away somebody may be and still reach this gateway. Anybody lowering one is
 * narrowing who can reach them, not tuning a lookup.
 *
 * **What the introducer does not learn.** The token names a subject, a holder and a
 * distance. It never names a media, and there is no field here for one: the request A
 * would naturally write — "introduce me to C so I can get this episode" — is precisely
 * the sentence the introducer must not be holding afterwards, and a field nobody fills
 * in today is a field somebody fills in next year.
 *
 * **What it does not buy.** Nothing here is encryption. The link between A and C is
 * authenticated by key and carried by whatever transport the two ends can open; when
 * neither can open a direct one it falls back to being carried by me, the introducer,
 * and my machine then really does see the bytes. That is a fact the interface states
 * in one line rather than dressing up — see `peer.relay_hint`.
 *
 * **And when there is nobody in the middle at all**, two gateways behind two routers
 * cannot be connected. That is an ordinary home-network fact and a stated limit, not
 * a setting somebody failed to fill in: the fix is forwarding the interface's port on
 * one of the two routers. The one case with no intermediary by definition — two
 * gateways that have never met — is the invitation, which carries the issuing
 * gateway's own address.
 */

/** Version of the token payload, so a future shape can be told from this one. */
export const INTRODUCTION_VERSION = 1;

/**
 * The method A calls on B to be introduced to somebody B is linked to.
 *
 * Named like every other peer method, and answered with a value rather than a stream:
 * an introduction is one small object, and the bytes it leads to never come back this
 * way.
 */
export const PEER_INTRODUCE_METHOD = 'peer.introduce';

/**
 * Where the token rides on the upgrade to the holder.
 *
 * A header rather than a query parameter, for the reason the credential is one: the
 * four credential headers are already read there, proxies do not log headers the way
 * they log URLs, and a token in a path ends up in somebody's access log for a day.
 */
export const PEER_INTRODUCTION_HEADER = 'x-mcs-introduction';

/**
 * How long a token the issuer mints stays good: two minutes.
 *
 * It is a bootstrap and nothing more. What it has to survive is one dial — a direct
 * attempt at fifteen seconds, the introducer's answer, and a relayed attempt at
 * fifteen more — which is under a minute of work. Two minutes is that with room to
 * spare, and far short of a credential anybody would think of storing.
 *
 * It is deliberately not longer. Once A and C have completed a handshake they hold
 * each other's fingerprint and key, which is all an ordinary peer link has ever
 * needed: from that moment they reconnect without anybody's help, and the introducer
 * can go offline for good. A token that outlived the dial would be a key to somebody
 * else's gateway sitting in a log, buying a step that is already unnecessary.
 */
export const INTRODUCTION_TTL_MS = 2 * 60_000;

/**
 * How far apart the two clocks are allowed to be: five minutes, each way.
 *
 * The same tolerance a signed challenge already gets, and for the same reason — the
 * two clocks belong to two households and neither is ours. Without it a two-minute
 * token would be refused on arrival by a gateway whose clock is three minutes behind,
 * and the refusal would be indistinguishable from a forged token: somebody would go
 * looking at their keys for a problem that is a wrong time zone.
 */
export const INTRODUCTION_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * What the introducer signs, and the holder reads.
 *
 * Every field is there to stop one thing:
 *
 * - `subject` binds the token to A's key. A token lifted off the wire is worthless to
 *   anybody else, because the upgrade it rides on still has to carry a signature made
 *   with A's private key. This is why the token may be presented more than once inside
 *   its two minutes rather than being burned on first use: the fallback to the relay is
 *   a *second* upgrade with the same token, and a link that drops mid-transfer and
 *   redials is a third. One-shot would make the fallback need a fresh round trip to the
 *   introducer — who may be the one who is offline — to recover from the exact failure
 *   the fallback exists for. What bounds this token is its life, not a counter, and a
 *   counter would also mean the holder keeping a list of spent tokens that a stranger
 *   can make grow.
 * - `holder` binds it to C. Without it, a token minted to reach C would open a link to
 *   any other peer of the introducer's.
 * - `depth` is what the holder checks against its own ceiling. It is the subject's
 *   distance from the holder as the introducer counts it, and the holder never takes it
 *   as read: it is compared with the introducer's own distance and the larger wins, so
 *   nobody can shorten a chain by claiming a smaller number.
 *
 * There is no scope field. What A may see at C is decided by C's share policies for
 * somebody at that distance, every time, on every route — the mechanism that already
 * exists and is already the one people configure. A scope inside the token would be a
 * second place that decision is made, and the finer it got the more it would tell the
 * introducer about what A came for.
 */
export interface PeerIntroductionClaim {
	v: number;
	/** Fingerprint of the gateway that signed this. The holder's peer. */
	introducer: string;
	/** Fingerprint of whoever may present it. */
	subject: string;
	/** Fingerprint of the gateway it opens a link to. */
	holder: string;
	/** Hops between subject and holder, as the introducer counts them. */
	depth: number;
	issuedAt: number;
	expiresAt: number;
}

/**
 * How many friends are asked to introduce us before a dial gives up: three.
 *
 * A bound rather than "every peer we have", because the screen is waiting. Each ask
 * is a round trip to a household on the other side of a consumer uplink, and a
 * gateway that tried twenty of them in turn would leave somebody looking at a spinner
 * for a minute before being told what a single failure already said. Three is enough
 * for the friend who told us about this peer to be offline and for two others to have
 * nothing to offer either.
 */
export const MAX_INTRODUCERS_ASKED = 3;

/**
 * What the introducer answers, and what A needs to dial.
 *
 * The address is a hint and may be null: the introducer may know the holder only
 * through an inbound link, which is exactly the case for a friend behind a router.
 * What is never here is a public key — the holder proves which key it holds during the
 * handshake, exactly as it does for a direct friend, and shipping one would invite the
 * caller to trust a key it was handed by a third party.
 */
export interface PeerIntroduction {
	/** Signed by the introducer, opaque to the bearer, checked by the holder. */
	token: string;
	fingerprint: string;
	address: string | null;
	/** ISO, for a caller that wants to say why a link can no longer be opened. */
	expiresAt: string;
	depth: number;
}

/**
 * Why an introduction was refused, so a log says something true.
 *
 * The holder answers the same flat refusal to the far end whichever of these it is —
 * telling them apart would let somebody map out a gateway's friends and limits by
 * watching what happens — so these exist for the side that is writing the log entry.
 */
export enum IntroductionRefusal {
	/** Not a token, or not one this version can read. */
	MALFORMED = 'malformed',
	/** Signed, but past its life. */
	EXPIRED = 'expired',
	/** The signature does not verify against the key we hold for the introducer. */
	UNVERIFIED = 'unverified',
	/** Whoever signed it is not a peer of ours, so they vouch for nobody here. */
	UNKNOWN_INTRODUCER = 'unknown_introducer',
	/** The token was minted for somebody else, or for another gateway. */
	NOT_ADDRESSED = 'not_addressed',
	/** Further away than this gateway agreed to be reachable from. */
	TOO_FAR = 'too_far',
}
