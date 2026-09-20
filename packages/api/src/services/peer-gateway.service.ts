import type { IncomingMessage, Server } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import {
	ErrorKey,
	PEER_HELLO_METHOD,
	type PeerHandshake,
	type PeerHello,
} from '@mcs/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';

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
	/** Where the socket came from, for a peer we have never seen. */
	address: string | null;
}

/** Who a credential turned out to belong to. */
export interface PeerAdmission {
	peerId: string;
	name: string;
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

	public constructor(
		public readonly peerId: string,
		public readonly peerName: string,
		private readonly _socket: WebSocket,
		private readonly _authority: PeerLinkAuthority,
		private readonly _methods: PeerMethodHandler | undefined,
		private readonly _logger: Logger,
		private readonly _onClose: (session: PeerSession) => void,
	) {
		this._greeting = setTimeout(() => {
			if (this._hello === null) {
				this._logger.warn(`${this.peerName} connected and never said hello`);
				this.close();
			}
		}, HELLO_TIMEOUT_MS);
		this._greeting.unref?.();

		this._socket.on('message', (data: Buffer, isBinary: boolean) => {
			// Nothing in this protocol travels from the far end as bytes: binary frames
			// only ever go the other way, carrying what was asked for. One arriving here
			// is something we do not understand, and the rule for those is to ignore
			// them rather than to drop a link that is otherwise working.
			if (!isBinary) {
				void this._onMessage(data);
			}
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

	public constructor(
		@Optional()
		@Inject(PEER_LINK_AUTHORITY)
		private readonly _authority?: PeerLinkAuthority,
		@Optional()
		@Inject(PEER_METHOD_HANDLER)
		private readonly _methods?: PeerMethodHandler,
	) {
		this._server = new WebSocketServer({ noServer: true });
	}

	public attach(server: Server): void {
		server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			const { pathname } = new URL(request.url ?? '/', 'http://localhost');

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

	public onModuleDestroy(): void {
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
			const session = new PeerSession(
				admission.peerId,
				admission.name,
				client,
				authority,
				this._methods,
				this._logger,
				(closed) => this._sessions.delete(closed),
			);

			this._sessions.add(session);
			this._logger.log(`${admission.name} opened a peer link`);
		});
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
