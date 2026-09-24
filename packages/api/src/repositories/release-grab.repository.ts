import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { GrabState } from '@mcs/shared';
import { ReleaseGrab } from '@/entities';

/** Grabs the download client may still have something to say about. */
const LIVE_STATES = [GrabState.SENT, GrabState.DOWNLOADING, GrabState.FETCHED];

/**
 * Reading and writing what was grabbed, and nothing else.
 *
 * Which grab is worth polling, and what to do about one that has finished, are
 * decisions and live in `ReleaseManager`. This knows how to find rows.
 */
@Injectable()
export class ReleaseGrabRepository extends Repository<ReleaseGrab> {
	public constructor(dataSource: DataSource) {
		super(ReleaseGrab, dataSource.createEntityManager());
	}

	/**
	 * Everything the poller still has a reason to ask the client about.
	 *
	 * `FETCHED` is included although the bytes are all there: it means the client has
	 * finished and the gateway has not filed it yet, which is precisely the row the next
	 * pass has work to do on. Leaving it out is how a completed download sits on the
	 * disk for ever with nothing coming to collect it.
	 */
	public findLive(): Promise<ReleaseGrab[]> {
		return this.find({ where: { state: In(LIVE_STATES) }, order: { createdAt: 'ASC' } });
	}

	/** What has been grabbed for one media, newest first. */
	public findForItem(itemId: string): Promise<ReleaseGrab[]> {
		return this.find({ where: { itemId }, order: { createdAt: 'DESC' } });
	}

	/** Everything, newest first — the downloads screen's list. */
	public findRecent(limit = 100): Promise<ReleaseGrab[]> {
		return this.find({ order: { createdAt: 'DESC' }, take: limit });
	}
}
