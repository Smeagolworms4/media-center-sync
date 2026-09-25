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
	/**
	 * A registration that stands for a linked peer was asked to be edited.
	 *
	 * Refused whole rather than field by field, because none of what a registration
	 * carries means anything for a peer: their files are on their disk so no root
	 * mapping here could ever resolve, the link authenticates by key fingerprint so
	 * there is no token to type, and the address is `peer://<uuid>` rather than
	 * something anybody enters. A mapping stored for one would look configured and
	 * never resolve, which is worse than being told no.
	 *
	 * Everything that *is* decidable about a peer — its local name, the hop limit,
	 * forbidding it from reading, removing it, banning it — lives on the peer routes.
	 */
	SERVICE_PEER_NOT_EDITABLE: 'error.service.peer_not_editable',
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
	/**
	 * A root mapping with nothing on one of its two sides.
	 *
	 * Refused rather than dropped: half a mapping derives nothing, and a row that
	 * vanished on save would leave somebody believing they had mapped a disk that the
	 * gateway still does not know about.
	 */
	SERVICE_MAPPING_EMPTY: 'error.service.mapping_empty',
	/**
	 * A root mapping side that is not an absolute path.
	 *
	 * A relative path resolves against whatever directory the process was started in,
	 * which differs between the container, a development shell and a command — one
	 * stored value, three directories.
	 */
	SERVICE_MAPPING_RELATIVE: 'error.service.mapping_relative',
	/**
	 * The same server prefix listed twice.
	 *
	 * Two rows claiming one prefix would derive a library's path from whichever came
	 * first in the list, so reordering the rows would silently move where transfers
	 * land. Nested prefixes are a different thing and are allowed: the most specific
	 * one wins, which is an answer that does not depend on the order.
	 */
	SERVICE_MAPPING_DUPLICATE: 'error.service.mapping_duplicate',
	/**
	 * A list of mappings that is not one: not a list, entries that are not pairs of
	 * strings, a path past any length a filesystem accepts, or more rows than any
	 * installation has disks. The form never sends this; a hand-written request does.
	 */
	SERVICE_MAPPING_INVALID: 'error.service.mapping_invalid',

	/**
	 * This kind of service has no directory to sign in to and be told its servers.
	 *
	 * A Jellyfin has no account service above it: its address is the only way to find
	 * it, and the form that asks for one is the right screen.
	 */
	DIRECTORY_UNSUPPORTED: 'error.directory.unsupported',
	/**
	 * The directory itself — plex.tv — did not answer.
	 *
	 * Distinct from a server that does not answer, because the fix is somewhere else
	 * entirely: this is the gateway's own internet connection, or the account service
	 * having a bad day, and no server anybody owns has anything to do with it.
	 */
	DIRECTORY_UNREACHABLE: 'error.directory.unreachable',
	/**
	 * The directory refused the account token it once issued.
	 *
	 * The person signed the gateway out from their account page, or changed their
	 * password, which revokes every token. Only signing in again fixes it.
	 */
	DIRECTORY_REFUSED: 'error.directory.refused',
	/**
	 * No sign-in by that handle: never started, already finished, or started on a
	 * gateway that has restarted since and forgotten it. The dialog starts again.
	 */
	DIRECTORY_SIGN_IN_NOT_FOUND: 'error.directory.sign_in_not_found',
	/** Servers were asked for before the person approved the sign-in. */
	DIRECTORY_SIGN_IN_PENDING: 'error.directory.sign_in_pending',
	/** Nobody approved the sign-in before the directory let the request lapse. */
	DIRECTORY_SIGN_IN_EXPIRED: 'error.directory.sign_in_expired',
	/**
	 * The account no longer lists that server: its owner removed it, or a friend
	 * stopped sharing it, between the list being shown and the box being ticked.
	 */
	DIRECTORY_SERVER_NOT_FOUND: 'error.directory.server_not_found',
	/**
	 * Every address the directory gave for that server was tried, and none answered as
	 * that server.
	 *
	 * "As that server" is the part that matters: an address that answers as some other
	 * machine — a stale local IP now handed to a different box — is refused exactly
	 * like one that does not answer, because registering it would index somebody
	 * else's library under this server's name.
	 */
	DIRECTORY_SERVER_UNREACHABLE: 'error.directory.server_unreachable',

	LIBRARY_NOT_FOUND: 'error.library.not_found',
	LIBRARY_PATH_UNREADABLE: 'error.library.path_unreadable',
	LIBRARY_PATH_NOT_WRITABLE: 'error.library.path_not_writable',
	/**
	 * The gateway's path and the media server's path are not the same directory.
	 *
	 * The failure this product exists to prevent, and the only one that reports
	 * nothing on its own: both directories are real, the gateway writes into one and
	 * the server scans the other, every transfer succeeds and nothing ever appears.
	 * It is raised only when a marker file written here was demonstrably not visible
	 * there — a server that cannot list its own directories answers `unknown`, which
	 * is not this.
	 */
	LIBRARY_PATH_MISMATCH: 'error.library.path_mismatch',
	/** A category key that no library answers to any more — a stale screen, usually. */
	LIBRARY_CATEGORY_NOT_FOUND: 'error.library.category_not_found',
	LIBRARY_KEYWORD_NOT_FOUND: 'error.library.keyword_not_found',
	/**
	 * A keyword that folds to nothing: punctuation, spaces, or an empty box.
	 *
	 * Refused rather than stored, because the folded form is what matching compares
	 * and an empty one matches every library whose name is also punctuation — which
	 * is none today and whichever one somebody adds tomorrow.
	 */
	LIBRARY_KEYWORD_INVALID: 'error.library.keyword_invalid',
	/**
	 * The same keyword already files into another category.
	 *
	 * One keyword, one category, enforced rather than resolved: two categories
	 * claiming `tv` would file a shelf into whichever row the database handed back
	 * first, and that answer changes between two identical requests. Moving it is a
	 * deliberate act and has its own route.
	 */
	LIBRARY_KEYWORD_TAKEN: 'error.library.keyword_taken',

	MEDIA_NOT_FOUND: 'error.media.not_found',

	/**
	 * Asked to erase a copy this gateway cannot reach on a disk of its own.
	 *
	 * A refusal rather than a silent success. The copy exists — on a friend's server,
	 * or on one of ours whose folders nobody has mapped — and telling somebody it is
	 * gone when nothing was touched is the worst answer available. Deleting is only
	 * ever offered for a copy the gateway can name a real path for.
	 */
	MEDIA_NOT_ON_OUR_DISK: 'error.media.not_on_our_disk',
	/** There is nothing to erase: the row carries no file, which is a folder or a show. */
	MEDIA_HAS_NO_FILE: 'error.media.has_no_file',

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
	/**
	 * No introduction to that gateway, from us, now.
	 *
	 * One key for every reason, and that is deliberate on the wire: a caller who could
	 * tell "I do not know them" from "they are further than my limit allows" could map
	 * out somebody's friends and their reach by asking. It reaches a person only on
	 * this side of the link, where the honest reading is "that route is not available",
	 * not "something went wrong".
	 */
	PEER_INTRODUCTION_REFUSED: 'error.peer.introduction_refused',

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
	/**
	 * A plan already covers the media somebody asked to keep in sync.
	 *
	 * Refused rather than duplicated: two plans over one show are two runs pulling the
	 * same missing episodes into the same folder, and the loser of the race finds the
	 * winner's half-written file. The answer is the plan that already covers it — which
	 * is why the coverage route names it — or extending that plan, never a second one.
	 */
	SYNC_ITEM_ALREADY_COVERED: 'error.sync.item_already_covered',
	/**
	 * That plan cannot take another subtree without changing what it means.
	 *
	 * The fields of a scope intersect, so adding a root to a plan scoped by category
	 * narrows it to the part of that show in that category, and adding one to a plan
	 * that names nothing turns "everything, nightly" into one show. Both are silent
	 * edits to somebody else's standing intent, and neither is what "add this show to
	 * that plan" was asking for.
	 */
	SYNC_PLAN_NOT_EXTENDABLE: 'error.sync.plan_not_extendable',
	/**
	 * A plan says it runs on a schedule and carries no cron expression.
	 *
	 * It would be stored, listed as scheduled, and never fire — the scheduler has
	 * nothing to register. A plan that lies about when it runs is worse than one that
	 * was refused, because the first anybody hears of it is the episodes that never
	 * arrived.
	 */
	SYNC_SCHEDULE_REQUIRED: 'error.sync.schedule_required',

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
	/**
	 * The destination asked for is not a library this gateway can write into.
	 *
	 * Its own key rather than the library refusals, because the mistake it catches is
	 * a different one: somebody naming a folder no media server scans. A transfer sent
	 * there succeeds, reports success, and produces nothing anybody can watch — which
	 * is the failure the whole destination rule exists to prevent, so it is refused at
	 * the point of choosing rather than discovered at the end of a download.
	 */
	TRANSFER_DESTINATION_INVALID: 'error.transfer.destination_invalid',
	/**
	 * The destination filled up while the finished file was being moved into it.
	 *
	 * Distinct from `TRANSFER_NO_SPACE`, which is a refusal before anything is written
	 * and means "pick somewhere else". This one is reported after a download has
	 * completed and a copy has partly run, so the answer is different and worth saying:
	 * nothing is lost, the partial is still on the destination, and freeing space and
	 * resuming carries on from the byte it reached. "The move failed" would send
	 * somebody to start a forty gigabyte download again for no reason.
	 */
	TRANSFER_DESTINATION_FULL: 'error.transfer.destination_full',
	/**
	 * The file is being moved into the library at this exact moment. Ask again after.
	 *
	 * A refusal and not a queued request, and the alternative was weighed: the mover
	 * can be aborted with `FILE_MOVE_CANCEL` and resumed, so cancelling the move in
	 * flight and starting another one towards the new library is buildable. It was
	 * rejected because the two destinations would both hold part of the file for as
	 * long as the cancellation takes to land — the partial on the old path is only
	 * removed after the abort is observed — and a crash inside that window leaves half
	 * a film in one library and half in another, with the row naming the second. A half
	 * moved file is the outcome this whole area is designed against, and the price of
	 * refusing is that somebody waits for a copy that was already running.
	 */
	TRANSFER_BEING_PLACED: 'error.transfer.being_placed',

	USER_NOT_FOUND: 'error.user.not_found',
	USER_LAST_ADMIN: 'error.user.last_admin',

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
	NOTIFICATION_CHANNEL_NOT_FOUND: 'error.notification.channel_not_found',
	/**
	 * The channel's settings are missing something that channel requires.
	 *
	 * The refused field travels beside the key, because only the handler knows what
	 * `config` has to contain and the person is looking at a form: "the settings were
	 * refused" for an opaque object is a message that cannot be acted on, while
	 * "topic" under the topic box is the whole answer.
	 */
	NOTIFICATION_CONFIG_INVALID: 'error.notification.config_invalid',
	/** A stored row names a channel type this build has no handler for. */
	NOTIFICATION_HANDLER_UNKNOWN: 'error.notification.handler_unknown',
	/**
	 * The channel was asked to deliver and did not.
	 *
	 * Only ever answered by the test route, and never while reporting something: a
	 * notification that breaks the transfer it was about is worse than no
	 * notification. Everywhere else the failure lands in `lastError` on the row, so a
	 * channel that has gone silent can be seen to have gone silent.
	 */
	NOTIFICATION_SEND_FAILED: 'error.notification.send_failed',

	/**
	 * Nobody has told this gateway where to search.
	 *
	 * Its own key rather than a general refusal, because the fix is one screen away and
	 * naming it is the difference between "this is broken" and "this is not set up".
	 */
	INDEXER_NOT_CONFIGURED: 'error.indexer.not_configured',
	/** Configured, and it did not answer. The address or the key, and the row says which. */
	INDEXER_UNREACHABLE: 'error.indexer.unreachable',
	/** A stored row names an indexer type this build has no implementation for. */
	INDEXER_UNKNOWN: 'error.indexer.unknown',
	DOWNLOAD_CLIENT_NOT_CONFIGURED: 'error.download_client.not_configured',
	DOWNLOAD_CLIENT_UNREACHABLE: 'error.download_client.unreachable',
	DOWNLOAD_CLIENT_UNKNOWN: 'error.download_client.unknown',
	/** The client took it and then would not say what it did with it. */
	DOWNLOAD_CLIENT_REFUSED: 'error.download_client.refused',
	/**
	 * The directory the client writes into is not one this gateway can read.
	 *
	 * The failure this whole pair of paths exists to prevent: a client in its own
	 * container writes to `/downloads` and the gateway sees `/share/torrents`. Get it
	 * wrong and everything succeeds — the torrent completes, the client is happy — and
	 * the file is never filed, with nothing anywhere reporting a fault.
	 */
	DOWNLOAD_PATH_UNREADABLE: 'error.download_client.path_unreadable',
	/** The release is not in the last search, which is the only place releases exist. */
	RELEASE_NOT_FOUND: 'error.release.not_found',
	/**
	 * That row is a copy on a peer, and a download client cannot be given one.
	 *
	 * Its own key rather than "not found", because the two send somebody somewhere quite
	 * different: a release that is gone means search again, while this one means press the
	 * other button on the same row. Handed to the client instead, the copy would be
	 * accepted, nothing would ever move, and every screen would say it had been taken —
	 * the failure this whole feature keeps producing.
	 */
	RELEASE_NOT_GRABBABLE: 'error.release.not_grabbable',
	/**
	 * Nobody has told this gateway where the household asks for things.
	 *
	 * Its own key rather than a general refusal, for the reason the indexer's is: the
	 * fix is one screen away, and naming it is the difference between "this is broken"
	 * and "this is not set up".
	 */
	REQUEST_SOURCE_NOT_CONFIGURED: 'error.request_source.not_configured',
	REQUEST_SOURCE_UNREACHABLE: 'error.request_source.unreachable',
	/**
	 * It answered, and it refused the key.
	 *
	 * Apart from `UNREACHABLE` because they send somebody to two different places: an
	 * address that is wrong is a container name, a port, a reverse proxy; a key that is
	 * wrong is one field on one screen. A wrong key reported as "unreachable" is the
	 * commonest way to spend twenty minutes on the network when the answer was a
	 * copy-and-paste — and Seerr answers **403** rather than 401 for it, which is why
	 * both statuses are read as this.
	 */
	REQUEST_SOURCE_UNAUTHORIZED: 'error.request_source.unauthorized',
	/** A stored row names a request source this build has no implementation for. */
	REQUEST_SOURCE_UNKNOWN: 'error.request_source.unknown',
	REQUEST_NOT_FOUND: 'error.request.not_found',
	/**
	 * Closing an ask that nothing here answers.
	 *
	 * Refused rather than done, because the whole value of the request screen is that
	 * "answered" means something. Told an ask is complete, the household stops asking —
	 * so marking one on a work no library of ours holds, or on a show we are still short
	 * seasons of, ends the asking and delivers nothing. The interface only offers the
	 * action when the gateway says it would be honest; this is the same rule on the route,
	 * for everything that is not the interface.
	 */
	REQUEST_NOT_HELD: 'error.request.not_held',
	/**
	 * A media of ours that no request source could be told about.
	 *
	 * It carries no provider identifier, or it is not a thing anybody asks for — a
	 * season row, a folder. Its own key rather than the general refusal because the
	 * screen can then say which of the two it is, and both are ordinary rather than
	 * faults.
	 */
	MEDIA_NOT_IDENTIFIED: 'error.media.not_identified',
	GRAB_NOT_FOUND: 'error.grab.not_found',
	/**
	 * Asked to resume a download that has nothing to resume.
	 *
	 * Either it has not failed — a running download is already doing the thing the retry
	 * would ask for — or the client never took it, which needs a new grab rather than a
	 * second look at one that never started.
	 */
	GRAB_NOT_RETRYABLE: 'error.grab.not_retryable',

	GENERAL: 'error.general',
} as const;

export type ErrorKeyValue = (typeof ErrorKey)[keyof typeof ErrorKey];
