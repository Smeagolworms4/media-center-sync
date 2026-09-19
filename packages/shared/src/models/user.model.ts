/** Coarse role. Fine-grained decisions are taken on rights, never on a role. */
export enum UserRole {
	ADMIN = 'admin',
	USER = 'user',
	GUEST = 'guest',
}

/**
 * What a route checks.
 *
 * Routes test a right, never a role: `@Granted(Right.SERVICE_MANAGE)` keeps working
 * when the role hierarchy changes, `role === 'admin'` does not.
 */
export enum Right {
	SERVICE_READ = 'service.read',
	SERVICE_MANAGE = 'service.manage',
	LIBRARY_READ = 'library.read',
	LIBRARY_MANAGE = 'library.manage',
	MEDIA_READ = 'media.read',
	PEER_READ = 'peer.read',
	PEER_MANAGE = 'peer.manage',
	SHARE_MANAGE = 'share.manage',
	SYNC_READ = 'sync.read',
	SYNC_RUN = 'sync.run',
	SYNC_MANAGE = 'sync.manage',
	TRANSFER_READ = 'transfer.read',
	TRANSFER_MANAGE = 'transfer.manage',
	SETTINGS_MANAGE = 'settings.manage',
	USER_MANAGE = 'user.manage',
}

/** Rights carried by each role. A role is a bundle of rights, nothing more. */
export const ROLE_RIGHTS: Record<UserRole, Right[]> = {
	[UserRole.ADMIN]: Object.values(Right),
	[UserRole.USER]: [
		Right.SERVICE_READ,
		Right.LIBRARY_READ,
		Right.MEDIA_READ,
		Right.PEER_READ,
		Right.SYNC_READ,
		Right.SYNC_RUN,
		Right.TRANSFER_READ,
	],
	[UserRole.GUEST]: [Right.LIBRARY_READ, Right.MEDIA_READ],
};

export interface User {
	id: string;
	username: string;
	displayName: string | null;
	email: string | null;
	role: UserRole;
	/** Which provider authenticated this account. */
	provider: string;
	/** Identifier of this user inside the provider, when it is not us. */
	providerUserId: string | null;
	avatarUrl: string | null;
	lastSeenAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface UpdateUserRequest {
	displayName?: string | null;
	email?: string | null;
	role?: UserRole;
}
