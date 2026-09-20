import {
	PeerCapability,
	PeerTrust,
	ShareVisibility,
	type CatalogueEntry,
	type PeerLibrary,
} from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PeerLinkService } from './peer-link.service';

/**
 * How many pages of a peer's catalogue one import will walk.
 *
 * A ceiling rather than a trust: the far end decides when its pages stop, and a
 * gateway that answers a full page forever — by accident or on purpose — would
 * otherwise keep this loop running for as long as it cared to. Five hundred rows a
 * page puts the cap at a quarter of a million items, which is more than anybody
 * shares and far less than forever.
 */
const MAX_CATALOGUE_PAGES = 500;

/** The subset of a share policy this service decides on. */
export interface CataloguePolicy {
	libraryId: string;
	visibility: ShareVisibility;
	allowedPeerIds: string[];
	deniedPeerIds: string[];
	/**
	 * Bytes per second this library will serve. Zero means no cap of its own.
	 *
	 * It exists alongside the global upload limit so somebody can share one collection
	 * generously and another sparingly, without that decision being all-or-nothing for
	 * their whole line.
	 */
	rateLimit: number;
}

export interface CataloguePeer {
	id: string;
	name: string;
	trust: PeerTrust;
	/** The friend who introduced them, for a friend of a friend. */
	viaPeerId: string | null;
	/**
	 * How far introductions through this peer may travel, or null for the gateway's
	 * own ceiling. See `Peer.maxDepth`.
	 */
	maxDepth?: number | null;
}

/** Somebody who says they hold a given file. */
export interface ContentHolder {
	peerId: string;
	peerName: string;
	serviceId: string;
	externalId: string;
	size: number | null;
	trust: PeerTrust;
	/**
	 * How many hops away they are, counted from us. 1 is a friend we linked to.
	 *
	 * Computed here from who relayed the answer, never taken from the answer itself:
	 * a peer that could state its own distance could state 1 and promote an arbitrary
	 * machine to a direct friend. What the far end says is how far a holder is *from
	 * them*, and our hop is added to it.
	 */
	depth: number;
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
	 * A library is either shared or it is not. There was a middle setting once — show
	 * the titles, refuse the files — and it was dropped: seeing something you cannot
	 * have is not a feature, and anybody who does not want to serve a library simply
	 * does not share it.
	 */
	public filterForPeer(
		entries: CatalogueEntry[],
		policies: CataloguePolicy[],
		peer: CataloguePeer,
	): CatalogueEntry[] {
		const byLibrary = new Map(policies.map((policy) => [policy.libraryId, policy]));

		return entries.flatMap((entry) => {
			// A row that names no library cannot be matched against a policy, and the
			// rule below decides the rest: no policy means nothing was shared.
			const policy = entry.libraryId ? byLibrary.get(entry.libraryId) : undefined;

			// No policy at all means nothing was shared. Defaulting to visible would
			// expose a library the moment somebody links, which is the wrong default
			// exactly once.
			if (!policy || !this.isVisible(policy, peer)) {
				return [];
			}

			return [entry];
		});
	}

	/**
	 * Which of their libraries this peer shares with us.
	 *
	 * Empty for a peer that does not advertise the capability, and that is a fallback
	 * rather than a failure: a gateway from before this method existed answers "not
	 * supported" and its catalogue is still perfectly good. The caller files those rows
	 * into one library instead of three, which is exactly what it had before.
	 */
	public async fetchLibraries(peerId: string): Promise<PeerLibrary[]> {
		if (!this._links.supports(peerId, PeerCapability.LIBRARIES)) {
			return [];
		}

		const answer = await this._links
			.request<{ libraries?: PeerLibrary[] }>(peerId, 'catalogue.libraries', {})
			.catch((error: unknown) => {
				this._logger.warn(`Peer ${peerId} did not answer its libraries: ${String(error)}`);

				return { libraries: [] };
			});

		return (answer.libraries ?? []).filter((library) => typeof library?.externalId === 'string');
	}

	/**
	 * What a linked peer exposes to us, as they have already filtered it.
	 *
	 * Paged all the way through rather than asked once, because one answer carries a
	 * page and the page size is the far end's decision. Asking once and stopping was
	 * survivable only while nothing called this: it silently imported the first few
	 * hundred rows of a library and reported the rest as missing, which reads as a
	 * friend who deleted half their series.
	 *
	 * A page that fails ends the walk with what was collected instead of throwing. Half
	 * a catalogue is worth having — the next refresh fills the rest — and a link that
	 * drops in the middle of an import must not lose the pages that already crossed.
	 */
	public async fetchCatalogue(
		peerId: string,
		query: { since?: string | null; libraryId?: string | null } = {},
	): Promise<CatalogueEntry[]> {
		const entries: CatalogueEntry[] = [];

		for (let page = 1; page <= MAX_CATALOGUE_PAGES; page += 1) {
			const answer = await this._links
				.request<{ entries?: CatalogueEntry[] }>(peerId, 'catalogue.list', { ...query, page })
				.catch((error: unknown) => {
					this._logger.warn(`Peer ${peerId} did not answer the catalogue: ${String(error)}`);

					return null;
				});

			const rows = answer?.entries ?? [];

			entries.push(...rows);

			// An empty page is the end, and it is the only honest stop: the page size is
			// the far end's decision, so a short page cannot be told from a full one
			// without asking them what theirs is. A peer holding an exact multiple of
			// their page size costs one extra round trip and nothing else.
			if (answer === null || rows.length === 0) {
				break;
			}
		}

		return entries;
	}

	/**
	 * Everybody who holds a given file, out to the configured number of hops.
	 *
	 * The hops past the first are what make the swarm worth having: a friend's friend
	 * may hold the same episode, and their bandwidth is as good as anybody's. They are
	 * asked through the friend who knows them rather than directly — we have no link
	 * to them and no business opening one — and the answer is tagged with who vouched
	 * and how far away they are.
	 *
	 * Each friend is asked for a budget of their own, `maxDepth` on their row falling
	 * back to the gateway ceiling. That is the point of the per-peer override: one
	 * friend runs a gateway for a household and another for a club of forty, and
	 * widening the reach for the first should not widen it for the second.
	 *
	 * The budget sent is one less than the limit, because the friend being asked is
	 * already the first hop. Sending the limit itself is the obvious off-by-one here,
	 * and it is invisible in testing — it simply reaches one circle further than
	 * anybody asked for.
	 */
	public async findHolders(
		contentId: string,
		peers: CataloguePeer[],
		options: { maxDepth: number },
	): Promise<ContentHolder[]> {
		const holders = new Map<string, ContentHolder>();
		const friends = peers.filter((peer) => peer.trust === PeerTrust.FRIEND);
		const limitFor = (peer: CataloguePeer): number =>
			Math.max(1, peer.maxDepth ?? options.maxDepth);

		const answers = await Promise.all(
			friends.map(async (peer) => {
				if (!this._links.isLinked(peer.id)) {
					return [];
				}

				return this._links
					.request<{ holders?: ContentHolder[] }>(peer.id, 'catalogue.holders', {
						contentId,
						// Asked for rather than assumed, so a peer whose own limit is
						// shorter than ours simply answers with fewer holders. A budget
						// enforced only on our side would stop us listing distant
						// holders while our own announcements kept travelling.
						depth: limitFor(peer) - 1,
					})
					.then((answer) => this._attribute(answer.holders ?? [], peer))
					.catch(() => [] as ContentHolder[]);
			}),
		);

		for (const holder of answers.flat()) {
			// Checked again on the way in. The budget was a request, and a peer that
			// ignores it — through a bug or on purpose — must not be able to widen our
			// circle by answering with more than was asked for.
			if (holder.depth > options.maxDepth) {
				continue;
			}

			// The same file behind two friends is one source, not two: keeping both
			// would open two connections to the same machine and count its bandwidth
			// twice when picking sources. The nearer attribution wins, because that is
			// the shorter path to the same bytes.
			const key = `${holder.peerId}:${holder.serviceId}:${holder.externalId}`;
			const known = holders.get(key);

			if (known === undefined || holder.depth < known.depth) {
				holders.set(key, holder);
			}
		}

		// Nearest first: a direct link is faster, already authenticated, and does not
		// spend somebody else's connection relaying for us.
		return [...holders.values()].sort((left, right) => left.depth - right.depth);
	}

	/**
	 * Stamp an answer with who it came through, and how far away that puts it.
	 *
	 * A peer reporting its own holdings is one hop; anything else it reports is at
	 * least two, whatever the answer claims about itself. What the far end sends is a
	 * distance measured from *them*, so our own hop is added to it — and a missing or
	 * nonsensical distance is read as their nearest possible, which is the reading
	 * that cannot be used to claim a shorter path than actually exists.
	 *
	 * Taking the far end's word for any of this would let one peer promote an
	 * arbitrary machine to a direct friend, which is the whole reason it is recomputed
	 * here rather than trusted.
	 */
	private _attribute(holders: ContentHolder[], via: CataloguePeer): ContentHolder[] {
		return holders.map((holder) => {
			const isSelf = holder.peerId === via.id || holder.peerId === '';
			const reported = Number.isFinite(holder.depth) ? Math.trunc(holder.depth) : 1;
			const depth = isSelf ? 1 : 1 + Math.max(1, reported);

			return {
				...holder,
				peerId: isSelf ? via.id : holder.peerId,
				peerName: isSelf ? via.name : (holder.peerName ?? 'unknown'),
				depth,
				trust: depth === 1 ? PeerTrust.FRIEND : PeerTrust.FRIEND_OF_FRIEND,
				viaPeerId: isSelf ? null : via.id,
			};
		});
	}
}
