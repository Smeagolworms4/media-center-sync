import { EventEmitter } from 'node:events';
import {
	RELAY_MAX_BUFFERED_BYTES,
	RELAY_MAX_SESSIONS,
	RELAY_OPEN_TIMEOUT_MS,
	RelayOpcode,
	RelayRefusal,
	type RelayOpcodeValue,
	type RelayOpenPayload,
} from '@mcs/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BandwidthService } from './bandwidth.service';
import { RelayFrameReader, encodeRelayFrame, type RelayFrame } from './peer-relay.frames';
import { SettingsService } from './settings.service';

/** The two states a carried socket is ever in, spelled as `ws` spells them. */
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/**
 * A live peer link, seen by the relay as somewhere to put a frame.
 *
 * Deliberately this small. The relay does not care whether the link underneath is one
 * this gateway dialled or one a friend opened to it — and it must not, because the
 * whole reason relaying exists is the case where the only usable socket is the inbound
 * one. What it does need is `dialled`, and only to split the session numbering: both
 * ends of one link may carry a session at the same time, and two sessions with the
 * same number on one socket would deliver one end's bytes to the other's reader. The
 * side that dialled numbers from two, the side that answered from one.
 */
export interface RelayTransport {
	readonly peerId: string;
	readonly dialled: boolean;
	/** True while the link can still carry a frame. */
	readonly open: boolean;
	send(frame: Buffer): void;
}

/** What a link gets back, so it can feed the relay and let go of it. */
export interface RelayChannel {
	/** A binary message arrived that `isRelayFrame` recognised. */
	receive(data: Buffer): void;
	/** The link is gone, whatever took it. */
	close(): void;
}

/** The far end of a carried session, at the gateway the link is really for. */
export interface RelayEndpoint {
	/**
	 * Turn a carried session into an inbound peer link, or refuse it.
	 *
	 * False rather than a thrown error for a refusal, because every refusal reaching
	 * here is the ordinary one — a credential the authority did not admit — and the
	 * carrier is told the same flat "no" for all of them.
	 */
	accept(payload: RelayOpenPayload, socket: RelayedSocket): Promise<boolean>;
}

/**
 * A socket that is really a session on somebody else's link.
 *
 * It exists so that the gateway at the far end of a relayed link runs exactly the code
 * a direct one runs: the same admission, the same hello, the same method dispatch, the
 * same close. A second implementation of an inbound peer link — one for real sockets
 * and one for carried ones — would be two places for the handshake to be right in, and
 * they would disagree the first time either gained a step.
 *
 * Structurally what `ws` offers and nothing more, so it can be handed straight to the
 * session class. There is no back pressure to honour here: the bytes are already in
 * memory by the time they arrive, and the link underneath has its own.
 */
export class RelayedSocket extends EventEmitter {
	private _state = SOCKET_OPEN;

	public constructor(
		/** Puts a frame on the carrying link. Never called once closed. */
		private readonly _write: (opcode: RelayOpcodeValue, payload?: Buffer) => void,
		/** Told when this end hangs up, so the session can be forgotten. */
		private readonly _hangUp: () => void,
	) {
		super();
	}

	public get readyState(): number {
		return this._state;
	}

	public send(data: string | Buffer, callback?: (error?: Error) => void): void {
		if (this._state !== SOCKET_OPEN) {
			callback?.(new Error('relayed link closed'));

			return;
		}

		if (typeof data === 'string') {
			this._write(RelayOpcode.TEXT, Buffer.from(data, 'utf8'));
		} else {
			this._write(RelayOpcode.BINARY, data);
		}

		// Answered at once rather than when the far end acknowledges, which is what the
		// real socket does too: `ws` calls back when the frame is handed to the kernel,
		// not when it lands. A relayed frame handed to the carrying link has got exactly
		// as far.
		callback?.();
	}

	public close(): void {
		if (this._state === SOCKET_CLOSED) {
			return;
		}

		this._state = SOCKET_CLOSED;
		this._hangUp();
		this.emit('close');
	}

	/** The carrying end let go. Told, rather than telling. */
	public dropped(): void {
		if (this._state === SOCKET_CLOSED) {
			return;
		}

		this._state = SOCKET_CLOSED;
		this.emit('close');
	}

	public deliver(data: Buffer, isBinary: boolean): void {
		if (this._state === SOCKET_OPEN) {
			this.emit('message', data, isBinary);
		}
	}
}

/** One link this gateway is carrying for two friends. */
export interface CarriedSession {
	id: number;
	registration: Registration;
	/** The gateway that dialled us, once the upgrade has completed. */
	client: CarriedClient | null;
	/** Frames that arrived before the upgrade finished, which is a race, not a bug. */
	inbox: RelayFrame[];
	/** Bytes waiting on the bandwidth budget, against `RELAY_MAX_BUFFERED_BYTES`. */
	pending: number;
	queue: Promise<void>;
	settle: ((refusal: RelayRefusal | null) => void) | null;
	timer: NodeJS.Timeout | null;
	closed: boolean;
}

/** The dialler's socket, as the carrier uses it. `ws` satisfies this as it stands. */
export interface CarriedClient {
	readonly readyState: number;
	on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
	on(event: 'close', listener: () => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	send(data: string | Buffer): void;
	close(): void;
}

/** One link carried for us, at the gateway it was really for. */
interface HostedSession {
	id: number;
	socket: RelayedSocket;
}

/**
 * One registered peer link, with whatever it is carrying in either direction.
 *
 * Both maps hang off the link rather than off a gateway-wide table because they die
 * with it: when a socket goes, everything riding on it goes in one pass, and there is
 * no entry left anywhere pointing at a link that no longer exists.
 */
export class Registration implements RelayChannel {
	public readonly reader = new RelayFrameReader();
	public readonly carried = new Map<number, CarriedSession>();
	public readonly hosted = new Map<number, HostedSession>();

	private _next: number;

	public constructor(
		public readonly transport: RelayTransport,
		private readonly _service: PeerRelayService,
	) {
		// See `RelayTransport.dialled`: two ends numbering from the same place would
		// collide the moment both carried something at once.
		this._next = transport.dialled ? 2 : 1;
	}

	public nextSession(): number {
		const id = this._next;

		this._next += 2;

		return id;
	}

	public receive(data: Buffer): void {
		this._service.deliver(this, data);
	}

	public close(): void {
		this._service.unregister(this);
	}
}

/**
 * Carrying a link between two friends who cannot reach each other.
 *
 * The shape of the problem, and the whole reason this is not simply another socket:
 * in the case that needs it, **the link to the holder is inbound**. They dialled this
 * gateway; this gateway cannot dial them, because if it could the friend asking for
 * the relay could too. So the bytes travel back down a socket that already exists and
 * is already carrying the ordinary peer protocol, inside the envelope described in
 * `peer-relay.model.ts`.
 *
 * Three decisions are recorded here because they are the ones somebody will want to
 * change and should not change without reading why.
 *
 * **Consent is one switch for the gateway, off by default** — `Settings.relayForPeers`.
 * Advertising `PeerCapability.RELAY` *is* the promise, so the capability is derived
 * from the setting and never hard-coded: a gateway that advertised it and refused
 * would waste fifteen seconds of somebody's dial at the one moment it mattered. It is
 * not per peer because the cost is one uplink and because a per-peer answer cannot be
 * advertised honestly in a handshake that happens once.
 *
 * **Relayed bytes are inside `uploadRateLimit`, not beside it.** The setting means
 * what this gateway is allowed to put on its uplink, and the uplink does not care why
 * a byte is leaving. A relay with its own budget would be a way for somebody else's
 * transfer to walk straight through a cap its owner set precisely to keep the line
 * usable for the household. Both directions are paid for, because both directions
 * leave this machine. Nothing is charged at the two ends: the holder already pays for
 * what it serves, at the source, in `PeerExchangeManager`.
 *
 * **Nothing here is encrypted and this file does not pretend otherwise.** The carrier
 * holds both halves in plaintext. That is why direct is tried first, why the peer card
 * says in one line when a link is relayed, and why the switch exists at all.
 */
@Injectable()
export class PeerRelayService implements OnModuleDestroy {
	private readonly _logger = new Logger(PeerRelayService.name);
	private readonly _links = new Set<Registration>();

	/**
	 * What turns a carried session into an inbound peer link.
	 *
	 * Bound by the gateway service rather than injected, because the dependency only
	 * runs one way: the inbound endpoint knows it may be reached through a relay, and
	 * the relay must not know what an admission or a hello is.
	 */
	private _endpoint: RelayEndpoint | null = null;

	private _stopping = false;

	public constructor(
		private readonly _settings: SettingsService,
		private readonly _bandwidth: BandwidthService,
	) {}

	/**
	 * Has somebody agreed to carry other people's bytes on this machine?
	 *
	 * Read from the settings on every ask rather than cached here. They are already
	 * held in memory by the settings service, so it costs nothing, and a copy kept here
	 * would be a second answer to the same question — one of which would be the stale
	 * one the day somebody turns the switch off to get their evening back.
	 */
	public async carrying(): Promise<boolean> {
		return (await this._settings.get()).relayForPeers;
	}

	public bind(endpoint: RelayEndpoint): void {
		this._endpoint = endpoint;
	}

	/** How many links this gateway is carrying right now, for a test and for a log. */
	public get carriedCount(): number {
		let count = 0;

		for (const registration of this._links) {
			count += registration.carried.size;
		}

		return count;
	}

	public register(transport: RelayTransport): RelayChannel {
		const registration = new Registration(transport, this);

		this._links.add(registration);

		return registration;
	}

	/**
	 * A link went away, and everything riding on it goes with it.
	 *
	 * This is the case an unbounded relay leaks on: the holder's socket drops, and
	 * without this the dialler is left holding a session that will never answer and the
	 * carrier a buffer that nothing will drain. Both ends are told, so both redial.
	 */
	public unregister(registration: Registration): void {
		if (!this._links.delete(registration)) {
			return;
		}

		for (const session of [...registration.carried.values()]) {
			this._closeCarried(session, RelayRefusal.LINK_LOST);
		}

		for (const session of [...registration.hosted.values()]) {
			registration.hosted.delete(session.id);
			session.socket.dropped();
		}
	}

	public onModuleDestroy(): void {
		this._stopping = true;

		for (const registration of [...this._links]) {
			this.unregister(registration);
		}
	}

	/**
	 * Ask the holder to take a link, and hold a place for it. Null when it cannot be.
	 *
	 * Run before the upgrade with the dialler is completed rather than after, so a
	 * refusal is an HTTP status on a socket that never became a peer link — which is
	 * what the dialler's ladder is written to fall through. Answering after the upgrade
	 * would mean closing a WebSocket the far end had already started a handshake on.
	 */
	public async reserve(
		holderPeerId: string,
		payload: RelayOpenPayload,
	): Promise<CarriedSession | null> {
		if (!(await this.carrying())) {
			return this._refused(RelayRefusal.NOT_CARRYING);
		}

		if (this.carriedCount >= RELAY_MAX_SESSIONS) {
			return this._refused(RelayRefusal.AT_CAPACITY);
		}

		const registration = this._routeTo(holderPeerId);

		if (registration === null) {
			return this._refused(RelayRefusal.NO_ROUTE);
		}

		const session: CarriedSession = {
			id: registration.nextSession(),
			registration,
			client: null,
			inbox: [],
			pending: 0,
			queue: Promise.resolve(),
			settle: null,
			timer: null,
			closed: false,
		};

		registration.carried.set(session.id, session);

		const refusal = await new Promise<RelayRefusal | null>((resolve) => {
			session.settle = resolve;
			session.timer = setTimeout(() => {
				// A holder running a version from before any of this existed drops the
				// frame it cannot place and never answers. That is the case this timeout
				// is really for, and it is why it is shorter than the dial above it.
				resolve(RelayRefusal.DECLINED);
			}, RELAY_OPEN_TIMEOUT_MS);
			session.timer.unref?.();

			registration.transport.send(
				encodeRelayFrame(
					RelayOpcode.OPEN,
					session.id,
					Buffer.from(JSON.stringify(payload), 'utf8'),
				),
			);
		});

		this._settled(session);

		if (refusal !== null) {
			registration.carried.delete(session.id);
			session.closed = true;

			return this._refused(refusal);
		}

		return session;
	}

	/**
	 * The dialler's socket finally exists. Join the two halves.
	 *
	 * Whatever arrived between the holder accepting and the upgrade completing is
	 * delivered here, in order. It is a narrow window and nothing should be in it —
	 * the dialler speaks first on a peer link — but a relay that dropped the frames in
	 * it would fail as a handshake that hangs, which is the least attributable failure
	 * of the lot.
	 */
	public attach(session: CarriedSession, client: CarriedClient): void {
		if (session.closed) {
			client.close();

			return;
		}

		session.client = client;

		client.on('message', (data: Buffer, isBinary: boolean) => {
			this._toHolder(session, isBinary ? RelayOpcode.BINARY : RelayOpcode.TEXT, data);
		});
		client.on('close', () => this._closeCarried(session, null));
		client.on('error', () => this._closeCarried(session, null));

		const waiting = session.inbox;

		session.inbox = [];

		for (const frame of waiting) {
			this._toClient(session, frame);
		}
	}

	/** Give a reserved place back when the upgrade never happened. */
	public abandon(session: CarriedSession, reason: RelayRefusal): void {
		this._closeCarried(session, reason);
	}

	/**
	 * A relay frame arrived on a link. Which half of the world it belongs to.
	 *
	 * `OPEN` is the only frame that creates anything; everything else names a session
	 * that either exists or does not, and one that does not is dropped in silence. That
	 * is deliberate: a `CLOSE` racing a `CLOSE` from the other end is the ordinary way
	 * a session ends, and answering it would have the two ends closing each other
	 * forever.
	 */
	public deliver(registration: Registration, data: Buffer): void {
		const frames = registration.reader.push(data);

		if (registration.reader.failed) {
			// There is no way to find the start of the next frame after a length nobody
			// can make sense of, so the sessions on this link are all suspect.
			this._logger.warn(`Unreadable relay frame from peer ${registration.transport.peerId}`);
			this.unregister(registration);

			return;
		}

		for (const frame of frames) {
			this._dispatch(registration, frame);
		}
	}

	private _dispatch(registration: Registration, frame: RelayFrame): void {
		if (frame.opcode === RelayOpcode.OPEN) {
			void this._host(registration, frame);

			return;
		}

		const carried = registration.carried.get(frame.session);

		if (carried !== undefined) {
			this._toClient(carried, frame);

			return;
		}

		const hosted = registration.hosted.get(frame.session);

		if (hosted === undefined) {
			return;
		}

		if (frame.opcode === RelayOpcode.CLOSE) {
			registration.hosted.delete(frame.session);
			hosted.socket.dropped();

			return;
		}

		if (frame.opcode === RelayOpcode.TEXT || frame.opcode === RelayOpcode.BINARY) {
			hosted.socket.deliver(frame.payload, frame.opcode === RelayOpcode.BINARY);
		}
	}

	/**
	 * Somebody's friend is being carried to us. Admit them as if they had dialled.
	 *
	 * Which is exactly what they did, from the credential's point of view: it is theirs,
	 * signed with their key, carrying a token our own peer minted. The carrier passed it
	 * on and vouches for none of it.
	 *
	 * Accepted even when this gateway does not itself carry anything. The two are
	 * different questions — agreeing to spend an uplink for other people, and agreeing
	 * to be reached — and conflating them would mean a household that declined to relay
	 * could not be reached through a friend who agreed to, which is the whole feature
	 * refusing itself.
	 */
	private async _host(registration: Registration, frame: RelayFrame): Promise<void> {
		const endpoint = this._endpoint;
		const refuse = (reason: RelayRefusal): void => {
			registration.transport.send(
				encodeRelayFrame(
					RelayOpcode.REFUSE,
					frame.session,
					Buffer.from(JSON.stringify({ reason }), 'utf8'),
				),
			);
		};

		if (endpoint === null || this._stopping) {
			refuse(RelayRefusal.DECLINED);

			return;
		}

		if (registration.hosted.size >= RELAY_MAX_SESSIONS) {
			refuse(RelayRefusal.AT_CAPACITY);

			return;
		}

		let payload: RelayOpenPayload;

		try {
			payload = JSON.parse(frame.payload.toString('utf8')) as RelayOpenPayload;
		} catch {
			refuse(RelayRefusal.NOT_ADDRESSED);

			return;
		}

		const socket = new RelayedSocket(
			(opcode, body) => {
				if (registration.transport.open) {
					registration.transport.send(encodeRelayFrame(opcode, frame.session, body));
				}
			},
			() => {
				registration.hosted.delete(frame.session);

				if (registration.transport.open) {
					registration.transport.send(encodeRelayFrame(RelayOpcode.CLOSE, frame.session));
				}
			},
		);

		// In the map before the authority is asked. Admission reads the database, and a
		// dialler that gave up during it would otherwise have its `CLOSE` arrive for a
		// session nobody had heard of yet — leaving the socket that came after it live
		// with nobody at the other end.
		registration.hosted.set(frame.session, { id: frame.session, socket });

		const admitted = await endpoint.accept(payload, socket).catch((error: unknown) => {
			this._logger.warn(`Relayed link refused: ${String(error)}`);

			return false;
		});

		if (!admitted) {
			registration.hosted.delete(frame.session);
			refuse(RelayRefusal.DECLINED);

			return;
		}

		registration.transport.send(encodeRelayFrame(RelayOpcode.ACCEPT, frame.session));
	}

	/** A frame from the holder, on its way to the gateway that dialled us. */
	private _toClient(session: CarriedSession, frame: RelayFrame): void {
		if (frame.opcode === RelayOpcode.ACCEPT || frame.opcode === RelayOpcode.REFUSE) {
			session.settle?.(frame.opcode === RelayOpcode.ACCEPT ? null : RelayRefusal.DECLINED);

			return;
		}

		if (frame.opcode === RelayOpcode.CLOSE) {
			this._closeCarried(session, null);

			return;
		}

		if (frame.opcode !== RelayOpcode.TEXT && frame.opcode !== RelayOpcode.BINARY) {
			return;
		}

		const client = session.client;

		if (client === null) {
			session.inbox.push(frame);

			return;
		}

		this._forward(session, frame.payload.length, () => {
			if (client.readyState === SOCKET_OPEN) {
				client.send(
					frame.opcode === RelayOpcode.BINARY
						? frame.payload
						: frame.payload.toString('utf8'),
				);
			}
		});
	}

	/** A frame from the dialler, on its way down the link the holder opened to us. */
	private _toHolder(session: CarriedSession, opcode: RelayOpcodeValue, data: Buffer): void {
		const payload = Buffer.from(data);

		this._forward(session, payload.length, () => {
			if (session.registration.transport.open) {
				session.registration.transport.send(encodeRelayFrame(opcode, session.id, payload));
			}
		});
	}

	/**
	 * Pay for the bytes, then write them, and never write two out of order.
	 *
	 * The queue is what makes the bandwidth budget safe to apply here: paying for a
	 * frame is a wait, and two waits that finish in the wrong order would hand the far
	 * end the second half of a message before the first. The counter beside it is the
	 * other half of the same problem — a fast holder feeding a slow dialler would
	 * otherwise have this gateway buffer the difference until the process died, which
	 * is the failure an unbounded relay really has.
	 */
	private _forward(session: CarriedSession, bytes: number, write: () => void): void {
		if (session.closed) {
			return;
		}

		session.pending += bytes;

		if (session.pending > RELAY_MAX_BUFFERED_BYTES) {
			this._closeCarried(session, RelayRefusal.OVERFLOW);

			return;
		}

		session.queue = session.queue
			.then(async () => {
				await this._bandwidth.send(bytes);

				if (!session.closed) {
					write();
				}

				session.pending -= bytes;
			})
			.catch((error: unknown) => {
				this._logger.warn(`Relayed session ${session.id} failed: ${String(error)}`);
				this._closeCarried(session, RelayRefusal.LINK_LOST);
			});
	}

	/**
	 * End a carried session once, from whichever side noticed.
	 *
	 * Both ends are told, and both are told at most once. A session that closed because
	 * its own client hung up passes a null reason: there is nothing to report, and the
	 * `CLOSE` frame carries no payload anyway.
	 */
	private _closeCarried(session: CarriedSession, reason: RelayRefusal | null): void {
		if (session.closed) {
			return;
		}

		session.closed = true;
		session.registration.carried.delete(session.id);
		this._settled(session);

		if (session.registration.transport.open) {
			session.registration.transport.send(encodeRelayFrame(RelayOpcode.CLOSE, session.id));
		}

		session.client?.close();

		if (reason !== null) {
			this._logger.debug(`Relayed session ${session.id} ended: ${reason}`);
		}
	}

	private _settled(session: CarriedSession): void {
		if (session.timer !== null) {
			clearTimeout(session.timer);
			session.timer = null;
		}

		session.settle = null;
	}

	/**
	 * A link to the holder, in whichever direction one exists.
	 *
	 * The inbound one is the whole point — a holder behind a router is reachable only
	 * through the socket it opened — but an outbound one carries a frame just as well,
	 * and refusing to use it would make the relay fail in the one case where it had the
	 * better socket of the two.
	 */
	private _routeTo(peerId: string): Registration | null {
		for (const registration of this._links) {
			if (registration.transport.peerId === peerId && registration.transport.open) {
				return registration;
			}
		}

		return null;
	}

	private _refused(reason: RelayRefusal): null {
		this._logger.log(`Refused to carry a link: ${reason}`);

		return null;
	}
}
