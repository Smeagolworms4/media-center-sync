import { constants } from 'node:fs';
import { access, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import {
	ChunkState,
	ErrorKey,
	EventName,
	TransferErrorKind,
	TransferState,
	type Settings,
	type TransferProgress,
	type TransferQueueStats,
	type TransferSource,
} from '@mcs/shared';
import {
	Injectable,
	Logger,
	NotFoundException,
	OnApplicationBootstrap,
	OnModuleDestroy,
} from '@nestjs/common';
import { Transfer } from '@/entities';
import { TransferChunkRepository, TransferRepository } from '@/repositories';
import { planChunks, type ChunkPlan, type PlannedChunk } from './chunk-planner';
import { EventGatewayService } from './event-gateway.service';
import { SettingsService } from './settings.service';
import type { TransferSourceRef, TransportCapabilities } from './transport/transport.interface';
import { TransportRegistry } from './transport/transport.registry';
import { VerificationService } from './verification.service';

/** Window over which a rate is measured. Short enough to react, long enough to mean it. */
const RATE_WINDOW_MS = 5_000;

/** How many repair passes before a transfer is called failed. */
const MAX_REPAIR_PASSES = 3;

/** A chunk that has failed this many times is not asked for again this run. */
const MAX_CHUNK_ATTEMPTS = 5;

/** Bytes moved between two progress reports. Smaller means more database writes. */
const PROGRESS_INTERVAL_BYTES = 4 * 1024 * 1024;

/** Resolves the sources for a transfer. Supplied by the sync manager. */
export type SourceResolver = (transfer: Transfer) => Promise<TransferSourceRef[]>;

interface RuntimeSource {
	ref: TransferSourceRef;
	capabilities: TransportCapabilities;
	/** Bytes per second over the last window. */
	rate: number;
	bytesDone: number;
	connections: number;
	failures: number;
	healthy: boolean;
	windowBytes: number;
	windowStart: number;
}

/**
 * What only the engine knows about a transfer in flight.
 *
 * Kept apart from the persisted row on purpose: every field here changes several
 * times a second, and none of it is worth a write.
 */
export interface LiveProgress {
	rate: number;
	etaSeconds: number | null;
	sources: TransferSource[];
}

/** The one place a runtime source becomes something the outside may see. */
const toPublicSource = (source: RuntimeSource): TransferSource => ({
	serviceId: source.ref.serviceId,
	serviceName: source.ref.serviceName,
	peerId: source.ref.peerId,
	peerName: source.ref.peerName ?? null,
	transport: source.ref.transport,
	rate: source.rate,
	bytesDone: source.bytesDone,
	connections: source.connections,
	healthy: source.healthy,
});

interface RunningTransfer {
	transfer: Transfer;
	plan: ChunkPlan;
	sources: RuntimeSource[];
	handle: FileHandle | null;
	abort: AbortController;
	bytesSinceReport: number;
	windowBytes: number;
	windowStart: number;
	rate: number;
	/** Set when a pause was asked for, so workers stop at a chunk boundary. */
	pausing: boolean;
	cancelling: boolean;
}

/**
 * A global cap on how fast bytes come in.
 *
 * A token bucket rather than a sleep per chunk: the limit is a shared resource
 * across every connection of every transfer, and the only way four connections
 * respect one number is if they all draw from the same bucket. Zero means no cap,
 * and the fast path then costs one comparison.
 */
class RateLimiter {
	private _tokens = 0;
	private _last = Date.now();

	public constructor(private _bytesPerSecond: number) {}

	public set limit(bytesPerSecond: number) {
		this._bytesPerSecond = Math.max(0, bytesPerSecond);
	}

	/**
	 * Pay for a read, waiting until the bucket can afford it.
	 *
	 * The limit is re-read on every turn of the loop rather than once on entry, and
	 * both readings matter. Lifting the cap has to release whoever is already waiting
	 * — a person who sets a limit, watches the transfer crawl and then removes it
	 * would otherwise wait out the old allowance with nothing saying why. And the
	 * ceiling is never below the read being paid for: capped at one second's
	 * allowance, a limit smaller than one buffer could never be reached, and the
	 * transfer would not slow down, it would stop forever.
	 */
	public async take(bytes: number): Promise<void> {
		for (;;) {
			if (this._bytesPerSecond <= 0) {
				return;
			}

			const now = Date.now();

			this._tokens = Math.min(
				Math.max(this._bytesPerSecond, bytes),
				this._tokens + ((now - this._last) / 1000) * this._bytesPerSecond,
			);
			this._last = now;

			if (this._tokens >= bytes) {
				this._tokens -= bytes;

				return;
			}

			const missing = bytes - this._tokens;
			const waitMs = Math.max(5, (missing / this._bytesPerSecond) * 1000);

			await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 250)));
		}
	}
}

/**
 * Runs transfers: the bounded pool, the connections, the bytes, the bookkeeping.
 *
 * The one thing worth stating up front is where the truth lives. Chunk state is
 * written to the database as it goes, not held in the cache, because the cache is
 * not the source of truth and cannot be: it is optional (an in-process map by
 * default), it expires by design, and it is exactly what a restart loses. A gateway
 * that crashed mid-transfer has to be able to come back and continue from the byte
 * it reached, and the only thing that survives a crash is what was committed. The
 * cache is for answers we can afford to recompute; a transfer's progress is not one
 * of those.
 */
@Injectable()
export class TransferEngineService implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly _logger = new Logger(TransferEngineService.name);
	private readonly _running = new Map<string, RunningTransfer>();
	private readonly _queue: string[] = [];
	private readonly _limiter = new RateLimiter(0);

	private _resolveSources: SourceResolver | null = null;
	private _draining = false;
	private _pumping = false;

	public constructor(
		private readonly _transfers: TransferRepository,
		private readonly _chunks: TransferChunkRepository,
		private readonly _transports: TransportRegistry,
		private readonly _verification: VerificationService,
		private readonly _settings: SettingsService,
		private readonly _events: EventGatewayService,
	) {}

	/**
	 * The manager tells the engine how to find sources for a transfer.
	 *
	 * Necessary because a queue rebuilt from the database carries no sources: which
	 * services hold an item, and which of them we are allowed to use, is a decision,
	 * and decisions live above this class.
	 */
	public setSourceResolver(resolver: SourceResolver): void {
		this._resolveSources = resolver;
	}

	/**
	 * Rebuild the queue from the database.
	 *
	 * Everything that was running when the process stopped is put back in the queue
	 * rather than resumed in place: the chunk plan already knows which pieces
	 * completed, so restarting a transfer costs the chunk that was in flight and
	 * nothing more.
	 */
	public async onApplicationBootstrap(): Promise<void> {
		const settings = await this._settings.get();

		this._limiter.limit = settings.downloadRateLimit;

		const resumable = await this._transfers.findResumable().catch((error: unknown) => {
			this._logger.error(`Could not rebuild the transfer queue: ${String(error)}`);

			return [] as Transfer[];
		});

		for (const transfer of resumable) {
			// A transfer that was mid-flight is queued, not marked failed: nothing about
			// it is wrong, the process simply stopped.
			if (transfer.state !== TransferState.PAUSED) {
				this._queue.push(transfer.id);
			}
		}

		if (resumable.length > 0) {
			this._logger.log(`Rebuilt ${this._queue.length} transfers from the database`);
		}

		void this._pump();
	}

	public async enqueue(transferId: string): Promise<void> {
		if (this._running.has(transferId) || this._queue.includes(transferId)) {
			return;
		}

		this._queue.push(transferId);

		void this._pump();
	}

	public async pause(transferId: string): Promise<void> {
		const running = this._running.get(transferId);

		if (running) {
			// Flagged rather than aborted outright: the workers stop at a chunk
			// boundary, so a pause never throws away a piece that was nearly complete.
			running.pausing = true;
			running.abort.abort();

			return;
		}

		this._removeFromQueue(transferId);
		await this._setState(transferId, TransferState.PAUSED);
	}

	public async resume(transferId: string): Promise<void> {
		await this._setState(transferId, TransferState.QUEUED);
		await this.enqueue(transferId);
	}

	public async cancel(transferId: string): Promise<void> {
		const running = this._running.get(transferId);

		if (running) {
			running.cancelling = true;
			running.abort.abort();

			return;
		}

		this._removeFromQueue(transferId);

		const transfer = await this._load(transferId);

		transfer.state = TransferState.CANCELLED;
		transfer.errorKind = TransferErrorKind.CANCELLED;
		transfer.finishedAt = new Date();

		await this._transfers.save(transfer);
		// The partial file goes with the transfer: keeping it would silently consume
		// the disk space somebody cancelled the transfer to free.
		await rm(transfer.workPath, { force: true }).catch(() => undefined);

		this._events.emit(EventName.TRANSFER_STATE, this._toPublic(transfer, []));
	}

	/**
	 * The live figures for one transfer, or null when it is not running.
	 *
	 * The row in the database carries what survives a restart — which pieces are held,
	 * where the file is going — and deliberately not the rate, the estimate or which
	 * sources are feeding it, all of which are true for a second and would be a write
	 * per chunk. They live here, and a listing asks for them.
	 *
	 * Without this, a queue read back from the database shows every running transfer at
	 * zero bytes per second with no sources, and the only place the truth appears is the
	 * progress stream — so a page opened mid-transfer looks stalled until the next frame.
	 */
	public progressOf(transferId: string): LiveProgress | null {
		const running = this._running.get(transferId);

		if (!running) {
			return null;
		}

		const remaining = Math.max(0, running.plan.bytesTotal - running.plan.bytesDone);

		return {
			rate: running.rate,
			// No rate means no estimate. Showing a number derived from a division by
			// something close to zero is worse than showing nothing: it reads as
			// certainty, and it is off by hours.
			etaSeconds: running.rate > 0 ? Math.round(remaining / running.rate) : null,
			sources: running.sources.map(toPublicSource),
		};
	}

	/**
	 * A new bandwidth cap, on the transfers already running.
	 *
	 * The bucket is read on every chunk, so moving its limit takes effect within one
	 * chunk rather than on the next transfer — which is how every torrent client
	 * behaves and what the interface promises by exposing the field as a live control.
	 * Without this, the only places the limit was ever pushed in were the bootstrap and
	 * the pump, so a person throttling a running download would watch the number they
	 * just saved change nothing until the queue moved on.
	 */
	public applyRateLimits(settings: Pick<Settings, 'downloadRateLimit'>): void {
		this._limiter.limit = settings.downloadRateLimit;
	}

	public stats(): TransferQueueStats {
		let rate = 0;
		let bytesRemaining = 0;

		for (const running of this._running.values()) {
			rate += running.rate;
			bytesRemaining += Math.max(0, running.plan.bytesTotal - running.plan.bytesDone);
		}

		return {
			active: this._running.size,
			queued: this._queue.length,
			paused: 0,
			failed: 0,
			rate,
			bytesRemaining,
		};
	}

	public async onModuleDestroy(): Promise<void> {
		this._draining = true;

		for (const running of this._running.values()) {
			running.pausing = true;
			running.abort.abort();
		}
	}

	/**
	 * Start as many transfers as the settings allow, then stop.
	 *
	 * Re-entrant by a flag rather than by a lock: every completion calls it again, and
	 * two overlapping pumps would start the same transfer twice.
	 */
	private async _pump(): Promise<void> {
		if (this._pumping || this._draining) {
			return;
		}

		this._pumping = true;

		try {
			const settings = await this._settings.get();

			this._limiter.limit = settings.downloadRateLimit;

			while (this._running.size < settings.maxParallelTransfers && this._queue.length > 0) {
				const transferId = this._queue.shift() as string;

				// Started without awaiting: the pool is bounded by `_running`, and
				// awaiting here would make the whole thing sequential.
				void this._run(transferId, settings).finally(() => {
					this._running.delete(transferId);
					void this._pump();
				});
			}
		} finally {
			this._pumping = false;
		}
	}

	private async _run(transferId: string, settings: Settings): Promise<void> {
		let running: RunningTransfer | null = null;

		try {
			const transfer = await this._load(transferId);

			if (transfer.state === TransferState.CANCELLED || transfer.state === TransferState.DONE) {
				return;
			}

			await this._setState(transferId, TransferState.CONNECTING);

			const sources = await this._prepareSources(transfer);

			if (sources.length === 0) {
				await this._fail(transfer, TransferErrorKind.SOURCE_GONE, ErrorKey.SYNC_NO_SOURCE);

				return;
			}

			const size = this._totalBytes(transfer, sources);
			const existing = await this._chunks.findByTransfer(transferId);
			const plan = planChunks(size, settings.chunkSize, existing);

			await this._persistPlan(transfer, plan);

			running = {
				transfer,
				plan,
				sources,
				handle: await this._openWorkFile(transfer.workPath, size),
				abort: new AbortController(),
				bytesSinceReport: 0,
				windowBytes: 0,
				windowStart: Date.now(),
				rate: 0,
				pausing: false,
				cancelling: false,
			};

			this._running.set(transferId, running);

			await this._setState(transferId, TransferState.DOWNLOADING);
			await this._download(running, settings);

			if (running.cancelling) {
				await this.cancel(transferId);

				return;
			}

			if (running.pausing) {
				await this._setState(transferId, TransferState.PAUSED);

				return;
			}

			await this._finish(running, settings);
		} catch (error) {
			this._logger.error(`Transfer ${transferId} failed: ${String(error)}`);

			const transfer = await this._load(transferId).catch(() => null);

			if (transfer) {
				await this._fail(transfer, this._classify(error), ErrorKey.GENERAL);
			}
		} finally {
			await running?.handle?.close().catch(() => undefined);
		}
	}

	/**
	 * Ask every source what it can do, and keep the ones that answer.
	 *
	 * In parallel because a dead source costs a timeout, and doing that sequentially
	 * across four sources makes starting a transfer take a minute.
	 */
	private async _prepareSources(transfer: Transfer): Promise<RuntimeSource[]> {
		const refs = (await this._resolveSources?.(transfer)) ?? [];
		const prepared = await Promise.all(
			refs.map(async (ref) => {
				try {
					const transport = this._transports.get(ref.transport);
					const capabilities = await transport.prepare(ref);

					const source: RuntimeSource = {
						ref,
						capabilities,
						rate: 0,
						bytesDone: 0,
						connections: 0,
						failures: 0,
						healthy: true,
						windowBytes: 0,
						windowStart: Date.now(),
					};

					return source;
				} catch (error) {
					this._logger.warn(`Source ${ref.serviceName} is unusable: ${String(error)}`);

					return null;
				}
			}),
		);

		return prepared.filter((source): source is RuntimeSource => source !== null);
	}

	/**
	 * Run the connections until every chunk is done or something stops us.
	 *
	 * The number of workers is the sum of what each source will tolerate, capped by
	 * the setting: four connections against one server, or one each against four
	 * peers, both add up to four and neither is decided here.
	 */
	private async _download(running: RunningTransfer, settings: Settings): Promise<void> {
		const perSource = settings.maxConnectionsPerSource;
		const capacity = running.sources.reduce(
			(total, source) => total + Math.min(perSource, source.capabilities.maxConnections),
			0,
		);

		// A source that cannot serve ranges forces a single sequential connection: any
		// parallelism against it writes the head of the file at four different offsets.
		const resumable = running.sources.some((source) => source.capabilities.resumable);
		const workers = Math.max(1, Math.min(resumable ? capacity : 1, running.plan.chunks.length));

		await Promise.all(
			Array.from({ length: workers }, () => this._worker(running, settings)),
		);
	}

	private async _worker(running: RunningTransfer, settings: Settings): Promise<void> {
		for (;;) {
			if (running.pausing || running.cancelling || this._draining) {
				return;
			}

			const chunk = this._nextChunk(running);

			if (!chunk) {
				return;
			}

			const source = this._pickSource(running, settings);

			if (!source) {
				// Every source is saturated or dead. Putting the chunk back and waiting
				// is better than failing the transfer: a source often comes back.
				chunk.state = ChunkState.PENDING;

				if (running.sources.every((candidate) => !candidate.healthy)) {
					throw new Error('every source failed');
				}

				await new Promise((resolve) => setTimeout(resolve, 200));

				continue;
			}

			await this._fetchChunk(running, chunk, source);
		}
	}

	private async _fetchChunk(
		running: RunningTransfer,
		chunk: PlannedChunk,
		source: RuntimeSource,
	): Promise<void> {
		source.connections += 1;
		chunk.attempts += 1;
		chunk.sourceServiceId = source.ref.serviceId;

		try {
			const transport = this._transports.get(source.ref.transport);
			const answer = await transport.fetch(
				source.ref,
				{ start: chunk.start, end: chunk.end },
				{ signal: running.abort.signal, chunkIndex: chunk.index },
			);

			// The source ignored the range and is sending from zero. Only the first
			// chunk can consume that; anything else would write the head of the file
			// into the middle of itself.
			if (answer.wholeFile && chunk.start !== 0) {
				answer.stream.destroy();

				throw new Error('source ignored the byte range');
			}

			let position = chunk.start;
			const limit = answer.wholeFile ? running.plan.bytesTotal - 1 : chunk.end;

			for await (const piece of answer.stream) {
				const buffer = piece as Buffer;

				if (running.cancelling || running.pausing) {
					answer.stream.destroy();

					break;
				}

				// The global cap is taken before the write, so the disk never runs ahead
				// of the limit the person set.
				await this._limiter.take(buffer.length);

				const writable = Math.min(buffer.length, limit - position + 1);

				if (writable <= 0) {
					break;
				}

				await running.handle?.write(buffer, 0, writable, position);

				position += writable;
				this._account(running, source, writable);
			}

			const received = position - chunk.start;

			if (!answer.wholeFile && received < chunk.size) {
				throw new Error(`short chunk: ${received} of ${chunk.size} bytes`);
			}

			chunk.state = ChunkState.DONE;
			chunk.bytesDone = chunk.size;

			if (answer.wholeFile) {
				// One stream carried everything: mark the rest done rather than asking
				// for ranges the server has already proved it ignores.
				for (const other of running.plan.chunks) {
					other.state = ChunkState.DONE;
					other.bytesDone = other.size;
				}
			}

			source.failures = 0;

			await this._saveChunk(running.transfer.id, chunk);
		} catch (error) {
			chunk.state =
				chunk.attempts >= MAX_CHUNK_ATTEMPTS ? ChunkState.FAILED : ChunkState.PENDING;
			chunk.bytesDone = 0;
			source.failures += 1;

			// Three failures in a row is a source that is not coming back this run.
			// Marking it unhealthy takes it out of the rotation without failing the
			// transfer, which the other sources can still finish.
			if (source.failures >= 3) {
				source.healthy = false;
				this._logger.warn(`Dropping source ${source.ref.serviceName} after repeated failures`);
			}

			await this._saveChunk(running.transfer.id, chunk);

			if (chunk.state === ChunkState.FAILED) {
				throw error;
			}
		} finally {
			source.connections = Math.max(0, source.connections - 1);
		}
	}

	/**
	 * Verify, repair if needed, then move the file into place.
	 *
	 * In that order and never overlapping: a file is only ever moved to its final
	 * path once it has been checked, because the media server watches that directory
	 * and will happily index a half-written file the moment it appears.
	 */
	private async _finish(running: RunningTransfer, settings: Settings): Promise<void> {
		const transfer = running.transfer;

		await this._setState(transfer.id, TransferState.VERIFYING);

		let report = await this._verification.verify({
			transferId: transfer.id,
			path: transfer.workPath,
			chunks: running.plan.chunks,
			expectedSize: running.plan.bytesTotal,
		});

		for (let pass = 0; !report.ok && pass < MAX_REPAIR_PASSES; pass += 1) {
			await this._setState(transfer.id, TransferState.REPAIRING);

			const assignments = this._verification.planRepair(
				report,
				running.plan.chunks,
				running.sources.filter((source) => source.healthy).map((source) => source.ref.serviceId),
			);

			for (const assignment of assignments) {
				const chunk = running.plan.chunks.find(
					(candidate) => candidate.index === assignment.chunkIndex,
				);

				if (!chunk) {
					continue;
				}

				chunk.state = ChunkState.CORRUPT;
				chunk.bytesDone = 0;
				transfer.chunksRepaired += 1;

				const source =
					running.sources.find(
						(candidate) =>
							candidate.healthy && candidate.ref.serviceId === assignment.sourceServiceId,
					) ?? this._pickSource(running, settings);

				if (source) {
					await this._fetchChunk(running, chunk, source);
				}
			}

			report = await this._verification.verify({
				transferId: transfer.id,
				path: transfer.workPath,
				chunks: running.plan.chunks,
				expectedSize: running.plan.bytesTotal,
			});
		}

		if (!report.ok) {
			await this._fail(
				transfer,
				TransferErrorKind.CHECKSUM_MISMATCH,
				ErrorKey.TRANSFER_CHECKSUM_MISMATCH,
			);

			return;
		}

		await this._setState(transfer.id, TransferState.PLACING);
		await running.handle?.close();

		running.handle = null;

		await this._place(transfer);

		transfer.state = TransferState.DONE;
		transfer.bytesDone = running.plan.bytesTotal;
		transfer.lastVerifiedAt = new Date();
		transfer.finishedAt = new Date();
		transfer.error = null;
		transfer.errorKind = null;

		await this._transfers.save(transfer);

		this._events.emit(EventName.TRANSFER_STATE, this._toPublic(transfer, running.sources));
		this._events.flushProgress();
	}

	/**
	 * Move the finished file to the path the manager decided on.
	 *
	 * A rename when both are on the same filesystem, a copy otherwise — and the copy
	 * goes through a temporary name in the destination directory so the media server
	 * never sees a partial file appear under the final one.
	 */
	private async _place(transfer: Transfer): Promise<void> {
		await mkdir(dirname(transfer.targetPath), { recursive: true });

		try {
			await rename(transfer.workPath, transfer.targetPath);

			return;
		} catch {
			// `EXDEV`: the working directory and the library are different mounts, which
			// is the normal case when the library is a NAS.
		}

		const temporary = `${transfer.targetPath}.mcs-part`;
		const { copyFile } = await import('node:fs/promises');

		await copyFile(transfer.workPath, temporary);
		await rename(temporary, transfer.targetPath);
		await unlink(transfer.workPath).catch(() => undefined);
	}

	/**
	 * The next piece to fetch.
	 *
	 * In order rather than at random: a media file downloaded front to back can be
	 * watched before it finishes, and the ordering costs nothing when every
	 * connection is busy anyway.
	 */
	private _nextChunk(running: RunningTransfer): PlannedChunk | null {
		const chunk = running.plan.chunks.find((candidate) => candidate.state === ChunkState.PENDING);

		if (chunk) {
			chunk.state = ChunkState.ACTIVE;
		}

		return chunk ?? null;
	}

	/**
	 * Which source feeds the next chunk.
	 *
	 * Measured rate, not configured priority: the friend with the fastest upstream
	 * today is not the one who had it last week, and a source that has not been
	 * measured yet is tried before a slow one so it gets the chance to prove itself.
	 */
	private _pickSource(running: RunningTransfer, settings: Settings): RuntimeSource | null {
		const available = running.sources.filter(
			(source) =>
				source.healthy &&
				source.connections < Math.min(settings.maxConnectionsPerSource, source.capabilities.maxConnections),
		);

		if (available.length === 0) {
			return null;
		}

		return available.sort((left, right) => {
			if ((left.rate === 0) !== (right.rate === 0)) {
				return left.rate === 0 ? -1 : 1;
			}

			return right.rate - left.rate || left.connections - right.connections;
		})[0];
	}

	private _account(running: RunningTransfer, source: RuntimeSource, bytes: number): void {
		const now = Date.now();

		running.plan.bytesDone += bytes;
		running.bytesSinceReport += bytes;
		running.windowBytes += bytes;
		source.bytesDone += bytes;
		source.windowBytes += bytes;

		const elapsed = now - running.windowStart;

		if (elapsed >= RATE_WINDOW_MS) {
			running.rate = (running.windowBytes / elapsed) * 1000;
			running.windowBytes = 0;
			running.windowStart = now;
		}

		const sourceElapsed = now - source.windowStart;

		if (sourceElapsed >= RATE_WINDOW_MS) {
			source.rate = (source.windowBytes / sourceElapsed) * 1000;
			source.windowBytes = 0;
			source.windowStart = now;
		}

		// Progress is reported by bytes rather than by time: a stalled transfer should
		// not keep emitting identical frames, and a fast one should not emit one per
		// buffer.
		if (running.bytesSinceReport >= PROGRESS_INTERVAL_BYTES) {
			running.bytesSinceReport = 0;
			this._events.publishProgress(this._toProgress(running));
			void this._transfers
				.save(Object.assign(running.transfer, { bytesDone: running.plan.bytesDone }))
				.catch(() => undefined);
		}
	}

	private _toProgress(running: RunningTransfer): TransferProgress {
		const chunksDone = running.plan.chunks.filter(
			(chunk) => chunk.state === ChunkState.DONE,
		).length;

		const remaining = Math.max(0, running.plan.bytesTotal - running.plan.bytesDone);

		return {
			id: running.transfer.id,
			state: running.transfer.state,
			bytesDone: running.plan.bytesDone,
			bytesTotal: running.plan.bytesTotal,
			rate: running.rate,
			// No estimate without a rate: a made-up number that swings between two
			// minutes and four hours is worse than nothing at all.
			etaSeconds: running.rate > 0 ? Math.round(remaining / running.rate) : null,
			chunksDone,
			chunksTotal: running.plan.chunksTotal,
			sourceCount: running.sources.filter((source) => source.healthy).length,
		};
	}

	private _toPublic(transfer: Transfer, sources: RuntimeSource[]) {
		const publicSources: TransferSource[] = sources.map(toPublicSource);

		return {
			id: transfer.id,
			jobId: transfer.jobId,
			itemId: transfer.itemId,
			contentId: transfer.contentId,
			title: transfer.title,
			kind: '',
			state: transfer.state,
			targetPath: transfer.targetPath,
			bytesTotal: Number(transfer.bytesTotal),
			bytesDone: Number(transfer.bytesDone),
			rate: publicSources.reduce((total, source) => total + source.rate, 0),
			etaSeconds: null,
			sources: publicSources,
			chunkSize: transfer.chunkSize,
			chunksTotal: transfer.chunksTotal,
			chunksDone: 0,
			error: transfer.error,
			errorKind: transfer.errorKind,
			chunksRepaired: transfer.chunksRepaired,
			lastVerifiedAt: transfer.lastVerifiedAt?.toISOString() ?? null,
			startedAt: transfer.startedAt?.toISOString() ?? null,
			finishedAt: transfer.finishedAt?.toISOString() ?? null,
			createdAt: transfer.createdAt?.toISOString() ?? new Date().toISOString(),
			updatedAt: transfer.updatedAt?.toISOString() ?? new Date().toISOString(),
		};
	}

	/**
	 * Create or reopen the working file.
	 *
	 * Opened for positional writes so several connections write different offsets of
	 * the same handle at once, which is the whole point of the chunk plan. Not
	 * preallocated: a sparse file is fine on every filesystem the gateway runs on, and
	 * writing forty gigabytes of zeroes first would double the disk cost of a transfer.
	 */
	private async _openWorkFile(path: string, size: number): Promise<FileHandle> {
		await mkdir(dirname(path), { recursive: true });

		try {
			await access(path, constants.F_OK);
		} catch {
			const created = await open(path, 'w');

			await created.close();
		}

		const handle = await open(path, 'r+');
		const stats = await stat(path);

		// A working file longer than the transfer is a leftover from a previous,
		// differently sized attempt. Truncating is safe because the chunk plan is
		// about to say which parts are valid.
		if (stats.size > size && size > 0) {
			await handle.truncate(size);
		}

		return handle;
	}

	private async _persistPlan(transfer: Transfer, plan: ChunkPlan): Promise<void> {
		transfer.chunkSize = plan.chunkSize;
		transfer.chunksTotal = plan.chunksTotal;
		transfer.bytesTotal = plan.bytesTotal;
		transfer.bytesDone = plan.bytesDone;
		transfer.startedAt = transfer.startedAt ?? new Date();

		await this._transfers.save(transfer);

		if (plan.resumed) {
			return;
		}

		await this._chunks.insertPlan(
			transfer.id,
			plan.chunks.map((chunk) => ({
				index: chunk.index,
				start: chunk.start,
				end: chunk.end,
				checksum: chunk.checksum,
			})),
		);
	}

	private async _saveChunk(transferId: string, chunk: PlannedChunk): Promise<void> {
		// One write per chunk transition, not per buffer: the point is that a restart
		// knows which pieces are whole, and a half-written piece is worth nothing.
		await this._chunks
			.updateState(transferId, chunk.index, {
				state: chunk.state,
				bytesDone: chunk.bytesDone,
				sourceServiceId: chunk.sourceServiceId,
				attempts: chunk.attempts,
			})
			.catch((error: unknown) => {
				this._logger.warn(`Could not record chunk ${chunk.index}: ${String(error)}`);
			});
	}

	private _totalBytes(transfer: Transfer, sources: RuntimeSource[]): number {
		const stored = Number(transfer.bytesTotal);

		if (stored > 0) {
			return stored;
		}

		for (const source of sources) {
			if (source.capabilities.totalBytes) {
				return source.capabilities.totalBytes;
			}
		}

		return 0;
	}

	private async _load(transferId: string): Promise<Transfer> {
		const transfer = await this._transfers.findOneBy({ id: transferId });

		if (!transfer) {
			throw new NotFoundException({ key: ErrorKey.TRANSFER_NOT_FOUND });
		}

		return transfer;
	}

	private async _setState(transferId: string, state: TransferState): Promise<void> {
		const transfer = await this._load(transferId);

		transfer.state = state;

		await this._transfers.save(transfer);

		this._events.emit(EventName.TRANSFER_STATE, this._toPublic(transfer, []));
	}

	private async _fail(
		transfer: Transfer,
		kind: TransferErrorKind,
		key: string,
	): Promise<void> {
		transfer.state = TransferState.FAILED;
		transfer.errorKind = kind;
		transfer.error = key;
		transfer.finishedAt = new Date();

		await this._transfers.save(transfer);

		this._events.emit(EventName.TRANSFER_STATE, this._toPublic(transfer, []));
	}

	/**
	 * Turn whatever was thrown into something the interface can offer to act on.
	 *
	 * The kinds exist because the buttons differ: a missing source offers "look for
	 * another one", a full disk offers "choose another library", and neither is a
	 * retry button that would fail the same way.
	 */
	private _classify(error: unknown): TransferErrorKind {
		const message = error instanceof Error ? error.message.toLowerCase() : String(error);

		if (message.includes('enospc') || message.includes('no space')) {
			return TransferErrorKind.DISK_FULL;
		}

		if (message.includes('eacces') || message.includes('eperm')) {
			return TransferErrorKind.PERMISSION_DENIED;
		}

		if (message.includes('enoent')) {
			return TransferErrorKind.TARGET_MISSING;
		}

		if (message.includes('unauthor') || message.includes('401') || message.includes('403')) {
			return TransferErrorKind.SOURCE_UNAUTHORIZED;
		}

		if (message.includes('404') || message.includes('gone')) {
			return TransferErrorKind.SOURCE_GONE;
		}

		if (message.includes('checksum') || message.includes('short chunk')) {
			return TransferErrorKind.CHECKSUM_MISMATCH;
		}

		if (message.includes('timeout') || message.includes('econn') || message.includes('network')) {
			return TransferErrorKind.NETWORK;
		}

		return TransferErrorKind.UNKNOWN;
	}

	private _removeFromQueue(transferId: string): void {
		const index = this._queue.indexOf(transferId);

		if (index !== -1) {
			this._queue.splice(index, 1);
		}
	}
}
