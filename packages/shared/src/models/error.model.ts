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
	SERVICE_UNAUTHORIZED: 'error.service.unauthorized',
	SERVICE_DUPLICATE: 'error.service.duplicate',
	SERVICE_HANDLER_UNKNOWN: 'error.service.handler_unknown',

	LIBRARY_NOT_FOUND: 'error.library.not_found',
	LIBRARY_PATH_UNREADABLE: 'error.library.path_unreadable',
	LIBRARY_PATH_NOT_WRITABLE: 'error.library.path_not_writable',

	MEDIA_NOT_FOUND: 'error.media.not_found',

	PEER_NOT_FOUND: 'error.peer.not_found',
	PEER_INVITE_INVALID: 'error.peer.invite_invalid',
	PEER_INVITE_EXPIRED: 'error.peer.invite_expired',
	PEER_UNREACHABLE: 'error.peer.unreachable',
	PEER_REJECTED: 'error.peer.rejected',

	SYNC_PLAN_NOT_FOUND: 'error.sync.plan_not_found',
	SYNC_JOB_NOT_FOUND: 'error.sync.job_not_found',
	SYNC_NO_SOURCE: 'error.sync.no_source',
	SYNC_ALREADY_RUNNING: 'error.sync.already_running',

	TRANSFER_NOT_FOUND: 'error.transfer.not_found',
	TRANSFER_NOT_RESUMABLE: 'error.transfer.not_resumable',
	TRANSFER_NO_SPACE: 'error.transfer.no_space',
	TRANSFER_CHECKSUM_MISMATCH: 'error.transfer.checksum_mismatch',

	USER_NOT_FOUND: 'error.user.not_found',
	USER_LAST_ADMIN: 'error.user.last_admin',

	SETTINGS_INVALID: 'error.settings.invalid',
	GENERAL: 'error.general',
} as const;

export type ErrorKeyValue = (typeof ErrorKey)[keyof typeof ErrorKey];
