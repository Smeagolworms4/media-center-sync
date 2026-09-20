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
	/**
	 * Whether somebody chose this visibility, or it is the gateway's default applying.
	 *
	 * False means no policy was ever written for this library and `visibility` above is
	 * `Settings.defaultShareVisibility` resolved for it — so changing that setting moves
	 * this library, and every other one nobody has touched.
	 *
	 * A screen that cannot tell the two apart cannot answer the only question people
	 * ask of it: a library reading "nobody" because somebody deliberately made it
	 * private looks exactly like one reading "nobody" because its service is not shared
	 * and the default never reaches it. They are opposite states — one is a decision to
	 * leave alone, the other moves the moment somebody flips the service's switch — and
	 * without this flag the interface has to guess which it is showing.
	 */
	overridden: boolean;
	/** Peers explicitly allowed, on top of the visibility rule. */
	allowedPeerIds: string[];
	/** Peers explicitly denied, whatever the visibility rule says. */
	deniedPeerIds: string[];
	/** Cap the bandwidth this library serves, in bytes per second. 0 means no cap. */
	rateLimit: number;
	updatedAt: string;
}

export type UpdateSharePolicyRequest = Partial<
	Pick<SharePolicy, 'visibility' | 'allowedPeerIds' | 'deniedPeerIds' | 'rateLimit'>
>;

/** What a given peer would see of us. The interface shows this before saving. */
export interface ShareAudit {
	peerId: string;
	peerName: string;
	trust: string;
	libraries: {
		libraryId: string;
		name: string;
		/**
		 * Which server it sits on, shown beside the name.
		 *
		 * Libraries of the same name are one category everywhere else in this
		 * application, but this list is deliberately not merged: it answers what a
		 * given peer would be served, and that is decided per library. Two rows called
		 * `Movies` and two called `Shows`, with nothing to tell them apart, read as a
		 * rendering bug — and the one question somebody has here, which of their
		 * servers is exposed, has no answer on the screen.
		 */
		serviceName: string;
		itemCount: number;
		/**
		 * True when they would be pulling through us rather than from us.
		 *
		 * A fact, not a gate: sharing a library whose files we do not hold is served by
		 * reading the media server over HTTP and passing the bytes on, which works and
		 * is often the point. It is said here because it is the one thing about a share
		 * that costs us our own line, and nothing else on the screen would say so.
		 */
		throughUs: boolean;
	}[];
}
