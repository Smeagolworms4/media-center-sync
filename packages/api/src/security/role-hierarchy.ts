import { ROLE_RIGHTS, type Right, type UserRole } from '@mcs/shared';

/**
 * The rights a role carries.
 *
 * The table itself is shared with the interface, which needs the same answer to
 * decide what to show; resolving it in two places would let a button appear for
 * something the API refuses. An unknown role — a row written by an older or newer
 * version — resolves to nothing rather than to a default, because the safe reading of
 * a role nobody recognises is that it grants nothing.
 */
export const rightsForRole = (role: UserRole): Right[] => [...(ROLE_RIGHTS[role] ?? [])];

export const hasRight = (role: UserRole, right: Right): boolean =>
	rightsForRole(role).includes(right);

/** True when the role carries every one of them. A route asks for all it names. */
export const hasEveryRight = (role: UserRole, rights: Right[]): boolean => {
	const granted = rightsForRole(role);

	return rights.every((right) => granted.includes(right));
};
