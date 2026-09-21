import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import {
	ErrorKey,
	EventName,
	MediaServiceStatus,
	MediaServiceType,
	NotificationEvent,
	PeerDirection,
	MAX_PEER_MAX_DEPTH,
	PeerStatus,
	PeerTrust,
	negotiateProtocol,
	IntroductionRefusal,
	MAX_INTRODUCERS_ASKED,
	type MediaService,
	type AddPeerRequest,
	type BannedPeer,
	type Peer,
	type PeerHandshake,
	type PeerHello,
	type PeerIdentity,
	type PeerInvite,
} from '@mcs/shared';
import {
	ConflictException,
	HttpException,
	Injectable,
	Logger,
	NotFoundException,
	OnApplicationBootstrap,
	OnModuleInit,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
	BannedPeer as BannedPeerEntity,
	MediaService as MediaServiceEntity,
	Peer as PeerEntity,
} from '@/entities';
import {
	BannedPeerRepository,
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerInviteRepository,
	PeerRepository,
} from '@/repositories';
import type { AppConfig } from '@/config';
import type { PeerCredentialVerifier } from '@/security';
import {
	EventGatewayService,
	PeerDialOutcome,
	PeerIntroductionService,
	PeerLinkService,
	PeerReconnectService,
	SettingsService,
	peerBaseUrl,
	type PeerAdmission,
	type PeerCredential,
	type PeerLinkAuthority,
	type PeerRelayGrant,
} from '@/services';
import { toMediaService, toPeer } from './mappers';
import { NotificationManager } from './notification.manager';
import { ServiceManager } from './service.manager';

/**
 * Where a peer's media sits in the order sources are consulted.
 *
 * Behind everything of ours by default, and deliberately so: pulling from a friend
 * costs their upload and somebody else's evening, while reading from a server in the
 * next room costs nothing. It is an ordinary priority on an ordinary service row, so
 * anybody who disagrees can change it on the service — including per run, which is
 * what a sync's own source order is for.
 */
export const PEER_SERVICE_PRIORITY = 500;

/** Default life of an invitation. Long enough to send, short enough to forget about. */
export const DEFAULT_INVITE_TTL_MINUTES = 60;

/** `mcs://invite/<code>?fingerprint=…&address=…&secret=…&exp=…` */
const INVITE_SCHEME = 'mcs://invite/';

/**
 * The parameter this used to be called, still read when an invitation carries it.
 *
 * An invitation lives in somebody's chat window for an hour, and one minted by a
 * gateway on the previous image is a perfectly good invitation — refusing to read its
 * address would turn a rename into a link that silently has nowhere to dial.
 */
const LEGACY_INVITE_ADDRESS_PARAM = 'rendezvous';

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
export class PeerManager
implements PeerCredentialVerifier, PeerLinkAuthority, OnModuleInit, OnApplicationBootstrap {
	private readonly _logger = new Logger(PeerManager.name);

	/** Whether this gateway dials by itself. Off under test; see `PeersConfig`. */
	private readonly _autoConnect: boolean;

	public constructor(
		private readonly _peers: PeerRepository,
		private readonly _bans: BannedPeerRepository,
		private readonly _invites: PeerInviteRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _items: MediaItemRepository,
		private readonly _links: PeerLinkService,
		private readonly _introductions: PeerIntroductionService,
		private readonly _settings: SettingsService,
		private readonly _events: EventGatewayService,
		private readonly _libraries: LibraryRepository,
		private readonly _mediaMatches: MediaMatchRepository,
		private readonly _serviceManager: ServiceManager,
		/**
		 * A request nobody can see is a request nobody chases.
		 *
		 * The peers screen already shows a pending row, and that is exactly the problem:
		 * somebody has to be looking at it. Fire-and-forget, like every other call to
		 * this manager — a friend waiting on an answer must not be able to fail our own
		 * handshake by having an unreachable mail server on our side of it.
		 */
		private readonly _notifications: NotificationManager,
		/**
		 * Holds the retry timers, and decides nothing.
		 *
		 * The split is deliberate: when to try again is a schedule, whether a peer is
		 * still linked and whether a failure was a refusal is a decision, and a service
		 * that read peer rows to answer the second would be a manager with a timer in it.
		 */
		private readonly _reconnects: PeerReconnectService,
		config: ConfigService,
	) {
		this._autoConnect = config.getOrThrow<AppConfig['peers']>('peers').autoConnect;
	}

	/**
	 * Wire the reconnection before anything can drop.
	 *
	 * In `onModuleInit` rather than at bootstrap because the peer gateway accepts
	 * incoming links as soon as the module is up: a listener registered later would
	 * miss the first drop, and that drop would never be retried.
	 */
	public onModuleInit(): void {
		this._reconnects.onDial((peerId) => this._dial(peerId));
		this._links.onLinkLost((peerId) => void this._lost(peerId));
	}

	/**
	 * A link of ours dropped. Dial again, unless the peer was only ever a transfer.
	 *
	 * The two cases are opposite and the distinction has to be made before the retry is
	 * scheduled: an ordinary friend is tried again, further away each time, while a peer
	 * met through an introduction and not kept has just finished — redialling them would
	 * be this gateway chasing a stranger it was never asked to know.
	 */
	private async _lost(peerId: string): Promise<void> {
		if (await this._forgetIfDiscovered(peerId)) {
			return;
		}

		this._logger.log(`Link with peer ${peerId} dropped, retrying`);
		await this._peers.setStatus(peerId, PeerStatus.UNREACHABLE);
		this._reconnects.schedule(peerId);
	}

	/**
	 * Dial every linked peer, in the background, without holding the boot.
	 *
	 * Detached on purpose. A friend whose gateway is switched off takes the whole
	 * connection timeout to fail, and awaiting a dozen of those would leave the
	 * interface unanswerable for minutes after a restart — for peers whose absence
	 * changes nothing about whether this gateway can serve its own library.
	 */
	public onApplicationBootstrap(): void {
		void this._resume();
	}

	/**
	 * What a restart has to undo before it does anything else.
	 *
	 * A peer met through an introduction and not kept lives exactly as long as its
	 * link, and the link did not survive the process. Sweeping those rows first is also
	 * what stops the reconnection loop below adopting them: a temporary peer redialled
	 * at every boot is a link nobody asked for, to somebody nobody invited.
	 */
	private async _resume(): Promise<void> {
		await this._sweepDiscovered();

		if (!this._autoConnect) {
			return;
		}

		await this._dialLinkedPeers();
	}

	/** Rows left behind by a gateway that stopped mid-transfer. */
	private async _sweepDiscovered(): Promise<void> {
		try {
			const discovered = await this._peers.find({ where: { discovered: true } });

			for (const peer of discovered) {
				await this.remove(peer.id);
			}

			if (discovered.length > 0) {
				this._logger.log(`Forgot ${discovered.length} peers kept only for a transfer`);
			}
		} catch (error) {
			// Worth a line and never worth failing a boot over: the cost of a row that
			// outlived its link is a peer in a list, not a broken gateway.
			this._logger.warn(`Could not forget temporary peers: ${String(error)}`);
		}
	}

	private async _dialLinkedPeers(): Promise<void> {
		try {
			const peers = await this._peers.findLinked();

			for (const peer of peers) {
				// Straight to the schedule rather than dialling here, so one unreachable
				// friend cannot delay the next: `schedule` arms a timer and returns.
				this._reconnects.schedule(peer.id);
			}

			if (peers.length > 0) {
				this._logger.log(`Reconnecting to ${peers.length} linked peers`);
			}
		} catch (error) {
			this._logger.warn(`Could not list peers to reconnect to: ${String(error)}`);
		}
	}

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
		return this._links.identity(await this._instanceName());
	}

	/**
	 * What we call ourselves to other people.
	 *
	 * The hostname is the fallback and not the answer: inside a container it is a
	 * random hex string, so a friend's peer list read `d9b90135` where they were
	 * looking for "Living room". A blank setting means nobody chose one, which is
	 * different from choosing an empty name.
	 */
	private async _instanceName(): Promise<string> {
		const chosen = (await this._settings.getValue('instanceName'))?.trim();

		return chosen && chosen.length > 0 ? chosen : hostname();
	}


	/**
	 * Mint an invitation.
	 *
	 * Only the hash of the secret is stored. The secret itself exists in the URL and
	 * nowhere else, so a stolen database hands over no usable invitations.
	 *
	 * **The address it carries is this gateway's own**, and that is the whole reason
	 * this one address survives while the rendezvous does not. Peers are introduced by
	 * the friends they already have — except the very first one, where by definition
	 * there is nobody in the middle, and the two ends have never heard of each other.
	 * An invitation is what covers exactly that case: it is handed over out of band, it
	 * is signed, it is one shot and it expires, and the address in it is where *we* are.
	 * It is not a third party's directory, it names nobody but the sender, and there is
	 * nothing here for anybody to run or configure beyond the address at which this
	 * gateway already answers. Empty when `publicUrl` is unset, which is an invitation
	 * that names a gateway without saying where to find it — the interface says so on
	 * the setting rather than letting somebody discover it by sending one.
	 */
	public async createInvite(ttlMinutes = DEFAULT_INVITE_TTL_MINUTES): Promise<PeerInvite> {
		const code = randomBytes(9).toString('base64url');
		const secret = randomBytes(24).toString('base64url');
		const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
		const address = (await this._settings.getValue('publicUrl')) ?? '';
		const identity = this._links.identity(await this._instanceName());

		await this._invites.save(
			this._invites.create({ code, secretHash: this._hash(secret), expiresAt }),
		);

		return {
			code,
			fingerprint: identity.fingerprint,
			address,
			expiresAt: expiresAt.toISOString(),
			url: this._encode({
				code,
				fingerprint: identity.fingerprint,
				address,
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

		// A valid invitation is not a way around the list. Redeeming one from a banned
		// key would link them outright — no pending row, nothing to approve — which
		// makes this the one path where the ban has to be checked before anything is
		// written rather than merely before a link is granted.
		if (await this._bans.isBanned(fingerprint)) {
			throw new ConflictException(ErrorKey.PEER_BANNED);
		}

		const existing = await this._peers.findByFingerprint(fingerprint);
		/*
		 * The address in the invitation is kept, and it is the only thing that makes a
		 * first link possible at all.
		 *
		 * Two gateways that have never met have no friend in the middle to introduce
		 * them, so there is nothing else to dial: without this the row would be linked,
		 * addressless, and would sit unreachable forever while looking accepted. An
		 * address we already hold wins, because it was learned from a handshake that
		 * actually succeeded and this one is somebody's setting.
		 */
		const peer = await this._peers.save(
			existing === null
				? this._peers.create({
					name: name ?? this._defaultName(fingerprint),
					fingerprint,
					address: parsed.address || null,
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
				})
				: Object.assign(existing, {
					name: name ?? existing.name,
					address: existing.address ?? (parsed.address || null),
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

		await this._adoptServices(peer);
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

		// Told plainly, because this direction is us adding them: somebody has
		// forgotten that this key is on the list, and the answer they need is that it
		// is. The opposite direction — a banned key asking us — is never told, so that
		// nobody can discover they are banned by watching what happens.
		if (await this._bans.isBanned(fingerprint)) {
			throw new ConflictException(ErrorKey.PEER_BANNED);
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
					status: PeerStatus.PENDING,
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
	 *
	 * That rule was written here and on the route while nothing enforced it, so the
	 * interface's approve button settled our own outgoing requests. A conflict rather
	 * than a refusal, because nothing is wrong with the caller or their rights — the
	 * peer is simply in the one state where this is not the operation to run.
	 */
	public async approve(id: string): Promise<Peer> {
		const peer = await this._require(id);

		if (peer.direction === PeerDirection.OUTGOING) {
			// Not `PEER_REJECTED`: that one says the far end refused us, which is the
			// opposite fact and reads as alarming news about a request that is simply
			// still outstanding.
			throw new ConflictException(ErrorKey.PEER_AWAITING_THEM);
		}

		return this._present(await this._settle(peer));
	}

	/**
	 * Turn a pending row into a link.
	 *
	 * Takes the row rather than an identifier, because both callers already hold it and
	 * a second read would be a query bought for nothing — and, in a test, a second stub
	 * to remember.
	 */
	private async _settle(peer: PeerEntity): Promise<PeerEntity> {
		peer.status = PeerStatus.LINKED;
		peer.direction = null;
		peer.trust = PeerTrust.FRIEND;
		// Settling a link is the one moment a peer becomes somebody we chose, whatever
		// they were before: a friend of a friend we then invite directly is at one hop
		// from now on, and leaving the old distance would keep ranking them behind
		// peers who are further away.
		peer.depth = 1;

		const saved = await this._peers.save(peer);

		await this._adoptServices(saved);
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
		// The ban outlives the row, which is the whole reason it exists: removing a peer
		// used to delete the only thing refusing them, so the next request from the same
		// key arrived as a fresh introduction to accept. Checked before the row is even
		// looked for, and answered with silence: an answer that said "banned" would let
		// anybody map out the list by watching what happens.
		if (await this._bans.isBanned(fingerprint)) {
			return;
		}

		// The ban list is the only thing that refuses a fingerprint here. There used to
		// be a second silent refusal, for a peer whose status was blocked, and it goes
		// with that status: forbidding somebody to read keeps them a peer on purpose, so
		// refusing their announcement would close the link the point was to keep open.

		const existing = await this._peers.findByFingerprint(fingerprint);

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

		// Only for a row that is actually waiting on somebody. A peer settled above —
		// one answering a request of ours — is not news anybody has to act on, and a
		// re-announcement from a gateway that reconnects would otherwise notify on
		// every restart of theirs.
		if (peer.status === PeerStatus.PENDING) {
			void this._notifications.notify({
				event: NotificationEvent.PEER_REQUEST,
				title: `${peer.name} wants to link with this gateway`,
				// The fingerprint, because that is the only part somebody can actually
				// check against what their friend read out to them. A name is whatever
				// the far end typed.
				body: `Fingerprint ${peer.fingerprint}. Nothing is shared until somebody approves it.`,
				link: '/peers',
			});
		}
	}

	public async rename(id: string, name: string): Promise<Peer> {
		const peer = await this._require(id);

		peer.name = name;

		const saved = await this._peers.save(peer);

		// What they brought carries their name. Leaving the service row on the old one
		// means the peers screen and the services screen name the same machine two
		// different things, and only one of them is what somebody just typed. A rename
		// is not a reason to open a link or re-read a catalogue, so only the name moves.
		for (const service of await this._services.findByPeer(saved.id)) {
			if (service.name !== saved.name) {
				service.name = saved.name;

				await this._services.save(service);
			}
		}

		return this._present(saved);
	}

	/**
	 * Serve this peer nothing of ours, or start serving them again.
	 *
	 * **The link is deliberately left open**, and that is the correction this makes to
	 * the blocking it replaces. Blocking closed the socket in both directions, so
	 * punishing somebody also took away our own access to *their* library — which
	 * nobody wanted, and which made the action cost more than the problem it solved.
	 * The consequence to accept, and the one the interface states in so many words, is
	 * that they stay connected on their side and find an empty catalogue.
	 *
	 * One flag on the row, honoured in one place — `ShareManager.visiblePolicies` —
	 * because that is the funnel every peer-facing route already goes through. It sits
	 * a cut above `SharePolicy.deniedPeerIds`, which is per library and so cannot say
	 * "this person sees nothing of mine" without being written into every policy that
	 * exists today and every one somebody adds next week.
	 */
	public async setReadingForbidden(id: string, forbidden: boolean): Promise<Peer> {
		const peer = await this._require(id);

		peer.readingForbidden = forbidden;

		const saved = await this._peers.save(peer);

		this._emit(saved);

		return this._present(saved);
	}

	/**
	 * Unlink, and take back everything the link brought.
	 *
	 * Their services, their libraries, their rows and the matches that named them go
	 * with the peer — and nothing of ours does. The database would cascade most of it
	 * on its own, but not the matches: a match names an item on each side and only one
	 * of the two is reached by a foreign key, so unlinking used to leave rows pointing
	 * at media that no longer exists. Doing it here also means it happens identically
	 * on both engines rather than depending on whether foreign keys are enforced.
	 *
	 * It refuses nobody. A peer removed because a friend rebuilt their gateway can ask
	 * again, which is what somebody nearly always means; refusing the key for good is
	 * `ban`, a separate action with its own confirmation. The two used to be one call
	 * with a checkbox on it, and the checkbox went when the standalone ban made it a
	 * second way to do the same thing.
	 */
	public async remove(id: string): Promise<void> {
		const peer = await this._require(id);

		// Cancelled first: a timer left armed for a row that is about to be deleted
		// wakes up into `PEER_NOT_FOUND` every fifteen minutes until the process ends.
		this._reconnects.cancel(peer.id);
		this._links.disconnect(peer.id);

		for (const service of await this._services.findByPeer(peer.id)) {
			// The same stop the services screen gives a removed service: what their
			// server was feeding would otherwise fail later on a source that is gone.
			await this._serviceManager.releaseService(service.id);
			await this._forgetLibraries(service.id, await this._libraries.findByService(service.id));
			await this._mediaMatches.deleteForService(service.id);
			await this._services.delete({ id: service.id });
			this._events.emit(EventName.SERVICE_CHANGED, { id: service.id });
		}

		await this._peers.delete({ id: peer.id });
	}

	/**
	 * Register what a peer shares as a media service of ours, and keep it in step.
	 *
	 * This is the whole bet, made concrete: a peer is a media service with an
	 * introduction service bolted on, so linking one registers it the way registering
	 * a Jellyfin does. From here on nothing downstream knows the difference —
	 * indexing, correlation, categories, missing counts, quality summaries, sync plans
	 * and transfers all read an ordinary service row.
	 *
	 * Deliberately one service per peer rather than one per library of theirs. A peer
	 * is one machine, one link, one bandwidth budget and one thing to put in a source
	 * order; their libraries are libraries, which is exactly what libraries are for.
	 *
	 * It never throws. A peer that cannot be asked right now is a service with no
	 * libraries yet, and the next connection fills it — where a failure here would
	 * fail the link itself, and somebody would be told their friend refused them
	 * because a catalogue page timed out.
	 */
	private async _adoptServices(peer: PeerEntity): Promise<void> {
		if (peer.status !== PeerStatus.LINKED) {
			return;
		}

		// A peer we are not keeping brought one file, not a library. Registering a
		// service for them would scan a catalogue we are about to forget, leaving rows
		// and matches behind for a link that closes with the transfer — and putting a
		// stranger's whole collection in the library screen for as long as it lasted.
		if (peer.discovered) {
			return;
		}

		try {
			const service = await this._peerService(peer);

			if (!this._links.isLinked(peer.id)) {
				return;
			}

			// Through the service manager, which owns what registering means: it probes,
			// writes the status and adopts the libraries the probe reported. A second
			// implementation of that here is a second place for "what a service holds"
			// to be decided, and they would disagree within the month.
			const probe = await this._serviceManager.probe(service.id);

			await this._unshared(service.id, probe.libraries.map((library) => library.externalId));

			// A first link indexes everything they share; afterwards only what changed,
			// which is what the cursor on each library is for. Both are detached — the
			// caller is a link settling, not somebody waiting on a catalogue.
			if (service.lastScanAt === null) {
				await this._serviceManager.scan(service.id);
			} else {
				await this._serviceManager.refresh(service.id);
			}
		} catch (error) {
			this._logger.warn(
				`Could not register what ${peer.name} shares: ${String(error)}`,
			);
		}
	}

	/**
	 * The service row standing for this peer, created the first time we link.
	 *
	 * Never shared, and that is not a default somebody can change their way out of: the
	 * registration form does not offer the switch for a peer and `ShareManager` refuses
	 * their libraries whatever the row says. What a friend's friend holds is going to be
	 * reached by introducing the two ends so they connect directly — carrying the bytes
	 * through the middle would be a second propagation stacked on the hop limit that
	 * exists to bound the first, and a path people would depend on before the right one
	 * lands.
	 *
	 * `serviceMode` reads a service with a peer as a peer's whatever else the row says,
	 * and the repository refuses to offer one as a destination. We cannot write into
	 * somebody else's disk, and a transfer planned onto one would fail at the end of a
	 * completed download.
	 *
	 * The name follows theirs. Renaming a peer renames what it brought, because two
	 * names for one machine on two screens is a question nobody can answer.
	 */
	private async _peerService(peer: PeerEntity): Promise<MediaServiceEntity> {
		const baseUrl = peerBaseUrl(peer.id);
		const existing = (await this._services.findByPeer(peer.id)).find(
			(service) => service.baseUrl === baseUrl,
		);

		if (existing === undefined) {
			const created = await this._services.save(
				this._services.create({
					name: peer.name,
					type: MediaServiceType.PEER,
					shared: false,
					baseUrl,
					peerId: peer.id,
					priority: PEER_SERVICE_PRIORITY,
					status: MediaServiceStatus.UNKNOWN,
				}),
			);

			this._events.emit(EventName.SERVICE_CHANGED, { id: created.id });

			return created;
		}

		if (existing.name === peer.name) {
			return existing;
		}

		existing.name = peer.name;

		const renamed = await this._services.save(existing);

		this._events.emit(EventName.SERVICE_CHANGED, { id: renamed.id });

		return renamed;
	}

	/**
	 * Drop the libraries a peer has stopped sharing.
	 *
	 * Adopting libraries creates and updates and never deletes, which is right for a
	 * media server — a library missing from one probe is usually a server mid-restart —
	 * and wrong for a peer, where a library disappearing is somebody having changed
	 * their mind on purpose. Leaving it behind would keep showing a friend's films in
	 * the categories and counting them as available to pull, which is the one thing
	 * un-sharing was meant to stop.
	 */
	private async _unshared(serviceId: string, stillShared: string[]): Promise<void> {
		const gone = (await this._libraries.findByService(serviceId)).filter(
			(library) => !stillShared.includes(library.externalId),
		);

		if (gone.length > 0) {
			await this._forgetLibraries(serviceId, gone);
		}
	}

	/** Their rows, their matches and the library rows themselves, in that order. */
	private async _forgetLibraries(
		serviceId: string,
		libraries: { id: string }[],
	): Promise<void> {
		for (const library of libraries) {
			const items = await this._items.findStale(library.id, []);

			if (items.length > 0) {
				await this._mediaMatches.deleteForItems(items.map((item) => item.id));
				await this._items.remove(items);
			}

			await this._libraries.delete({ id: library.id, serviceId });
		}
	}

	/**
	 * Try the link now rather than waiting for the next scheduled attempt.
	 *
	 * That is what the button behind this route means since links redial themselves:
	 * the gateway is already trying, and somebody who knows their friend has just come
	 * back should not have to wait out a backoff that has grown to a quarter of an
	 * hour. Going through the reconnection service rather than dialling directly is
	 * what makes it a *sooner*, not a second attempt running beside the scheduled one.
	 */
	public async connect(id: string): Promise<Peer> {
		await this._require(id);

		const outcome = await this._reconnects.now(id);

		if (outcome !== PeerDialOutcome.LINKED) {
			// One answer for unreachable and for refused. The far end's reason is theirs
			// to know: telling a caller that a peer rejected them, rather than that it
			// could not be reached, is a fact about somebody else's decision.
			throw new ServiceUnavailableException(ErrorKey.PEER_UNREACHABLE);
		}

		return this.read(id);
	}

	/**
	 * Which friends to ask to introduce us to this peer, best first.
	 *
	 * **The peer that told us about this one comes first.** It is the obvious answer
	 * and the one that certainly can: `viaPeerId` is how we know this gateway exists at
	 * all, so that friend is linked to them by construction and their ceiling has
	 * already been checked once. For a peer added by fingerprint or met through an
	 * invitation there is no such friend, and the list simply starts at the next rung.
	 *
	 * **When that one is offline, the others are tried**, and that is deliberate rather
	 * than an afterthought: a friend's gateway being down is the commonest reason a
	 * link cannot be opened, and giving up there would make the whole ladder depend on
	 * one household's uptime. The rest are the peers we are linked to right now, as
	 * `findLinked` orders them, which is by name — a stable order, so a failure is the
	 * same failure twice rather than a different one each time somebody presses the
	 * button. Any of them may turn out to know this peer; none of them is known to.
	 *
	 * **And the list is short on purpose.** Each ask is a round trip to a household on
	 * the other side of a consumer uplink while somebody watches a spinner, so
	 * `MAX_INTRODUCERS_ASKED` of them are asked and no more. A gateway that tried
	 * twenty friends in turn before reporting failure is a screen that hangs, and the
	 * twentieth answer tells nobody anything the first three did not.
	 *
	 * Peers with no live link are dropped here rather than asked: an introduction is a
	 * request over an open socket, and a peer we cannot reach cannot answer one.
	 */
	public async introducersFor(peer: PeerEntity): Promise<string[]> {
		const linked = await this._peers.findLinked();
		const candidates = [
			...(peer.viaPeerId === null ? [] : [peer.viaPeerId]),
			...linked.map((one) => one.id),
		];
		const ordered: string[] = [];

		for (const id of candidates) {
			if (id === peer.id || ordered.includes(id) || !this._links.isLinked(id)) {
				continue;
			}

			ordered.push(id);

			if (ordered.length >= MAX_INTRODUCERS_ASKED) {
				break;
			}
		}

		return ordered;
	}

	/**
	 * Open the link, and say plainly which of the three things happened.
	 *
	 * The distinction is the whole reason this is not just `connect`. A peer nobody
	 * answered for is tried again, further away each time; a peer who *refused* us —
	 * a banned key, a rejected handshake, a protocol neither end speaks — is never
	 * tried again on a timer, because from the far end a gateway that keeps knocking
	 * after being told no is indistinguishable from one trying to get in, and that is
	 * how you get banned there for good.
	 */
	private async _dial(id: string): Promise<PeerDialOutcome> {
		const peer = await this._peers.findWithPublicKey(id);

		if (peer === null) {
			// The row went while a timer was in flight. Refused, so nothing rearms it.
			return PeerDialOutcome.REFUSED;
		}

		// Checked before a socket is opened rather than after the far end refuses us:
		// a key we ourselves banned is one we must stop calling, and finding that out
		// by being rejected costs a connection and tells the far end we are still here.
		if (await this._bans.isBanned(peer.fingerprint)) {
			return PeerDialOutcome.REFUSED;
		}

		try {
			const state = await this._links.connect(
				{
					id: peer.id,
					name: peer.name,
					fingerprint: peer.fingerprint,
					address: peer.address,
					publicKey: peer.publicKey,
				},
				{ introducers: await this.introducersFor(peer) },
			);

			await this._peers.setStatus(peer.id, PeerStatus.LINKED, state.mode, state.address);

			// Written here rather than inside the link service: a version and a list of
			// capabilities are facts about a peer, and where facts about a peer are kept
			// is this layer's business. Null protocol cannot happen on an established
			// link — the handshake refuses before returning one — but the state type
			// allows it, and asserting otherwise here would be a lie waiting to be true.
			if (state.protocol !== null) {
				await this._peers.recordHandshake(peer.id, {
					nodeId: state.nodeId,
					protocol: state.protocol,
					capabilities: state.capabilities,
				});
			}
		} catch (error) {
			const refused = this._isRefusal(error);

			this._logger.warn(
				refused
					? `Peer ${peer.name} refused the link, not trying again: ${String(error)}`
					: `Peer ${peer.name} could not be reached: ${String(error)}`,
			);

			await this._peers.setStatus(peer.id, PeerStatus.UNREACHABLE);
			this._emit(await this._require(peer.id));

			return refused ? PeerDialOutcome.REFUSED : PeerDialOutcome.UNREACHABLE;
		}

		const refreshed = await this._require(peer.id);

		// Now rather than when the row settled: the libraries can only be asked for over
		// a live link, and this is the first moment there is one.
		await this._adoptServices(refreshed);
		this._emit(refreshed);

		return PeerDialOutcome.LINKED;
	}

	/**
	 * Did the far end say no, as opposed to say nothing?
	 *
	 * Read off the error key the link service raises, which is the only place that
	 * knows the difference: a handshake whose proof did not verify and a protocol
	 * version we cannot speak are both answers, given by a machine that was reached.
	 */
	private _isRefusal(error: unknown): boolean {
		if (!(error instanceof HttpException)) {
			return false;
		}

		const response = error.getResponse() as { key?: string } | string;
		const key = typeof response === 'string' ? response : response?.key;

		return key === ErrorKey.PEER_REJECTED || key === ErrorKey.PEER_PROTOCOL_UNSUPPORTED;
	}

	public async services(id: string): Promise<MediaService[]> {
		await this._require(id);

		const services = await this._services.findByPeer(id);

		return Promise.all(
			services.map(async (service) =>
				toMediaService(service, {
					// Counted rather than reported as zero. It was a placeholder from when
					// nothing ever gave a peer-backed service any libraries; now that
					// linking one registers what they share, a hard zero is a screen saying
					// a friend shares nothing while their films are listed underneath it.
					libraryCount: await this._libraries.count({ where: { serviceId: service.id } }),
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
	/**
	 * Somebody opened a socket on the peer endpoint. Are they anybody?
	 *
	 * The cryptography is checked first and by the link service, which owns the keys:
	 * the presented key has to hash to the fingerprint, the signature has to verify,
	 * and the challenge has to be recent. Everything after that is a decision about
	 * trust, which is why it is here and not in the thing holding the socket.
	 *
	 * An unknown gateway is recorded as a request and refused, which is the same
	 * answer `requested` gives everywhere else: the only thing a stranger can do is
	 * ask, and somebody has to say yes before a single catalogue row crosses.
	 *
	 * `UNREACHABLE` is admitted alongside `LINKED` — the repository already treats the
	 * two as one for exactly this reason. It means *we* failed to reach *them*, which
	 * says nothing about whether they are a friend, and refusing them here would make
	 * a gateway that went offline once unable to ever call back in.
	 */
	public async admit(credential: PeerCredential): Promise<PeerAdmission | null> {
		if (!this._links.verifyCredential(credential)) {
			return null;
		}

		// Read only when there is a token to weigh it against, so an ordinary link
		// between two friends costs exactly the queries it always did.
		if (credential.introduction !== null) {
			const known = await this._peers.findByFingerprint(credential.fingerprint);

			// A token is only consulted for somebody we have no settled link with. A
			// friend presenting one changes nothing about a relationship that already
			// exists, and re-reading it on every reconnection would let a third party go
			// on restating who somebody is long after the two ends stopped needing them.
			if (known === null || !this._isSettled(known)) {
				const introduced = await this._admitIntroduced(credential, known);

				if (introduced !== null) {
					return introduced;
				}
			}
		}

		// Records a stranger, and settles a request of ours they are answering by
		// connecting. Both are the same fact seen from two sides.
		await this.requested(credential.fingerprint, '', credential.address);

		const peer = await this._peers.findByFingerprint(credential.fingerprint);

		if (peer === null || !this._isSettled(peer)) {
			// One answer for an unknown fingerprint and for a peer still pending. Telling
			// them apart would let a stranger learn whether they are known here by
			// watching what happens.
			return null;
		}

		return { peerId: peer.id, name: peer.name };
	}

	/**
	 * Somebody we have never met, carrying a token from a gateway we are linked to.
	 *
	 * This is the receiving half of the feature, and the whole of the security surface
	 * on this side. Nothing here asks anybody for permission, and that is the settled
	 * design: being reachable at this distance *is* the agreement, recorded in
	 * `peerMaxDepth` and in the introducer's own `maxDepth`. What is checked is that the
	 * token really is theirs, that it was minted for this gateway and for the key on the
	 * other end of this socket, and that the distance it states is one we accept.
	 *
	 * The order matters. The signature is checked against the key *we* hold for the
	 * introducer — never one the token carries, which would be a token vouching for
	 * itself — and a signer who is not a peer of ours vouches for nobody here, however
	 * well-formed their signature is.
	 *
	 * Every refusal answers null and writes one line in our own log. The far end is told
	 * nothing but that the link was refused: a stranger able to tell "your signer is not
	 * my friend" from "you are further than I allow" could map out this gateway's
	 * friends and its reach by trying.
	 */
	private async _admitIntroduced(
		credential: PeerCredential,
		known: PeerEntity | null,
	): Promise<PeerAdmission | null> {
		const token = credential.introduction ?? '';
		const claim = this._introductions.read(token);

		if (claim === null) {
			return this._refuseIntroduction(IntroductionRefusal.MALFORMED, credential);
		}

		// The token names who may present it and which gateway it opens. Without the
		// first, a token lifted off the wire would work for anybody; without the second,
		// a token minted to reach us would open a link to every other peer the
		// introducer has.
		if (claim.subject !== credential.fingerprint || claim.holder !== this._links.fingerprint) {
			return this._refuseIntroduction(IntroductionRefusal.NOT_ADDRESSED, credential);
		}

		// A ban is refused before anything else is read. An introduction is a route in,
		// and the whole point of the ban list is that it survives every route.
		if (await this._bans.isBanned(credential.fingerprint)) {
			return null;
		}

		const introducer = await this._peers.findByFingerprint(claim.introducer);

		if (introducer === null || !this._isSettled(introducer)) {
			return this._refuseIntroduction(IntroductionRefusal.UNKNOWN_INTRODUCER, credential);
		}

		const withKey = await this._peers.findWithPublicKey(introducer.id);

		if (withKey?.publicKey == null) {
			// A peer whose key we never learned cannot vouch for anybody: there is
			// nothing to check the signature against, and an unchecked introduction is
			// an open door with a token taped to it.
			return this._refuseIntroduction(IntroductionRefusal.UNKNOWN_INTRODUCER, credential);
		}

		const checked = this._introductions.verify(token, withKey.publicKey);

		if (!checked.ok) {
			return this._refuseIntroduction(checked.refusal, credential);
		}

		const settings = await this._settings.get();
		// Never shorter than the truth. The claim is the introducer's arithmetic and the
		// second term is ours; taking the larger is what stops a chain being made to look
		// direct by a gateway that states a smaller number than it counted.
		const depth = Math.max(claim.depth, introducer.depth + 1);
		/*
		 * The reach, which is the consent and not a lookup setting.
		 *
		 * `peerMaxDepth` says how far an introduction may travel, and since a friend of
		 * a friend reaches this gateway by opening a link straight to it, that is the
		 * same sentence as how far away somebody may be and still connect here. The
		 * introducer's own `maxDepth` narrows it further for their circle alone. Anybody
		 * lowering either one to save bandwidth is narrowing who can reach them — which
		 * is exactly what happens on the line below.
		 */
		const allowed = Math.min(settings.peerMaxDepth, introducer.maxDepth ?? settings.peerMaxDepth);

		if (depth > allowed) {
			return this._refuseIntroduction(IntroductionRefusal.TOO_FAR, credential);
		}

		const keep = settings.keepDiscoveredPeers;
		const peer = await this._peers.save(
			known === null
				? this._peers.create({
					name: this._defaultName(credential.fingerprint),
					fingerprint: credential.fingerprint,
					address: credential.address,
					status: PeerStatus.LINKED,
					direction: null,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					depth,
					viaPeerId: introducer.id,
					// Temporary unless somebody asked for these to be kept. The flag is
					// what the sweep and the closing link read, and it is only ever set
					// on a row this admission created: a row somebody made deliberately —
					// a request of ours they are now answering — is never turned into
					// something that deletes itself.
					discovered: !keep,
				})
				: Object.assign(known, {
					status: PeerStatus.LINKED,
					direction: null,
					address: credential.address ?? known.address,
					trust: known.trust === PeerTrust.FRIEND ? known.trust : PeerTrust.FRIEND_OF_FRIEND,
					viaPeerId: known.viaPeerId ?? introducer.id,
					discovered: known.discovered && !keep,
				}),
		);

		this._emit(peer);
		this._logger.log(
			`${peer.name} was introduced by ${introducer.name}, ${depth} hops away` +
				`${peer.discovered ? ', for this transfer only' : ''}`,
		);

		return { peerId: peer.id, name: peer.name };
	}

	/**
	 * Somebody we introduced cannot reach the gateway we introduced them to. Carry it?
	 *
	 * Only for a pair this gateway itself put in touch, and only inside the two minutes
	 * the token lives. That is the whole authorisation, and it is deliberately not a
	 * new one: the introduction already recorded the decision — who may be introduced
	 * to whom, and how far away either of them is — so a relay that asked a different
	 * question would be a second answer to it, and the two would disagree the day
	 * somebody lowered their reach.
	 *
	 * The order matters. The signature on the socket is checked first, because
	 * everything below only means anything if the far end really holds the key the
	 * token names as its subject. Then the token is verified **against our own public
	 * key**: a token we did not sign is a request to carry bytes for two strangers.
	 *
	 * Every refusal answers null and says one line here. The far end is told nothing
	 * but that the upgrade failed — somebody able to tell "we do not carry" from "that
	 * is not our peer" could map out this gateway's friends and its settings by dialling
	 * it.
	 *
	 * **What this gateway can see once it agrees.** Everything crossing the link, in
	 * plaintext: it holds both halves. It cannot be the dialler and it cannot be the
	 * holder — neither key is here — but nothing about carrying is private, which is
	 * why the switch exists, why direct is tried first, and why the peer card says on
	 * the row when a link is relayed.
	 */
	public async carry(credential: PeerCredential): Promise<PeerRelayGrant | null> {
		const token = credential.introduction;

		if (token === null || !this._links.verifyCredential(credential)) {
			return null;
		}

		if (!(await this._settings.get()).relayForPeers) {
			// The one refusal that is not about them. Logged as such: a household that
			// never turned it on should be able to see why a friend says they cannot be
			// reached, without reading the code.
			this._logger.log('Refused to carry a link: relaying is off');

			return null;
		}

		const checked = this._introductions.verify(token, this._links.publicKey);

		if (!checked.ok || checked.claim.introducer !== this._links.fingerprint) {
			return this._refuseRelay('the token is not ours or is spent');
		}

		if (checked.claim.subject !== credential.fingerprint) {
			// A token lifted off somebody else's wire. It names who may present it, and
			// the socket underneath has just proved who that is.
			return this._refuseRelay('the token was minted for somebody else');
		}

		if (await this._bans.isBanned(credential.fingerprint)) {
			return null;
		}

		const subject = await this._peers.findByFingerprint(credential.fingerprint);
		const holder = await this._peers.findByFingerprint(checked.claim.holder);

		// Both ends have to be ours. We introduced them, which means they were both
		// peers of this gateway two minutes ago; a row that has gone since is somebody
		// unlinking, and a relay is not a way back in.
		if (subject === null || !this._isSettled(subject) || holder === null || !this._isSettled(holder)) {
			return this._refuseRelay('one of the two ends is not a peer of ours');
		}

		return { holderPeerId: holder.id, holderName: holder.name, subjectName: subject.name };
	}

	private _refuseRelay(why: string): null {
		this._logger.warn(`Refused to carry a link: ${why}`);

		return null;
	}

	/** One line for us, and nothing at all for the far end. */
	private _refuseIntroduction(
		refusal: IntroductionRefusal,
		credential: PeerCredential,
	): null {
		this._logger.warn(
			`Refused an introduction for ${credential.fingerprint.slice(0, 16)}…: ${refusal}`,
		);

		return null;
	}

	/**
	 * A peer whose link is agreed, whether or not we can reach them this minute.
	 *
	 * `UNREACHABLE` sits beside `LINKED` because it means *we* failed to reach *them*,
	 * which says nothing about whether they are a friend — refusing them would make a
	 * gateway that went offline once unable to ever call back in.
	 */
	private _isSettled(peer: PeerEntity): boolean {
		return peer.status === PeerStatus.LINKED || peer.status === PeerStatus.UNREACHABLE;
	}

	/**
	 * Their link ended, and for a peer we were not asked to keep that is the end of them.
	 *
	 * Called by the inbound endpoint when a session closes. A peer met through an
	 * introduction was created to move one file: leaving the row behind would put a
	 * gateway nobody invited in somebody's peer list, dialled at every restart, with no
	 * word on screen for where it came from. `Settings.keepDiscoveredPeers` is what
	 * makes it a peer instead, and it is read when the link opens rather than here —
	 * somebody turning the setting on mid-transfer means it for the next one.
	 */
	public released(peerId: string): void {
		void this._forgetIfDiscovered(peerId);
	}

	/**
	 * Drop a peer that only existed for a transfer. True when there was one.
	 *
	 * The answer is what the caller needs: the two things that happen when a link ends
	 * — forget them, or schedule a retry — are mutually exclusive, and a caller that had
	 * to ask the database a second time to tell them apart would sometimes get a
	 * different answer than this one did.
	 */
	public async forget(peerId: string): Promise<boolean> {
		return this._forgetIfDiscovered(peerId);
	}

	private async _forgetIfDiscovered(peerId: string): Promise<boolean> {
		try {
			const peer = await this._peers.findOne({ where: { id: peerId } });

			if (peer === null || !peer.discovered) {
				return false;
			}

			// Both ends may hold a socket: they dialled us, and we may have dialled them
			// for a pull of our own. Forgetting the row while our own link is still open
			// would cut a transfer that is still running, so the last link out is what
			// ends the relationship.
			if (this._links.isLinked(peerId)) {
				return false;
			}

			this._logger.log(`${peer.name} finished, and was not one to keep`);

			await this.remove(peer.id);

			return true;
		} catch (error) {
			this._logger.warn(`Could not forget ${peerId} after its link closed: ${String(error)}`);

			return false;
		}
	}

	/**
	 * Answer their hello with ours, and remember what they said.
	 *
	 * Null when the version is not one we speak, and the caller closes the link. There
	 * is exactly one version before the first release: a mismatch is a flat refusal
	 * rather than a downgrade, because carrying compatibility for versions nobody ever
	 * ran is weight with no cargo.
	 */
	public async greet(
		peerId: string,
		hello: PeerHello,
		challenge: string,
	): Promise<PeerHandshake | null> {
		const protocol = negotiateProtocol(hello.protocol);

		if (protocol === null) {
			this._logger.warn(`Peer ${peerId} speaks protocol ${hello.protocol}, which we do not`);

			return null;
		}

		await this._peers.recordHandshake(peerId, {
			nodeId: hello.nodeId || null,
			protocol,
			capabilities: hello.capabilities,
		});

		return {
			hello: await this._links.hello(),
			publicKey: this._links.publicKey,
			// Their challenge, not one of ours: it is the only thing that proves this
			// answer was produced now, by whoever holds the key, for them.
			signature: this._links.sign(challenge),
		};
	}

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
		address: string;
		secret: string;
		expiresAt: Date;
	}): string {
		const query = new URLSearchParams({
			fingerprint: invite.fingerprint,
			address: invite.address,
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
		address: string | null;
		secret: string | null;
		expiresAt: Date | null;
	} {
		const trimmed = invite.trim();

		if (!trimmed.startsWith(INVITE_SCHEME)) {
			return { code: trimmed, fingerprint: null, address: null, secret: null, expiresAt: null };
		}

		const [path, query] = trimmed.slice(INVITE_SCHEME.length).split('?');
		const parameters = new URLSearchParams(query ?? '');
		const expiry = parameters.get('exp');
		const parsedExpiry = expiry === null ? null : new Date(expiry);

		return {
			code: path,
			fingerprint: parameters.get('fingerprint'),
			address:
				parameters.get('address') ?? parameters.get(LEGACY_INVITE_ADDRESS_PARAM),
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

	/**
	 * Refuse a fingerprint for good, and take the peer with it.
	 *
	 * The last of three outcomes that do not overlap. Forbidding somebody to read
	 * keeps them and their link and serves them nothing; removing them drops the link
	 * and lets them ask again; a ban survives the row, so the same key cannot come
	 * back through a new request, an invitation, or an introduction by a friend.
	 *
	 * A standalone action rather than a checkbox on the removal, which is where it
	 * used to live. Two ways to reach one outcome meant two confirmations to keep in
	 * step and a removal dialog that had to explain a decision most people were not
	 * making; the checkbox went, this stayed.
	 *
	 * Removing the peer is part of it rather than a separate step somebody has to
	 * remember: a banned peer still listed among the others is a row that can be
	 * approved by whoever does not know why it is there.
	 */
	public async ban(id: string, reason?: string): Promise<BannedPeer> {
		const peer = await this._require(id);

		// Recorded before anything is deleted, because once the row is gone there is
		// nothing left to take the fingerprint and the name from — and a ban recorded
		// from a half-deleted peer is a ban on whatever survived the failure.
		const banned = await this._bans.ban(peer.fingerprint, {
			name: peer.name,
			reason: reason?.trim() || null,
		});

		await this.remove(peer.id);

		return this._presentBan(banned);
	}

	/**
	 * Ban a fingerprint nobody ever linked to.
	 *
	 * The case is somebody being told about a key to refuse before it has asked —
	 * which is exactly when refusing it is worth anything. It is also how a ban
	 * survives a peer row that was deleted the ordinary way before this list existed.
	 */
	public async banFingerprint(
		fingerprint: string,
		{ name, reason }: { name?: string; reason?: string } = {},
	): Promise<BannedPeer> {
		const trimmed = fingerprint.trim();

		if (trimmed === '') {
			throw new UnauthorizedException(ErrorKey.PEER_INVITE_INVALID);
		}

		const existing = await this._peers.findByFingerprint(trimmed);

		if (existing !== null) {
			return this.ban(existing.id, reason);
		}

		return this._presentBan(
			await this._bans.ban(trimmed, { name: name?.trim() || null, reason: reason?.trim() || null }),
		);
	}

	/** The ban list, most recent first — that is the one somebody is looking for. */
	public async bans(): Promise<BannedPeer[]> {
		return (await this._bans.findAll()).map((ban) => this._presentBan(ban));
	}

	/**
	 * Lift a ban. It does not re-link anybody: the key is merely allowed to ask again.
	 *
	 * Reported as not found rather than silently succeeding, because this is called
	 * from a list somebody is looking at, and a row that disappears from one screen
	 * while still refusing requests on another is the kind of disagreement nobody
	 * thinks to check.
	 */
	public async unban(fingerprint: string): Promise<void> {
		if (!(await this._bans.unban(fingerprint.trim()))) {
			throw new NotFoundException(ErrorKey.PEER_BAN_NOT_FOUND);
		}
	}

	/**
	 * How far introductions through one peer may travel.
	 *
	 * Null puts them back on the gateway's own ceiling, which is what somebody means
	 * when they clear the box — not a limit of zero, and not the number that happened
	 * to be the default the day they set it.
	 */
	public async setMaxDepth(id: string, maxDepth: number | null): Promise<Peer> {
		const peer = await this._require(id);

		if (maxDepth !== null) {
			const value = Math.trunc(maxDepth);

			if (!Number.isFinite(value) || value < 1 || value > MAX_PEER_MAX_DEPTH) {
				throw new ConflictException(ErrorKey.SETTINGS_INVALID);
			}

			peer.maxDepth = value;
		} else {
			peer.maxDepth = null;
		}

		const saved = await this._peers.save(peer);

		this._emit(saved);

		return this._present(saved);
	}

	private _presentBan(ban: BannedPeerEntity): BannedPeer {
		return {
			fingerprint: ban.fingerprint,
			name: ban.name,
			reason: ban.reason,
			bannedAt: ban.createdAt.toISOString(),
		};
	}
}
