import { Injectable } from '@nestjs/common';
import { DataSource, In, Not, Repository } from 'typeorm';
import { ShareVisibility } from '@mcs/shared';
import { SharePolicy } from '@/entities';

@Injectable()
export class SharePolicyRepository extends Repository<SharePolicy> {
	public constructor(dataSource: DataSource) {
		super(SharePolicy, dataSource.createEntityManager());
	}

	/**
	 * The stored policy of one library, or nothing.
	 *
	 * Nothing means nobody has decided about this library — not that it is private.
	 * What it then exposes is resolved by `effectiveVisibility`, which is the gateway
	 * default on one of our own services and private on anything else. A caller that
	 * reads `null` here as "private" is the bug this repository cannot prevent: it is
	 * why a fresh gateway shared nothing at all while its setting said otherwise.
	 */
	public findByLibrary(libraryId: string): Promise<SharePolicy | null> {
		return this.findOne({ where: { libraryId } });
	}

	public findByLibraries(libraryIds: string[]): Promise<SharePolicy[]> {
		return libraryIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { libraryId: In(libraryIds) } });
	}

	/**
	 * Every **override** that exposes a library to somebody, whatever the audience.
	 *
	 * Not the same thing as every library that is exposed: the libraries following the
	 * gateway default have no row here and are missing from this answer. Anything that
	 * has to enumerate what is really shared goes through `ShareManager`, which starts
	 * from the libraries.
	 */
	public findShared(): Promise<SharePolicy[]> {
		return this.find({ where: { visibility: Not(ShareVisibility.PRIVATE) } });
	}

	/** Overrides set to one visibility. The rows nobody wrote are not in this answer. */
	public findByVisibility(visibility: ShareVisibility): Promise<SharePolicy[]> {
		return this.find({ where: { visibility } });
	}

	public async deleteForLibrary(libraryId: string): Promise<void> {
		await this.delete({ libraryId });
	}
}
