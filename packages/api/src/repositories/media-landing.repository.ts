import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MediaLanding } from '@/entities';

@Injectable()
export class MediaLandingRepository extends Repository<MediaLanding> {
	public constructor(dataSource: DataSource) {
		super(MediaLanding, dataSource.createEntityManager());
	}

	/**
	 * Every landing still waiting on somebody, whatever the state.
	 *
	 * Both states are open questions — a stale row is one we have stopped waiting
	 * patiently for, not one we have stopped looking at — so there is no third state to
	 * exclude and no filter here. See `MediaLandingState`.
	 */
	public findOpen(): Promise<MediaLanding[]> {
		return this.find({ order: { createdAt: 'ASC' } });
	}

	public findForItem(itemId: string): Promise<MediaLanding | null> {
		return this.findOne({ where: { itemId } });
	}
}
