import { Injectable, Logger } from '@nestjs/common';
import { FingerprintService, SAMPLE_SIZE, type FileFingerprint } from './fingerprint.service';
import { HandlerRegistry } from './handlers/handler.registry';
import type { MediaItemRef, ServiceConnection } from './handlers/media-handler.interface';

/**
 * How many bytes one window is allowed to cost before the attempt is abandoned.
 *
 * A server that ignores the range and starts sending the file would otherwise have
 * this reading a twenty-gigabyte film to produce a two-hundred-kilobyte answer. The
 * ceiling is the window itself plus a little slack for a response that overshoots by
 * a buffer; anything past it is a server that did not do what was asked.
 */
const READ_CEILING = SAMPLE_SIZE * 2;

/**
 * The identity of a copy this gateway cannot reach on a disk of its own.
 *
 * The gap it closes is the ordinary household one, and it cost the owner a transfer to
 * find: Jellyfin and Plex indexing the same file on the same NAS, only one of them
 * mounted. The mounted copy is fingerprinted at every scan and the other never is, so
 * two records of one file can never be shown to be one file — and the gateway offers
 * to fetch, over the network, twenty gigabytes that are already on the disk it would
 * write them to.
 *
 * Neither media server publishes a content hash worth comparing. Jellyfin publishes
 * none at all, and Plex's own is Plex's own — two different algorithms over the same
 * bytes produce two different values, so the only thing two servers can ever agree
 * about is the bytes. This fetches three windows of them, which is exactly what the
 * local path reads, and hands them to the same function. See `fingerprintOf`.
 *
 * **What it costs and what it shows.** Three ranges of a quarter of a megabyte, once,
 * for a file whose identity is actually in question. On Plex that is a `download=1`
 * fetch of the original part: no transcode, no session in "now playing", and no watched
 * flag, since those come from a client reporting progress and nothing here reports any.
 * Jellyfin's download route behaves the same way; if a server has downloads disabled it
 * falls back to its streaming route, which does register a session, and that is the one
 * visible trace this can leave.
 *
 * **It never guesses.** A server that will not serve ranges is left alone rather than
 * read whole: the point of this is to be cheaper than the transfer it prevents.
 */
@Injectable()
export class RemoteFingerprintService {
	private readonly _logger = new Logger(RemoteFingerprintService.name);

	public constructor(
		private readonly _handlers: HandlerRegistry,
		private readonly _fingerprints: FingerprintService,
	) {}

	/**
	 * Fetch enough of a remote copy to identify it, or answer null.
	 *
	 * Null for every reason a caller cannot act on differently — no handler, no size,
	 * no ranges, a refusal, a timeout. The caller's alternative is to know nothing about
	 * this copy, which is where it already was, so a failure here is not an error
	 * anywhere: it is logged and the pass goes on.
	 *
	 * The size is the caller's rather than the server's on purpose. It is the size the
	 * index recorded and the size the comparison will be made against, so fingerprinting
	 * against a different one would produce a value that answers a question nobody
	 * asked.
	 */
	public async fingerprint(
		connection: ServiceConnection,
		item: MediaItemRef,
		size: number,
	): Promise<FileFingerprint | null> {
		if (size <= 0) {
			return null;
		}

		const handler = this._handlers.get(connection.type);

		if (!handler) {
			return null;
		}

		try {
			return await this._fingerprints.fingerprintOf(size, async (offset, length) => {
				const opened = await handler.openStream(connection, item, {
					start: offset,
					end: offset + length - 1,
				});

				/*
				 * A source that ignores the range is refused rather than read.
				 *
				 * Without this the first window would stream the whole film through a
				 * hash to produce a quarter of a megabyte of answer — slower and far more
				 * expensive than the transfer this exists to avoid.
				 */
				if (!opened.acceptsRanges) {
					opened.stream.destroy();

					throw new Error('the source does not serve ranges');
				}

				const chunks: Buffer[] = [];
				let read = 0;

				for await (const chunk of opened.stream) {
					const buffer = chunk as Buffer;

					chunks.push(buffer);
					read += buffer.length;

					if (read >= length) {
						break;
					}

					// A response longer than the window was asked for, from a server that
					// accepted the range and then sent more anyway. Stopping here keeps the
					// cost bounded; the extra bytes are dropped below.
					if (read > READ_CEILING) {
						break;
					}
				}

				opened.stream.destroy();

				return Buffer.concat(chunks).subarray(0, length);
			});
		} catch (error: unknown) {
			this._logger.debug(
				`Could not identify ${item.externalId} on service ${connection.id}: ${String(error)}`,
			);

			return null;
		}
	}
}
