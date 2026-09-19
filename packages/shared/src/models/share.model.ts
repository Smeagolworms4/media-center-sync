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
	/** Cap the bandwidth this library serves, in bytes per second. 0 means no cap. */
	rateLimit: number;
	updatedAt: string;
}

export type UpdateSharePolicyRequest = Partial<
	Pick<
		SharePolicy,
		'visibility' | 'allowedPeerIds' | 'deniedPeerIds' | 'rateLimit'
	>
>;

/** What a given peer would see of us. The interface shows this before saving. */
export interface ShareAudit {
	peerId: string;
	peerName: string;
	trust: string;
	libraries: { libraryId: string; name: string; itemCount: number }[];
}
