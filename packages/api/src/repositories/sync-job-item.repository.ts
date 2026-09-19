import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { SyncJobItemState } from '@mcs/shared';
import { SyncJobItem } from '@/entities';

@Injectable()
export class SyncJobItemRepository extends Repository<SyncJobItem> {
	public constructor(dataSource: DataSource) {
		super(SyncJobItem, dataSource.createEntityManager());
	}

	/**
	 * One page of a run, in the order the plan chose.
	 *
	 * Ordered on `position` rather than on `createdAt`: five hundred rows are inserted
	 * inside the same second, and a page ordered on a timestamp they share comes back
	 * in whatever order the engine felt like — which, paginated, drops some lines and
	 * repeats others.
	 */
	public findPage(jobId: string, skip: number, take: number): Promise<[SyncJobItem[], number]> {
		return this.findAndCount({ where: { jobId }, order: { position: 'ASC' }, skip, take });
	}

	/**
	 * The line a transfer belongs to.
	 *
	 * Found on the job and the item rather than on the transfer identifier, because the
	 * line exists before any transfer does — it is written when the run is planned — and
	 * a lookup by transfer would find nothing at exactly the moment the first state
	 * change arrives.
	 */
	public findLine(jobId: string, itemId: string): Promise<SyncJobItem | null> {
		return this.findOne({ where: { jobId, itemId } });
	}

	public findByJob(jobId: string): Promise<SyncJobItem[]> {
		return this.find({ where: { jobId }, order: { position: 'ASC' } });
	}

	/**
	 * Everything still waiting on a cancelled run is not waiting for anything.
	 *
	 * Left alone, the lines of a stopped job read "pending" forever, which is the one
	 * state they can no longer be in — and a screen showing four hundred of them is a
	 * run that looks like it is still going.
	 */
	public async skipUnfinished(jobId: string): Promise<void> {
		await this.update(
			{ jobId, state: In([SyncJobItemState.PENDING, SyncJobItemState.RUNNING]) },
			{ state: SyncJobItemState.SKIPPED, transferId: null, finishedAt: new Date() },
		);
	}

	/**
	 * What a run has actually achieved, counted in the database.
	 *
	 * Counted rather than accumulated on the job row: a counter incremented on every
	 * event drifts the first time one arrives twice — a resumed transfer reports `done`
	 * again after a restart — and a job that says 901 of 900 is one nobody believes
	 * again.
	 */
	public async progressOf(
		jobId: string,
	): Promise<{ done: number; failed: number; bytesDone: number; open: number }> {
		const rows = await this.find({ where: { jobId } });
		const counted = { done: 0, failed: 0, bytesDone: 0, open: 0 };

		for (const row of rows) {
			counted.bytesDone += Number(row.bytesDone);

			if (row.state === SyncJobItemState.DONE) {
				counted.done += 1;
			} else if (row.state === SyncJobItemState.FAILED) {
				counted.failed += 1;
			} else if (row.state !== SyncJobItemState.SKIPPED) {
				counted.open += 1;
			}
		}

		return counted;
	}
}
