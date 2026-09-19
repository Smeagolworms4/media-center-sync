import { ChunkState, ErrorKey, EventName, TransferState } from '@mcs/shared';
import type {
	ResultList,
	Revalidation,
	Transfer,
	TransferChunk,
	TransferQueueStats,
	TransferVerification,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import type { Transfer as TransferEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaServiceRepository,
	RevalidationRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import { EventGatewayService, TransferEngineService, VerificationService } from '@/services';
import {
	pageBounds,
	paginate,
	toRevalidation,
	toTransfer,
	toTransferChunk,
} from './mappers';

/** Nothing can be done to a transfer that has already finished one way or another. */
const FINISHED = [TransferState.DONE, TransferState.FAILED, TransferState.CANCELLED];

/**
 * The queue, and what can be done to one transfer.
 *
 * Every action here is a state machine question, and each answer is a decision rather
 * than a convenience:
 *
 * - **pause** applies to a queued transfer as much as to a running one. A queued
 *   transfer that could not be paused would start the moment a slot freed, which is
 *   precisely what somebody pressing pause is trying to prevent.
 * - **retry** starts a cancelled or failed transfer over. A cancelled one has had its
 *   partial file deleted, so its pieces are reset rather than resumed — resuming
 *   against bytes that are no longer there writes a file that verifies as corrupt
 *   everywhere at once.
 * - **verify** answers what it found and changes nothing; **repair** acts. Keeping
 *   them apart is what lets somebody ask the question without committing to fetching
 *   nine gigabytes again.
 */
@Injectable()
export class TransferManager {
	private readonly _logger = new Logger(TransferManager.name);

	public constructor(
		private readonly _transfers: TransferRepository,
		private readonly _chunks: TransferChunkRepository,
		private readonly _revalidations: RevalidationRepository,
		private readonly _items: MediaItemRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _engine: TransferEngineService,
		private readonly _verification: VerificationService,
		private readonly _events: EventGatewayService,
	) {}

	public async list(query: {
		page?: number;
		limit?: number;
		state?: TransferState;
	}): Promise<ResultList<Transfer>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [transfers, total] = await this._transfers.findAndCount({
			where: query.state === undefined ? {} : { state: query.state },
			order: { createdAt: 'DESC' },
			skip: (page - 1) * limit,
			take: limit,
		});

		return paginate(await this._present(transfers), total, page, limit);
	}

	/**
	 * The queue counters.
	 *
	 * The counts come from the database and the rate from the engine, because neither
	 * can answer the other. A rate is measured over a window of the last few seconds
	 * and lives in memory; computed from stored bytes it would be an average since the
	 * transfer started, which is a different number that looks like the same one.
	 */
	public async stats(): Promise<TransferQueueStats> {
		const stored = await this._transfers.queueStats();

		return { ...stored, rate: this._engine.stats().rate };
	}

	public async read(id: string): Promise<Transfer> {
		const transfer = await this._require(id);
		const [presented] = await this._present([transfer]);

		return presented;
	}

	public async chunks(id: string): Promise<TransferChunk[]> {
		await this._require(id);

		const chunks = await this._chunks.findByTransfer(id);

		return chunks.map(toTransferChunk);
	}

	/**
	 * Why a transfer changed its mind.
	 *
	 * Which source was asked, what it said, and what was decided. Without it the queue
	 * shows outcomes nobody can account for — a source dropped, a path followed, a
	 * version abandoned, all of them indistinguishable from a bug.
	 */
	public async revalidations(id: string): Promise<Revalidation[]> {
		await this._require(id);

		const rows = await this._revalidations.findForTransfer(id);
		const names = await this._serviceNames(rows.map((row) => row.sourceServiceId));

		return rows.map((row) => toRevalidation(row, names.get(row.sourceServiceId) ?? ''));
	}

	public async pause(id: string): Promise<Transfer> {
		const transfer = await this._requireLive(id);

		if (transfer.state === TransferState.PAUSED) {
			return this.read(id);
		}

		await this._engine.pause(transfer.id);

		return this.read(id);
	}

	public async resume(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		// A failed transfer is resumable: the pieces it already holds are still on
		// disk and still verified, and the alternative is fetching them again.
		if (transfer.state !== TransferState.PAUSED && transfer.state !== TransferState.FAILED) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		await this._engine.resume(transfer.id);

		return this.read(id);
	}

	public async cancel(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		if (transfer.state === TransferState.DONE) {
			// Cancelling a finished transfer would delete a file that is already in the
			// library and that nothing is going to fetch again.
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		if (FINISHED.includes(transfer.state)) {
			return this.read(id);
		}

		await this._engine.cancel(transfer.id);

		return this.read(id);
	}

	/**
	 * Start a finished-badly transfer over.
	 *
	 * Only from `failed` or `cancelled`. Retrying a running one would have two workers
	 * writing the same offsets, and retrying a finished one would fetch a file that is
	 * already in the library.
	 */
	public async retry(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		if (transfer.state !== TransferState.FAILED && transfer.state !== TransferState.CANCELLED) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		// The pieces go back to pending rather than being kept: a cancelled transfer had
		// its partial file removed, and a failed one may have failed because of what is
		// on disk. Starting from bytes nobody can vouch for is how a repair loop begins.
		await this._chunks.deleteForTransfer(transfer.id);

		transfer.state = TransferState.QUEUED;
		transfer.bytesDone = 0;
		transfer.chunksTotal = 0;
		transfer.error = null;
		transfer.errorKind = null;
		transfer.startedAt = null;
		transfer.finishedAt = null;

		await this._transfers.save(transfer);
		await this._engine.enqueue(transfer.id);

		return this.read(id);
	}

	/**
	 * Re-read what is on disk and report. Writes nothing.
	 *
	 * The report goes out on the event stream as well as back to the caller, because a
	 * verification that comes back clean is worth knowing about even though no state
	 * changed: it says the source was fine and the problem is somewhere else, and that
	 * is invisible if the only signal is a transfer going back to `done`.
	 */
	public async verify(id: string): Promise<TransferVerification> {
		const transfer = await this._require(id);
		const chunks = await this._chunks.findByTransfer(transfer.id);
		const report = await this._verification.verify({
			transferId: transfer.id,
			path: transfer.state === TransferState.DONE ? transfer.targetPath : transfer.workPath,
			chunks: chunks.map((chunk) => ({
				index: chunk.index,
				start: Number(chunk.start),
				end: Number(chunk.end),
				state: chunk.state,
				sourceServiceId: chunk.sourceServiceId,
				checksum: chunk.checksum,
			})),
			expectedSize: Number(transfer.bytesTotal),
		});

		const answer: TransferVerification = {
			transferId: report.transferId,
			ok: report.ok,
			chunksChecked: report.chunksChecked,
			chunksCorrupt: report.chunksCorrupt,
			bytesToRepair: report.bytesToRepair,
			checkedAt: report.checkedAt,
		};

		this._events.emit(EventName.TRANSFER_VERIFIED, answer);

		return answer;
	}

	/**
	 * Verify, then act on what was found.
	 *
	 * Only the pieces that failed come back, and preferably from another source: the
	 * one that served bad bytes once is the least likely to serve good ones now.
	 * Throwing away thirty gigabytes because two megabytes are wrong is what makes
	 * people give up on syncing.
	 */
	public async repair(id: string): Promise<Transfer> {
		const transfer = await this._require(id);
		const chunks = await this._chunks.findByTransfer(transfer.id);
		const report = await this._verification.verify({
			transferId: transfer.id,
			path: transfer.state === TransferState.DONE ? transfer.targetPath : transfer.workPath,
			chunks: chunks.map((chunk) => ({
				index: chunk.index,
				start: Number(chunk.start),
				end: Number(chunk.end),
				state: chunk.state,
				sourceServiceId: chunk.sourceServiceId,
				checksum: chunk.checksum,
			})),
			expectedSize: Number(transfer.bytesTotal),
		});

		if (report.ok) {
			// Nothing to repair is an answer, not a failure: the transfer stays as it is
			// rather than being re-queued for work nobody found.
			return this.read(id);
		}

		for (const index of report.corruptChunks) {
			await this._chunks.updateState(transfer.id, index, {
				state: ChunkState.CORRUPT,
				bytesDone: 0,
			});
		}

		transfer.state = TransferState.REPAIRING;
		transfer.bytesDone = await this._chunks.sumBytesDone(transfer.id);
		transfer.lastVerifiedAt = new Date();
		transfer.finishedAt = null;

		await this._transfers.save(transfer);
		await this._engine.enqueue(transfer.id);

		this._logger.log(
			`Repairing ${report.corruptChunks.length} pieces of ${transfer.title} (${report.bytesToRepair} bytes)`,
		);

		return this.read(id);
	}

	/**
	 * The wire shape, with the numbers the row cannot carry.
	 *
	 * `kind` comes from the item, which already has it; `chunksDone` is counted per
	 * transfer. The live rate and the source list are left empty on purpose — they are
	 * pushed on the event stream, and a REST answer carrying a stale rate is worse than
	 * one carrying none.
	 */
	private async _present(transfers: TransferEntity[]): Promise<Transfer[]> {
		if (transfers.length === 0) {
			return [];
		}

		const items = await this._items.find({
			where: { id: In(transfers.map((transfer) => transfer.itemId)) },
		});
		const kinds = new Map(items.map((item) => [item.id, item.kind as string]));

		return Promise.all(
			transfers.map(async (transfer) =>
				toTransfer(transfer, {
					kind: kinds.get(transfer.itemId),
					chunksDone: (await this._chunks.countByState(transfer.id))[ChunkState.DONE],
				}),
			),
		);
	}

	private async _serviceNames(ids: string[]): Promise<Map<string, string>> {
		const unique = [...new Set(ids)];

		if (unique.length === 0) {
			return new Map();
		}

		const services = await this._services.find({ where: { id: In(unique) } });

		return new Map(services.map((service) => [service.id, service.name]));
	}

	private async _require(id: string): Promise<TransferEntity> {
		const transfer = await this._transfers.findOne({ where: { id } });

		if (transfer === null) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		return transfer;
	}

	private async _requireLive(id: string): Promise<TransferEntity> {
		const transfer = await this._require(id);

		if (FINISHED.includes(transfer.state)) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		return transfer;
	}
}
