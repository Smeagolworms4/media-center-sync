import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { PeerInvite } from '@/entities';

@Injectable()
export class PeerInviteRepository extends Repository<PeerInvite> {
	public constructor(dataSource: DataSource) {
		super(PeerInvite, dataSource.createEntityManager());
	}

	public findByCode(code: string): Promise<PeerInvite | null> {
		return this.findOne({ where: { code } });
	}

	/**
	 * An invitation that can still be accepted: not used, not expired.
	 *
	 * Both conditions belong here rather than in the caller. An invitation is a
	 * credential, and the check that decides whether a stranger becomes a friend is
	 * not one to leave to whoever remembers to write it.
	 */
	public findUsable(code: string, now: Date = new Date()): Promise<PeerInvite | null> {
		return this.findOne({ where: { code, usedAt: IsNull(), expiresAt: MoreThan(now) } });
	}

	public findOutstanding(now: Date = new Date()): Promise<PeerInvite[]> {
		return this.find({
			where: { usedAt: IsNull(), expiresAt: MoreThan(now) },
			order: { createdAt: 'DESC' },
		});
	}

	/** Burns the invitation on the peer it created. One code, one link. */
	public async markUsed(id: string, peerId: string, at: Date = new Date()): Promise<void> {
		await this.update({ id, usedAt: IsNull() }, { usedAt: at, peerId });
	}

	public async deleteExpired(before: Date = new Date()): Promise<number> {
		const result = await this.delete({ expiresAt: LessThan(before) });

		return result.affected ?? 0;
	}
}
