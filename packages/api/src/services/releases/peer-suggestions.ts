import {
	MediaOrigin,
	MediaResolution,
	PEER_SUGGESTION_PREFIX,
	SuggestionSource,
	type EpisodeRef,
	type MediaGroupSource,
	type PeerCopy,
	type QualitySummary,
	type ReleaseGroup,
	type ReleaseSuggestion,
} from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { QualityService } from '../quality.service';

/**
 * Turning the holdings we already index into suggestions a search screen can offer.
 *
 * **This is not a second peer system, and it deliberately reads nothing over the wire.**
 * The gateway already knows which peer holds what: every media service, ours or reached
 * through a friend, is indexed into the same catalogue, and `MediaGroup.sources` is that
 * knowledge in the shape a media page uses. Asking a peer live would be a second answer
 * to a question already answered, one that is slow, fails when they are asleep, and
 * disagrees with the sources list on the tab next door.
 *
 * What is new is the *question*. The sources list says "here are the copies of this
 * media"; a search screen asks "what would fill the gap", and for a season somebody is
 * four episodes short of those are not the same answer. Four rows on a sources list is
 * four facts; one offer covering four episodes is the thing somebody acts on, and the
 * thing a season pack on a tracker is competing against.
 *
 * **No registry here, on purpose.** The indexer and download-client registries exist to
 * resolve one of several interchangeable implementations named by a settings row —
 * Prowlarr today, something else tomorrow, one class and one enum value each. None of
 * that holds for peers: there is one peer network, it is not a type anybody configures,
 * and a peer copy is not interchangeable with a tracker release — it carries different
 * fields and is fetched by different machinery. Forcing both behind one interface would
 * buy an extension point nobody can extend, at the price of a lowest-common-denominator
 * result shape, which is exactly the shape that lets a magnet reach the transfer engine.
 */

/** One gap of ours, with every copy of it the index knows about. */
export interface SuggestionHolding {
	/** The episode, or the film, that is missing here. */
	ref: EpisodeRef;
	/** Every indexed copy of it, ours included — the local ones are filtered out here. */
	sources: MediaGroupSource[];
}

export interface PeerCopyRequest {
	holdings: SuggestionHolding[];
	/**
	 * The title to put on an offer that covers several episodes.
	 *
	 * The media being searched for, because a folded season has no one episode's title to
	 * borrow. A single-episode offer uses the episode's own, which is what somebody is
	 * looking for on the row.
	 */
	title: string;
	/**
	 * Peers a friend introduced rather than ones this household linked to itself.
	 *
	 * The same set `MediaGroupManager` builds for the origin filter, and the same reason
	 * for reading it here: `friend_of_friend` cannot be told from `friend` by looking at a
	 * source, and calling an uninvited gateway a friend is precisely the mistake the
	 * distinction exists to prevent.
	 */
	friendsOfFriends: Set<string>;
}

/**
 * Resolutions best first, which is the order the labels are declared in.
 *
 * Taken from `MediaResolution` rather than written out again: the two would drift, and a
 * private table saying `1080p` beats `2160p` is a wrong order that still looks like an
 * order.
 */
const RESOLUTION_RANK = new Map<string, number>(
	Object.values(MediaResolution).map((label, index) => [label, index]),
);

/** How far away a holder is. Nearer is better, and the numbers only ever compare. */
const ORIGIN_DISTANCE: Record<MediaOrigin, number> = {
	[MediaOrigin.LOCAL]: 0,
	[MediaOrigin.DIRECT]: 1,
	[MediaOrigin.FRIEND]: 2,
	[MediaOrigin.FRIEND_OF_FRIEND]: 3,
};

@Injectable()
export class PeerSuggestionService {
	/**
	 * The quality summaries are folded with the same service the library folds them with.
	 *
	 * A local fold would be a second reading of what `mixed` means, and the two would
	 * disagree the first time somebody changed one — leaving a search screen calling a
	 * season uniform that the library beside it calls mixed.
	 */
	public constructor(private readonly _quality: QualityService) {}

	/**
	 * What the peers and remote servers we are connected to could satisfy, folded.
	 *
	 * **One holder and one season per offer.** A service holding four of the episodes
	 * somebody is short of is one thing to press, and splitting it into four rows would
	 * put the same decision on screen four times while making it look worse than the
	 * season pack underneath it.
	 *
	 * Local copies are dropped rather than offered. A copy on a disk this gateway writes
	 * into is not a suggestion — it is what we hold — and a row offering to fetch it would
	 * plan a transfer from the machine the file is already on.
	 */
	public copiesFor(request: PeerCopyRequest): PeerCopy[] {
		const folds = new Map<string, { source: MediaGroupSource; fills: EpisodeRef[]; itemIds: string[]; qualities: (QualitySummary | null)[] }>();

		for (const holding of request.holdings) {
			for (const source of holding.sources) {
				if (source.local) {
					continue;
				}

				const key = `${source.serviceId}:${holding.ref.seasonNumber ?? ''}`;
				const fold = folds.get(key);

				if (fold === undefined) {
					folds.set(key, {
						source,
						fills: [holding.ref],
						itemIds: [source.itemId],
						qualities: [source.quality],
					});

					continue;
				}

				/*
				 * One row per episode and per service, even where a service holds the same
				 * episode twice. The ranked order the group view answers in already puts the
				 * copy that represents it first, so taking the first is taking that decision
				 * rather than making a second one here — and pulling both would write two
				 * files for one gap.
				 */
				if (fold.fills.some((one) => one.itemId === holding.ref.itemId)) {
					continue;
				}

				fold.fills.push(holding.ref);
				fold.itemIds.push(source.itemId);
				fold.qualities.push(source.quality);
			}
		}

		return [...folds.values()].map((fold) => this._copy(fold, request));
	}

	private _copy(
		fold: { source: MediaGroupSource; fills: EpisodeRef[]; itemIds: string[]; qualities: (QualitySummary | null)[] },
		request: PeerCopyRequest,
	): PeerCopy {
		const { source } = fold;
		const single = fold.fills.length === 1;
		const seasonNumber = fold.fills[0]?.seasonNumber ?? null;
		const quality = this._quality.merge(fold.qualities);

		return {
			// Keyed on the holder and the season and nothing else, so the same offer keeps
			// its place across two searches. The prefix is what stops it ever being taken
			// for a release the download client would accept — see `PEER_SUGGESTION_PREFIX`.
			id: `${PEER_SUGGESTION_PREFIX}${source.serviceId}:${seasonNumber ?? ''}`,
			itemIds: fold.itemIds,
			title: single ? (fold.fills[0]?.title ?? request.title) : request.title,
			serviceId: source.serviceId,
			serviceName: source.serviceName,
			serviceType: source.serviceType,
			peerId: source.peerId,
			peerName: source.peerName,
			origin: originOf(source, request.friendsOfFriends),
			seasonNumber,
			// Null on a folded offer: it covers several, and naming one of them on the row
			// would be a coordinate that does not describe what pressing it fetches.
			episodeNumber: single ? (fold.fills[0]?.episodeNumber ?? null) : null,
			size: sizeOf(fold.qualities, source, single),
			// `merge` answers a summary with no variants for copies nothing has
			// fingerprinted, and an empty summary on a chip reads as a measurement of
			// nothing rather than as an absence. Null says the honest thing.
			quality: quality.variants.length === 0 ? null : quality,
			path: single ? source.path : null,
			fills: fold.fills,
		};
	}
}

/**
 * Where a copy comes from, worked out the same way the library filter works it out.
 *
 * A service with no peer is one we registered ourselves, and a peer we cannot place is
 * read as a friend rather than as a stranger — the set names the ones a friend
 * introduced, so absence from it is the answer and not ignorance.
 *
 * `local` is not one of the three answers here, because a local source never reaches this
 * function: `copiesFor` drops it before folding. A branch for it would be code nothing can
 * run, which is worse than no branch — it reads as a case somebody has thought about.
 */
const originOf = (source: MediaGroupSource, friendsOfFriends: Set<string>): MediaOrigin => {
	if (source.peerId === null) {
		return MediaOrigin.DIRECT;
	}

	return friendsOfFriends.has(source.peerId) ? MediaOrigin.FRIEND_OF_FRIEND : MediaOrigin.FRIEND;
};

/**
 * What the offer costs, in bytes.
 *
 * Summed over the copies for a folded season, because the number somebody is deciding on
 * is what four episodes cost rather than what one of them does. Null when nothing
 * reported a size at all — a zero there would be an offer that looks free.
 */
const sizeOf = (
	qualities: (QualitySummary | null)[],
	source: MediaGroupSource,
	single: boolean,
): number | null => {
	if (single) {
		return source.bytes ?? qualities[0]?.totalBytes ?? null;
	}

	const total = qualities.reduce((sum, one) => sum + (one?.totalBytes ?? 0), 0);

	return total > 0 ? total : null;
};

/**
 * The two kinds of answer in one order.
 *
 * **A peer copy sorts above every tracker release, and that is a rule rather than a
 * score.** The two are not comparable on the axes the release preference is built from: a
 * peer copy has no scene name to read a group, a source or a codec tag off, and running
 * the household's preference across both would rank a measured file by the absence of the
 * words a tracker would have put in its name. What can be said, always, is that one of
 * them exists and the other is a claim — the file is on a machine we are already allowed
 * to talk to, its quality was read off the file rather than off a name, there are no
 * seeders to have gone to zero, and nothing has to be added to a torrent client and
 * copied out of it afterwards. So the fact goes above the claims.
 *
 * Above both, one thing outranks everything: an offer that brings nothing goes last. That
 * is the rule `orderGroupsByPreference` already applies to a release we hold, extended to
 * a peer copy with nothing left to fill, and for the same reason — it is still listed,
 * because "you already have this one" is an answer and a shorter list is not.
 *
 * The tracker rows keep the order they arrived in. They have already been through
 * `orderGroupsByPreference`, the sort below is stable, and comparing them a second time
 * here would be a second opinion about the household's preference in a file that has
 * never read it.
 */
export const orderSuggestions = (
	copies: PeerCopy[],
	groups: ReleaseGroup[],
): ReleaseSuggestion[] => {
	const suggestions: ReleaseSuggestion[] = [
		...[...copies].sort(comparePeerCopies).map(
			(copy): ReleaseSuggestion => ({ source: SuggestionSource.PEER, key: copy.id, copy }),
		),
		...groups.map(
			(release): ReleaseSuggestion => ({
				source: SuggestionSource.INDEXER,
				key: release.key,
				release,
			}),
		),
	];

	return suggestions.sort(
		(left, right) =>
			Number(bringsNothing(left)) - Number(bringsNothing(right)) ||
			Number(left.source === SuggestionSource.INDEXER) -
				Number(right.source === SuggestionSource.INDEXER),
	);
};

/**
 * An offer with nothing to bring, in whichever vocabulary its kind states that.
 *
 * A tracker release says it by matching a file we hold to the byte; a peer copy says it by
 * filling nothing. Two spellings of one fact, which is why they are read in one place.
 */
const bringsNothing = (one: ReleaseSuggestion): boolean =>
	one.source === SuggestionSource.PEER ? one.copy.fills.length === 0 : one.release.heldAlready;

/**
 * Which of two peer copies to offer first.
 *
 * Distance decides before anything else: a direct link is faster, already authenticated,
 * and does not spend a friend's connection relaying for us — the same order
 * `findHolders` answers in. Then how much of the gap it closes, which is the rule the
 * coverage plan is built on. Then the resolution the gateway measured, and only then the
 * size, because size alone is a bad signal: a bloated 720p rip is bigger than a good 1080p
 * encode.
 */
const comparePeerCopies = (left: PeerCopy, right: PeerCopy): number =>
	ORIGIN_DISTANCE[left.origin] - ORIGIN_DISTANCE[right.origin] ||
	right.fills.length - left.fills.length ||
	resolutionRank(left.quality) - resolutionRank(right.quality) ||
	(right.size ?? 0) - (left.size ?? 0);

/** Last place for a copy whose resolution nothing could read, rather than first. */
const resolutionRank = (quality: QualitySummary | null): number =>
	RESOLUTION_RANK.get(quality?.dominant?.resolution ?? '') ?? RESOLUTION_RANK.size;
