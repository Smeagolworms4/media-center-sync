/** Who may see a library, and pull from it. */
export enum ShareVisibility {
	/** Nobody but us. */
	PRIVATE = 'private',
	/** The peers we linked to ourselves. */
	FRIENDS = 'friends',
	/** Our friends, and theirs. */
	FRIENDS_OF_FRIENDS = 'friends_of_friends',
}

/**
 * What one library exposes.
 *
 * Sharing is decided per library, not per service: somebody may want their series
 * visible and their home videos not, and both live on the same Jellyfin.
 */
export interface SharePolicy {
	id: string;
	libraryId: string;
	libraryName: string;
	serviceId: string;
	visibility: ShareVisibility;
	/** Peers explicitly allowed, on top of the visibility rule. */
	allowedPeerIds: string[];
	/** Peers explicitly denied, whatever the visibility rule says. */
	deniedPeerIds: string[];
	/**
	 * Whether sharing this library makes us a relay, and whether that was agreed to.
	 *
	 * A library on one of our own services is ours to give: we serve our own bytes off
	 * our own disk. A library on a remote service — a friend's gateway, or a Jellyfin we
	 * merely have an account on — is not. Sharing it means our friends pull through us:
	 * our bandwidth, our connection, and an access somebody granted to us rather than to
	 * them.
	 *
	 * That is a real and useful thing to do — it is how somebody with a good line makes
	 * a distant server reachable for their friends — but it is never something to do by
	 * accident, so it has to be said out loud. `relays` is a fact about the library and
	 * cannot be set; `relay` is the answer, and without it a remote library stays private
	 * however its visibility is set.
	 */
	relays: boolean;
	relay: boolean;
	/** Cap the bandwidth this library serves, in bytes per second. 0 means no cap. */
	rateLimit: number;
	updatedAt: string;
}

export type UpdateSharePolicyRequest = Partial<
	Pick<
		SharePolicy,
		'visibility' | 'allowedPeerIds' | 'deniedPeerIds' | 'rateLimit' | 'relay'
	>
>;

/** What a given peer would see of us. The interface shows this before saving. */
export interface ShareAudit {
	peerId: string;
	peerName: string;
	trust: string;
	libraries: {
		libraryId: string;
		name: string;
		itemCount: number;
		/** True when they would be pulling through us rather than from us. */
		throughUs: boolean;
	}[];
}
