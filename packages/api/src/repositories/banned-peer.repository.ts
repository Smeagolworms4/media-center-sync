import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BannedPeer } from '@/entities';

/**
 * The list of fingerprints this gateway refuses, and nothing more.
 *
 * It decides nothing: whether a ban is recorded when a peer is removed, and what an
 * incoming request from a banned key is told, are both business rules and live in the
 * manager.
 */
@Injectable()
export class BannedPeerRepository extends Repository<BannedPeer> {
	public constructor(dataSource: DataSource) {
		super(BannedPeer, dataSource.createEntityManager());
	}

	public findByFingerprint(fingerprint: string): Promise<BannedPeer | null> {
		return this.findOne({ where: { fingerprint } });
	}

	/**
	 * Whether a key is refused.
	 *
	 * A count rather than a fetch, because every incoming request pays for this check
	 * before anything else is known about it, and the row itself is only ever read by
	 * the screen that lists bans.
	 */
	public async isBanned(fingerprint: string): Promise<boolean> {
		return (await this.countBy({ fingerprint })) > 0;
	}

	/** Most recently banned first: that is the one somebody is looking for. */
	public findAll(): Promise<BannedPeer[]> {
		return this.find({ order: { createdAt: 'DESC' } });
	}

	/**
	 * Record a ban, or refresh the one already there.
	 *
	 * Idempotent on purpose. Banning a fingerprint that is already banned is not an
	 * error to report — it is somebody making sure — and the unique index would turn
	 * it into a five hundred. The name and reason are updated because the newer ones
	 * are the ones that were just typed.
	 */
	public async ban(
		fingerprint: string,
		{ name = null, reason = null }: { name?: string | null; reason?: string | null } = {},
	): Promise<BannedPeer> {
		const existing = await this.findByFingerprint(fingerprint);

		if (existing !== null) {
			existing.name = name ?? existing.name;
			existing.reason = reason ?? existing.reason;

			return this.save(existing);
		}

		return this.save(this.create({ fingerprint, name, reason }));
	}

	/** Returns whether anything was actually lifted, which is what the caller reports. */
	public async unban(fingerprint: string): Promise<boolean> {
		const result = await this.delete({ fingerprint });

		return (result.affected ?? 0) > 0;
	}
}
