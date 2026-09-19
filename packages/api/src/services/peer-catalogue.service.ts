import { PeerTrust, ShareVisibility, type MediaKind, type QualitySummary } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PeerLinkService } from './peer-link.service';

/** One row of a catalogue, ours or theirs. Metadata only; bytes are asked for later. */
export interface CatalogueEntry {
	itemId: string;
	serviceId: string;
	libraryId: string;
	kind: MediaKind;
	title: string;
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	contentId: string | null;
	quickHash: string | null;
	size: number | null;
	quality: QualitySummary | null;
	/** False when the policy exposes the title but not the file. */
	pullable: boolean;
}

/** The subset of a share policy this service decides on. */
export interface CataloguePolicy {
	libraryId: string;
	visibility: ShareVisibility;
	allowedPeerIds: string[];
	deniedPeerIds: string[];
	metadataOnly: boolean;
}

export interface CataloguePeer {
	id: string;
	name: string;
	trust: PeerTrust;
	/** The friend who introduced them, for a friend of a friend. */
	viaPeerId: string | null;
}

/** Somebody who says they hold a given file. */
export interface ContentHolder {
	peerId: string;
	peerName: string;
	serviceId: string;
	externalId: string;
	size: number | null;
	trust: PeerTrust;
	/** The friend who vouched for them, when they are a friend of a friend. */
	viaPeerId: string | null;
}

/**
 * What we show a peer, and what they show us.
 *
 * Both directions go through the same filter, because the question is the same one
 * asked twice: given a policy and a peer, which libraries are visible and which of
 * them may serve files. Sharing is decided per library rather than per service —
 * somebody's series and their home videos live on the same Jellyfin and belong on
 * different sides of that line.
 */
@Injectable()
export class PeerCatalogueService {
	private readonly _logger = new Logger(PeerCatalogueService.name);

	public constructor(private readonly _links: PeerLinkService) {}

	/**
	 * May this peer see this library at all?
	 *
	 * Denial is checked first and wins over everything, including an explicit allow.
	 * A list of people who must not see something is only useful if it cannot be
	 * overridden by a rule somebody set six months earlier and forgot.
	 */
	public isVisible(policy: CataloguePolicy, peer: CataloguePeer): boolean {
		if (policy.deniedPeerIds.includes(peer.id)) {
			return false;
		}

		if (policy.allowedPeerIds.includes(peer.id)) {
			return true;
		}

		switch (policy.visibility) {
			case ShareVisibility.PRIVATE:
				return false;

			case ShareVisibility.FRIENDS:
				// A friend of a friend is not a friend. They were never invited by us,
				// and the whole point of the trust level is that this line exists.
				return peer.trust === PeerTrust.FRIEND;

			case ShareVisibility.FRIENDS_OF_FRIENDS:
				return true;
		}
	}

	/**
	 * The rows a peer is allowed to receive.
	 *
	 * `metadataOnly` is applied here rather than by dropping the row, because seeing
	 * that a friend has a film and being unable to pull it is a useful thing to know —
	 * it is how somebody decides to ask.
	 */
	public filterForPeer(
		entries: CatalogueEntry[],
		policies: CataloguePolicy[],
		peer: CataloguePeer,
	): CatalogueEntry[] {
		const byLibrary = new Map(policies.map((policy) => [policy.libraryId, policy]));

		return entries.flatMap((entry) => {
			const policy = byLibrary.get(entry.libraryId);

			// No policy at all means nothing was shared. Defaulting to visible would
			// expose a library the moment somebody links, which is the wrong default
			// exactly once.
			if (!policy || !this.isVisible(policy, peer)) {
				return [];
			}

			return [{ ...entry, pullable: entry.pullable && !policy.metadataOnly }];
		});
	}

	/** What a linked peer exposes to us, as they have already filtered it. */
	public async fetchCatalogue(
		peerId: string,
		query: { since?: string | null; libraryId?: string | null } = {},
	): Promise<CatalogueEntry[]> {
		const answer = await this._links
			.request<{ entries?: CatalogueEntry[] }>(peerId, 'catalogue.list', query)
			.catch((error: unknown) => {
				this._logger.warn(`Peer ${peerId} did not answer the catalogue: ${String(error)}`);

				return { entries: [] };
			});

		return answer.entries ?? [];
	}

	/**
	 * Everybody who holds a given file, including one hop further out.
	 *
	 * The second hop is what makes the swarm worth having: a friend's friend may hold
	 * the same episode, and their bandwidth is as good as anybody's. They are asked
	 * through the friend who knows them rather than directly — we have no link to
	 * them and no business opening one — and the answer is tagged with who vouched,
	 * so the interface can say where a source came from and the settings can refuse
	 * the whole idea.
	 */
	public async findHolders(
		contentId: string,
		peers: CataloguePeer[],
		options: { allowFriendsOfFriends: boolean },
	): Promise<ContentHolder[]> {
		const holders = new Map<string, ContentHolder>();
		const friends = peers.filter((peer) => peer.trust === PeerTrust.FRIEND);

		const answers = await Promise.all(
			friends.map(async (peer) => {
				if (!this._links.isLinked(peer.id)) {
					return [];
				}

				return this._links
					.request<{ holders?: ContentHolder[] }>(peer.id, 'catalogue.holders', {
						contentId,
						// The depth is asked for rather than assumed, so a peer that has
						// turned friend-of-friend sharing off simply answers with itself.
						depth: options.allowFriendsOfFriends ? 1 : 0,
					})
					.then((answer) => this._attribute(answer.holders ?? [], peer))
					.catch(() => [] as ContentHolder[]);
			}),
		);

		for (const holder of answers.flat()) {
			if (!options.allowFriendsOfFriends && holder.trust === PeerTrust.FRIEND_OF_FRIEND) {
				continue;
			}

			// The same file behind two friends is one source, not two: keeping both
			// would open two connections to the same machine and count its bandwidth
			// twice when picking sources.
			const key = `${holder.peerId}:${holder.serviceId}:${holder.externalId}`;

			if (!holders.has(key)) {
				holders.set(key, holder);
			}
		}

		// Friends first: a direct link is faster, already authenticated, and does not
		// spend somebody else's connection relaying for us.
		return [...holders.values()].sort((left, right) =>
			left.trust === right.trust ? 0 : left.trust === PeerTrust.FRIEND ? -1 : 1,
		);
	}

	/**
	 * Stamp an answer with who it came through.
	 *
	 * A peer reporting its own holdings is a friend; anything else it reports is one
	 * hop further out, whatever the answer claims about itself. Taking the far end's
	 * word for the trust level would let one peer promote an arbitrary machine to
	 * friend.
	 */
	private _attribute(holders: ContentHolder[], via: CataloguePeer): ContentHolder[] {
		return holders.map((holder) => {
			const isSelf = holder.peerId === via.id || holder.peerId === '';

			return {
				...holder,
				peerId: isSelf ? via.id : holder.peerId,
				peerName: isSelf ? via.name : (holder.peerName ?? 'unknown'),
				trust: isSelf ? PeerTrust.FRIEND : PeerTrust.FRIEND_OF_FRIEND,
				viaPeerId: isSelf ? null : via.id,
			};
		});
	}
}
