import { ErrorKey, PeerLinkMode, TransferTransport as TransportKind } from '@mcs/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { ByteRange } from '../handlers/media-handler.interface';
import { PeerLinkService } from '../peer-link.service';
import { Transport } from './transport.decorator';
import type {
	ByteTransport,
	TransferSourceRef,
	TransportCapabilities,
	TransportChunk,
	TransportFetchOptions,
} from './transport.interface';

/** What a peer answers when asked to describe something it holds. */
interface RemoteDescription {
	size?: number;
	resumable?: boolean;
	/** Piece hashes, when the far end has them. Indexed by piece number. */
	pieces?: Record<string, string>;
	chunkSize?: number;
}

/**
 * A relayed link is somebody else's bandwidth in the middle.
 *
 * Fewer connections through it, not because the protocol cannot take more but
 * because the friend in the middle is doing us a favour, and four transfers each
 * opening four relayed sockets is how that favour stops being offered.
 */
const MAX_DIRECT_CONNECTIONS = 4;
const MAX_RELAYED_CONNECTIONS = 2;

/**
 * Pulls through an established peer link.
 *
 * This transport does not establish anything: the link is `PeerLinkService`'s,
 * already authenticated, already either direct or relayed. That separation is what
 * lets a transfer survive a link that drops and comes back on the other mode
 * halfway through — the transport asks for the same range over whatever link
 * exists now, and neither end has to know it changed.
 */
@Injectable()
@Transport(TransportKind.PEER_DIRECT)
export class PeerTransport implements ByteTransport {
	public readonly transport = TransportKind.PEER_DIRECT;

	public constructor(private readonly _links: PeerLinkService) {}

	public async prepare(source: TransferSourceRef): Promise<TransportCapabilities> {
		const peerId = this._peerId(source);
		const description = await this._links.request<RemoteDescription>(peerId, 'media.describe', {
			serviceId: source.serviceId,
			externalId: source.externalId,
			contentId: source.contentId ?? null,
		});

		const state = this._links.state(peerId);
		const pieces = new Map<number, string>();

		for (const [index, checksum] of Object.entries(description.pieces ?? {})) {
			pieces.set(Number(index), checksum);
		}

		return {
			// Another gateway always serves ranges — it is our own code at the far end —
			// so the only reason this would be false is a far end that says so.
			resumable: description.resumable !== false,
			totalBytes: description.size ?? source.sizeHint ?? null,
			maxConnections:
				state?.mode === PeerLinkMode.RELAY ? MAX_RELAYED_CONNECTIONS : MAX_DIRECT_CONNECTIONS,
			// Piece hashes from a peer are the difference between repairing two
			// megabytes and refetching thirty gigabytes, which is why the protocol
			// bothers to carry them. The size they were computed over goes with them:
			// without it the engine cannot tell whether piece seventeen over there is
			// the same range as chunk seventeen over here, and has to ignore them.
			pieceChecksums: pieces.size > 0 ? pieces : null,
			pieceSize: description.chunkSize ?? null,
		};
	}

	public async fetch(
		source: TransferSourceRef,
		range: ByteRange,
		options: TransportFetchOptions = {},
	): Promise<TransportChunk> {
		const peerId = this._peerId(source);
		const stream = await this._links.openStream(peerId, 'media.range', {
			serviceId: source.serviceId,
			externalId: source.externalId,
			contentId: source.contentId ?? null,
			start: range.start,
			end: range.end,
			chunkIndex: options.chunkIndex ?? null,
		});

		return {
			stream,
			// The far end is our own protocol: it either serves the range asked for or
			// answers with an error. There is no case where it sends the whole file and
			// pretends otherwise.
			wholeFile: false,
			length: range.end - range.start + 1,
		};
	}

	private _peerId(source: TransferSourceRef): string {
		if (!source.peerId) {
			throw new BadRequestException({
				key: ErrorKey.PEER_NOT_FOUND,
				detail: `source ${source.serviceId} has no peer`,
			});
		}

		return source.peerId;
	}
}
