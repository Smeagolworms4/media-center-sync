import { Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import type { MatchStrategy } from '@mcs/shared';
import { SyncState } from '@mcs/shared';
import { MediaMatch } from '@/entities';

/** What a correlation pass produces for one pair. */
export interface MatchClaim {
	localItemId: string | null;
	remoteItemId: string;
	remoteServiceId: string;
	remotePeerId?: string | null;
	strategy: MatchStrategy;
	confidence: number;
	state: SyncState;
	reason?: string | null;
}

/** Two items an applied match joined — the edge grouping walks. */
export interface MatchPair {
	localItemId: string;
	remoteItemId: string;
}

@Injectable()
export class MediaMatchRepository extends Repository<MediaMatch> {
	public constructor(dataSource: DataSource) {
		super(MediaMatch, dataSource.createEntityManager());
	}

	/**
	 * The pairs the gateway actually acted on, as two identifiers and nothing else.
	 *
	 * Runs `SELECT localItemId, remoteItemId FROM media_matches WHERE localItemId IS
	 * NOT NULL AND state <> 'conflict' AND (confidence >= :threshold OR confirmedAt IS
	 * NOT NULL)`. It is what grouping joins on, and each clause is one of the rules:
	 *
	 * - a null `localItemId` is a media known only elsewhere, so there is no second row
	 *   to join to;
	 * - a conflict is a disputed pair, and the whole point of that state is that nobody
	 *   has decided the two are the same thing;
	 * - below the threshold a match was proposed and not applied, which has to stay two
	 *   posters rather than become one;
	 * - a confirmation overrules the score, because a human said so.
	 *
	 * `applied` is not a column — it is a flag on the proposal, computed against the
	 * threshold and thrown away on write — so the condition is rebuilt here from the
	 * threshold in force now. A library therefore regroups when that setting moves,
	 * which is the behaviour a person changing it expects.
	 */
	public findAppliedPairs(threshold: number): Promise<MatchPair[]> {
		return this.createQueryBuilder('match')
			.select('match.localItemId', 'localItemId')
			.addSelect('match.remoteItemId', 'remoteItemId')
			.where('match.localItemId IS NOT NULL')
			.andWhere('match.state != :conflict', { conflict: SyncState.CONFLICT })
			.andWhere('(match.confidence >= :threshold OR match.confirmedAt IS NOT NULL)', {
				threshold,
			})
			.getRawMany<MatchPair>();
	}

	public findForLocalItem(localItemId: string): Promise<MediaMatch[]> {
		return this.find({ where: { localItemId }, order: { confidence: 'DESC' } });
	}

	public findForRemoteItem(remoteItemId: string): Promise<MediaMatch[]> {
		return this.find({ where: { remoteItemId }, order: { confidence: 'DESC' } });
	}

	/**
	 * What that service holds and we do not.
	 *
	 * A null `localItemId` is the whole definition of missing: the media is known
	 * there, and nothing here was correlated with it.
	 */
	public findMissingByService(remoteServiceId: string): Promise<MediaMatch[]> {
		return this.find({
			where: { remoteServiceId, localItemId: IsNull(), state: SyncState.MISSING },
			order: { createdAt: 'DESC' },
		});
	}

	public findByState(state: SyncState): Promise<MediaMatch[]> {
		return this.find({ where: { state }, order: { confidence: 'DESC' } });
	}

	/** Matches a human has not confirmed, which is what the review screen lists. */
	public findUnconfirmedBelow(threshold: number): Promise<MediaMatch[]> {
		return this.createQueryBuilder('match')
			.where('match.confirmedAt IS NULL')
			.andWhere('match.confidence < :threshold', { threshold })
			.orderBy('match.confidence', 'DESC')
			.getMany();
	}

	/**
	 * Writes the claim about one pair, replacing whatever was claimed before.
	 *
	 * A correlation pass re-examines pairs it has already seen, and inserting blindly
	 * would violate the unique index on the pair the second time a scan runs. Updating
	 * in place also keeps the identifier stable, so a match a human confirmed is still
	 * the same row afterwards.
	 */
	public async upsertPair(claim: MatchClaim): Promise<MediaMatch> {
		const existing = await this.findOne({
			where: { localItemId: claim.localItemId ?? IsNull(), remoteItemId: claim.remoteItemId },
		});

		const match = existing ?? this.create({ ...claim, localItemId: claim.localItemId ?? null });

		if (existing !== null) {
			Object.assign(existing, claim);
		}

		return this.save(match);
	}

	public async deleteForItems(itemIds: string[]): Promise<number> {
		if (itemIds.length === 0) {
			return 0;
		}

		const local = await this.delete({ localItemId: In(itemIds) });
		const remote = await this.delete({ remoteItemId: In(itemIds) });

		return (local.affected ?? 0) + (remote.affected ?? 0);
	}

	public async deleteForService(remoteServiceId: string): Promise<number> {
		const result = await this.delete({ remoteServiceId });

		return result.affected ?? 0;
	}
}
