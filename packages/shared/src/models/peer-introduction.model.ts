/**
 * Introducing two peers, rather than standing between them.
 *
 * I am a friend of A and a friend of B. A and B have never met. A wants something B
 * holds — or simply wants to know what B has.
 *
 * There are two ways to answer that, and they are not variations of one idea:
 *
 * - **Relaying**: A asks me, I ask B, I pass the answer back. Every byte and every
 *   listing crosses my machine. It costs my bandwidth, it makes me a bottleneck, and
 *   it hides B's address from A.
 * - **Introducing**: I tell A where B is and hand A something B will accept, then I
 *   step out. A and B talk directly, and my part is over.
 *
 * This file is the second one. It applies to the catalogue exactly as it applies to
 * the content: once A and B are introduced there is no reason for a listing to take
 * the long way round either, and `findHolders` looking things up on somebody's behalf
 * becomes a thing we no longer do.
 *
 * **The disclosure is the price, and it has to be deliberate.** Introducing reveals
 * B's address to A, which relaying does not. That is why an introduction is issued
 * against consent on both sides rather than implied by two friendships existing:
 * being willing to share with my friends is not the same as being willing to be
 * reachable by people I have never heard of.
 *
 * **What the introducer does not learn, and must not be able to.** An introduction
 * names a peer and a scope. It never names a media. A asks to be introduced to B, not
 * to be introduced to B *for Titanic* — so the one thing I hold is that two of my
 * friends now know each other, which is inherent in having introduced them and is the
 * whole of it. Once the link is up it is end to end between A and B: I am not a
 * termination point, I hold no key to it, and what they list or pull is not something
 * I could report even if somebody made me want to.
 *
 * This is the property that makes introducing *better* than relaying rather than
 * merely cheaper. A relay sees every title requested and every byte moved, and a
 * relay's operator is therefore worth compelling. An introducer has nothing to give
 * up. It is also why the scope is coarse — `CATALOGUE` and `CONTENT`, not a list of
 * permitted items: a fine-grained scope would smuggle back into the voucher exactly
 * the knowledge this design exists to keep out of it.
 */

/**
 * Three arrangements, and only two of them can keep this gateway out of the middle.
 *
 * 1. **Two peers who can reach each other** — introduce them. Coordinates and a
 *    voucher cross this gateway once; nothing else ever does.
 * 2. **Two peers behind NAT with nothing forwarded** — neither can open a connection,
 *    so coordinates are useless and the only thing that works is somebody both can
 *    reach. Relayed, only with `relayBetweenPeers`, and relayed as ciphertext: the
 *    bandwidth is spent, the knowledge is not.
 * 3. **A remote Jellyfin or Plex this gateway shares** — there is no introduction to
 *    make. That server does not speak our protocol, and the friend being shared with
 *    has no account on it; the only reason they can see anything at all is that *we*
 *    have an account and are willing to stand in front of it. Being the gateway is
 *    not a fallback here, it is the entire arrangement, which is why sharing one is
 *    consent (`SharePolicy.relay`) rather than something that follows from sharing.
 *
 * **And the third case does not get the privacy the first two do.** We fetch from
 * that media server with our own credentials and hand the result on, so we see what
 * was asked for and what came back. There is no version of this where we do not:
 * end-to-end encryption between the friend and a Jellyfin that has never heard of
 * them is not a thing that can exist. Anybody sharing a remote service should know
 * they are reading their friends' requests, whether or not they want to be.
 */

/** What an introduction entitles the bearer to do. */
export enum IntroductionScope {
	/** List what the far end shares — the same view a direct friend would get. */
	CATALOGUE = 'catalogue',
	/** Ask for bytes of something already known to be shared. */
	CONTENT = 'content',
}

/**
 * What I hand A so that B will talk to them.
 *
 * `voucher` is signed by the introducer and **verified by B without asking anybody**.
 * That is the whole point: an introduction B had to phone home about would put me
 * back in the path — for control rather than for data, but back in it, and offline
 * the moment my gateway is down.
 *
 * **The expiry bounds the first handshake, not the friendship.** An introduction is a
 * bootstrap and nothing more: once A and B have completed a handshake they hold each
 * other's fingerprint and key, which is all an ordinary peer link has ever needed, so
 * from that moment they reconnect directly and for ever without anybody's help. The
 * introducer can go offline permanently and nothing between them breaks. Asking to be
 * re-introduced to somebody you already know would be a step that exists only to
 * serve the design rather than the people using it.
 *
 * So the voucher's life is measured in minutes, not months: it needs to survive long
 * enough for A to dial B once. That also settles what a revocation list would have
 * been for, and the honest answer is: nothing useful. A list is only as good as the
 * last time it was fetched, it fails open exactly when the network is broken, and by
 * the time anybody consulted it the two ends would already know each other.
 *
 * Which is worth saying plainly, because it is the real cost of this design:
 * **introducing cannot be undone.** It is not lending access that can be taken back —
 * it is telling two people about each other, and afterwards that is between them.
 * Whoever presses the button should understand they are making an introduction, not
 * granting a permission.
 */
export interface PeerIntroduction {
	id: string;
	/** The node being introduced: who will present this. */
	subjectNodeId: string;
	/** The node they are being introduced to. */
	targetNodeId: string;
	/** Where to reach the target. Null when only the rendezvous knows. */
	targetAddress: string | null;
	/** The introducer. Also who signed the voucher. */
	issuerNodeId: string;
	scope: IntroductionScope[];
	/** Opaque to everyone but the target, who verifies it against the issuer's key. */
	voucher: string;
	issuedAt: string;
	expiresAt: string;
}

/**
 * A asks me to introduce them to B.
 *
 * Deliberately carries no media identifier, and there is no field here for one. The
 * request A would naturally write — "introduce me to B so I can get this episode" —
 * is precisely the sentence the introducer must not be holding afterwards, and a
 * field nobody fills in today is a field somebody fills in next year.
 */
export interface RequestIntroductionRequest {
	targetNodeId: string;
	scope?: IntroductionScope[];
	/**
	 * Free text shown to whoever decides, never interpreted and never stored past the
	 * decision. It is for "we met at the LAN party", not for naming a file.
	 */
	reason?: string;
}

/**
 * Whether this gateway will introduce its friends to each other, and be introduced.
 *
 * Two separate permissions because they are two separate exposures. Introducing costs
 * me nothing but tells A where B lives; being introduced means strangers vouched for
 * by my friends can reach me. Somebody may reasonably want one and not the other.
 */
export interface IntroductionPolicy {
	/** Hand my friends to each other when they ask. */
	introduceFriends: boolean;
	/** Accept a voucher from a friend and talk to whoever it names. */
	acceptIntroductions: boolean;
	/** How long an introduction I issue stays good, in minutes. */
	validityMinutes: number;

	/**
	 * Carry traffic between two peers who cannot reach each other. Off by default.
	 *
	 * Introducing fails when *both* ends are behind a NAT with nothing forwarded:
	 * there is no direction in which a connection can be opened, and coordinates are
	 * no use to either of them. Then the only thing that works is somebody in the
	 * middle who both can reach — which, for two of my friends, is me.
	 *
	 * It is off unless switched on, and that is not timidity. Relaying spends my
	 * upload on somebody else's transfer, indefinitely, for a pair I may have
	 * introduced once and forgotten. An introduction costs one exchange and ends; a
	 * relay is an open-ended commitment, so it is one somebody agrees to.
	 *
	 * **What it does not cost is the privacy above.** The session stays end to end
	 * between the two peers, and what crosses this gateway is ciphertext it holds no
	 * key to — so a relay learns no more about what is being moved than an
	 * introduction does. That is the whole reason to relay the session rather than
	 * terminate it here and forward the plain request: terminating would be simpler to
	 * write and would make this gateway's operator worth compelling.
	 */
	relayBetweenPeers: boolean;
	/** A ceiling on what relaying may spend, in bytes per second. Zero is unlimited. */
	relayRateLimit: number;
}

/** Why an introduction was refused, so the far end can say something true. */
export enum IntroductionRefusal {
	/** The issuer does not introduce. */
	NOT_OFFERED = 'not_offered',
	/** The target does not accept introductions. */
	NOT_ACCEPTED = 'not_accepted',
	/** The issuer is not actually a friend of both ends. */
	NOT_BOTH_FRIENDS = 'not_both_friends',
	/** Signed, but past its expiry. */
	EXPIRED = 'expired',
	/** Neither end could open a connection, and this gateway does not relay. */
	NO_PATH = 'no_path',
	/** The signature does not verify against the issuer we know. */
	UNVERIFIED = 'unverified',
}
