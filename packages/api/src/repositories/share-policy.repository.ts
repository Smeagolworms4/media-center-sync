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
	 * The policy of one library, or nothing.
	 *
	 * Nothing means private. A library is never shared by having been forgotten, so
	 * the absence of a row is a decision and not a gap the caller should fill with a
	 * permissive default.
	 */
	public findByLibrary(libraryId: string): Promise<SharePolicy | null> {
		return this.findOne({ where: { libraryId } });
	}

	public findByLibraries(libraryIds: string[]): Promise<SharePolicy[]> {
		return libraryIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { libraryId: In(libraryIds) } });
	}

	/** Every library that is exposed to somebody, whatever the audience. */
	public findShared(): Promise<SharePolicy[]> {
		return this.find({ where: { visibility: Not(ShareVisibility.PRIVATE) } });
	}

	public findByVisibility(visibility: ShareVisibility): Promise<SharePolicy[]> {
		return this.find({ where: { visibility } });
	}

	public async deleteForLibrary(libraryId: string): Promise<void> {
		await this.delete({ libraryId });
	}
}
