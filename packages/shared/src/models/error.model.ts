/**
 * Error keys.
 *
 * The API answers with keys, never sentences: the interface decides the wording,
 * and a key can be translated without breaking a caller. Field validation errors
 * keep their own shape — `{ field: string[] }` — which the form layer maps onto
 * the matching input.
 */
export const ErrorKey = {
	AUTH_INVALID_CREDENTIALS: 'error.auth.invalid_credentials',
	AUTH_PROVIDER_UNKNOWN: 'error.auth.provider_unknown',
	AUTH_PROVIDER_UNREACHABLE: 'error.auth.provider_unreachable',
	AUTH_SESSION_EXPIRED: 'error.auth.session_expired',
	AUTH_FORBIDDEN: 'error.auth.forbidden',

	SERVICE_NOT_FOUND: 'error.service.not_found',
	SERVICE_UNREACHABLE: 'error.service.unreachable',
	/**
	 * The service answered, and does not have the thing we asked for.
	 *
	 * Deliberately distinct from `SERVICE_UNREACHABLE`: "the file is gone" and "I
	 * cannot reach you" are the two answers revalidation exists to tell apart, and
	 * collapsing them costs either a dead source kept alive forever or a healthy one
	 * abandoned on a reboot.
	 */
	SERVICE_RESOURCE_NOT_FOUND: 'error.service.resource_not_found',
	SERVICE_UNAUTHORIZED: 'error.service.unauthorized',
	SERVICE_DUPLICATE: 'error.service.duplicate',
	SERVICE_HANDLER_UNKNOWN: 'error.service.handler_unknown',
	/**
	 * This kind of service cannot sign anybody in, and never will.
	 *
	 * A peer is a media service in every way the index cares about, but there is one
	 * thing it is not: an account system. Answering with a made-up identity, or with
	 * the generic refusal, would let somebody set a friend's gateway as the gateway's
	 * authentication provider and discover the mistake at the sign-in screen, where
	 * the only thing on offer is "wrong credentials".
	 */
	SERVICE_AUTH_UNSUPPORTED: 'error.service.auth_unsupported',

	LIBRARY_NOT_FOUND: 'error.library.not_found',
	LIBRARY_PATH_UNREADABLE: 'error.library.path_unreadable',
	LIBRARY_PATH_NOT_WRITABLE: 'error.library.path_not_writable',

	MEDIA_NOT_FOUND: 'error.media.not_found',

	/**
	 * The path asked for is outside every root this gateway allows browsing.
	 *
	 * A refusal, not an absence: the directory may very well exist, and saying so
	 * would turn a read-only browser into a way of mapping the host's filesystem one
	 * guess at a time. The containment is decided on the resolved path, so `..` and a
	 * symlink land here exactly as a plainly foreign path does.
	 */
	FILESYSTEM_PATH_OUTSIDE_ROOT: 'error.filesystem.path_outside_root',
	/** Inside the roots, and there is nothing there — a stale field, usually. */
	FILESYSTEM_PATH_NOT_FOUND: 'error.filesystem.path_not_found',
	/**
	 * It is there, it is inside the roots, and this gateway cannot read it.
	 *
	 * Its own key because the fix is neither a typo nor a boundary: it is a permission
	 * or a mount, and telling somebody their path is wrong when the directory is
	 * perfectly right sends them to correct the one thing that was not broken.
	 */
	FILESYSTEM_PATH_UNREADABLE: 'error.filesystem.path_unreadable',

	PEER_NOT_FOUND: 'error.peer.not_found',
	PEER_INVITE_INVALID: 'error.peer.invite_invalid',
	PEER_INVITE_EXPIRED: 'error.peer.invite_expired',
	PEER_UNREACHABLE: 'error.peer.unreachable',
	PEER_REJECTED: 'error.peer.rejected',
	/**
	 * The fingerprint is on this gateway's ban list.
	 *
	 * Reported when *we* try to add or accept a banned key, which is somebody having
	 * forgotten — the list is the answer, and the message points at it. An incoming
	 * request from a banned key is never told this: answering differently would let
	 * somebody learn they are banned by watching what happens, which is more than a
	 * refused peer should be able to find out.
	 */
	PEER_BANNED: 'error.peer.banned',
	/** Nothing on the ban list matches that fingerprint. */
	PEER_BAN_NOT_FOUND: 'error.peer.ban_not_found',
	/**
	 * We asked them; they have not answered. There is nothing here to approve.
	 *
	 * Distinct from `PEER_REJECTED`, which says the far end refused us — the opposite
	 * fact, and the one a reused key would have told somebody who pressed approve on
	 * their own outgoing request. A false "they refused you" is worse than no message.
	 */
	PEER_AWAITING_THEM: 'error.peer.awaiting_them',

	SYNC_PLAN_NOT_FOUND: 'error.sync.plan_not_found',
	SYNC_JOB_NOT_FOUND: 'error.sync.job_not_found',
	SYNC_NO_SOURCE: 'error.sync.no_source',
	SYNC_ALREADY_RUNNING: 'error.sync.already_running',
	/**
	 * A destination cannot hold what the run would put in it.
	 *
	 * Arithmetic, not a warning: free space and the size of every file are both known
	 * before a byte moves. Starting anyway buys a transfer that dies at ninety per cent
	 * and a truncated file the media server indexes as real, so the run is refused and
	 * no acknowledgement gets past this one.
	 */
	SYNC_NOT_ENOUGH_SPACE: 'error.sync.not_enough_space',
	/**
	 * It fits, but only by eating into the reserve — or the disk could not be probed.
	 *
	 * Distinct from the refusal above because the answer differs: this one is a
	 * question, and `acknowledgeSpace` is somebody answering it. Unknown free space is
	 * asked about rather than assumed, since "we could not measure it" read as "it
	 * fits" is the same full disk with an alibi.
	 */
	SYNC_SPACE_NOT_ACKNOWLEDGED: 'error.sync.space_not_acknowledged',
	/**
	 * A plan whose scope names nothing was asked to be enabled.
	 *
	 * "Synchronise everything, every night" is what an empty form produces and almost
	 * never what somebody meant to build, so it takes `acknowledgeUnbounded` to say it
	 * on purpose.
	 */
	SYNC_SCOPE_UNBOUNDED: 'error.sync.scope_unbounded',

	TRANSFER_NOT_FOUND: 'error.transfer.not_found',
	TRANSFER_NOT_RESUMABLE: 'error.transfer.not_resumable',
	TRANSFER_NO_SPACE: 'error.transfer.no_space',
	TRANSFER_CHECKSUM_MISMATCH: 'error.transfer.checksum_mismatch',
	/**
	 * Something already occupies the path, and no free name could be built for it.
	 *
	 * Refusing is the whole point: two versions of one episode render the same name,
	 * and the second one used to land on the first at the end of a completed download —
	 * silently, with nothing anywhere reporting an error. A transfer that stops with
	 * this key has cost a download; the alternative cost somebody their file.
	 */
	TRANSFER_TARGET_OCCUPIED: 'error.transfer.target_occupied',

	USER_NOT_FOUND: 'error.user.not_found',
	USER_LAST_ADMIN: 'error.user.last_admin',

	SHARE_RELAY_NOT_AGREED: 'error.share.relay_not_agreed',

	PEER_PROTOCOL_UNSUPPORTED: 'error.peer.protocol_unsupported',
	/**
	 * A method the far end asked for and this gateway does not implement.
	 *
	 * It is an answer, not a failure: the link stays open and everything else keeps
	 * working. That is what lets one side gain a method without the other side having
	 * to be upgraded first — the whole reason the protocol version does not move for
	 * every addition.
	 */
	PEER_METHOD_UNSUPPORTED: 'error.peer.method_unsupported',

	SETTINGS_INVALID: 'error.settings.invalid',
	/**
	 * The field is pinned by the deployment's environment and cannot be changed here.
	 *
	 * Its own key so the interface can say which control is disabled and why, rather
	 * than reporting a generic refusal for a box the person cannot see is locked.
	 */
	SETTINGS_PINNED: 'error.settings.pinned',
	/**
	 * The public URL is not a URL, or not one anything can dial.
	 *
	 * Its own key rather than the generic settings refusal because this is the one
	 * value that leaves the gateway: an invitation, a share link and a torrent announce
	 * all carry it. "These settings were refused" under the field says nothing about
	 * what to type instead, and the person is being asked for an address they have
	 * probably never had to write down before.
	 */
	SETTINGS_PUBLIC_URL_INVALID: 'error.settings.public_url_invalid',
	SETTINGS_TARGET_PATH_INVALID: 'error.settings.target_path_invalid',
	/**
	 * The fallback target exists and this gateway cannot write into it.
	 *
	 * Distinct from the refusal above because the fix is different — a typo versus a
	 * permission or a mount — and because this one was answered by the filesystem
	 * rather than by a pattern. Accepting it would buy a download that completes and
	 * then has nowhere to put its file.
	 */
	SETTINGS_TARGET_PATH_NOT_WRITABLE: 'error.settings.target_path_not_writable',
	GENERAL: 'error.general',
} as const;

export type ErrorKeyValue = (typeof ErrorKey)[keyof typeof ErrorKey];
