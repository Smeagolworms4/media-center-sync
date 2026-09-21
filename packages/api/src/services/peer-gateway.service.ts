import type { IncomingMessage, Server } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import {
	ErrorKey,
	PEER_HELLO_METHOD,
	PEER_INTRODUCTION_HEADER,
	PEER_RELAY_PATH_SUFFIX,
	RelayRefusal,
	type PeerHandshake,
	type PeerHello,
} from '@mcs/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import { isRelayFrame } from './peer-relay.frames';
import { PeerRelayService, type RelayChannel, type RelayedSocket } from './peer-relay.service';

/**
 * Where another gateway connects, on the same port as everything else.
 *
 * One port, deliberately. A second listener would need its own firewall rule, its own
 * entry in whatever reverse proxy sits in front, and its own certificate to be usable
 * over TLS — three things to get right for a link that works perfectly well as an
 * upgrade on the port the interface is already served from. It also means a peer link
 * inherits the proxy's TLS for free, which is the difference between "forward a port"
 * and "nothing to do".
 */
export const PEER_LINK_PATH = '/api/peer/link';

/**
 * Where a gateway asks this one to carry a link to a friend it cannot reach.
 *
 * A second path rather than a flag on the first, because the two upgrades mean
 * opposite things: one says "be my peer", the other says "put me through to somebody
 * else". A gateway that answered the same path either way would decide which by
 * reading a header, and the one header that can say so is the introduction token —
 * which an ordinary dial from a stranger carries too.
 */
export const PEER_RELAY_PATH = `${PEER_LINK_PATH}${PEER_RELAY_PATH_SUFFIX}`;

/**
 * How long a link has to say hello before it is dropped.
 *
 * A socket that connected and then went quiet holds a file descriptor and a row in
 * the session map forever. Ten seconds is far beyond any real handshake — the far end
 * sends its hello as the first frame after the upgrade — and short enough that a port
 * scanner cannot accumulate sockets.
 */
export const HELLO_TIMEOUT_MS = 10_000;

/** Binary frames carry the identifier of the request that asked for those bytes. */
const FRAME_HEADER_BYTES = 4;

/** What the far end presented at the upgrade, before anything was believed. */
export interface PeerCredential {
	fingerprint: string;
	/** PEM of the public key they claim, as sent. */
	publicKey: string;
	/** `<their fingerprint>:<epoch millis>`, which they signed. */
	challenge: string;
	signature: string;
	/**
	 * A token from a gateway we are linked to, saying who this is and how far away.
	 *
	 * Absent for an ordinary link, which is every link between two friends. It is
	 * present when the far end has never met us and was sent here by a peer of ours —
	 * and it is the only way a socket from a stranger gets past the authority, so it is
	 * read here and judged nowhere near here.
	 */
	introduction: string | null;
	/** Where the socket came from, for a peer we have never seen. */
	address: string | null;
}

/** Who a credential turned out to belong to. */
export interface PeerAdmission {
	peerId: string;
	name: string;
}

/**
 * Who this gateway agreed to carry a link to, and for whom.
 *
 * `holderPeerId` is *our* row identifier for the gateway on the far side, because it
 * is the only name a link can be looked up by here. Working it out is the authority's
 * job and not this file's: the token names a fingerprint, and turning a fingerprint
 * into a peer we are still willing to help means reading rows, a ban list and a
 * setting.
 */
export interface PeerRelayGrant {
	holderPeerId: string;
	holderName: string;
	/** For the log, so a household can see whose bytes it carried. */
	subjectName: string;
}

/**
 * Who decides whether a socket is a peer, and what we answer it.
 *
 * A port rather than a direct dependency, and for the same reason the peer guard has
 * one: admitting a link is a decision about trust, an invitation and a status, none
 * of which belong in something whose job is to frame bytes. This file knows it has to
 * ask.
 */
export interface PeerLinkAuthority {
	/** The peer behind this credential, or null when the link must be refused. */
	admit(credential: PeerCredential): Promise<PeerAdmission | null>;

	/**
	 * Answer their hello with ours.
	 *
	 * Null when the version they speak is not one of ours, which is a refusal rather
	 * than a degraded mode: a gateway that guessed would fail later, somewhere
	 * unrelated, with an error about a missing field.
	 */
	greet(peerId: string, hello: PeerHello, challenge: string): Promise<PeerHandshake | null>;

	/**
	 * An inbound link ended. Whether that means anything is the authority's business.
	 *
	 * It exists because one kind of peer is not meant to outlive its link: somebody
	 * introduced by a friend, pulling one file, whom this gateway was not asked to
	 * keep. Reported through the port rather than through a listener the manager
	 * registers, because the manager is already what this service asks for admission —
	 * injecting the service back into it would be a cycle, and a second wire for one
	 * callback.
	 *
	 * Optional so that an authority with no opinion about closed links — every test
	 * double, and any future one — does not have to write an empty method.
	 */
	released?(peerId: string): void;

	/**
	 * May this gateway carry a link for whoever is dialling, and to whom?
	 *
	 * Null refuses, and refuses flatly: an authority that told "I do not carry" apart
	 * from "that is not my peer" would let somebody map out a gateway's friends by
	 * dialling it with tokens.
	 *
	 * Optional for the same reason `released` is — a double with no opinion is a valid
	 * authority — and an absent one means nothing is ever carried, which is the state
	 * this gateway was in before any of it existed.
	 */
	carry?(credential: PeerCredential): Promise<PeerRelayGrant | null>;
}

export const PEER_LINK_AUTHORITY = 'mcs:peer-link-authority';

/** Whether a method answers with a value or with bytes. */
export const PeerMethodKind = {
	VALUE: 'value',
	STREAM: 'stream',
} as const;

export type PeerMethodKindValue = (typeof PeerMethodKind)[keyof typeof PeerMethodKind];

/**
 * What this gateway answers, once the link is established.
 *
 * `kind` returning null is how an unknown method is recognised, and it is answered
 * rather than fatal: the far end gets `error.peer.method_unsupported` and the link
 * stays open, which is what lets one side gain a method while the other has not been
 * updated yet.
 */
export interface PeerMethodHandler {
	kind(method: string): PeerMethodKindValue | null;
	call(peerId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
	stream(peerId: string, method: string, params: Record<string, unknown>): Promise<Readable>;
}

export const PEER_METHOD_HANDLER = 'mcs:peer-method-handler';

/**
 * What an inbound link needs of its socket, which is less than a socket.
 *
 * Narrowed to this so that a session carried inside another peer's link can be the
 * same object as one on a socket of its own — see `RelayedSocket`. The alternative
 * was a second session class for relayed links, which would be two implementations of
 * the handshake, the dispatch and the close, disagreeing the first time either gained
 * a step. `ws` satisfies this as it stands.
 */
export interface PeerSocket {
	readonly readyState: number;
	on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
	on(event: 'close', listener: () => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	send(data: string | Buffer, callback?: (error?: Error) => void): void;
	close(): void;
}

/** A frame the far end sent us. Anything it carries beyond this is ignored. */
interface PeerRequestFrame {
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

/**
 * One inbound link, from the upgrade to the close.
 *
 * A plain class rather than an injectable, like `PeerLink` on the outgoing side:
 * there is one per socket and its lifetime is the socket's.
 */
class PeerSession {
	private _hello: PeerHello | null = null;
	private _closed = false;

	private readonly _greeting: NodeJS.Timeout;

	/** What this link is carrying for other people, or null when it may carry nothing. */
	private readonly _channel: RelayChannel | null;

	public constructor(
		public readonly peerId: string,
		public readonly peerName: string,
		private readonly _socket: PeerSocket,
		private readonly _authority: PeerLinkAuthority,
		private readonly _methods: PeerMethodHandler | undefined,
		private readonly _logger: Logger,
		private readonly _onClose: (session: PeerSession) => void,
		relay?: PeerRelayService,
	) {
		this._greeting = setTimeout(() => {
			if (this._hello === null) {
				this._logger.warn(`${this.peerName} connected and never said hello`);
				this.close();
			}
		}, HELLO_TIMEOUT_MS);
		this._greeting.unref?.();

		const socket = _socket;

		this._channel =
			relay?.register({
				peerId,
				// They opened this socket, so this end numbers relayed sessions from one.
				// See `RelayTransport.dialled` for what collides otherwise.
				dialled: false,
				get open(): boolean {
					return socket.readyState === WebSocket.OPEN;
				},
				send: (frame: Buffer) => socket.send(frame),
			}) ?? null;

		this._socket.on('message', (data: Buffer, isBinary: boolean) => {
			if (isBinary) {
				// Nothing of the ordinary protocol travels from the far end as bytes:
				// binary frames only ever go the other way, carrying what was asked for.
				// The one exception is a link this gateway agreed to carry for somebody
				// else, which is marked by an identifier that can never be a request.
				if (this._channel !== null && isRelayFrame(data)) {
					this._channel.receive(data);
				}

				return;
			}

			void this._onMessage(data);
		});
		this._socket.on('close', () => this._finish());
		this._socket.on('error', (error) => {
			this._logger.debug(`Link with ${this.peerName} failed: ${String(error)}`);
			this._finish();
		});
	}

	public get greeted(): boolean {
		return this._hello !== null;
	}

	public get hello(): PeerHello | null {
		return this._hello;
	}

	public close(): void {
		this._socket.close();
		this._finish();
	}

	private _finish(): void {
		if (this._closed) {
			return;
		}

		this._closed = true;
		clearTimeout(this._greeting);
		// Whatever was riding on this socket goes with it. A carried session left behind
		// is a buffer nothing drains and a friend waiting on bytes that cannot arrive.
		this._channel?.close();
		this._onClose(this);
	}

	private async _onMessage(data: Buffer): Promise<void> {
		let frame: PeerRequestFrame;

		try {
			frame = JSON.parse(data.toString('utf8')) as PeerRequestFrame;
		} catch {
			this._logger.warn(`Unreadable frame from ${this.peerName}`);

			return;
		}

		// A frame with no identifier can never be answered — there is nothing to answer
		// to — so there is no error to send and nothing to do but drop it.
		if (typeof frame.id !== 'number' || typeof frame.method !== 'string') {
			return;
		}

		const id = frame.id;
		const params = this._params(frame.params);

		if (frame.method === PEER_HELLO_METHOD) {
			await this._greet(id, params);

			return;
		}

		// Nothing is served before the hello. Without this line a socket that got
		// through the upgrade could read the catalogue without ever agreeing on a
		// version, and the first incompatibility would surface as a malformed answer
		// somewhere else entirely.
		if (this._hello === null) {
			this._answer({ id, error: ErrorKey.PEER_REJECTED });

			return;
		}

		await this._dispatch(id, frame.method, params);
	}

	private async _greet(id: number, params: Record<string, unknown>): Promise<void> {
		const hello = this._toHello(params.hello);
		const challenge = typeof params.challenge === 'string' ? params.challenge : '';

		if (hello === null) {
			this._answer({ id, error: ErrorKey.PEER_REJECTED });
			this.close();

			return;
		}

		let answer: PeerHandshake | null;

		try {
			answer = await this._authority.greet(this.peerId, hello, challenge);
		} catch (error) {
			// A handshake that failed on our side is not a version we refuse, and
			// answering as if it were would send somebody looking at their release
			// number for a database that was unreachable for a second.
			this._logger.warn(`Handshake with ${this.peerName} failed: ${String(error)}`);
			this._answer({ id, error: errorKeyOf(error) });
			this.close();

			return;
		}

		if (answer === null) {
			// Refused outright rather than downgraded. Pre-release there is one version,
			// and carrying compatibility for versions nobody ever ran is weight with no
			// cargo — it also hides the one thing a changing protocol should make loud.
			this._answer({ id, error: ErrorKey.PEER_PROTOCOL_UNSUPPORTED });
			this.close();

			return;
		}

		this._hello = hello;
		clearTimeout(this._greeting);
		this._answer({ id, result: answer });
		this._logger.log(
			`${this.peerName} speaks protocol ${hello.protocol} with [${hello.capabilities.join(', ')}]`,
		);
	}

	private async _dispatch(
		id: number,
		method: string,
		params: Record<string, unknown>,
	): Promise<void> {
		const methods = this._methods;
		const kind = methods?.kind(method) ?? null;

		if (methods === undefined || kind === null) {
			// An answer, not a failure, and the link stays open. This is one of the three
			// rules that let the wire grow without a version bump.
			this._answer({ id, error: ErrorKey.PEER_METHOD_UNSUPPORTED });

			return;
		}

		try {
			if (kind === PeerMethodKind.VALUE) {
				this._answer({ id, result: await methods.call(this.peerId, method, params) });

				return;
			}

			await this._pump(id, await methods.stream(this.peerId, method, params));
		} catch (error) {
			this._answer({ id, error: errorKeyOf(error) });
		}
	}

	/**
	 * The bytes, framed with the identifier of the request that asked for them.
	 *
	 * Every frame is awaited rather than fired at the socket, which is what makes the
	 * far end's window the limit on how much of a file is held in memory here. Without
	 * it a peer pulling a forty-gigabyte season over a slow line would have us buffer
	 * the whole of it.
	 */
	private async _pump(id: number, stream: Readable): Promise<void> {
		try {
			for await (const chunk of stream) {
				const payload = Buffer.from(chunk as Buffer);
				const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);

				frame.writeUInt32BE(id, 0);
				payload.copy(frame, FRAME_HEADER_BYTES);

				await this._send(frame);
			}
		} catch (error) {
			stream.destroy();
			this._answer({ id, error: errorKeyOf(error) });

			return;
		}

		// Only an explicit end closes a byte stream at the far end. A stream that
		// simply stopped is indistinguishable from a complete one, and that is how a
		// truncated chunk passes for a finished file.
		this._answer({ id, end: true });
	}

	private _send(frame: Buffer): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this._socket.readyState !== WebSocket.OPEN) {
				reject(new Error('link closed'));

				return;
			}

			this._socket.send(frame, (error) => (error ? reject(error) : resolve()));
		});
	}

	private _answer(message: { id: number; result?: unknown; error?: string; end?: boolean }): void {
		if (this._socket.readyState !== WebSocket.OPEN) {
			return;
		}

		this._socket.send(JSON.stringify(message));
	}

	private _params(raw: unknown): Record<string, unknown> {
		return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	}

	/**
	 * Their hello, keeping only what this version knows about.
	 *
	 * Anything else in it is dropped rather than refused: a field we have never heard
	 * of is how a newer gateway carries something we do not need, and refusing it would
	 * make every addition a breaking change.
	 */
	private _toHello(raw: unknown): PeerHello | null {
		if (typeof raw !== 'object' || raw === null) {
			return null;
		}

		const candidate = raw as Partial<PeerHello>;

		if (typeof candidate.protocol !== 'number' || typeof candidate.fingerprint !== 'string') {
			return null;
		}

		return {
			nodeId: typeof candidate.nodeId === 'string' ? candidate.nodeId : '',
			fingerprint: candidate.fingerprint,
			name: typeof candidate.name === 'string' ? candidate.name : '',
			protocol: candidate.protocol,
			capabilities: Array.isArray(candidate.capabilities)
				? candidate.capabilities.filter((value): value is PeerHello['capabilities'][number] =>
					typeof value === 'string',
				)
				: [],
		};
	}
}

/**
 * The error key behind an exception, whatever shape it was thrown in.
 *
 * Three shapes reach here and all three are used in this code base:
 * `new NotFoundException({ key })`, where the object is returned verbatim, and
 * `new NotFoundException(key)`, where Nest wraps the string into `{ message, ... }`
 * before anybody sees it. Reading only the first was enough to turn every
 * `error.media.not_found` into `error.general` on the wire, and the far end acted on
 * it: a source that no longer holds an item is decisive, and "something went wrong"
 * is not.
 */
const errorKeyOf = (error: unknown): string => {
	const response = (error as { getResponse?: () => unknown }).getResponse?.();

	if (typeof response === 'string') {
		return response;
	}

	const body = response as { key?: unknown; message?: unknown } | undefined;

	if (typeof body?.key === 'string') {
		return body.key;
	}

	return typeof body?.message === 'string' ? body.message : ErrorKey.GENERAL;
};

/**
 * Where other gateways connect, sharing the HTTP server with the interface.
 *
 * The room was left for this in the event gateway: both claim a path and leave every
 * other upgrade alone, so one port carries the interface, its event stream and every
 * peer link. `refuseUnknownUpgrades` closes the set, because an upgrade nobody claims
 * would otherwise sit open until something times out.
 *
 * Authentication is the far end's business to prove and the authority's to judge. The
 * headers are the same ones the outgoing side sends — fingerprint, public key, a
 * challenge and its signature — and nothing here decides what they are worth.
 */
@Injectable()
export class PeerGatewayService implements OnModuleDestroy {
	private readonly _logger = new Logger(PeerGatewayService.name);
	private readonly _server: WebSocketServer;
	private readonly _sessions = new Set<PeerSession>();

	/**
	 * Whether the process is going away rather than a peer.
	 *
	 * Without it, a shutdown closes every session and each one is reported to the
	 * authority as a peer that has finished with us — which, for a peer met through an
	 * introduction and not kept, means deleting its row while the database connection
	 * is being torn down.
	 */
	private _stopping = false;

	public constructor(
		@Optional()
		@Inject(PEER_LINK_AUTHORITY)
		private readonly _authority?: PeerLinkAuthority,
		@Optional()
		@Inject(PEER_METHOD_HANDLER)
		private readonly _methods?: PeerMethodHandler,
		/**
		 * Optional so that a gateway built without one simply never relays, which is
		 * what every double in the tests wants and what this service did before.
		 */
		@Optional()
		private readonly _relay?: PeerRelayService,
	) {
		this._server = new WebSocketServer({ noServer: true });

		// Bound here rather than injected the other way round: a link carried inside
		// somebody else's socket still has to be admitted, greeted and dispatched, and
		// this is the only thing that knows how. The relay must not learn any of it.
		this._relay?.bind({ accept: (payload, socket) => this._admitRelayed(payload, socket) });
	}

	public attach(server: Server): void {
		server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			const { pathname } = new URL(request.url ?? '/', 'http://localhost');

			if (pathname === PEER_RELAY_PATH) {
				void this._carry(request, socket, head);

				return;
			}

			// Left alone rather than refused: the event stream's handler is on the same
			// server and claims its own path.
			if (pathname !== PEER_LINK_PATH) {
				return;
			}

			void this._open(request, socket, head);
		});

		this._logger.log(`Peer links listening on ${PEER_LINK_PATH}`);
	}

	public get sessionCount(): number {
		return this._sessions.size;
	}

	/** The peers with a live inbound link, for anything that needs to know. */
	public get linkedPeerIds(): string[] {
		return [...this._sessions].map((session) => session.peerId);
	}

	/** Set `_stopping` first: a shutdown is not every peer finishing with us at once. */
	public onModuleDestroy(): void {
		this._stopping = true;

		for (const session of this._sessions) {
			session.close();
		}

		this._sessions.clear();
		this._server.close();
	}

	private async _open(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const credential = this._credential(request);

		if (credential === null) {
			this._refuse(socket, 401, 'peer credential required');

			return;
		}

		const authority = this._authority;

		// No authority bound means no credential can be checked, and an unchecked peer
		// link hands the catalogue to whoever guesses a fingerprint — which is public by
		// design. Refusing is the only safe reading of a missing verifier.
		if (authority === undefined) {
			this._refuse(socket, 503, 'no peer authority');

			return;
		}

		const admission = await authority.admit(credential).catch((error: unknown) => {
			this._logger.error(`Admission failed: ${String(error)}`);

			return null;
		});

		if (admission === null) {
			// The same answer for an unknown fingerprint, a bad signature and a key on
			// the ban list. Telling them apart would let somebody discover they are
			// refused by watching what happens, which is more than they should know.
			this._refuse(socket, 401, 'peer refused');

			return;
		}

		// An `await` happened since the upgrade arrived, so the socket may be gone.
		// `handleUpgrade` on a destroyed socket throws from inside `ws`.
		if (socket.destroyed) {
			return;
		}

		this._server.handleUpgrade(request, socket, head, (client) => {
			this._session(authority, admission, client, 'opened a peer link', this._relay);
		});
	}

	/**
	 * Somebody wants this gateway to put them through to a friend of ours.
	 *
	 * The order is the point. The holder is asked first, over the link they already
	 * have with us, and only once they have taken it is the upgrade completed — so a
	 * refusal is an HTTP status on a socket that never became a peer link, which is
	 * exactly what the dialler's ladder is written to fall through. Completing the
	 * upgrade first would mean closing a WebSocket the far end had already begun a
	 * handshake on, and that failure is indistinguishable from a link that dropped.
	 *
	 * Every refusal is the same 503 with no detail. Telling "I do not carry" from "that
	 * is not my peer" apart would let anybody holding a token map out this gateway's
	 * friends and its settings.
	 */
	private async _carry(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const relay = this._relay;
		const authority = this._authority;
		const credential = this._credential(request);

		if (relay === undefined || credential === null || authority?.carry === undefined) {
			this._refuse(socket, 503, 'no relay here');

			return;
		}

		const grant = await authority.carry(credential).catch((error: unknown) => {
			this._logger.error(`Relay grant failed: ${String(error)}`);

			return null;
		});

		if (grant === null) {
			this._refuse(socket, 503, 'no relay here');

			return;
		}

		const session = await relay.reserve(grant.holderPeerId, {
			fingerprint: credential.fingerprint,
			publicKey: credential.publicKey,
			challenge: credential.challenge,
			signature: credential.signature,
			introduction: credential.introduction,
			address: credential.address,
		});

		if (session === null) {
			this._refuse(socket, 503, 'no relay here');

			return;
		}

		// Two awaits happened since the upgrade arrived, so the dialler may have given
		// up. The reserved place has to go back, or a gateway that timed out twice would
		// use up everything this household offered to carry.
		if (socket.destroyed) {
			relay.abandon(session, RelayRefusal.LINK_LOST);

			return;
		}

		this._server.handleUpgrade(request, socket, head, (client) => {
			relay.attach(session, client);
			this._logger.log(`Carrying a link from ${grant.subjectName} to ${grant.holderName}`);
		});
	}

	/**
	 * A link that reached us inside a friend's socket, admitted like any other.
	 *
	 * The credential is the dialler's own — their key, their signed challenge, and a
	 * token one of our peers minted — so the authority answers the same question it
	 * answers for a direct upgrade, against the same rows. The carrier vouches for
	 * nothing and is not consulted.
	 */
	private async _admitRelayed(
		credential: PeerCredential,
		client: RelayedSocket,
	): Promise<boolean> {
		const authority = this._authority;

		if (authority === undefined || this._stopping) {
			return false;
		}

		const admission = await authority.admit(credential).catch((error: unknown) => {
			this._logger.error(`Admission failed: ${String(error)}`);

			return null;
		});

		if (admission === null) {
			return false;
		}

		this._session(authority, admission, client, 'opened a peer link through a relay');

		return true;
	}

	/**
	 * One inbound session, however its bytes arrive.
	 *
	 * Shared by the two paths above rather than written twice, because everything that
	 * matters about an inbound link — the hello timeout, the dispatch, what a close
	 * means for a peer we were not asked to keep — has to be identical whether the
	 * socket is ours or a session on somebody else's.
	 */
	private _session(
		authority: PeerLinkAuthority,
		admission: PeerAdmission,
		client: PeerSocket,
		what: string,
		relay?: PeerRelayService,
	): void {
		const session = new PeerSession(
			admission.peerId,
			admission.name,
			client,
			authority,
			this._methods,
			this._logger,
			(closed) => {
				this._sessions.delete(closed);

				if (!this._stopping) {
					authority.released?.(closed.peerId);
				}
			},
			relay,
		);

		this._sessions.add(session);
		this._logger.log(`${admission.name} ${what}`);
	}

	/**
	 * What the far end put on the upgrade, or null when it put nothing usable.
	 *
	 * Read here and judged elsewhere. The one thing this does decide is that all four
	 * have to be present: a partial credential is not a credential, and letting it
	 * through would have the authority checking a signature over an empty challenge.
	 */
	private _credential(request: IncomingMessage): PeerCredential | null {
		const fingerprint = this._header(request, 'x-mcs-fingerprint');
		const publicKey = this._header(request, 'x-mcs-public-key');
		const challenge = this._header(request, 'x-mcs-challenge');
		const signature = this._header(request, 'x-mcs-signature');

		if (!fingerprint || !publicKey || !challenge || !signature) {
			return null;
		}

		return {
			fingerprint,
			// Base64 on the wire because a PEM is multi-line and a header is not.
			publicKey: Buffer.from(publicKey, 'base64').toString('utf8'),
			challenge,
			signature,
			// Optional, and deliberately not part of the "all four or nothing" rule
			// above: a link between two friends carries no introduction, and requiring
			// one would refuse every ordinary peer.
			introduction: this._header(request, PEER_INTRODUCTION_HEADER) || null,
			address: request.socket.remoteAddress ?? null,
		};
	}

	private _header(request: IncomingMessage, name: string): string {
		const value = request.headers[name];

		return (Array.isArray(value) ? value[0] : value) ?? '';
	}

	private _refuse(socket: Duplex, status: number, reason: string): void {
		if (socket.destroyed) {
			return;
		}

		socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
		socket.destroy();
	}
}

/**
 * Close the set: an upgrade to a path nobody claims is refused, not left hanging.
 *
 * Both gateways return rather than reject when the path is not theirs, which is what
 * lets them share one server. The cost is that nothing answers an upgrade to anything
 * else, and Node does not close it for you: the socket stays open, half upgraded,
 * until some timeout somewhere gives up. Registered after both, so it only ever sees
 * what neither took.
 */
export const refuseUnknownUpgrades = (server: Server, paths: readonly string[]): void => {
	server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');

		if (paths.includes(pathname) || socket.destroyed) {
			return;
		}

		socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
		socket.destroy();
	});
};
