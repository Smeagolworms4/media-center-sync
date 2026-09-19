import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';

/**
 * How much of the file each sampled window covers.
 *
 * Large enough that three windows contain real, varied compressed data — the tail
 * of a container is not padding, the middle is picture — and small enough that the
 * three reads are one seek each on any disk. A quarter of a megabyte times three is
 * the entire cost of deciding whether a friend holds the same file we do.
 */
export const SAMPLE_SIZE = 256 * 1024;

/**
 * Version marker in front of every identifier.
 *
 * Two gateways must compute the same value with no communication, which means the
 * sampling rule is a protocol, not an implementation detail. Changing the windows
 * or the digest changes this prefix, so an old identifier and a new one can never
 * be compared as if they meant the same thing.
 */
const FINGERPRINT_VERSION = 'q1';

export interface FileFingerprint {
	size: number;
	quickHash: string;
	contentId: string;
}

/**
 * Cheap content identity, and the expensive kind when it is finally worth paying.
 *
 * The whole argument for this class is a cost comparison: hashing a forty-gigabyte
 * season to find out whether a friend has the same episodes costs more, in time and
 * in disk, than downloading the ones we are missing. Reading three windows and the
 * byte count costs nothing and answers the same question well enough to match on —
 * so that is what correlation and swarm discovery use, and the full hash is computed
 * exactly once, at verification, when we already have the bytes in hand and a wrong
 * answer would mean keeping a corrupt file.
 */
@Injectable()
export class FingerprintService {
	/**
	 * Head, middle and tail, folded together with the exact size.
	 *
	 * The size is hashed in rather than merely compared, so two files that differ
	 * only in length can never produce the same value even if every sampled window
	 * happens to agree — which is precisely what happens with a truncated download of
	 * the file next to it.
	 */
	public async fingerprint(path: string): Promise<FileFingerprint> {
		const { size } = await stat(path);
		const handle = await open(path, 'r');

		try {
			const digest = createHash('sha256');

			// The size goes in first and in a fixed textual form: a decimal string is
			// the one encoding two independent implementations cannot disagree about,
			// where a 64-bit integer would invite an endianness argument.
			digest.update(`${FINGERPRINT_VERSION}:${size}:`);

			for (const { offset, length } of this._sampleWindows(size)) {
				if (length <= 0) {
					continue;
				}

				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);

				// A short read at the end of a file being written into is normal. Hashing
				// what actually arrived keeps the value a function of the bytes rather
				// than of the buffer we happened to allocate.
				digest.update(buffer.subarray(0, bytesRead));
			}

			const quickHash = digest.digest('hex');

			return { size, quickHash, contentId: this.contentId(quickHash, size) };
		} finally {
			await handle.close();
		}
	}

	/**
	 * The swarm identifier.
	 *
	 * Derived rather than stored separately so that anything holding a quick hash and
	 * a size — a peer's catalogue entry, a row we indexed months ago — can produce the
	 * same identifier without reading the file again.
	 */
	public contentId(quickHash: string, size: number): string {
		const digest = createHash('sha256').update(`${FINGERPRINT_VERSION}:${quickHash}:${size}`);

		return `${FINGERPRINT_VERSION}-${digest.digest('hex')}`;
	}

	/**
	 * The full hash, streamed.
	 *
	 * Streamed and not read into memory for the obvious reason, and computed only at
	 * verification: this is the call that costs forty gigabytes of reading, and the
	 * only moment that is worth it is when the alternative is trusting a file we just
	 * assembled from four strangers.
	 */
	public async fullHash(path: string, algorithm = 'sha256'): Promise<string> {
		const digest = createHash(algorithm);
		const stream = createReadStream(path);

		for await (const chunk of stream) {
			digest.update(chunk as Buffer);
		}

		return digest.digest('hex');
	}

	/**
	 * The hash of one range, which is what per-piece verification compares.
	 *
	 * Reading the range back off the disk rather than hashing the buffer we just
	 * wrote is deliberate: it catches the case the whole exercise exists for, a write
	 * that reported success and landed short because the disk filled up.
	 */
	public async hashRange(
		path: string,
		start: number,
		end: number,
		algorithm = 'sha256',
	): Promise<string> {
		const digest = createHash(algorithm);
		const stream = createReadStream(path, { start, end });

		for await (const chunk of stream) {
			digest.update(chunk as Buffer);
		}

		return digest.digest('hex');
	}

	/** In-memory digest, for a piece still in flight. */
	public hashBuffer(buffer: Buffer, algorithm = 'sha256'): string {
		return createHash(algorithm).update(buffer).digest('hex');
	}

	/**
	 * Where the three windows sit, as a function of the size alone.
	 *
	 * A function of the size alone is the entire requirement: two gateways that never
	 * speak have to pick the same three windows. A file too small for three distinct
	 * windows is read whole, which is both cheaper and exact.
	 */
	private _sampleWindows(size: number): { offset: number; length: number }[] {
		if (size <= SAMPLE_SIZE * 3) {
			return [{ offset: 0, length: size }];
		}

		return [
			{ offset: 0, length: SAMPLE_SIZE },
			{ offset: Math.floor(size / 2) - Math.floor(SAMPLE_SIZE / 2), length: SAMPLE_SIZE },
			{ offset: size - SAMPLE_SIZE, length: SAMPLE_SIZE },
		];
	}
}
