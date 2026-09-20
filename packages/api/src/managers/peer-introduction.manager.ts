import {
	ErrorKey,
	PEER_INTRODUCE_METHOD,
	PeerCapability,
	PeerStatus,
	PeerTrust,
	type Peer,
	type PeerIntroduction,
} from '@mcs/shared';
import {
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import type { Peer as PeerEntity } from '@/entities';
import { BannedPeerRepository, PeerRepository } from '@/repositories';
import { PeerLinkService, SettingsService } from '@/services';
import { toPeer } from './mappers';
import { PeerManager } from './peer.manager';

/**
 * Being introduced to a gateway we have never met, and letting go of it afterwards.
 *
 * This is the asking half of the feature; `PeerExchangeManager.introduce` is the
 * answering half and `PeerManager.admit` is the receiving one. The shape is the whole
 * point of the design: the friend in the middle answers one small request and then has
 * nothing more to do with the transfer. They do not carry a byte, they are not asked
 * again when the link drops, and they can go offline the moment the two ends have said
 * hello to each other.
 *
 * **What it deliberately does not do is announce anything.** The holder is named by
 * the identifier the middle gateway used when it told us about them, which is their
 * own row identifier and means nothing anywhere else. Publishing a stable identifier
 * for a source so that a puller could find it without being introduced was considered
 * and put off: it is a different thing with different consequences — a name that
 * travels is a name that can be collected — and none of it is needed to stop relaying.
 *
 * The link it opens is an ordinary peer link. It is direct when either end can open a
 * socket, and it falls back to being carried by the same friend in the middle when
 * neither can, exactly as a link between two friends does — see
 * `PeerLinkService.connect`, which is the one ladder both cases climb.
 */
@Injectable()
export class PeerIntroductionManager {
	private readonly _logger = new Logger(PeerIntroductionManager.name);

	public constructor(
		private readonly _peers: PeerRepository,
		private readonly _bans: BannedPeerRepository,
		private readonly _links: PeerLinkService,
		private readonly _settings: SettingsService,
		/**
		 * Removing a peer is one operation with one owner.
		 *
		 * It cancels the retry timer, closes the link and takes the services, libraries
		 * and matches the link brought with it. A second implementation here would be a
		 * second answer to "what does forgetting a peer mean", and the two would disagree
		 * the first time either gained a step.
		 */
		private readonly _manager: PeerManager,
	) {}

	/**
	 * Get introduced to somebody behind a friend, and open a link straight to them.
	 *
	 * `holderId` is what the friend in the middle called them — their row identifier,
	 * which is what `catalogue.holders` already answers with. It is meaningless to us
	 * and is handed back untouched, so nothing here has to hold a second kind of name
	 * for a gateway.
	 *
	 * A holder we already know is returned as they are, without asking anybody: a token
	 * is a way to meet a stranger, and using one to reopen a link to an existing friend
	 * would rewrite a relationship somebody chose from a statement made by a third
	 * party.
	 */
	public async reach(viaPeerId: string, holderId: string): Promise<Peer> {
		const via = await this._require(viaPeerId);

		if (!this._links.isLinked(via.id)) {
			throw new ServiceUnavailableException(ErrorKey.PEER_UNREACHABLE);
		}

		// The rule the whole versioning scheme rests on: a feature is used because the
		// far end advertised it. A gateway from before introductions existed would
		// answer "method not supported", and reporting that as a friend refusing to
		// introduce us would be a fact about their release read as a decision.
		if (!this._links.supports(via.id, PeerCapability.INTRODUCE)) {
			throw new NotFoundException(ErrorKey.PEER_INTRODUCTION_REFUSED);
		}

		const introduction = await this._ask(via.id, holderId);
		const existing = await this._peers.findByFingerprint(introduction.fingerprint);

		if (existing !== null && existing.status !== PeerStatus.PENDING) {
			return this._connect(existing, introduction, { created: false, via: via.id });
		}

		if (await this._bans.isBanned(introduction.fingerprint)) {
			// A key we refused does not come back through a friend, which is the whole
			// reason the ban list outlives the peer row.
			throw new ConflictException(ErrorKey.PEER_BANNED);
		}

		const keep = (await this._settings.get()).keepDiscoveredPeers;
		/*
		 * A row that already exists is used as it stands, and that includes a pending
		 * one — somebody who asked us and has not been answered yet.
		 *
		 * It is deliberately not rewritten as a discovered peer. The row predates this
		 * introduction and is somebody's decision to make; marking it temporary would
		 * have `release` delete a request that was waiting for an answer, and a failed
		 * dial below would take it with it.
		 */
		const peer = await this._peers.save(
			existing ??
				this._peers.create({
					name: `peer-${introduction.fingerprint.slice(0, 8)}`,
					fingerprint: introduction.fingerprint,
					address: introduction.address,
					// Not linked until the socket is open, and not pending either: pending
					// is a request waiting on somebody's decision, and nobody is deciding
					// anything here. The row exists for the seconds the dial takes because
					// a link is keyed by a peer identifier and there has to be one.
					status: PeerStatus.UNREACHABLE,
					direction: null,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					depth: introduction.depth,
					viaPeerId: via.id,
					discovered: !keep,
				}),
		);

		return this._connect(peer, introduction, { created: existing === null, via: via.id });
	}

	/**
	 * The transfer is over. Close a link that was only opened for it.
	 *
	 * A peer somebody asked to keep is left exactly as it is, link and all — that is
	 * what `Settings.keepDiscoveredPeers` means, and half the value of the setting is
	 * that this call is safe to make either way. The caller does not have to know which
	 * kind of peer it has.
	 */
	public async release(peerId: string): Promise<void> {
		const peer = await this._peers.findOne({ where: { id: peerId } });

		if (peer === null || !peer.discovered) {
			return;
		}

		// Closed before it is forgotten, and through the manager, so that the drop is
		// recorded as one we made: a link that simply vanished would be scheduled for a
		// reconnection to a row that no longer exists.
		await this._manager.remove(peer.id);
		this._logger.log(`Closed the temporary link with ${peer.name}`);
	}

	private async _ask(viaPeerId: string, holderId: string): Promise<PeerIntroduction> {
		const answer = await this._links
			.request<Partial<PeerIntroduction>>(viaPeerId, PEER_INTRODUCE_METHOD, { holderId })
			.catch((error: unknown) => {
				this._logger.warn(`No introduction from peer ${viaPeerId}: ${String(error)}`);

				return null;
			});

		if (!answer?.token || !answer.fingerprint) {
			// One key for "they will not" and for "they cannot", because from here they
			// are the same fact: there is no route that way. The reason is theirs to
			// know — a refusal names their limits and their friends.
			throw new NotFoundException(ErrorKey.PEER_INTRODUCTION_REFUSED);
		}

		return {
			token: answer.token,
			fingerprint: answer.fingerprint,
			address: answer.address ?? null,
			expiresAt: answer.expiresAt ?? new Date().toISOString(),
			// Their arithmetic, floored at two: a holder introduced by a friend is at
			// least two hops away whatever the answer claims, and a gateway that stated
			// one would be promoting a stranger to somebody we chose.
			depth: Math.max(2, Math.trunc(answer.depth ?? 0)),
		};
	}

	/**
	 * Dial the holder, with the token on the upgrade.
	 *
	 * The ladder is the ordinary one — the address if we were given one, then the
	 * friend in the middle, then that same friend carrying the bytes when neither end
	 * can be dialled — because a gateway behind a router does not become reachable by
	 * having been introduced. What the token changes is only that the far end will
	 * accept a socket from somebody it has never heard of.
	 *
	 * The introducer is named alongside the token so the ladder does not ask them for a
	 * second one it already holds, and so the last rung falls back through that same
	 * friend rather than through somebody who never agreed to anything.
	 *
	 * A row this call created and could not connect is removed again. Leaving it would
	 * put a gateway in the peers list that nobody invited, that was never reached, and
	 * that the reconnection loop would go on dialling.
	 */
	private async _connect(
		peer: PeerEntity,
		introduction: PeerIntroduction,
		{ created, via }: { created: boolean; via: string },
	): Promise<Peer> {
		const withKey = await this._peers.findWithPublicKey(peer.id);

		try {
			const state = await this._links.connect(
				{
					id: peer.id,
					name: peer.name,
					fingerprint: peer.fingerprint,
					address: introduction.address ?? peer.address,
					publicKey: withKey?.publicKey ?? null,
				},
				{ introduction: introduction.token, via, introducers: [via] },
			);

			await this._peers.setStatus(peer.id, PeerStatus.LINKED, state.mode, state.address);

			if (state.protocol !== null) {
				await this._peers.recordHandshake(peer.id, {
					nodeId: state.nodeId,
					protocol: state.protocol,
					capabilities: state.capabilities,
				});
			}
		} catch (error) {
			this._logger.warn(`Could not reach ${peer.name} after an introduction: ${String(error)}`);

			if (created) {
				await this._peers.delete({ id: peer.id });
			}

			throw new ServiceUnavailableException(ErrorKey.PEER_UNREACHABLE);
		}

		const linked = await this._peers.findOne({ where: { id: peer.id } });

		return toPeer(linked ?? peer);
	}

	private async _require(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
