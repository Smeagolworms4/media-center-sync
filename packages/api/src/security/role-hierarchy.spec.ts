import { Right, ROLE_RIGHTS, UserRole } from '@mcs/shared';
import { hasEveryRight, hasRight, rightsForRole } from './role-hierarchy';

describe('role hierarchy', () => {
	it('gives an administrator every right there is', () => {
		expect(rightsForRole(UserRole.ADMIN)).toEqual(Object.values(Right));
	});

	it('keeps a plain user away from what manages the gateway', () => {
		const rights = rightsForRole(UserRole.USER);

		expect(rights).toContain(Right.MEDIA_READ);
		expect(rights).toContain(Right.SYNC_RUN);
		expect(rights).not.toContain(Right.SERVICE_MANAGE);
		expect(rights).not.toContain(Right.USER_MANAGE);
	});

	it('leaves a guest with reading, and nothing else', () => {
		expect(rightsForRole(UserRole.GUEST)).toEqual([Right.LIBRARY_READ, Right.MEDIA_READ]);
	});

	it('grants nothing for a role it does not know', () => {
		expect(rightsForRole('archivist' as UserRole)).toEqual([]);
	});

	it('hands back a copy, so a caller cannot widen the shared table', () => {
		rightsForRole(UserRole.GUEST).push(Right.USER_MANAGE);

		expect(ROLE_RIGHTS[UserRole.GUEST]).not.toContain(Right.USER_MANAGE);
	});

	it('answers a single right', () => {
		expect(hasRight(UserRole.USER, Right.SYNC_RUN)).toBe(true);
		expect(hasRight(UserRole.USER, Right.SYNC_MANAGE)).toBe(false);
	});

	it('requires every right a route names, not one of them', () => {
		expect(hasEveryRight(UserRole.USER, [Right.MEDIA_READ, Right.SYNC_READ])).toBe(true);
		expect(hasEveryRight(UserRole.USER, [Right.MEDIA_READ, Right.SERVICE_MANAGE])).toBe(false);
	});
});
