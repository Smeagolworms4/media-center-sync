import { basename, join, relative, resolve } from 'node:path';
import {
	ChunkState,
	ErrorKey,
	EventName,
	MediaServiceMode,
	PlacedBy,
	TransferState,
} from '@mcs/shared';
import type {
	ChangeDestinationRequest,
	ResultList,
	Revalidation,
	Transfer,
	TransferChunk,
	TransferQueueStats,
	TransferVerification,
	UnconfiguredPlacement,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import type { Library as LibraryEntity, Transfer as TransferEntity } from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	RevalidationRepository,
	SyncJobItemRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import {
	EventGatewayService,
	FileMoveError,
	FileMoveService,
	serviceMode,
	SettingsService,
	TransferEngineService,
	VerificationService,
	isInside,
} from '@/services';
import { LibraryManager } from './library.manager';
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
		private readonly _libraries: LibraryRepository,
		/**
		 * The lines of the run this transfer belongs to, kept in step with it.
		 *
		 * A line records where the run decided the file would go. Moving the file and
		 * leaving the line alone gives a run detail that names a path nothing is at —
		 * which is the same quiet wrongness this whole feature exists to remove, one
		 * screen further along.
		 */
		private readonly _lines: SyncJobItemRepository,
		/**
		 * Asked which category a library belongs to, and whether a path can be written.
		 *
		 * A manager rather than the repository because both are decisions that belong to
		 * it: a category is a merge of library names, and a second reading of that merge
		 * here would name a different category than the one the settings were saved under.
		 */
		private readonly _libraryManager: LibraryManager,
		private readonly _settings: SettingsService,
		private readonly _mover: FileMoveService,
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
	 * Everything that landed on a step of the placement rule nobody configured.
	 *
	 * The one place any of this is ever mentioned. A file placed by the global default,
	 * the fallback folder or the last-resort walk of whatever is writable produced no
	 * error, no failed transfer and no log line worth reading — the transfer succeeded,
	 * and the only visible consequence is a folder somebody did not plan, found months
	 * later.
	 *
	 * The category is resolved here rather than stored on the row, because it is a merge
	 * of library names: renaming a shelf renames the category, and a name frozen at
	 * planning time would go on naming one that no longer exists. That name is the whole
	 * value of the row — "no destination is set for the category Animés" is something
	 * somebody can act on, and "fallback" is not.
	 */
	public async unconfigured(): Promise<UnconfiguredPlacement[]> {
		const rows = await this._transfers.findUnconfigured();

		if (rows.length === 0) {
			return [];
		}

		const [items, categories, libraries] = await Promise.all([
			this._items.find({ where: { id: In(rows.map((row) => row.itemId)) } }),
			this._libraryManager.categories(),
			this._libraries.find(),
		]);

		const itemsById = new Map(items.map((item) => [item.id, item]));
		const names = new Map(
			libraries.map((library) => [library.id, library.alias?.trim() || library.name]),
		);
		const categoryOf = new Map<string, { key: string; name: string }>();

		for (const category of categories) {
			for (const libraryId of category.libraryIds) {
				categoryOf.set(libraryId, { key: category.key, name: category.name });
			}
		}

		return rows.map((row) => {
			// The item the bytes come from, whose own library is what the category table
			// is keyed on — the same reading the plan used when it chose this path.
			const item = itemsById.get(row.itemId);
			const category = item === undefined ? undefined : categoryOf.get(item.libraryId);

			return {
				transferId: row.id,
				itemId: row.itemId,
				title: row.title,
				kind: item?.kind ?? '',
				state: row.state,
				targetPath: row.targetPath,
				targetLibraryId: row.targetLibraryId,
				targetLibraryName:
					row.targetLibraryId === null ? null : (names.get(row.targetLibraryId) ?? null),
				placedBy: row.placedBy as PlacedBy,
				categoryKey: category?.key ?? null,
				categoryName: category?.name ?? null,
				placedAt: (row.finishedAt ?? row.createdAt).toISOString(),
			};
		});
	}

	/**
	 * Send a transfer somewhere else, before it lands or after.
	 *
	 * The two cases cost wildly different things and that is worth knowing before
	 * pressing the button:
	 *
	 * - **While it is still downloading** every byte is going into the work file in the
	 *   scratch directory, and `targetPath` is not read until that file is finally moved
	 *   into place. Changing it is one row write. Nothing is copied, nothing is deleted,
	 *   and the download is not interrupted.
	 * - **Once it has landed** the file is in a library and this is a real move of real
	 *   bytes, usually across two filesystems, which is why it goes through the mover
	 *   and reports progress on the same channel the download used.
	 *
	 * A transfer the engine is placing right now is refused rather than queued: the
	 * engine is copying to the old path at that exact moment, and rewriting the row
	 * underneath it would leave the copy landing somewhere the row no longer names.
	 */
	public async changeDestination(
		id: string,
		request: ChangeDestinationRequest,
	): Promise<Transfer> {
		const transfer = await this._require(id);
		const library = await this._requireDestination(request.libraryId);
		const path = await this._destinationPath(transfer, library);

		if (path === resolve(transfer.targetPath) && transfer.targetLibraryId === library.id) {
			// The destination already in force. Answering the transfer unchanged beats
			// refusing it: a list somebody is fixing row by row should not punish them for
			// picking the library a file is already in.
			return this.read(id);
		}

		if (transfer.state === TransferState.PLACING) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		if ((await this._libraryManager.probe(path)).exists) {
			// Somebody else's file is there. Landing on it is the loss this whole area
			// exists to prevent, and it would be silent.
			throw new ConflictException(ErrorKey.TRANSFER_TARGET_OCCUPIED);
		}

		if (transfer.state === TransferState.DONE) {
			await this._moveInPlace(transfer, path);
		}

		await this._retarget(transfer, library, path);

		return this.read(id);
	}

	/**
	 * Move a file that is already in a library, with the screen following along.
	 *
	 * `PLACING` and the progress channel are reused rather than given a state and an
	 * event of their own. The interface already draws both, and a move that reported on
	 * a second channel would be a bar nobody had written a component for — while a move
	 * that reported nothing at all is forty minutes in which the only honest thing the
	 * screen could say is nothing.
	 *
	 * The state goes back to what it was if the move fails, because it did: the file is
	 * still in the library it was in, whole, and leaving the transfer stuck on `placing`
	 * would make a recoverable refusal look like a hung job.
	 */
	private async _moveInPlace(transfer: TransferEntity, path: string): Promise<void> {
		const settings = await this._settings.get();
		const source = transfer.targetPath;

		await this._publishState(transfer, TransferState.PLACING);

		try {
			await this._mover.move({
				source,
				destination: path,
				reserveBytes: settings.diskReserveBytes,
				onProgress: (progress) => {
					this._events.publishProgress({
						id: transfer.id,
						state: TransferState.PLACING,
						bytesDone: progress.bytesDone,
						bytesTotal: progress.bytesTotal,
						rate: progress.rate,
						// No estimate without a rate: a number that swings between two
						// minutes and four hours is worse than none, and the first window
						// has not closed yet.
						etaSeconds:
							progress.rate > 0
								? Math.round((progress.bytesTotal - progress.bytesDone) / progress.rate)
								: null,
						chunksDone: transfer.chunksTotal,
						chunksTotal: transfer.chunksTotal,
						sourceCount: 0,
					});
				},
			});
		} catch (error) {
			await this._publishState(transfer, TransferState.DONE);

			if (error instanceof FileMoveError) {
				throw new ConflictException(error.key);
			}

			throw error;
		}

		transfer.state = TransferState.DONE;
		this._events.flushProgress();
		this._logger.log(`Moved ${transfer.title} from ${source} to ${path}`);
	}

	/** Records the new destination on the transfer, and on the run line that names it. */
	private async _retarget(
		transfer: TransferEntity,
		library: LibraryEntity,
		path: string,
	): Promise<void> {
		transfer.targetPath = path;
		transfer.targetLibraryId = library.id;
		// Somebody chose this one by hand, so it is no longer a destination nobody
		// picked — whatever step the plan had originally reached.
		transfer.placedBy = PlacedBy.REQUESTED;

		await this._transfers.save(transfer);

		if (transfer.jobId !== null) {
			const line = await this._lines.findLine(transfer.jobId, transfer.itemId);

			if (line !== null) {
				line.targetPath = path;
				line.targetLibraryId = library.id;
				line.placedBy = PlacedBy.REQUESTED;

				await this._lines.save(line);
			}
		}

		const [presented] = await this._present([transfer]);

		this._events.emit(EventName.TRANSFER_STATE, presented);
	}

	/**
	 * The library a transfer may be sent to, or the refusal that says why not.
	 *
	 * A library on one of our own services, and one this gateway can write into. That
	 * is the whole rule, and it is the rule the product exists for: a path nothing
	 * scans accepts the file, reports success and produces a folder no media server
	 * will ever show. There is no error to find afterwards, because nothing failed.
	 *
	 * The write is probed rather than read off the library row. The flag is what the
	 * last scan believed, and a disk unmounted since then is exactly the case worth
	 * catching — it costs one `access` against a choice somebody is making by hand.
	 */
	private async _requireDestination(libraryId: string): Promise<LibraryEntity> {
		const library = await this._libraries.findOne({ where: { id: libraryId } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		const service = await this._services.findOne({ where: { id: library.serviceId } });

		// The mount and not the sharing switch: a destination has to be a path the media
		// server actually scans, and whether its libraries are offered to peers says
		// nothing about that. `serviceMode` also keeps a peer-backed row out, which no
		// column test on its own would.
		if (
			service === null
			|| serviceMode(service) !== MediaServiceMode.LOCAL
			|| !library.localPath
		) {
			throw new ConflictException(ErrorKey.TRANSFER_DESTINATION_INVALID);
		}

		if (!(await this._libraryManager.probe(library.localPath)).writable) {
			throw new ConflictException(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		}

		return library;
	}

	/**
	 * Where the file goes inside the new library.
	 *
	 * The layout it already has is kept — `The Expanse/Season 1/S01E02.mkv` stays that,
	 * one library over — because the folders are what a media server groups a series
	 * by, and flattening them to a file name would scatter a season the day somebody
	 * corrected its library.
	 *
	 * The fallback folder is looked at as well as the library, and it is not an
	 * afterthought: a file placed there belongs to no library at all, so without this
	 * every single row this screen exists to fix would be the one case that loses its
	 * folders on the way out. Only a file that sits under neither falls back to its own
	 * name, and then there is genuinely nothing to preserve.
	 */
	private async _destinationPath(
		transfer: TransferEntity,
		library: LibraryEntity,
	): Promise<string> {
		const current = resolve(transfer.targetPath);
		const previous =
			transfer.targetLibraryId === null
				? null
				: await this._libraries.findOne({ where: { id: transfer.targetLibraryId } });
		const fallback = (await this._settings.get()).defaultTargetPath?.trim();

		const roots = [
			previous?.localPath ? resolve(previous.localPath) : null,
			fallback ? resolve(fallback) : null,
		].filter((root): root is string => root !== null);

		const root = roots.find((candidate) => isInside(current, candidate)) ?? null;
		const inside = root === null ? basename(current) : relative(root, current);

		return join(resolve(library.localPath as string), inside);
	}

	/** Saves a state change and pushes it, so a long move is visible while it runs. */
	private async _publishState(transfer: TransferEntity, state: TransferState): Promise<void> {
		transfer.state = state;

		await this._transfers.save(transfer);

		const [presented] = await this._present([transfer]);

		this._events.emit(EventName.TRANSFER_STATE, presented);
	}

	/**
	 * The wire shape, with the numbers the row cannot carry.
	 *
	 * `kind` comes from the item, which already has it; `chunksDone` is counted per
	 * transfer, and the live figures from the engine for the ones it is running.
	 *
	 * Reading the rate and the source list from the engine rather than from the row is
	 * what makes a page opened mid-transfer show something: the row carries only what
	 * survives a restart, and a listing built from it alone shows every running
	 * transfer at zero bytes per second with no sources until the next pushed frame.
	 * A transfer the engine is not running has no live figures, which is the honest
	 * answer for one that is queued, paused or finished.
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
					...(this._engine.progressOf(transfer.id) ?? {}),
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
