import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import {
	ErrorKey,
	EventName,
	PeerDirection,
	PeerStatus,
	PeerTrust,
	type MediaService,
	type AddPeerRequest,
	type Peer,
	type PeerIdentity,
	type PeerInvite,
} from '@mcs/shared';
import {
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import type { Peer as PeerEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaServiceRepository,
	PeerInviteRepository,
	PeerRepository,
} from '@/repositories';
import type { PeerCredentialVerifier } from '@/security';
import { EventGatewayService, PeerLinkService, SettingsService } from '@/services';
import { toMediaService, toPeer } from './mappers';

/** Default life of an invitation. Long enough to send, short enough to forget about. */
export const DEFAULT_INVITE_TTL_MINUTES = 60;

/** `mcs://invite/<code>?fingerprint=…&rendezvous=…&secret=…&exp=…` */
const INVITE_SCHEME = 'mcs://invite/';

/**
 * Peers, and the invitations that create them.
 *
 * The interesting rule is the invitation. It is one shot and it expires, and both
 * halves are enforced here rather than trusted to the far end: an invitation that
 * could be replayed is a credential lying in somebody's chat log, and whoever finds
 * it becomes a friend as far as the gateway is concerned.
 *
 * An invitation this gateway never issued is still accepted — that is the normal
 * direction, since the code was minted by whoever is inviting us — and it is recorded
 * as spent the moment it is used, so the second attempt with the same code fails like
 * any other used one. Without that row there would be nothing anywhere able to say
 * that a code had already been redeemed.
 */
@Injectable()
export class PeerManager implements PeerCredentialVerifier {
	private readonly _logger = new Logger(PeerManager.name);

	public constructor(
		private readonly _peers: PeerRepository,
		private readonly _invites: PeerInviteRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _items: MediaItemRepository,
		private readonly _links: PeerLinkService,
		private readonly _settings: SettingsService,
		private readonly _events: EventGatewayService,
	) {}

	public async list(): Promise<Peer[]> {
		const peers = await this._peers.find({ order: { name: 'ASC' } });

		return Promise.all(peers.map((peer) => this._present(peer, peers)));
	}

	public async read(id: string): Promise<Peer> {
		return this._present(await this._require(id));
	}

	/**
	 * What you hand to a friend so they can find you.
	 *
	 * The fingerprint is the identity, never the address: a friend behind a dynamic IP
	 * is the same friend tomorrow. `directReachable` is worth showing — a gateway whose
	 * port is not forwarded works, but every transfer goes through a relay, and it is
	 * better to know that before wondering why it is slow.
	 */
	public async identity(): Promise<PeerIdentity> {
		const rendezvous = await this._settings.getValue('rendezvousUrl');

		return this._links.identity(hostname(), rendezvous);
	}

	/**
	 * Mint an invitation.
	 *
	 * Only the hash of the secret is stored. The secret itself exists in the URL and
	 * nowhere else, so a stolen database hands over no usable invitations.
	 */
	public async createInvite(ttlMinutes = DEFAULT_INVITE_TTL_MINUTES): Promise<PeerInvite> {
		const code = randomBytes(9).toString('base64url');
		const secret = randomBytes(24).toString('base64url');
		const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
		const rendezvous = (await this._settings.getValue('rendezvousUrl')) ?? '';
		const identity = this._links.identity(hostname(), rendezvous);

		await this._invites.save(
			this._invites.create({ code, secretHash: this._hash(secret), expiresAt }),
		);

		return {
			code,
			fingerprint: identity.fingerprint,
			rendezvous,
			expiresAt: expiresAt.toISOString(),
			url: this._encode({
				code,
				fingerprint: identity.fingerprint,
				rendezvous,
				secret,
				expiresAt,
			}),
		};
	}

	/**
	 * Redeem an invitation and link to whoever issued it.
	 *
	 * A used or expired code fails with its own key rather than linking anyway: those
	 * are the two cases somebody will hit, and "invalid" for both would leave them
	 * re-pasting a code that will never work again.
	 */
	public async accept(invite: string, name?: string): Promise<Peer> {
		const parsed = this._decode(invite);
		const known = await this._invites.findByCode(parsed.code);

		if (known !== null) {
			if (known.usedAt !== null) {
				throw new UnauthorizedException(ErrorKey.PEER_INVITE_INVALID);
			}

			if (known.expiresAt.getTime() <= Date.now()) {
				throw new UnauthorizedException(ErrorKey.PEER_INVITE_EXPIRED);
			}

			if (!this._matches(known.secretHash, parsed.secret)) {
				throw new UnauthorizedException(ErrorKey.PEER_INVITE_INVALID);
			}
		} else {
			// An invitation somebody else minted. Its expiry is the only thing it carries
			// that we can check, and a code with no fingerprint names nobody to link to.
			if (parsed.fingerprint === null) {
				throw new UnauthorizedException(ErrorKey.PEER_INVITE_INVALID);
			}

			if (parsed.expiresAt === null || parsed.expiresAt.getTime() <= Date.now()) {
				throw new UnauthorizedException(ErrorKey.PEER_INVITE_EXPIRED);
			}
		}

		const fingerprint = parsed.fingerprint ?? known?.code ?? parsed.code;
		const existing = await this._peers.findByFingerprint(fingerprint);
		const peer = await this._peers.save(
			existing === null
				? this._peers.create({
					name: name ?? this._defaultName(fingerprint),
					fingerprint,
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
				})
				: Object.assign(existing, {
					name: name ?? existing.name,
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
				}),
		);

		// Burned whether we minted it or not: one code, one link, and the row is the
		// only thing that can say a code has already been redeemed.
		await (known === null
			? this._invites.save(
				this._invites.create({
					code: parsed.code,
					secretHash: this._hash(parsed.secret ?? ''),
					expiresAt: parsed.expiresAt ?? new Date(),
					usedAt: new Date(),
					peerId: peer.id,
				}),
			)
			: this._invites.markUsed(known.id, peer.id));

		this._emit(peer);

		return this._present(peer);
	}

	/**
	 * Link by fingerprint, with nothing secret in transit.
	 *
	 * The invitation is the convenience; this is the plain form of the same thing. What
	 * a link needs is that each side knows the other's public key fingerprint and has
	 * said once that it trusts it. Here you paste your friend's, they get a request
	 * showing yours, and they accept — which costs one more action and buys three
	 * things a code cannot: nothing secret goes through a chat log, nothing expires,
	 * and whoever accepts sees exactly who is asking.
	 *
	 * The row is created immediately and stays `PENDING` until the far end answers. It
	 * has to exist before then: without it the interface has nothing to show for the
	 * thing somebody just did, and a request nobody can see is a request nobody chases.
	 */
	public async add(request: AddPeerRequest): Promise<Peer> {
		const fingerprint = request.fingerprint.trim();

		if (fingerprint === '') {
			throw new UnauthorizedException(ErrorKey.PEER_INVITE_INVALID);
		}

		const existing = await this._peers.findByFingerprint(fingerprint);

		// Somebody adding a peer who already asked us is answering, not asking. Treating
		// it as a fresh outgoing request would leave two halves of one link pointing at
		// each other and neither of them settled.
		if (existing !== null && existing.direction === PeerDirection.INCOMING) {
			return this._present(await this._settle(existing));
		}

		const peer = await this._peers.save(
			existing === null
				? this._peers.create({
					name: request.name ?? this._defaultName(fingerprint),
					fingerprint,
					address: request.address ?? null,
					status: PeerStatus.PENDING,
					direction: PeerDirection.OUTGOING,
					trust: PeerTrust.FRIEND,
				})
				: Object.assign(existing, {
					name: request.name ?? existing.name,
					address: request.address ?? existing.address,
					status: existing.status === PeerStatus.BLOCKED ? existing.status : PeerStatus.PENDING,
					direction: PeerDirection.OUTGOING,
				}),
		);

		this._emit(peer);

		return this._present(peer);
	}

	/**
	 * Accept a request somebody made of us.
	 *
	 * Only an incoming one: approving a request we made ourselves would mean declaring
	 * a link the other side has not agreed to, and the first pull would then fail with
	 * an authentication error rather than with the honest answer, which is that they
	 * have not answered yet.
	 */
	public async approve(id: string): Promise<Peer> {
		return this._present(await this._settle(await this._require(id)));
	}

	/**
	 * Turn a pending row into a link.
	 *
	 * Takes the row rather than an identifier, because both callers already hold it and
	 * a second read would be a query bought for nothing — and, in a test, a second stub
	 * to remember.
	 */
	private async _settle(peer: PeerEntity): Promise<PeerEntity> {
		if (peer.status === PeerStatus.BLOCKED) {
			throw new UnauthorizedException(ErrorKey.PEER_REJECTED);
		}

		peer.status = PeerStatus.LINKED;
		peer.direction = null;
		peer.trust = PeerTrust.FRIEND;

		const saved = await this._peers.save(peer);

		this._emit(saved);

		return saved;
	}

	/**
	 * A gateway we do not know announcing itself.
	 *
	 * It creates a pending row and nothing more: no catalogue, no bytes, no trust. The
	 * only thing an unknown peer can do here is ask, and somebody has to say yes before
	 * anything else becomes possible.
	 */
	public async requested(fingerprint: string, name: string, address: string | null): Promise<void> {
		const existing = await this._peers.findByFingerprint(fingerprint);

		if (existing !== null && existing.status === PeerStatus.BLOCKED) {
			// Blocked means blocked. Answering differently would let somebody learn they
			// are blocked by watching what happens, which is more than they should know.
			return;
		}

		// A request answering one of ours settles it: both sides have now named each
		// other, which is exactly what a link is.
		if (existing !== null && existing.direction === PeerDirection.OUTGOING) {
			await this._settle(existing);

			return;
		}

		const peer = await this._peers.save(
			existing ??
				this._peers.create({
					name: name || this._defaultName(fingerprint),
					fingerprint,
					address,
					status: PeerStatus.PENDING,
					direction: PeerDirection.INCOMING,
					trust: PeerTrust.FRIEND,
				}),
		);

		this._emit(peer);
	}

	public async rename(id: string, name: string): Promise<Peer> {
		const peer = await this._require(id);

		peer.name = name;

		return this._present(await this._peers.save(peer));
	}

	/**
	 * Refuse a peer, now rather than at the next restart.
	 *
	 * Blocking is the answer to somebody abusing the link, so the live connection goes
	 * with the status — leaving the socket open would let whatever prompted the block
	 * carry on until the process is restarted.
	 */
	public async block(id: string): Promise<Peer> {
		const peer = await this._require(id);

		this._links.disconnect(peer.id);
		await this._peers.setStatus(peer.id, PeerStatus.BLOCKED);

		return this.read(id);
	}

	/**
	 * Unblocked, but not reconnected.
	 *
	 * `UNREACHABLE` rather than `LINKED`: no socket is open, and claiming a link that
	 * has not been established would show a peer as connected until somebody tried to
	 * pull something from it.
	 */
	public async unblock(id: string): Promise<Peer> {
		const peer = await this._require(id);

		await this._peers.setStatus(peer.id, PeerStatus.UNREACHABLE);

		return this.read(id);
	}

	public async remove(id: string): Promise<void> {
		const peer = await this._require(id);

		this._links.disconnect(peer.id);
		await this._peers.delete({ id: peer.id });
	}

	/** Open the link now, so a screen can say whether it is direct or relayed. */
	public async connect(id: string): Promise<Peer> {
		const peer = await this._peers.findWithPublicKey(id);

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		const rendezvous = await this._settings.getValue('rendezvousUrl');

		try {
			const state = await this._links.connect(
				{
					id: peer.id,
					name: peer.name,
					fingerprint: peer.fingerprint,
					address: peer.address,
					publicKey: peer.publicKey,
				},
				rendezvous,
			);

			await this._peers.setStatus(peer.id, PeerStatus.LINKED, state.mode, state.address);
		} catch (error) {
			this._logger.warn(`Peer ${peer.name} could not be reached: ${String(error)}`);

			await this._peers.setStatus(peer.id, PeerStatus.UNREACHABLE);
			this._emit(await this._require(peer.id));

			throw new ServiceUnavailableException(ErrorKey.PEER_UNREACHABLE);
		}

		const refreshed = await this._require(peer.id);

		this._emit(refreshed);

		return this._present(refreshed);
	}

	public async services(id: string): Promise<MediaService[]> {
		await this._require(id);

		const services = await this._services.findByPeer(id);

		return Promise.all(
			services.map(async (service) =>
				toMediaService(service, {
					libraryCount: 0,
					itemCount: await this._items.countByService(service.id),
				}),
			),
		);
	}

	/**
	 * Prove that a peer credential belongs to the peer it names.
	 *
	 * The token is a signature over `<their fingerprint>:<ours>`, which is exactly what
	 * the link negotiation signs — so a peer that can open a link can call these routes
	 * and nothing else can. A peer whose public key we never learned cannot be checked
	 * at all, and an unchecked peer route hands the catalogue to whoever guesses a
	 * fingerprint, which is public by design. So that answers false.
	 */
	public async verify(fingerprint: string, token: string): Promise<boolean> {
		const peer = await this._peers.findByFingerprint(fingerprint);

		if (peer === null || peer.status !== PeerStatus.LINKED) {
			return false;
		}

		const withKey = await this._peers.findWithPublicKey(peer.id);

		if (withKey === null || withKey.publicKey === null) {
			return false;
		}

		return this._links.verify(
			withKey.publicKey,
			`${fingerprint}:${this._links.fingerprint}`,
			token,
		);
	}

	private _encode(invite: {
		code: string;
		fingerprint: string;
		rendezvous: string;
		secret: string;
		expiresAt: Date;
	}): string {
		const query = new URLSearchParams({
			fingerprint: invite.fingerprint,
			rendezvous: invite.rendezvous,
			secret: invite.secret,
			exp: invite.expiresAt.toISOString(),
		});

		return `${INVITE_SCHEME}${invite.code}?${query.toString()}`;
	}

	/**
	 * A whole URL or a bare code — both are accepted.
	 *
	 * Making somebody extract the code from a link they were sent is a pointless step
	 * that will be got wrong, and a code pasted with its query string still attached is
	 * what actually arrives.
	 */
	private _decode(invite: string): {
		code: string;
		fingerprint: string | null;
		rendezvous: string | null;
		secret: string | null;
		expiresAt: Date | null;
	} {
		const trimmed = invite.trim();

		if (!trimmed.startsWith(INVITE_SCHEME)) {
			return { code: trimmed, fingerprint: null, rendezvous: null, secret: null, expiresAt: null };
		}

		const [path, query] = trimmed.slice(INVITE_SCHEME.length).split('?');
		const parameters = new URLSearchParams(query ?? '');
		const expiry = parameters.get('exp');
		const parsedExpiry = expiry === null ? null : new Date(expiry);

		return {
			code: path,
			fingerprint: parameters.get('fingerprint'),
			rendezvous: parameters.get('rendezvous'),
			secret: parameters.get('secret'),
			expiresAt: parsedExpiry !== null && !Number.isNaN(parsedExpiry.getTime()) ? parsedExpiry : null,
		};
	}

	private _hash(secret: string): string {
		return createHash('sha256').update(secret).digest('hex');
	}

	/** Compared in constant time: the comparison itself must not leak the secret. */
	private _matches(expected: string, presented: string | null): boolean {
		const left = Buffer.from(expected);
		const right = Buffer.from(this._hash(presented ?? ''));

		return left.length === right.length && timingSafeEqual(left, right);
	}

	private _defaultName(fingerprint: string): string {
		return `peer-${fingerprint.slice(0, 8)}`;
	}

	private _emit(peer: PeerEntity): void {
		this._events.emit(EventName.PEER_STATUS, {
			id: peer.id,
			status: peer.status,
			linkMode: peer.linkMode,
			lastSeenAt: peer.lastSeenAt?.toISOString() ?? null,
		});
	}

	private async _present(peer: PeerEntity, known?: PeerEntity[]): Promise<Peer> {
		const services = await this._services.findByPeer(peer.id);
		const introducer =
			peer.viaPeerId === null
				? null
				: ((known ?? []).find((candidate) => candidate.id === peer.viaPeerId) ??
					(await this._peers.findOne({ where: { id: peer.viaPeerId } })));

		let sharedItemCount = 0;

		for (const service of services) {
			sharedItemCount += await this._items.countByService(service.id);
		}

		return toPeer(peer, {
			viaPeerName: introducer?.name ?? null,
			serviceCount: services.length,
			sharedItemCount,
		});
	}

	private async _require(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
