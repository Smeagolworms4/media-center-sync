import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { UserRole } from '@mcs/shared';
import { User } from '@/entities';

@Injectable()
export class UserRepository extends Repository<User> {
	public constructor(dataSource: DataSource) {
		super(User, dataSource.createEntityManager());
	}

	public findByUsername(username: string): Promise<User | null> {
		return this.findOne({ where: { username } });
	}

	/**
	 * The same account, with its password hash.
	 *
	 * `passwordHash` is `select: false` on the entity, so it is absent from every
	 * other read — including the ones whose result is serialised straight into a
	 * response. Sign-in is the one place that needs it, and asking for it explicitly
	 * is what keeps it out of everywhere else.
	 */
	public findForAuthentication(username: string): Promise<User | null> {
		return this.createQueryBuilder('user')
			.addSelect('user.passwordHash')
			.where('user.username = :username', { username })
			.getOne();
	}

	/** Mirrored accounts are identified by the provider plus the identifier it uses. */
	public findByProvider(provider: string, providerUserId: string): Promise<User | null> {
		return this.findOne({ where: { provider, providerUserId } });
	}

	public findByRole(role: UserRole): Promise<User[]> {
		return this.find({ where: { role }, order: { username: 'ASC' } });
	}

	/**
	 * How many administrators are left.
	 *
	 * Demoting or deleting the last one leaves a gateway nobody can configure any
	 * more, and no screen would report it — the account simply stops being able to do
	 * anything.
	 */
	public countAdmins(): Promise<number> {
		return this.count({ where: { role: UserRole.ADMIN } });
	}

	public async touchLastSeen(id: string, at: Date = new Date()): Promise<void> {
		await this.update({ id }, { lastSeenAt: at });
	}
}
