import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
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

	/**
	 * The landings of these transfers, in one read.
	 *
	 * Bulk because the queue screen asks for a page of transfers at a time, and one
	 * query per row is what stopped this being shown at all. An empty list is answered
	 * without a query: `In([])` renders as `IN ()`, which SQLite rejects outright.
	 */
	public findForTransfers(transferIds: string[]): Promise<MediaLanding[]> {
		return transferIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { transferId: In(transferIds) } });
	}
}
