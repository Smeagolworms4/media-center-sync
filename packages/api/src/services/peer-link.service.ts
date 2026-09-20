import {
	randomUUID,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
	verify as verifyBytes,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import {
	ErrorKey,
	PEER_HELLO_METHOD,
	PROTOCOL_VERSION,
	PeerCapability,
	PeerLinkMode,
	negotiateProtocol,
	type PeerCapabilityValue,
	type PeerHandshake,
	type PeerHello,
	type PeerIdentity,
} from '@mcs/shared';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	ServiceUnavailableException,
} from '@nestjs/common';
import { WebSocket } from 'ws';
import { PEER_LINK_PATH, type PeerCredential } from './peer-gateway.service';
import { RendezvousClient } from './rendezvous.client';

/** Where the gateway's own key pair lives, unless the environment says otherwise. */
const DEFAULT_DATA_DIR = './data';
const NODE_ID_FILE = 'node-id';
const KEY_FILE = 'peer-identity.pem';

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a signed challenge is worth anything.
 *
 * The challenge carries the moment it was made, and this is the only use that fact
 * has: a signature lifted off the wire stops opening links a few minutes later. It is
 * generous because the two clocks belong to two households and neither is ours.
 */
const CHALLENGE_MAX_AGE_MS = 5 * 60_000;

/**
 * What this gateway tells a peer it can do.
 *
 * Every entry here is a method this gateway really answers — advertising one it does
 * not is worse than advertising nothing, because the far end will use it and be
 * refused at the one moment it mattered. `RELAY` is absent on purpose: passing a
 * friend of a friend's traffic through this machine is the rendezvous's job, not
 * ours.
 */
export const LOCAL_CAPABILITIES: readonly PeerCapabilityValue[] = Object.freeze([
	PeerCapability.CONTENT,
	PeerCapability.CATALOGUE,
	PeerCapability.LIBRARIES,
	PeerCapability.REVALIDATE,
	PeerCapability.ANNOUNCE,
	PeerCapability.SWARM,
]);

/**
 * Binary frames carry a request identifier so several ranges share one socket.
 *
 * Four bytes in front of every payload, big-endian, matching the identifier of the
 * request that asked for those bytes. Without it a link could only ever serve one
 * transfer at a time, which would make the multi-connection machinery above it
 * pointless for peers.
 */
const FRAME_HEADER_BYTES = 4;

export interface PeerDescriptor {
	id: string;
	name: string;
	fingerprint: string;
	/** Last known address. Null forces a rendezvous lookup. */
	address: string | null;
	/** The far end's public key, learned when the invitation was accepted. */
	publicKey: string | null;
}

export interface PeerLinkState {
	peerId: string;
	mode: PeerLinkMode;
	address: string | null;
	connected: boolean;
	since: string;
	/** What the two ends agreed on. Null until the handshake has happened. */
	protocol: number | null;
	/** What the far end said it can do, as it said it. */
	capabilities: string[];
	/** Their stable name on the shared network, which is not their fingerprint. */
	nodeId: string | null;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	/** Set for a request whose answer is a byte stream rather than a value. */
	stream: PassThrough | null;
	timer: NodeJS.Timeout;
}

/**
 * One live link to another gateway.
 *
 * Deliberately a plain class rather than an injectable: there is one per peer, it
 * owns a socket, and its lifetime is the socket's. The service below owns the map.
 */
class PeerLink {
	public readonly since = new Date().toISOString();

	/**
	 * What the far end turned out to be, learned in the handshake.
	 *
	 * Held on the link rather than only in the database because the question asked of
	 * it — may I use this feature on this socket — is asked per request and has to be
	 * answered without a query.
	 */
	public protocol: number | null = null;
	public capabilities: string[] = [];
	public nodeId: string | null = null;

	private readonly _pending = new Map<number, PendingRequest>();
	private _nextRequestId = 1;

	/**
	 * Whether this link was closed by us rather than lost.
	 *
	 * The difference is the whole reason the flag exists: a link that dropped is one
	 * to dial again, and a link we hung up — because the peer was removed, banned, or
	 * the process is shutting down — is one that must never be dialled again. Without
	 * it, removing a peer would schedule a reconnection to a row that no longer exists.
	 */
	private _closedByUs = false;
	private _reported = false;

	public constructor(
		public readonly peerId: string,
		public readonly mode: PeerLinkMode,
		public readonly address: string | null,
		private readonly _socket: WebSocket,
		private readonly _logger: Logger,
		/** Called once when the link is lost, and never when we closed it ourselves. */
		private readonly _onLost: (peerId: string) => void = () => undefined,
	) {
		this._socket.on('message', (data: Buffer, isBinary: boolean) =>
			this._onMessage(data, isBinary),
		);
		this._socket.on('close', () => this._lost(new Error('link closed')));
		this._socket.on('error', (error) => this._lost(error));
	}

	public get connected(): boolean {
		return this._socket.readyState === WebSocket.OPEN;
	}

	public request<T>(method: string, params: unknown): Promise<T> {
		return this._send<T>(method, params, false) as Promise<T>;
	}

	public requestStream(method: string, params: unknown): Promise<Readable> {
		return this._send<Readable>(method, params, true) as Promise<Readable>;
	}

	public close(): void {
		this._closedByUs = true;
		this._failAll(new Error('link closed'));
		this._socket.close();
	}

	/**
	 * The socket went away. Fail what was in flight, and say so exactly once.
	 *
	 * `ws` emits `error` and then `close` for the same failure, so a listener wired to
	 * both would schedule two reconnections for one drop — which halves the backoff
	 * that was chosen to protect a friend's gateway.
	 */
	private _lost(error: Error): void {
		this._failAll(error);

		if (this._closedByUs || this._reported) {
			return;
		}

		this._reported = true;
		this._onLost(this.peerId);
	}

	private _send<T>(method: string, params: unknown, streaming: boolean): Promise<T | Readable> {
		if (!this.connected) {
			throw new ServiceUnavailableException({ key: ErrorKey.PEER_UNREACHABLE });
		}

		const id = this._nextRequestId++;

		return new Promise<T | Readable>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`peer request "${method}" timed out`));
			}, REQUEST_TIMEOUT_MS);

			// `unref` so a pending peer request cannot hold the process open during a
			// shutdown that is already waiting on the socket to close.
			timer.unref?.();

			const stream = streaming ? new PassThrough() : null;

			this._pending.set(id, { resolve: resolve as (value: unknown) => void, reject, stream, timer });
			this._socket.send(JSON.stringify({ id, method, params }));

			// A streaming request resolves as soon as it is sent: the bytes arrive
			// afterwards, frame by frame, and the caller wants the stream now so it can
			// start writing.
			if (stream) {
				resolve(stream);
			}
		});
	}

	private _onMessage(data: Buffer, isBinary: boolean): void {
		if (isBinary) {
			if (data.length < FRAME_HEADER_BYTES) {
				return;
			}

			const id = data.readUInt32BE(0);
			const pending = this._pending.get(id);

			// Backpressure is honoured by the socket's own flow control once the
			// PassThrough stops draining, which is what keeps a slow disk from turning
			// into unbounded memory here.
			pending?.stream?.write(data.subarray(FRAME_HEADER_BYTES));

			return;
		}

		let message: { id?: number; result?: unknown; error?: string; end?: boolean };

		try {
			message = JSON.parse(data.toString('utf8')) as typeof message;
		} catch {
			this._logger.warn(`Unreadable frame from peer ${this.peerId}`);

			return;
		}

		if (typeof message.id !== 'number') {
			return;
		}

		const pending = this._pending.get(message.id);

		if (!pending) {
			return;
		}

		if (message.error) {
			clearTimeout(pending.timer);
			this._pending.delete(message.id);
			pending.stream?.destroy(new Error(message.error));
			pending.reject(new Error(message.error));

			return;
		}

		if (pending.stream) {
			// Only an explicit end closes a byte stream. A stream that ended because
			// the socket went quiet is indistinguishable from a complete one, and that
			// is how a truncated chunk passes for a finished one.
			if (message.end) {
				clearTimeout(pending.timer);
				this._pending.delete(message.id);
				pending.stream.end();
			}

			return;
		}

		clearTimeout(pending.timer);
		this._pending.delete(message.id);
		pending.resolve(message.result);
	}

	private _failAll(error: Error): void {
		for (const [id, pending] of this._pending) {
			clearTimeout(pending.timer);
			this._pending.delete(id);
			pending.stream?.destroy(error);
			pending.reject(error);
		}
	}
}

/**
 * Establishes and holds links to other gateways.
 *
 * Direct when the far end's port is reachable, relayed through the rendezvous when
 * it is not — and the distinction is discovered by trying, not by configuration,
 * because whether a direct connection works depends on two routers neither end
 * controls. The identity underneath is a key pair generated once and kept: the
 * address changes, the fingerprint does not, and it is the fingerprint an invitation
 * carries.
 *
 * Verification runs after connecting rather than before, and that order is the whole
 * security argument: the rendezvous chooses the address, so a dishonest one can send
 * us to a machine of its choosing. That machine then has to prove it holds the
 * private key behind the fingerprint we asked for, which it cannot, and the link is
 * dropped before a single catalogue row crosses it.
 */
@Injectable()
export class PeerLinkService implements OnModuleDestroy {
	private readonly _logger = new Logger(PeerLinkService.name);
	private readonly _links = new Map<string, PeerLink>();

	/**
	 * Told when a link is lost, so something above can decide whether to dial again.
	 *
	 * A callback handed in rather than a decision made here: this class knows a socket
	 * closed, and nothing else. Whether that peer is still linked, still welcome, and
	 * worth another attempt is a business question, and answering it here would put a
	 * repository behind a class whose whole job is holding sockets.
	 */
	private _onLost: ((peerId: string) => void) | null = null;

	private readonly _privateKeyPem: string;
	private readonly _publicKeyPem: string;
	private readonly _fingerprint: string;

	private readonly _nodeId: string;

	public constructor(private readonly _rendezvous: RendezvousClient) {
		const keys = this._loadOrCreateKeys();

		this._privateKeyPem = keys.privateKey;
		this._publicKeyPem = keys.publicKey;
		this._fingerprint = this.fingerprintOf(keys.publicKey);
		this._nodeId = this._loadOrCreateNodeId();
	}

	/** This gateway's name on the shared network, whatever its key or address becomes. */
	public get nodeId(): string {
		return this._nodeId;
	}

	/**
	 * A stable identifier for this gateway, generated once and derived from nothing.
	 *
	 * Deliberately not the fingerprint: a key can be rotated, and a gateway that
	 * rotates its key has not become a different participant. Its whole job is to let
	 * an announcement be recognised as one we have already seen — a friend of a friend
	 * propagates what it hears, so without a name to know itself by, a gateway receives
	 * its own catalogue back through a third party and answers it. Two households then
	 * spend the evening telling each other about the same file.
	 *
	 * Stored beside the key, and regenerated if the file is lost: a new identity costs
	 * one round of redundant announcements, where refusing to start costs everything.
	 */
	private _loadOrCreateNodeId(): string {
		const path = process.env.PEER_NODE_ID_PATH
			?? join(process.env.MCS_DATA_DIR ?? DEFAULT_DATA_DIR, NODE_ID_FILE);

		try {
			const stored = readFileSync(path, 'utf8').trim();

			if (stored !== '') {
				return stored;
			}
		} catch {
			// Never written, or no longer readable. Both mean the same thing here.
		}

		const nodeId = randomUUID();

		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, nodeId, { mode: 0o600 });
		} catch (error) {
			this._logger.warn(
				`Node identity could not be written to ${path}: it will change on restart (${String(error)})`,
			);
		}

		return nodeId;
	}

	public identity(name: string, rendezvousUrl: string | null): PeerIdentity {
		return {
			nodeId: this._nodeId,
			fingerprint: this._fingerprint,
			name,
			rendezvous: rendezvousUrl ?? '',
			directAddress: process.env.PEER_PUBLIC_ADDRESS ?? null,
			directReachable: !!process.env.PEER_PUBLIC_ADDRESS,
		};
	}

	/**
	 * What this gateway says about itself, in both directions.
	 *
	 * One method rather than one per direction: the hello we send when we call and the
	 * hello we answer when we are called are the same statement, and two copies of it
	 * would drift the first time a capability was added.
	 */
	public hello(): PeerHello {
		return {
			nodeId: this._nodeId,
			fingerprint: this._fingerprint,
			name: hostname(),
			protocol: PROTOCOL_VERSION,
			capabilities: [...LOCAL_CAPABILITIES],
		};
	}

	/**
	 * Is this credential cryptographically sound? Not: is its owner welcome.
	 *
	 * Three things, and all three are needed. The key has to hash to the fingerprint it
	 * is presented with, or anybody could claim any fingerprint by sending their own
	 * key. The signature has to verify, or the key is just a public value they copied.
	 * And the challenge has to be recent, because it is the far end that chooses it —
	 * without the age check a signature lifted off the wire opens a link forever.
	 */
	public verifyCredential(credential: PeerCredential): boolean {
		if (this.fingerprintOf(credential.publicKey) !== credential.fingerprint) {
			return false;
		}

		if (!this._isChallengeFresh(credential.challenge)) {
			return false;
		}

		return this.verify(credential.publicKey, credential.challenge, credential.signature);
	}

	/**
	 * May we use this feature on this link?
	 *
	 * False when the peer never advertised it, and false when there is no link at all.
	 * That is the rule the whole versioning scheme rests on: a feature is used because
	 * the far end said it has it, never because we have it. Guessing is how a gateway
	 * on last month's release gets a request it cannot parse.
	 */
	public supports(peerId: string, capability: PeerCapabilityValue): boolean {
		return this._links.get(peerId)?.capabilities.includes(capability) ?? false;
	}

	/** The agreed version, or null when no handshake has happened on this link. */
	public protocolOf(peerId: string): number | null {
		return this._links.get(peerId)?.protocol ?? null;
	}

	public get publicKey(): string {
		return this._publicKeyPem;
	}

	public get fingerprint(): string {
		return this._fingerprint;
	}

	/**
	 * A fingerprint is a hash of the public key, not the key.
	 *
	 * Short enough to paste into a message to a friend, long enough that producing a
	 * key with the same one is not a thing anybody can do.
	 */
	public fingerprintOf(publicKeyPem: string): string {
		const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });

		return createHash('sha256').update(der).digest('hex');
	}

	/**
	 * `<fingerprint>:<epoch millis>` — and the millis are why it is not just a nonce.
	 *
	 * A challenge made in the future is refused as firmly as a stale one: the two
	 * clocks belong to two households, and a far end whose clock is a day ahead would
	 * otherwise hand out signatures usable tomorrow.
	 */
	private _isChallengeFresh(challenge: string): boolean {
		const issued = Number(challenge.split(':').pop());

		if (!Number.isFinite(issued)) {
			return false;
		}

		return Math.abs(Date.now() - issued) <= CHALLENGE_MAX_AGE_MS;
	}

	public sign(payload: string): string {
		return signBytes(null, Buffer.from(payload), createPrivateKey(this._privateKeyPem)).toString(
			'base64',
		);
	}

	public verify(publicKeyPem: string, payload: string, signature: string): boolean {
		try {
			return verifyBytes(
				null,
				Buffer.from(payload),
				createPublicKey(publicKeyPem),
				Buffer.from(signature, 'base64'),
			);
		} catch {
			// A malformed key or signature is a failed verification, not an exception
			// to handle three layers up.
			return false;
		}
	}

	/**
	 * Connect if we are not already, and hand back the live link.
	 *
	 * Direct first: it is faster, it costs the rendezvous nothing, and on a home
	 * network it is the only thing that works when the rendezvous is unreachable.
	 */
	public async connect(
		peer: PeerDescriptor,
		rendezvousUrl: string | null,
	): Promise<PeerLinkState> {
		const existing = this._links.get(peer.id);

		if (existing?.connected) {
			return this._toState(existing);
		}

		if (peer.address) {
			const direct = await this._open(peer, peer.address, PeerLinkMode.DIRECT).catch(
				(error: unknown) => {
					// A far end that answered and failed to prove its identity is not a
					// far end we failed to reach. Falling through to the rendezvous would
					// reach the same machine, fail the same way, and report it as
					// unreachable — which sends somebody looking at their firewall for a
					// problem that is a wrong fingerprint.
					if (this._isRejection(error)) {
						throw error;
					}

					return null;
				},
			);

			if (direct) {
				this._links.set(peer.id, direct);

				return this._toState(direct);
			}
		}

		if (!rendezvousUrl) {
			throw new ServiceUnavailableException({ key: ErrorKey.PEER_UNREACHABLE });
		}

		const introduction = await this._rendezvous.introduce(
			rendezvousUrl,
			peer.fingerprint,
			this.sign(`${this._fingerprint}:${peer.fingerprint}`),
		);

		if (introduction.address) {
			const punched = await this._open(peer, introduction.address, PeerLinkMode.DIRECT).catch(
				() => null,
			);

			if (punched) {
				this._links.set(peer.id, punched);

				return this._toState(punched);
			}
		}

		const relayUrl = introduction.relayUrl ?? this._rendezvous.relayUrl(rendezvousUrl, peer.fingerprint);
		const relayed = await this._open(peer, relayUrl, PeerLinkMode.RELAY);

		this._links.set(peer.id, relayed);

		return this._toState(relayed);
	}

	/**
	 * Register the one listener told when a link drops.
	 *
	 * One rather than a list: there is exactly one thing in the application that
	 * reconnects, and a set of listeners would invite a second one to appear and dial
	 * the same peer twice.
	 */
	public onLinkLost(listener: (peerId: string) => void): void {
		this._onLost = listener;
	}

	public state(peerId: string): PeerLinkState | null {
		const link = this._links.get(peerId);

		return link ? this._toState(link) : null;
	}

	public isLinked(peerId: string): boolean {
		return this._links.get(peerId)?.connected ?? false;
	}

	/** A call and its answer. Throws `PEER_UNREACHABLE` when there is no link. */
	public async request<T>(peerId: string, method: string, params: unknown = {}): Promise<T> {
		return this._link(peerId).request<T>(method, params);
	}

	/** A call whose answer is bytes — a range of a file the peer holds. */
	public async openStream(
		peerId: string,
		method: string,
		params: unknown = {},
	): Promise<Readable> {
		return this._link(peerId).requestStream(method, params);
	}

	/**
	 * Hang up deliberately, which is never a reason to dial again.
	 *
	 * The link marks itself as closed by us, so the drop listener stays quiet — a peer
	 * we removed or banned must not come back through the reconnection loop.
	 */
	public disconnect(peerId: string): void {
		this._links.get(peerId)?.close();
		this._links.delete(peerId);
	}

	public onModuleDestroy(): void {
		for (const link of this._links.values()) {
			link.close();
		}

		this._links.clear();
	}

	private _isRejection(error: unknown): boolean {
		if (!(error instanceof ServiceUnavailableException)) {
			return false;
		}

		const response = error.getResponse() as { key?: string };

		// A version we cannot speak counts as a refusal too: the rendezvous would send
		// us to the same machine, which would refuse the same way, and it would be
		// reported as unreachable — sending somebody to look at their firewall for a
		// problem that is a release difference.
		return (
			response?.key === ErrorKey.PEER_REJECTED ||
			response?.key === ErrorKey.PEER_PROTOCOL_UNSUPPORTED
		);
	}

	private _link(peerId: string): PeerLink {
		const link = this._links.get(peerId);

		if (!link?.connected) {
			throw new ServiceUnavailableException({ key: ErrorKey.PEER_UNREACHABLE, peerId });
		}

		return link;
	}

	private async _open(
		peer: PeerDescriptor,
		address: string,
		mode: PeerLinkMode,
	): Promise<PeerLink> {
		const url = this._toWebSocketUrl(address, mode);
		const challenge = `${this._fingerprint}:${Date.now()}`;

		const socket = new WebSocket(url, {
			headers: {
				// The far end checks these before accepting: who we claim to be, and a
				// signature proving it. Everything after this frame is authenticated by
				// the socket itself.
				'x-mcs-fingerprint': this._fingerprint,
				'x-mcs-public-key': Buffer.from(this._publicKeyPem).toString('base64'),
				'x-mcs-challenge': challenge,
				'x-mcs-signature': this.sign(challenge),
			},
			handshakeTimeout: CONNECT_TIMEOUT_MS,
		});

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('peer link timed out')), CONNECT_TIMEOUT_MS);

			timer.unref?.();

			socket.once('open', () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});

		const link = new PeerLink(peer.id, mode, address, socket, this._logger, (peerId) => {
			// Dropped from the map here rather than by the listener: a closed socket must
			// not stay in it, whether or not anybody is listening, or `isLinked` would
			// keep answering true for a link that can no longer carry a byte.
			this._links.delete(peerId);
			this._onLost?.(peerId);
		});

		// The address came from somewhere we do not control, so the far end proves it
		// holds the key behind the fingerprint before anything else happens. A machine
		// that cannot is dropped without being told what it got wrong.
		//
		// Our own hello travels in the same frame, so that by the time either end can
		// ask for anything, both have the other's version and capabilities. Two frames
		// would leave a window in which one side knows and the other is guessing.
		const handshake = await link
			.request<PeerHandshake>(PEER_HELLO_METHOD, { challenge, hello: this.hello() })
			.catch(() => null);

		if (!handshake || !this._isProofValid(peer, handshake, challenge)) {
			link.close();

			throw new ServiceUnavailableException({ key: ErrorKey.PEER_REJECTED });
		}

		const protocol = negotiateProtocol(handshake.hello.protocol);

		if (protocol === null) {
			// A flat refusal, and deliberately not a fallback to some older behaviour:
			// pre-release there is one version, and a gateway that guessed at a protocol
			// it does not implement fails later, somewhere unrelated, with an error about
			// a missing field.
			link.close();

			throw new ServiceUnavailableException({ key: ErrorKey.PEER_PROTOCOL_UNSUPPORTED });
		}

		link.protocol = protocol;
		link.capabilities = handshake.hello.capabilities;
		link.nodeId = handshake.hello.nodeId || null;

		this._logger.log(
			`Linked to ${peer.name} over ${mode} at ${address}, protocol ${protocol} ` +
				`with [${handshake.hello.capabilities.join(', ')}]`,
		);

		return link;
	}

	private _isProofValid(
		peer: PeerDescriptor,
		handshake: PeerHandshake,
		challenge: string,
	): boolean {
		if (typeof handshake.publicKey !== 'string' || typeof handshake.signature !== 'string') {
			return false;
		}

		if (this.fingerprintOf(handshake.publicKey) !== handshake.hello?.fingerprint) {
			return false;
		}

		if (handshake.hello.fingerprint !== peer.fingerprint) {
			return false;
		}

		return this.verify(handshake.publicKey, challenge, handshake.signature);
	}

	private _toWebSocketUrl(address: string, mode: PeerLinkMode): string {
		if (address.startsWith('ws://') || address.startsWith('wss://')) {
			return address;
		}

		const scheme = address.startsWith('https://') ? 'wss://' : 'ws://';
		const host = address.replace(/^https?:\/\//, '').replace(/\/+$/, '');

		// The same port the interface and the API are on. There is no second one, and
		// that is the point: a reverse proxy and its certificate cover peer traffic for
		// free, and there is nothing extra to forward on a router.
		return `${scheme}${host}${PEER_LINK_PATH}${mode === PeerLinkMode.RELAY ? '/relay' : ''}`;
	}

	private _toState(link: PeerLink): PeerLinkState {
		return {
			peerId: link.peerId,
			mode: link.mode,
			address: link.address,
			connected: link.connected,
			since: link.since,
			protocol: link.protocol,
			capabilities: [...link.capabilities],
			nodeId: link.nodeId,
		};
	}

	/**
	 * The key pair, loaded from disk or generated on first start.
	 *
	 * Ed25519 because the signatures are small, the keys are short enough to paste
	 * into an invitation, and there is nothing to choose or get wrong. Written with
	 * owner-only permissions: this file is the gateway's identity, and anybody
	 * holding it can be us to every friend we have.
	 */
	private _loadOrCreateKeys(): { privateKey: string; publicKey: string } {
		const path = process.env.PEER_KEY_PATH ?? join(process.env.MCS_DATA_DIR ?? DEFAULT_DATA_DIR, KEY_FILE);

		try {
			const privateKey = readFileSync(path, 'utf8');

			return {
				privateKey,
				publicKey: createPublicKey(privateKey)
					.export({ type: 'spki', format: 'pem' })
					.toString(),
			};
		} catch {
			const pair = generateKeyPairSync('ed25519', {
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			});

			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, pair.privateKey, { mode: 0o600 });
			} catch (error) {
				// A gateway that cannot persist its identity still works for this run,
				// but every friend will see a new fingerprint after a restart — which
				// looks exactly like an impersonation attempt. Worth a loud warning.
				this._logger.error(
					`Peer identity could not be written to ${path}: it will change on restart (${String(error)})`,
				);
			}

			return { privateKey: pair.privateKey, publicKey: pair.publicKey };
		}
	}
}
