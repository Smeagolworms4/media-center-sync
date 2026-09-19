import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { Session } from '@/entities';

@Injectable()
export class SessionRepository extends Repository<Session> {
	public constructor(dataSource: DataSource) {
		super(Session, dataSource.createEntityManager());
	}

	/**
	 * A session that is still usable: not revoked, not expired.
	 *
	 * The three conditions travel together on purpose. A lookup by hash alone would
	 * happily return a session somebody signed out of an hour ago, and the caller
	 * would have to remember to check — which is exactly the check that gets
	 * forgotten.
	 */
	public findValidByHash(refreshTokenHash: string, now: Date = new Date()): Promise<Session | null> {
		return this.findOne({
			where: { refreshTokenHash, revokedAt: IsNull(), expiresAt: MoreThan(now) },
		});
	}

	/** Same guarantee as above, for the session identifier carried by an access token. */
	public findValidById(id: string, now: Date = new Date()): Promise<Session | null> {
		return this.findOne({ where: { id, revokedAt: IsNull(), expiresAt: MoreThan(now) } });
	}

	public findForUser(userId: string): Promise<Session[]> {
		return this.find({ where: { userId }, order: { createdAt: 'DESC' } });
	}

	public async revoke(id: string, at: Date = new Date()): Promise<void> {
		await this.update({ id, revokedAt: IsNull() }, { revokedAt: at });
	}

	/** Signing out everywhere, and what a password change or a ban has to do. */
	public async revokeAllForUser(userId: string, at: Date = new Date()): Promise<number> {
		const result = await this.update({ userId, revokedAt: IsNull() }, { revokedAt: at });

		return result.affected ?? 0;
	}

	/**
	 * Drops sessions nobody can use any more.
	 *
	 * Expired rows are harmless but they accumulate: one per sign-in, forever, on a
	 * table every authenticated request reads.
	 */
	public async deleteExpired(before: Date = new Date()): Promise<number> {
		const result = await this.delete({ expiresAt: LessThan(before) });

		return result.affected ?? 0;
	}
}
