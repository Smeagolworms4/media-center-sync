import { ErrorKey, UserRole, type UpdateUserRequest, type User } from '@mcs/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { User as UserEntity } from '@/entities';
import { SessionRepository, UserRepository } from '@/repositories';
import { INTERNAL_PROVIDER } from './auth.manager';
import { toUser } from './mappers';

/**
 * What an administration screen may change about an account.
 *
 * `username` is accepted here although the HTTP DTO does not offer it, because the
 * rule it exists for is a rule about accounts and not about a form: an account
 * mirrored from a media service does not belong to the gateway, and the day another
 * caller — a command, an import — tries to rename one, it has to be refused there too.
 */
export interface UpdateUserPatch extends UpdateUserRequest {
	username?: string;
}

/**
 * Accounts.
 *
 * Two rules, and both are about not pretending to own something. An account mirrored
 * from Jellyfin or Plex keeps its username and its password where they live: changing
 * them here would change nothing at the far end and would leave the gateway with a
 * name that no longer resolves to anybody. Its role is a different matter — that is
 * ours, it says what this gateway lets somebody do, and nothing outside knows about
 * it.
 *
 * The other is that the last administrator cannot be demoted or deleted. There is no
 * screen for recovering from it: the account simply stops being able to do anything,
 * and the only way back in is a command line on the host.
 */
@Injectable()
export class UserManager {
	public constructor(
		private readonly _users: UserRepository,
		private readonly _sessions: SessionRepository,
	) {}

	public async list(): Promise<User[]> {
		const users = await this._users.find({ order: { username: 'ASC' } });

		return users.map(toUser);
	}

	public async read(id: string): Promise<User> {
		return toUser(await this._require(id));
	}

	public async update(id: string, patch: UpdateUserPatch): Promise<User> {
		const user = await this._require(id);
		const mirrored = user.provider !== INTERNAL_PROVIDER;

		if (patch.username !== undefined && patch.username !== user.username) {
			if (mirrored) {
				throw new ForbiddenException(ErrorKey.AUTH_FORBIDDEN);
			}

			user.username = patch.username;
		}

		if (patch.displayName !== undefined) {
			user.displayName = patch.displayName;
		}

		if (patch.email !== undefined) {
			user.email = patch.email;
		}

		if (patch.role !== undefined && patch.role !== user.role) {
			await this._refuseLosingLastAdmin(user, patch.role);

			user.role = patch.role;
		}

		return toUser(await this._users.save(user));
	}

	public async remove(id: string): Promise<void> {
		const user = await this._require(id);

		await this._refuseLosingLastAdmin(user, UserRole.USER);

		// The sessions go first. Deleting the row cascades to them, but a session that
		// outlived its account for even one request is a token that resolves to
		// nobody, and the strategy would have to guess what that means.
		await this._sessions.revokeAllForUser(user.id);
		await this._users.delete({ id: user.id });
	}

	private async _require(id: string): Promise<UserEntity> {
		const user = await this._users.findOne({ where: { id } });

		if (user === null) {
			throw new NotFoundException(ErrorKey.GENERAL);
		}

		return user;
	}

	private async _refuseLosingLastAdmin(
		user: UserEntity,
		nextRole: UserRole,
	): Promise<void> {
		if (user.role !== UserRole.ADMIN || nextRole === UserRole.ADMIN) {
			return;
		}

		if ((await this._users.countAdmins()) <= 1) {
			throw new ConflictException(ErrorKey.AUTH_FORBIDDEN);
		}
	}
}
