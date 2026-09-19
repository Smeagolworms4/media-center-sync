import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
	verify as verifyBytes,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { ErrorKey, PeerLinkMode, type PeerIdentity } from '@mcs/shared';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	ServiceUnavailableException,
} from '@nestjs/common';
import { WebSocket } from 'ws';
import { RendezvousClient } from './rendezvous.client';

/** Where the gateway's own key pair lives, unless the environment says otherwise. */
const DEFAULT_DATA_DIR = './data';
const KEY_FILE = 'peer-identity.pem';

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

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

	private readonly _pending = new Map<number, PendingRequest>();
	private _nextRequestId = 1;

	public constructor(
		public readonly peerId: string,
		public readonly mode: PeerLinkMode,
		public readonly address: string | null,
		private readonly _socket: WebSocket,
		private readonly _logger: Logger,
	) {
		this._socket.on('message', (data: Buffer, isBinary: boolean) =>
			this._onMessage(data, isBinary),
		);
		this._socket.on('close', () => this._failAll(new Error('link closed')));
		this._socket.on('error', (error) => this._failAll(error));
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
		this._failAll(new Error('link closed'));
		this._socket.close();
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

	private readonly _privateKeyPem: string;
	private readonly _publicKeyPem: string;
	private readonly _fingerprint: string;

	public constructor(private readonly _rendezvous: RendezvousClient) {
		const keys = this._loadOrCreateKeys();

		this._privateKeyPem = keys.privateKey;
		this._publicKeyPem = keys.publicKey;
		this._fingerprint = this.fingerprintOf(keys.publicKey);
	}

	public identity(name: string, rendezvousUrl: string | null): PeerIdentity {
		return {
			fingerprint: this._fingerprint,
			name,
			rendezvous: rendezvousUrl ?? '',
			directAddress: process.env.PEER_PUBLIC_ADDRESS ?? null,
			directReachable: !!process.env.PEER_PUBLIC_ADDRESS,
		};
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

		return response?.key === ErrorKey.PEER_REJECTED;
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

		const link = new PeerLink(peer.id, mode, address, socket, this._logger);

		// The address came from somewhere we do not control, so the far end proves it
		// holds the key behind the fingerprint before anything else happens. A machine
		// that cannot is dropped without being told what it got wrong.
		const proof = await link
			.request<{ fingerprint: string; publicKey: string; signature: string }>('peer.hello', {
				challenge,
			})
			.catch(() => null);

		if (!proof || !this._isProofValid(peer, proof, challenge)) {
			link.close();

			throw new ServiceUnavailableException({ key: ErrorKey.PEER_REJECTED });
		}

		this._logger.log(`Linked to ${peer.name} over ${mode} at ${address}`);

		return link;
	}

	private _isProofValid(
		peer: PeerDescriptor,
		proof: { fingerprint: string; publicKey: string; signature: string },
		challenge: string,
	): boolean {
		if (this.fingerprintOf(proof.publicKey) !== proof.fingerprint) {
			return false;
		}

		if (proof.fingerprint !== peer.fingerprint) {
			return false;
		}

		return this.verify(proof.publicKey, challenge, proof.signature);
	}

	private _toWebSocketUrl(address: string, mode: PeerLinkMode): string {
		if (address.startsWith('ws://') || address.startsWith('wss://')) {
			return address;
		}

		const scheme = address.startsWith('https://') ? 'wss://' : 'ws://';
		const host = address.replace(/^https?:\/\//, '').replace(/\/+$/, '');

		return `${scheme}${host}/api/peer${mode === PeerLinkMode.RELAY ? '/relay' : ''}`;
	}

	private _toState(link: PeerLink): PeerLinkState {
		return {
			peerId: link.peerId,
			mode: link.mode,
			address: link.address,
			connected: link.connected,
			since: link.since,
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
