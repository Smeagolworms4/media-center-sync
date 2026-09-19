import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
import { Peer } from '@/entities';

@Injectable()
export class PeerRepository extends Repository<Peer> {
	public constructor(dataSource: DataSource) {
		super(Peer, dataSource.createEntityManager());
	}

	/**
	 * The identity lookup. A peer is its key fingerprint, never its address: a friend
	 * behind a dynamic IP is the same friend tomorrow.
	 */
	public findByFingerprint(fingerprint: string): Promise<Peer | null> {
		return this.findOne({ where: { fingerprint } });
	}

	/** The same row, with the public key a link negotiation needs to verify against. */
	public findWithPublicKey(id: string): Promise<Peer | null> {
		return this.createQueryBuilder('peer')
			.addSelect('peer.publicKey')
			.where('peer.id = :id', { id })
			.getOne();
	}

	/** Linked peers, reachable or not — a peer we cannot reach is still linked. */
	public findLinked(): Promise<Peer[]> {
		return this.find({
			where: { status: In([PeerStatus.LINKED, PeerStatus.UNREACHABLE]) },
			order: { name: 'ASC' },
		});
	}

	public findByTrust(trust: PeerTrust): Promise<Peer[]> {
		return this.find({ where: { trust }, order: { name: 'ASC' } });
	}

	/** The peers a given friend introduced, which is what unlinking them takes away. */
	public findIntroducedBy(viaPeerId: string): Promise<Peer[]> {
		return this.find({ where: { viaPeerId }, order: { name: 'ASC' } });
	}

	public findPending(): Promise<Peer[]> {
		return this.find({ where: { status: PeerStatus.PENDING }, order: { createdAt: 'DESC' } });
	}

	public async setStatus(
		id: string,
		status: PeerStatus,
		linkMode: PeerLinkMode | null = null,
		address: string | null = null,
	): Promise<void> {
		await this.update({ id }, { status, linkMode, address, lastSeenAt: new Date() });
	}
}
