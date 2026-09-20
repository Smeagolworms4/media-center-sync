import { Readable } from 'node:stream';
import { ErrorKey, PeerCapability, TransferTransport as TransportKind } from '@mcs/shared';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ByteRange } from '../handlers/media-handler.interface';
import { PeerLinkService } from '../peer-link.service';
import type { ContentHolder } from '../peer-catalogue.service';
import { Transport } from './transport.decorator';
import type {
	ByteTransport,
	TransferSourceRef,
	TransportCapabilities,
	TransportChunk,
	TransportFetchOptions,
} from './transport.interface';

/** How many piece requests one peer may have outstanding at a time. */
const PIPELINE_DEPTH = 4;

/** Peers that fail this many pieces in a row are dropped from the set. */
const FAILURE_LIMIT = 3;

/**
 * One member of a swarm, and what it has told us it holds.
 *
 * `available` is a set rather than a bitfield because a swarm here is a handful of
 * friends, not ten thousand strangers, and a set is readable in a log.
 */
export interface SwarmPeer {
	holder: ContentHolder;
	available: Set<number>;
	/** Requests currently outstanding, which is what the pipelining limit counts. */
	inFlight: number;
	failures: number;
	/** Bytes per second measured over the pieces it has served. */
	rate: number;
}

export interface SwarmSession {
	contentId: string;
	pieceLength: number;
	pieceCount: number;
	totalBytes: number | null;
	peers: Map<string, SwarmPeer>;
	/** Pieces already delivered to the engine, so a prefetch does not repeat them. */
	delivered: Set<number>;
}

/**
 * How bytes are actually moved between two gateways in a swarm.
 *
 * This is the seam. Everything above it — the peer set, the rarest-first picker,
 * the pipelining, the failure accounting — is real and runs; everything below it is
 * one method per message type, implemented here over the existing peer link. A real
 * wire protocol replaces this interface and nothing else: a BitTorrent-style
 * implementation would add a handshake, `bitfield`, `have`, `interested`/`choke`
 * and out-of-order `piece` messages on a socket of its own, and the scheduler above
 * would not change, because it already asks exactly those questions.
 *
 * What is deliberately not here, and would be the first things a real wire needs:
 * choke/unchoke and the tit-for-tat accounting that goes with it, endgame mode
 * (requesting the last few pieces from everybody at once), and serving pieces back
 * out while downloading. None of it is stubbed or faked — it is absent, and the
 * in-process implementation below simply asks each peer for the range it wants.
 */
export interface SwarmWire {
	/**
	 * May this peer be asked for pieces at all?
	 *
	 * Separate from `bitfield` because the answer is not about the file: a gateway
	 * that never advertised the swarm capability is not a peer with no pieces, it is a
	 * peer that will refuse the question. Asking anyway costs a round trip per piece
	 * and fills the log with refusals that look like a network problem.
	 */
	usable(peer: ContentHolder): boolean;

	/** Which pieces this peer holds. An empty answer means "all of it". */
	bitfield(peer: ContentHolder, contentId: string, pieceCount: number): Promise<number[] | null>;

	/** One piece, or a range of one. Rejects rather than returning short. */
	fetchPiece(
		peer: ContentHolder,
		contentId: string,
		range: ByteRange,
		pieceIndex: number,
	): Promise<Readable>;
}

/**
 * The wire we actually have: the authenticated peer link, one request per piece.
 *
 * Honest about what it is — it is not a swarm protocol, it is N point-to-point
 * requests scheduled like one. The scheduling is what the multi-peer fetch buys,
 * and it is where most of the benefit is: pieces come from whoever is fastest and
 * still has capacity, and a peer that stalls stops being asked.
 */
@Injectable()
export class PeerLinkSwarmWire implements SwarmWire {
	public constructor(private readonly _links: PeerLinkService) {}

	/**
	 * Only a peer that said it speaks the swarm.
	 *
	 * This is the third of the three rules the protocol grows by, and the one that has
	 * to be enforced somewhere rather than remembered: a feature is used because the
	 * far end advertised it, never because we have it. A peer with no capabilities has
	 * not completed a handshake, which is the same answer as having said no.
	 */
	public usable(peer: ContentHolder): boolean {
		return this._links.supports(peer.peerId, PeerCapability.SWARM);
	}

	public async bitfield(
		peer: ContentHolder,
		contentId: string,
		pieceCount: number,
	): Promise<number[] | null> {
		const answer = await this._links
			.request<{ pieces?: number[] | null }>(peer.peerId, 'swarm.bitfield', {
				contentId,
				pieceCount,
			})
			.catch(() => null);

		// A peer that cannot answer is assumed to hold the whole file: it advertised
		// the content identifier, which is a claim about the complete file. Assuming
		// the opposite would exclude every peer running an older version.
		return answer?.pieces ?? null;
	}

	public async fetchPiece(
		peer: ContentHolder,
		contentId: string,
		range: ByteRange,
		pieceIndex: number,
	): Promise<Readable> {
		return this._links.openStream(peer.peerId, 'swarm.piece', {
			contentId,
			serviceId: peer.serviceId,
			externalId: peer.externalId,
			pieceIndex,
			start: range.start,
			end: range.end,
		});
	}
}

/**
 * Several peers feeding one file, keyed by content identifier.
 *
 * The swarm exists because a friend of a friend's upstream is as good as anybody's,
 * and because the file we want is often held by three people who each have a
 * quarter of the bandwidth we need. Peers are found by content identifier — computed
 * identically on every gateway from sampled ranges and the size, with no
 * coordination — so a transfer can pick up sources nobody told it about.
 *
 * The piece picker is rarest first, which is not an optimisation but the thing that
 * keeps a swarm alive: without it everybody downloads the common pieces, the rare
 * ones live on one machine, and that machine going offline strands everyone. Here
 * it decides prefetch order; the engine still asks for the piece it needs next, and
 * gets it from whichever peer is idle and holds it.
 */
@Injectable()
@Transport(TransportKind.SWARM)
export class SwarmTransport implements ByteTransport {
	public readonly transport = TransportKind.SWARM;

	private readonly _logger = new Logger(SwarmTransport.name);
	private readonly _sessions = new Map<string, SwarmSession>();

	public constructor(private readonly _wire: PeerLinkSwarmWire) {}

	/**
	 * Build the peer set for a content identifier.
	 *
	 * The holders are handed in on the source rather than discovered here, because
	 * who counts as a usable peer is a policy question — friends only, or friends of
	 * friends too — and policy belongs above a transport.
	 */
	public async prepare(source: TransferSourceRef): Promise<TransportCapabilities> {
		const contentId = source.contentId;

		if (!contentId) {
			// Without an identifier there is no swarm: it is the only thing peers agree
			// on without talking, and the only key the peer set is built from.
			throw new ServiceUnavailableException({
				key: ErrorKey.SYNC_NO_SOURCE,
				detail: 'a swarm transfer needs a contentId',
			});
		}

		const holders = source.holders ?? [];
		const pieceLength = source.sizeHint ? this._pieceLength(source.sizeHint) : 4 * 1024 * 1024;
		const pieceCount = source.sizeHint ? Math.ceil(source.sizeHint / pieceLength) : 0;

		const session: SwarmSession = {
			contentId,
			pieceLength,
			pieceCount,
			totalBytes: source.sizeHint ?? null,
			peers: new Map(),
			delivered: new Set(),
		};

		await Promise.all(
			holders.map(async (holder) => {
				if (!this._wire.usable(holder)) {
					this._logger.debug(`${holder.peerName} does not speak the swarm; not asking it`);

					return;
				}

				const pieces = await this._wire.bitfield(holder, contentId, pieceCount);

				session.peers.set(holder.peerId, {
					holder,
					// A null answer means the whole file; an empty array means nothing,
					// and the difference is the entire reason `bitfield` may return null.
					available: new Set(
						pieces ?? Array.from({ length: pieceCount }, (_, index) => index),
					),
					inFlight: 0,
					failures: 0,
					rate: 0,
				});
			}),
		);

		this._sessions.set(this._key(source), session);

		if (session.peers.size === 0) {
			throw new ServiceUnavailableException({ key: ErrorKey.SYNC_NO_SOURCE });
		}

		return {
			resumable: true,
			totalBytes: session.totalBytes,
			// One connection per peer. Opening several against one friend's gateway
			// gains nothing the peer set does not already give, and costs them sockets.
			maxConnections: session.peers.size,
			pieceChecksums: null,
		};
	}

	public async fetch(
		source: TransferSourceRef,
		range: ByteRange,
		options: TransportFetchOptions = {},
	): Promise<TransportChunk> {
		const session = this._sessions.get(this._key(source));

		if (!session) {
			throw new ServiceUnavailableException({
				key: ErrorKey.SYNC_NO_SOURCE,
				detail: 'swarm session was not prepared',
			});
		}

		const pieceIndex = options.chunkIndex ?? Math.floor(range.start / session.pieceLength);
		const attempted = new Set<string>();

		for (;;) {
			const peer = this._pick(session, pieceIndex, attempted);

			if (!peer) {
				throw new ServiceUnavailableException({
					key: ErrorKey.SYNC_NO_SOURCE,
					detail: `no swarm peer holds piece ${pieceIndex}`,
				});
			}

			attempted.add(peer.holder.peerId);
			peer.inFlight += 1;

			const startedAt = Date.now();

			try {
				const stream = await this._wire.fetchPiece(
					peer.holder,
					session.contentId,
					range,
					pieceIndex,
				);

				// Rate is measured on delivery rather than on the request, so a peer that
				// answers instantly and then trickles is ranked on what it actually sent.
				stream.once('end', () => {
					const elapsed = Math.max(1, Date.now() - startedAt);

					peer.rate = ((range.end - range.start + 1) / elapsed) * 1000;
					peer.inFlight = Math.max(0, peer.inFlight - 1);
					peer.failures = 0;
					session.delivered.add(pieceIndex);
				});

				stream.once('error', () => {
					peer.inFlight = Math.max(0, peer.inFlight - 1);
					peer.failures += 1;
				});

				return { stream, wholeFile: false, length: range.end - range.start + 1 };
			} catch (error) {
				peer.inFlight = Math.max(0, peer.inFlight - 1);
				peer.failures += 1;

				this._logger.warn(
					`Swarm peer ${peer.holder.peerName} failed piece ${pieceIndex}: ${String(error)}`,
				);

				// A peer that keeps failing is removed rather than retried forever: the
				// swarm's whole advantage is that there is somebody else to ask.
				if (peer.failures >= FAILURE_LIMIT) {
					session.peers.delete(peer.holder.peerId);
				}
			}
		}
	}

	public async release(source: TransferSourceRef): Promise<void> {
		this._sessions.delete(this._key(source));
	}

	/**
	 * Which pieces to want next, rarest first.
	 *
	 * Exposed and pure so the ordering can be reasoned about on its own. The engine
	 * asks for pieces in whatever order its plan says; this is what a prefetch — or a
	 * real wire protocol's request queue — would follow instead.
	 */
	public rarestFirst(session: SwarmSession, wanted: number[]): number[] {
		const availability = new Map<number, number>();

		for (const piece of wanted) {
			let holders = 0;

			for (const peer of session.peers.values()) {
				if (peer.available.has(piece)) {
					holders += 1;
				}
			}

			availability.set(piece, holders);
		}

		// A piece nobody holds sorts last rather than first: it is not rare, it is
		// absent, and asking for it before the others wastes the swarm's time.
		return [...wanted].sort((left, right) => {
			const leftCount = availability.get(left) ?? 0;
			const rightCount = availability.get(right) ?? 0;

			if (leftCount === 0 || rightCount === 0) {
				return rightCount - leftCount;
			}

			return leftCount - rightCount || left - right;
		});
	}

	/**
	 * The peer to ask for one piece.
	 *
	 * Among those holding it and below the pipeline depth: the fastest measured
	 * first, friends before friends of friends at equal speed. A peer with nothing
	 * measured yet is given a chance rather than ranked last, or the first peer to
	 * answer would be the only one ever used.
	 */
	private _pick(
		session: SwarmSession,
		pieceIndex: number,
		attempted: Set<string>,
	): SwarmPeer | null {
		const candidates = [...session.peers.values()].filter(
			(peer) =>
				!attempted.has(peer.holder.peerId) &&
				peer.inFlight < PIPELINE_DEPTH &&
				(peer.available.size === 0 || peer.available.has(pieceIndex)),
		);

		if (candidates.length === 0) {
			return null;
		}

		return candidates.sort((left, right) => {
			if ((left.rate === 0) !== (right.rate === 0)) {
				return left.rate === 0 ? -1 : 1;
			}

			if (left.rate !== right.rate) {
				return right.rate - left.rate;
			}

			// Nearer wins when nothing measured separates them. It is a better
			// tie-break than the friend/not-friend pair it replaced, which read every
			// hop past the first as the same distance: with three hops allowed, a
			// machine two circles out was ranked level with one that was four.
			return left.holder.depth - right.holder.depth;
		})[0];
	}

	/**
	 * Piece size for a file.
	 *
	 * Powers of two from four to sixteen mebibytes, chosen so a large file does not
	 * turn into tens of thousands of requests. The exact value only has to be agreed
	 * within one transfer — unlike the content identifier, it is not a protocol
	 * constant — but keeping it a function of the size alone means two peers computing
	 * it separately land on the same number anyway.
	 */
	private _pieceLength(totalBytes: number): number {
		if (totalBytes > 32 * 1024 * 1024 * 1024) {
			return 16 * 1024 * 1024;
		}

		if (totalBytes > 8 * 1024 * 1024 * 1024) {
			return 8 * 1024 * 1024;
		}

		return 4 * 1024 * 1024;
	}

	private _key(source: TransferSourceRef): string {
		return `${source.contentId ?? source.externalId}`;
	}
}
