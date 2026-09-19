import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Repository } from 'typeorm';
import { MediaServiceScope, MediaServiceStatus } from '@mcs/shared';
import { MediaService } from '@/entities';

@Injectable()
export class MediaServiceRepository extends Repository<MediaService> {
	public constructor(dataSource: DataSource) {
		super(MediaService, dataSource.createEntityManager());
	}

	/**
	 * The services whose libraries the gateway can write into.
	 *
	 * A peer is excluded whatever its scope reads, and this is the enforcement of the
	 * rule `serviceMode` states: the files are on somebody else's disk, so a
	 * peer-backed row can never be a destination. This is the read every caller uses to
	 * decide where a transfer lands, which makes it the right place to make that
	 * impossible rather than merely unlikely — a row that arrived as local, by a bug or
	 * by somebody's hand on the database, would otherwise be planned onto a path that
	 * does not exist here, and the failure would arrive at the end of a completed
	 * download.
	 */
	public findLocal(): Promise<MediaService[]> {
		return this.find({
			where: { scope: MediaServiceScope.LOCAL, peerId: IsNull() },
			order: { priority: 'ASC', name: 'ASC' },
		});
	}

	public findRemote(): Promise<MediaService[]> {
		return this.find({
			where: { scope: MediaServiceScope.REMOTE },
			order: { priority: 'ASC', name: 'ASC' },
		});
	}

	/**
	 * Every service in the order a sync consults them.
	 *
	 * The order is the whole point: when the same episode is available from three
	 * places, this is what decides which one is asked first.
	 */
	public findByPriority(): Promise<MediaService[]> {
		return this.find({ order: { priority: 'ASC', name: 'ASC' } });
	}

	/** Our own services, as opposed to the ones reached through a linked friend. */
	public findOwned(): Promise<MediaService[]> {
		return this.find({ where: { peerId: IsNull() }, order: { priority: 'ASC' } });
	}

	public findByPeer(peerId: string): Promise<MediaService[]> {
		return this.find({ where: { peerId }, order: { name: 'ASC' } });
	}

	public findAuthProviders(): Promise<MediaService[]> {
		return this.find({ where: { authProvider: true }, order: { name: 'ASC' } });
	}

	/**
	 * The one read that brings the credentials back.
	 *
	 * `token`, `username` and `password` are `select: false`, so no ordinary read can
	 * leak them into a response — and a handler about to call Jellyfin needs them. By
	 * keeping the re-selection to this single method, the places that hold a token in
	 * memory are the places that call it, and they can be counted.
	 */
	public findWithSecrets(id: string): Promise<MediaService | null> {
		return this.createQueryBuilder('service')
			.addSelect(['service.token', 'service.username', 'service.password'])
			.where('service.id = :id', { id })
			.getOne();
	}

	public findByBaseUrl(baseUrl: string, peerId: string | null = null): Promise<MediaService | null> {
		return this.findOne({ where: { baseUrl, peerId: peerId === null ? IsNull() : peerId } });
	}

	public async setStatus(
		id: string,
		status: MediaServiceStatus,
		version: string | null = null,
		at: Date = new Date(),
	): Promise<void> {
		await this.update({ id }, { status, version: version ?? undefined, lastProbeAt: at });
	}
}
