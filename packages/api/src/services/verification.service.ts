import { stat } from 'node:fs/promises';
import { ChunkState, type TransferVerification } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { FingerprintService } from './fingerprint.service';

/** A piece as verification sees it: where it is, and what it should hash to. */
export interface VerifiableChunk {
	index: number;
	start: number;
	end: number;
	state?: ChunkState;
	sourceServiceId?: string | null;
	/** Null when the source could not tell us. */
	checksum: string | null;
}

export interface VerificationRequest {
	transferId: string;
	/** The file as it stands — the working copy during a transfer, or the placed one. */
	path: string;
	chunks: VerifiableChunk[];
	expectedSize?: number | null;
	/** Whole-file hash, when anybody knows it. */
	expectedChecksum?: string | null;
}

export interface VerificationReport extends TransferVerification {
	/** Indexes to fetch again. Empty when the file is whole. */
	corruptChunks: number[];
	/** Why it failed, for the transfer's error message. */
	detail: string | null;
}

export interface RepairAssignment {
	chunkIndex: number;
	/** The source to try, chosen to differ from the one that served the bad bytes. */
	sourceServiceId: string | null;
	previousSourceServiceId: string | null;
}

/**
 * Checks what arrived, and works out how little has to come back.
 *
 * The premise is that a transfer failing its checksum is almost never wrong
 * everywhere: one source served a bad range, or a connection dropped mid-piece.
 * Discarding thirty gigabytes because two megabytes are wrong is what makes people
 * give up on syncing, so pieces are checked individually wherever the source gave
 * us something to check them against, and only the bad ones are fetched again —
 * preferably from somebody else, since the source that served bad bytes once is the
 * least likely to serve good ones now.
 */
@Injectable()
export class VerificationService {
	private readonly _logger = new Logger(VerificationService.name);

	public constructor(private readonly _fingerprint: FingerprintService) {}

	/**
	 * Verify a file against whatever evidence exists.
	 *
	 * Three levels, in descending order of usefulness: per-piece hashes, a whole-file
	 * hash, or nothing but the size. The last is weak and still worth doing — a file
	 * that is short is definitely wrong, and that is the failure a full disk produces.
	 */
	public async verify(request: VerificationRequest): Promise<VerificationReport> {
		const checkedAt = new Date().toISOString();
		const withChecksums = request.chunks.filter((chunk) => !!chunk.checksum);

		const size = await stat(request.path)
			.then((stats) => stats.size)
			.catch(() => null);

		if (size === null) {
			return this._report(request, checkedAt, [], 'the file is not there any more');
		}

		if (request.expectedSize != null && size !== request.expectedSize) {
			// A wrong size makes every piece hash meaningless — the offsets no longer
			// address what they were computed over — so nothing else is worth checking.
			return this._report(
				request,
				checkedAt,
				request.chunks.map((chunk) => chunk.index),
				`size is ${size}, expected ${request.expectedSize}`,
			);
		}

		if (withChecksums.length > 0) {
			const corrupt: number[] = [];

			for (const chunk of withChecksums) {
				const actual = await this._fingerprint.hashRange(request.path, chunk.start, chunk.end);

				if (actual !== chunk.checksum) {
					corrupt.push(chunk.index);
				}
			}

			return this._report(
				request,
				checkedAt,
				corrupt,
				corrupt.length > 0 ? `${corrupt.length} pieces did not match` : null,
			);
		}

		if (request.expectedChecksum) {
			const actual = await this._fingerprint.fullHash(request.path);

			if (actual === request.expectedChecksum) {
				return this._report(request, checkedAt, [], null);
			}

			// Without per-piece hashes there is nothing to say which part is wrong, so
			// every piece is suspect. This is the cost of a source that could not give
			// us piece hashes, and it is worth stating on screen rather than hiding.
			this._logger.warn(
				`Transfer ${request.transferId} failed its whole-file hash and has no piece hashes: every piece has to come back`,
			);

			return this._report(
				request,
				checkedAt,
				request.chunks.map((chunk) => chunk.index),
				'whole-file checksum mismatch, no piece hashes available',
			);
		}

		return this._report(request, checkedAt, [], null);
	}

	/**
	 * Verify a file that is already in the library.
	 *
	 * A rescan finds what arrival checks cannot: a file that was fine when it landed
	 * and was truncated later by a full disk, or by a move that was interrupted
	 * halfway. The gateway is the only thing on the machine that still knows what the
	 * file was supposed to contain.
	 */
	public async verifyPlaced(
		transferId: string,
		path: string,
		expectedSize: number | null,
		expectedChecksum: string | null,
	): Promise<VerificationReport> {
		return this.verify({
			transferId,
			path,
			chunks: [],
			expectedSize,
			expectedChecksum,
		});
	}

	/**
	 * Which pieces to fetch again, and from whom.
	 *
	 * Away from the source that served the bad bytes whenever there is anywhere else
	 * to go. Not because that source is necessarily at fault — a dropped connection
	 * looks identical from here — but because trying it again is the one choice that
	 * repeats the failure exactly.
	 */
	public planRepair(
		report: VerificationReport,
		chunks: VerifiableChunk[],
		availableSourceIds: string[],
	): RepairAssignment[] {
		const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]));

		return report.corruptChunks.map((chunkIndex, position) => {
			const previous = byIndex.get(chunkIndex)?.sourceServiceId ?? null;
			const alternatives = availableSourceIds.filter((id) => id !== previous);

			// Spread the repairs over the alternatives rather than sending them all to
			// the first one: a repair pass of two hundred pieces against a single
			// friend's gateway is a small denial of service.
			const chosen =
				alternatives.length > 0
					? alternatives[position % alternatives.length]
					: (availableSourceIds[0] ?? null);

			return { chunkIndex, sourceServiceId: chosen, previousSourceServiceId: previous };
		});
	}

	private _report(
		request: VerificationRequest,
		checkedAt: string,
		corruptChunks: number[],
		detail: string | null,
	): VerificationReport {
		const byIndex = new Map(request.chunks.map((chunk) => [chunk.index, chunk]));
		const bytesToRepair = corruptChunks.reduce((total, index) => {
			const chunk = byIndex.get(index);

			return total + (chunk ? chunk.end - chunk.start + 1 : 0);
		}, 0);

		return {
			transferId: request.transferId,
			ok: corruptChunks.length === 0 && detail === null,
			chunksChecked: request.chunks.length,
			chunksCorrupt: corruptChunks.length,
			bytesToRepair,
			checkedAt,
			corruptChunks,
			detail,
		};
	}
}
