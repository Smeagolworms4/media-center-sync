import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { MediaServiceStatus } from '@mcs/shared';
import { MediaService } from '@/entities';

@Injectable()
export class MediaServiceRepository extends Repository<MediaService> {
	public constructor(dataSource: DataSource) {
		super(MediaService, dataSource.createEntityManager());
	}

	/**
	 * The services whose libraries the gateway can write into.
	 *
	 * `filesMounted` and not a declared field, because a destination has to be a path
	 * the media server actually scans: a service somebody had labelled as theirs while
	 * nothing was mapped accepted transfers that could never be placed, and the failure
	 * arrived at the end of a completed download.
	 *
	 * A peer is excluded whatever the row reads, and this is the enforcement of the
	 * rule `serviceMode` states: the files are on somebody else's disk. This is the
	 * read every caller uses to decide where a transfer lands, which makes it the right
	 * place to make that impossible rather than merely unlikely — a peer-backed row
	 * that arrived mounted, by a bug or by somebody's hand on the database, would
	 * otherwise be planned onto a path that does not exist here.
	 */
	public findLocal(): Promise<MediaService[]> {
		return this.find({
			where: { filesMounted: true, peerId: IsNull() },
			order: { priority: 'ASC', name: 'ASC' },
		});
	}

	/** The services we only reach over HTTP: no folder of ours holds their files. */
	public findRemote(): Promise<MediaService[]> {
		return this.find({
			where: { filesMounted: false },
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
	 * `token`, `username`, `password` and `accountToken` are `select: false`, so no
	 * ordinary read can leak them into a response — and a handler about to call
	 * Jellyfin needs them. By keeping the re-selection to this single method, the
	 * places that hold a token in memory are the places that call it, and they can be
	 * counted.
	 */
	public findWithSecrets(id: string): Promise<MediaService | null> {
		return this.createQueryBuilder('service')
			.addSelect(['service.token', 'service.username', 'service.password', 'service.accountToken'])
			.where('service.id = :id', { id })
			.getOne();
	}

	public findByBaseUrl(baseUrl: string, peerId: string | null = null): Promise<MediaService | null> {
		return this.findOne({ where: { baseUrl, peerId: peerId === null ? IsNull() : peerId } });
	}

	/**
	 * Our own registrations of servers a directory knows, by their identity there.
	 *
	 * Only ours: a peer's row never carries an identifier, and matching one would be
	 * reporting a friend's server as already registered on this gateway.
	 */
	public findByServerIdentifiers(identifiers: string[]): Promise<MediaService[]> {
		if (identifiers.length === 0) {
			return Promise.resolve([]);
		}

		return this.find({ where: { serverIdentifier: In(identifiers), peerId: IsNull() } });
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
