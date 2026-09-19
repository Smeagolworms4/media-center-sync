import {
	MatchStrategy,
	MediaKind,
	SyncState,
	type ExternalIds,
	type MediaFileInfo,
} from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { QualityService } from './quality.service';
import { similarity } from './title-normalizer';

/**
 * The shape correlation works on.
 *
 * Deliberately narrower than the entity: everything here comes out of an index row,
 * and the correlation must not be able to reach a repository, a handler or a service
 * definition. `peerId` is passed in rather than read, because an item knows its
 * service and only the service knows whose machine it is on.
 */
export interface MatchCandidate {
	id: string;
	serviceId: string;
	peerId?: string | null;
	parentId?: string | null;
	kind: MediaKind;
	title: string;
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	externalIds: ExternalIds;
	file: MediaFileInfo | null;
}

export interface MatchOptions {
	/** From the settings. Below it, a correlation is proposed and not applied. */
	threshold: number;
	/**
	 * Parents already correlated, as local identifier to the remote ones.
	 *
	 * This is what makes season and episode numbers usable: `S01E02` is meaningless
	 * on its own and decisive once both sides agree which series they are inside.
	 */
	parentMatches?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One correlation, before anything has decided to keep it. */
export interface MatchProposal {
	localItemId: string | null;
	remoteItemId: string;
	remoteServiceId: string;
	remotePeerId: string | null;
	strategy: MatchStrategy;
	confidence: number;
	state: SyncState;
	reason: string | null;
	/**
	 * Whether the confidence cleared the settings threshold.
	 *
	 * The row is written either way — a proposed match the person can confirm is far
	 * more useful than a match silently dropped — and only this flag says whether the
	 * gateway may act on it.
	 */
	applied: boolean;
}

/** Below this, two titles are not the same work whatever else agrees. */
const TITLE_FLOOR = 0.62;

/** A title match can never be certain, however perfect the string. */
const TITLE_CEILING = 0.95;

const CONFIDENCE = {
	checksum: 1,
	externalId: 0.98,
	externalIdPartial: 0.9,
	seasonEpisode: 0.95,
	pathExact: 0.85,
	pathBasename: 0.8,
} as const;

/**
 * Correlates the same media across services.
 *
 * The strategies are tried in order of how much they prove, and the order is the
 * whole design — each one is wrong on its own in a different way:
 *
 * - A checksum is proof of identity and nothing else; it only ever matches a byte
 *   for byte copy, so it finds the files somebody already synced and misses every
 *   re-encode of the same episode.
 * - A provider identifier is what the metadata agents agreed on, which is close to
 *   proof — but libraries carry them inconsistently, an episode often inherits its
 *   series' identifier, and two different cuts of a film share one.
 * - Season and episode numbers are exact and meaningless without a parent: every
 *   library on earth has an `S01E02`. They are only usable below a series that has
 *   already been matched some other way, which is why they come after the
 *   identifiers rather than before.
 * - A normalised title is the only strategy that works on a library with no
 *   metadata at all, and the only one that can be confidently wrong: remakes, the
 *   two `The Office`s, and anything with a subtitle one library kept and the other
 *   dropped. Hence a score, a year check, and a threshold below which it is
 *   proposed rather than applied.
 * - A path is the weakest of all and still worth having last: two gateways that
 *   sync to each other end up with identical trees, and a matching path then
 *   confirms what nothing else could. It is also the one that matches two unrelated
 *   files called `movie.mkv`, which is why a bare basename scores lowest.
 */
@Injectable()
export class MatchingService {
	public constructor(private readonly _quality: QualityService) {}

	/**
	 * Score one pair, or null when nothing links them.
	 *
	 * Returns the first strategy that fires, never a blend: a correlation the person
	 * can be shown and can undo has to be explainable by one rule, and an averaged
	 * score of five signals explains nothing.
	 */
	public score(
		local: MatchCandidate,
		remote: MatchCandidate,
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		// An episode is never a season and a film is never a series. Kinds that differ
		// are a different node of the tree, whatever their titles say.
		if (local.kind !== remote.kind) {
			return null;
		}

		const checksum = this._checksumMatch(local, remote);

		if (checksum) {
			return checksum;
		}

		const external = this._externalIdMatch(local, remote);

		if (external) {
			return external;
		}

		const episode = this._seasonEpisodeMatch(local, remote, options);

		if (episode) {
			return episode;
		}

		const title = this._titleMatch(local, remote);

		if (title) {
			return title;
		}

		return this._pathMatch(local, remote);
	}

	/**
	 * The best remote candidate for one local item, per remote service.
	 *
	 * Per service rather than overall, because holding the same film on three
	 * friends' gateways is the normal case and each of them is a usable source. The
	 * transfer layer picks between them later, on measured rate; correlation only has
	 * to say that they are the same film.
	 */
	public correlate(
		local: MatchCandidate,
		candidates: MatchCandidate[],
		options: MatchOptions,
	): MatchProposal[] {
		const best = new Map<string, MatchProposal>();

		for (const remote of candidates) {
			if (remote.id === local.id || remote.serviceId === local.serviceId) {
				continue;
			}

			const scored = this.score(local, remote, options);

			if (!scored) {
				continue;
			}

			const proposal = this._toProposal(local, remote, scored, options);
			const incumbent = best.get(remote.serviceId);

			if (!incumbent || proposal.confidence > incumbent.confidence) {
				best.set(remote.serviceId, proposal);
			}
		}

		return [...best.values()].sort((left, right) => right.confidence - left.confidence);
	}

	/**
	 * What the icon says for one pair.
	 *
	 * `MISSING` is the case where we have nothing at all; everything else compares
	 * the two files through the quality comparator so that the list and the sync
	 * cannot disagree about what "outdated" means.
	 */
	public deriveState(local: MatchCandidate | null, remote: MatchCandidate): SyncState {
		if (!local) {
			return SyncState.MISSING;
		}

		// A node with no file of its own — a series, a season — is never outdated: its
		// state is an aggregate of its children, computed by whoever holds the tree.
		if (!local.file && !remote.file) {
			return SyncState.IN_SYNC;
		}

		if (!local.file) {
			return SyncState.MISSING;
		}

		if (!remote.file) {
			return SyncState.LOCAL_ONLY;
		}

		const comparison = this._quality.compare(remote.file, local.file);

		if (comparison.order > 0) {
			return SyncState.OUTDATED;
		}

		// Equal rank does not mean interchangeable: two cuts of different lengths are
		// a conflict, and replacing one with the other would be a surprise nobody
		// asked for.
		if (comparison.order === 0 && this._quality.isConflicting(local.file, remote.file)) {
			return SyncState.CONFLICT;
		}

		return SyncState.IN_SYNC;
	}

	/**
	 * The state of an item given everything it correlated with.
	 *
	 * The order of the tests is the order of urgency on screen: something to fetch
	 * beats something to arbitrate, which beats everything being fine.
	 */
	public deriveItemState(proposals: MatchProposal[]): SyncState {
		const applied = proposals.filter((proposal) => proposal.applied);

		if (applied.length === 0) {
			return SyncState.LOCAL_ONLY;
		}

		for (const state of [SyncState.MISSING, SyncState.OUTDATED, SyncState.CONFLICT]) {
			if (applied.some((proposal) => proposal.state === state)) {
				return state;
			}
		}

		return SyncState.IN_SYNC;
	}

	private _toProposal(
		local: MatchCandidate,
		remote: MatchCandidate,
		scored: { strategy: MatchStrategy; confidence: number },
		options: MatchOptions,
	): MatchProposal {
		const state = this.deriveState(local, remote);
		const comparison = this._quality.compare(remote.file, local.file);

		return {
			localItemId: local.id,
			remoteItemId: remote.id,
			remoteServiceId: remote.serviceId,
			remotePeerId: remote.peerId ?? null,
			strategy: scored.strategy,
			confidence: Number(scored.confidence.toFixed(4)),
			state,
			// Only worth a sentence when the remote copy wins; "nothing to say" is a
			// null the interface renders as nothing at all.
			reason: state === SyncState.OUTDATED ? comparison.reason : null,
			applied: scored.confidence >= options.threshold,
		};
	}

	private _checksumMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const localChecksum = local.file?.checksum;
		const remoteChecksum = remote.file?.checksum;

		if (localChecksum && remoteChecksum && localChecksum === remoteChecksum) {
			return { strategy: MatchStrategy.CHECKSUM, confidence: CONFIDENCE.checksum };
		}

		// The content identifier is the cheap cousin: derived from sampled ranges and
		// the exact size, computed identically on both gateways without talking to each
		// other. It is not proof the way a full hash is, but a collision needs two
		// files of the same byte count agreeing on three sampled windows.
		const localContent = local.file?.contentId;
		const remoteContent = remote.file?.contentId;

		if (localContent && remoteContent && localContent === remoteContent) {
			return { strategy: MatchStrategy.CHECKSUM, confidence: CONFIDENCE.checksum };
		}

		return null;
	}

	private _externalIdMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const providers: (keyof ExternalIds)[] = ['tvdb', 'tmdb', 'imdb', 'musicbrainz'];
		const agreed = providers.some((provider) => {
			const left = local.externalIds?.[provider];
			const right = remote.externalIds?.[provider];

			return !!left && !!right && left === right;
		});

		if (!agreed) {
			return null;
		}

		if (local.kind !== MediaKind.EPISODE) {
			return { strategy: MatchStrategy.EXTERNAL_ID, confidence: CONFIDENCE.externalId };
		}

		// Episodes routinely carry their series' identifier rather than their own,
		// which would make every episode of a show match every other. When both sides
		// number themselves, the numbers have to agree.
		const known =
			local.seasonNumber !== null &&
			remote.seasonNumber !== null &&
			local.episodeNumber !== null &&
			remote.episodeNumber !== null;

		if (!known) {
			return {
				strategy: MatchStrategy.EXTERNAL_ID,
				confidence: CONFIDENCE.externalIdPartial,
			};
		}

		if (
			local.seasonNumber !== remote.seasonNumber ||
			local.episodeNumber !== remote.episodeNumber
		) {
			return null;
		}

		return { strategy: MatchStrategy.EXTERNAL_ID, confidence: CONFIDENCE.externalId };
	}

	private _seasonEpisodeMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		if (local.kind !== MediaKind.EPISODE && local.kind !== MediaKind.SEASON) {
			return null;
		}

		if (local.seasonNumber === null || local.seasonNumber !== remote.seasonNumber) {
			return null;
		}

		if (local.kind === MediaKind.EPISODE && local.episodeNumber !== remote.episodeNumber) {
			return null;
		}

		if (local.kind === MediaKind.EPISODE && local.episodeNumber === null) {
			return null;
		}

		// Without a matched parent these numbers say nothing: every library has an
		// `S01E02`, and matching on it alone would correlate the second episode of
		// every series with the second episode of every other.
		const remoteParents = local.parentId
			? options.parentMatches?.get(local.parentId)
			: undefined;

		if (!remote.parentId || !remoteParents?.has(remote.parentId)) {
			return null;
		}

		return { strategy: MatchStrategy.SEASON_EPISODE, confidence: CONFIDENCE.seasonEpisode };
	}

	private _titleMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const score = similarity(local.normalizedTitle, remote.normalizedTitle);

		if (score < TITLE_FLOOR) {
			return null;
		}

		// Episodes are not matched on their titles alone: half a library has none, and
		// the ones that do repeat `Pilot` and `Part One` across every series there is.
		if (local.kind === MediaKind.EPISODE) {
			if (
				local.seasonNumber === null ||
				local.episodeNumber === null ||
				local.seasonNumber !== remote.seasonNumber ||
				local.episodeNumber !== remote.episodeNumber
			) {
				return null;
			}
		}

		let confidence = Math.min(score, TITLE_CEILING);

		if (local.year !== null && remote.year !== null) {
			if (local.year === remote.year) {
				confidence = Math.min(confidence + 0.05, TITLE_CEILING);
			} else if (Math.abs(local.year - remote.year) <= 1) {
				// One year apart is a release-date disagreement between two metadata
				// agents — a festival date against a cinema date — and it happens
				// constantly. It costs a little confidence, not the match.
				confidence -= 0.1;
			} else {
				// The same title several years apart is a remake, and pulling the 2010
				// version over the 1978 one because they share a name is exactly the
				// kind of wrong a person never forgives.
				confidence -= 0.4;
			}
		}

		if (confidence <= 0) {
			return null;
		}

		return { strategy: MatchStrategy.NORMALIZED_TITLE, confidence };
	}

	private _pathMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const localPath = local.file?.path;
		const remotePath = remote.file?.path;

		if (!localPath || !remotePath) {
			return null;
		}

		if (localPath === remotePath) {
			return { strategy: MatchStrategy.PATH, confidence: CONFIDENCE.pathExact };
		}

		const localName = this._basename(localPath);
		const remoteName = this._basename(remotePath);

		// A basename of `movie.mkv` or `01.mkv` matches half the internet. Requiring
		// some length is a blunt guard and a sufficient one: real release names are
		// long, and the two files that collide under this rule were named by the same
		// careless hand anyway.
		if (localName === remoteName && localName.length >= 12) {
			return { strategy: MatchStrategy.PATH, confidence: CONFIDENCE.pathBasename };
		}

		return null;
	}

	private _basename(path: string): string {
		const cut = path.replace(/\\/g, '/');
		const index = cut.lastIndexOf('/');

		return (index === -1 ? cut : cut.slice(index + 1)).toLowerCase();
	}
}
