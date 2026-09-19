/**
 * The version two gateways agree on before they exchange anything.
 *
 * Bumped only when a change breaks an older peer. Everything else — a new method, a
 * new field, a new kind of announcement — is a **capability**, named and advertised in
 * the handshake, because a protocol that needs a new version for every addition is one
 * where two friends on different release days cannot talk at all.
 *
 * The rules that keep that true, and they are rules rather than good intentions:
 *
 * - an unknown field in a payload is ignored, never fatal;
 * - an unknown method answers "not supported" and leaves the link open;
 * - a feature is used only when the other end advertised its capability.
 *
 * **Until the first release, there is exactly one version and a mismatch is refused.**
 * Carrying compatibility for versions nobody ever ran is weight with no cargo, and it
 * hides the one thing a pre-release protocol should make loud: that it changed. From
 * the first published release onward, older versions stay in `SUPPORTED_PROTOCOL_VERSIONS`
 * so that two gateways on different releases keep talking — which is the whole point
 * of federating with people who update when they feel like it.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Every version this gateway will still speak, newest first.
 *
 * One entry while unreleased. A published release appends the version it shipped with
 * rather than replacing it.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/**
 * What a gateway can do, beyond the version's own floor.
 *
 * Named so that adding one is not a breaking change: a peer that has never heard of a
 * capability simply does not use it, and a peer that has can ask.
 */
export const PeerCapability = {
	/** Pull a byte range over the peer link. Every version has this. */
	CONTENT: 'content',
	/** Answer a catalogue listing, paginated and filtered by the sharing rules. */
	CATALOGUE: 'catalogue',
	/** Re-read one item on request and say what is actually held now. */
	REVALIDATE: 'revalidate',
	/** Announce and answer which peers hold a content identifier. */
	ANNOUNCE: 'announce',
	/** Exchange pieces with several peers at once for one file. */
	SWARM: 'swarm',
	/** Pass on what a friend of a friend announced. */
	RELAY: 'relay',
} as const;

export type PeerCapabilityValue = (typeof PeerCapability)[keyof typeof PeerCapability];

/**
 * What two gateways tell each other before anything else.
 *
 * `nodeId` is the stable name on the shared network — deliberately not the fingerprint,
 * which can be rotated — and it is what lets an announcement travelling through a
 * friend of a friend be recognised as one we sent ourselves, instead of coming back
 * round and starting a conversation with itself.
 */
export interface PeerHello {
	nodeId: string;
	fingerprint: string;
	name: string;
	protocol: number;
	capabilities: PeerCapabilityValue[];
	/** Free-form, ignored by anything that does not understand it. */
	application?: string;
}

/**
 * The highest version both ends speak, or null when there is none.
 *
 * Null is a refusal rather than a degraded mode: a gateway that guessed at a protocol
 * it does not implement would fail later, somewhere unrelated, with an error about a
 * missing field.
 */
export const negotiateProtocol = (
	theirs: number,
	ours: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): number | null => (ours.includes(theirs) ? theirs : null);
