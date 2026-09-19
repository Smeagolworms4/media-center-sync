import { ErrorKey, UserRole } from '@mcs/shared';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { User } from '@/entities';
import type { SessionRepository, UserRepository } from '@/repositories';
import { UserManager } from './user.manager';

interface Fakes {
	users: {
		find: jest.Mock;
		findOne: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
		countAdmins: jest.Mock;
	};
	sessions: { revokeAllForUser: jest.Mock };
}

const user = (overrides: Partial<User> = {}): User =>
	({
		id: 'user-1',
		username: 'damien',
		displayName: 'Damien',
		email: null,
		role: UserRole.USER,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		lastSeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as User;

const build = (): { manager: UserManager; fakes: Fakes } => {
	const fakes: Fakes = {
		users: {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(user()),
			save: jest.fn((value: User) => Promise.resolve(value)),
			delete: jest.fn().mockResolvedValue(undefined),
			countAdmins: jest.fn().mockResolvedValue(2),
		},
		sessions: { revokeAllForUser: jest.fn().mockResolvedValue(1) },
	};

	return {
		manager: new UserManager(
			fakes.users as unknown as UserRepository,
			fakes.sessions as unknown as SessionRepository,
		),
		fakes,
	};
};

describe('UserManager', () => {
	describe('an account mirrored from a media service', () => {
		it('refuses to rename it: the gateway does not own the name', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(
				user({ provider: 'service:aaa', providerUserId: 'jf-42' }),
			);

			await expect(manager.update('user-1', { username: 'somebody-else' })).rejects.toThrow(
				ForbiddenException,
			);
			expect(fakes.users.save).not.toHaveBeenCalled();
		});

		it('lets its role change, because that is ours', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(
				user({ provider: 'service:aaa', providerUserId: 'jf-42' }),
			);

			await expect(manager.update('user-1', { role: UserRole.ADMIN })).resolves.toMatchObject({
				role: UserRole.ADMIN,
			});
		});

		it('accepts a username identical to the one it already has', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(user({ provider: 'service:aaa', username: 'damien' }));

			await expect(manager.update('user-1', { username: 'damien' })).resolves.toBeDefined();
		});
	});

	describe('the last administrator', () => {
		it('cannot be demoted, because nothing could put them back', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(user({ role: UserRole.ADMIN }));
			fakes.users.countAdmins.mockResolvedValue(1);

			await expect(manager.update('user-1', { role: UserRole.USER })).rejects.toThrow(
				ConflictException,
			);
		});

		it('cannot be deleted either', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(user({ role: UserRole.ADMIN }));
			fakes.users.countAdmins.mockResolvedValue(1);

			await expect(manager.remove('user-1')).rejects.toThrow(ConflictException);
			expect(fakes.users.delete).not.toHaveBeenCalled();
		});

		it('can be demoted once there is a second one', async () => {
			const { manager, fakes } = build();

			fakes.users.findOne.mockResolvedValue(user({ role: UserRole.ADMIN }));
			fakes.users.countAdmins.mockResolvedValue(2);

			await expect(manager.update('user-1', { role: UserRole.USER })).resolves.toMatchObject({
				role: UserRole.USER,
			});
		});
	});

	it('revokes the sessions before deleting the row', async () => {
		const { manager, fakes } = build();

		await manager.remove('user-1');

		expect(fakes.sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
		expect(fakes.users.delete).toHaveBeenCalledWith({ id: 'user-1' });
	});

	it('answers a key rather than a sentence for an account nobody has', async () => {
		const { manager, fakes } = build();

		fakes.users.findOne.mockResolvedValue(null);

		await expect(manager.read('ghost')).rejects.toThrow(ErrorKey.USER_NOT_FOUND);
	});
});
