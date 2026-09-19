import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Repository } from 'typeorm';
import type { RevalidationOutcome } from '@mcs/shared';
import { Revalidation } from '@/entities';

@Injectable()
export class RevalidationRepository extends Repository<Revalidation> {
	public constructor(dataSource: DataSource) {
		super(Revalidation, dataSource.createEntityManager());
	}

	/**
	 * Questions asked and not yet answered.
	 *
	 * A transfer waiting on one of these is not stalled, it is waiting — and telling
	 * the two apart is the difference between retrying and being patient.
	 */
	public findPending(transferId: string): Promise<Revalidation[]> {
		return this.find({
			where: { transferId, answeredAt: IsNull() },
			order: { requestedAt: 'ASC' },
		});
	}

	public findForTransfer(transferId: string): Promise<Revalidation[]> {
		return this.find({ where: { transferId }, order: { requestedAt: 'DESC' } });
	}

	/** The last thing that source told us about this transfer. */
	public findLatestForSource(transferId: string, sourceServiceId: string): Promise<Revalidation | null> {
		return this.findOne({
			where: { transferId, sourceServiceId },
			order: { requestedAt: 'DESC' },
		});
	}

	public findByOutcome(outcome: RevalidationOutcome): Promise<Revalidation[]> {
		return this.find({ where: { outcome }, order: { answeredAt: 'DESC' } });
	}
}
