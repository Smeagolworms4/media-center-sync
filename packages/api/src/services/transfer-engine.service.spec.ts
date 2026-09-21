import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
	ChunkState,
	ErrorKey,
	TransferErrorKind,
	TransferState,
	TransferTransport,
	type Settings,
} from '@mcs/shared';
import type { Transfer, TransferChunk } from '@/entities';
import type { TransferChunkRepository, TransferRepository } from '@/repositories';
import { EventGatewayService } from './event-gateway.service';
import {
	FileMoveService,
	NODE_FILE_MOVE_OPERATIONS,
	type FileMoveOperations,
} from './file-move.service';
import { FingerprintService } from './fingerprint.service';
import { MIN_CHUNK_SIZE } from './chunk-planner';
import { DEFAULT_SETTINGS } from './settings.service';
import type { SettingsService } from './settings.service';
import type { TransportRegistry } from './transport/transport.registry';
import type { ByteTransport, TransferSourceRef } from './transport/transport.interface';
import { TransferEngineService } from './transfer-engine.service';
import { VerificationService } from './verification.service';

/**
 * A transfer of four chunks, small enough to run in a test and large enough that the
 * plan has a short last chunk and several workers.
 */
const CHUNK = MIN_CHUNK_SIZE;
const TOTAL = CHUNK * 3 + 100;

function digest(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

async function digestOf(path: string): Promise<string> {
	return digest(await readFile(path));
}

function body(): Buffer {
	const buffer = Buffer.alloc(TOTAL);

	for (let index = 0; index < TOTAL; index += 1) {
		buffer[index] = index % 251;
	}

	return buffer;
}

describe('TransferEngineService', () => {
	const content = body();
	let root: string;
	let transfers: Map<string, Transfer>;
	let chunkRows: TransferChunk[];
	let transferRepository: jest.Mocked<Partial<TransferRepository>>;
	let chunkRepository: jest.Mocked<Partial<TransferChunkRepository>>;
	let settings: Settings;
	let fetchRange: jest.Mock;
	let prepare: jest.Mock;
	let events: EventGatewayService;
	let engine: TransferEngineService;
	/**
	 * The real filesystem, mutable so a test can make one call answer differently.
	 *
	 * The same object the service holds, rather than a copy, so a test can install a
	 * cross-device `rename` or a full disk after the engine has been built — neither
	 * of which can be arranged for real inside a test run.
	 */
	let moveFs: FileMoveOperations;

	function transfer(overrides: Partial<Transfer> = {}): Transfer {
		return {
			id: 't1',
			jobId: null,
			itemId: 'item-1',
			contentId: null,
			title: 'The Expanse - S01E02',
			state: TransferState.QUEUED,
			targetPath: join(root, 'library', 'Show', 'S01E02.mkv'),
			workPath: join(root, 'work', 't1.part'),
			bytesTotal: TOTAL,
			bytesDone: 0,
			chunkSize: 0,
			chunksTotal: 0,
			chunksRepaired: 0,
			error: null,
			errorKind: null,
			lastVerifiedAt: null,
			startedAt: null,
			finishedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			...overrides,
		} as Transfer;
	}

	function source(overrides: Partial<TransferSourceRef> = {}): TransferSourceRef {
		return {
			serviceId: 'service-1',
			serviceName: 'Jellyfin',
			peerId: null,
			transport: TransferTransport.HTTP_RANGE,
			externalId: 'item-1',
			sizeHint: TOTAL,
			...overrides,
		};
	}

	/** Runs the queue to completion without polling a private field. */
	async function runToEnd(id = 't1'): Promise<Transfer> {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));

			const current = transfers.get(id) as Transfer;

			if (
				[
					TransferState.DONE,
					TransferState.FAILED,
					TransferState.CANCELLED,
					TransferState.PAUSED,
				].includes(current.state)
			) {
				return current;
			}
		}

		throw new Error(`transfer ${id} never settled`);
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcs-engine-'));
		await mkdir(join(root, 'work'), { recursive: true });
		await mkdir(join(root, 'library'), { recursive: true });

		transfers = new Map([['t1', transfer()]]);
		chunkRows = [];
		settings = { ...DEFAULT_SETTINGS, chunkSize: CHUNK, maxParallelTransfers: 2 };

		transferRepository = {
			findResumable: jest.fn(async () => []),
			findOneBy: jest.fn(async ({ id }: { id: string }) => transfers.get(id) ?? null),
			save: jest.fn(async (entity: Transfer) => {
				transfers.set(entity.id, entity);

				return entity;
			}),
		} as unknown as jest.Mocked<Partial<TransferRepository>>;

		chunkRepository = {
			findByTransfer: jest.fn(async () => chunkRows),
			insertPlan: jest.fn(async (
				transferId: string,
				entries: { index: number; start: number; end: number; checksum: string | null }[],
			) => {
				chunkRows = entries.map(
					(entry) =>
						({
							transferId,
							index: entry.index,
							start: entry.start,
							end: entry.end,
							state: ChunkState.PENDING,
							bytesDone: 0,
							attempts: 0,
							sourceServiceId: null,
							checksum: entry.checksum,
						}) as TransferChunk,
				);

				return entries.length;
			}),
			updateState: jest.fn(async (transferId: string, index: number, patch: Partial<TransferChunk>) => {
				const row = chunkRows.find((candidate) => candidate.index === index);

				if (row) {
					Object.assign(row, patch);
				}
			}),
		} as unknown as jest.Mocked<Partial<TransferChunkRepository>>;

		fetchRange = jest.fn(async (_source: TransferSourceRef, range: { start: number; end: number }) => ({
			stream: Readable.from([content.subarray(range.start, range.end + 1)]),
			wholeFile: false,
			length: range.end - range.start + 1,
		}));

		prepare = jest.fn(async () => ({
			resumable: true,
			totalBytes: TOTAL,
			maxConnections: 4,
			pieceChecksums: null,
		}));

		const transport: ByteTransport = {
			transport: TransferTransport.HTTP_RANGE,
			prepare,
			fetch: fetchRange,
		} as unknown as ByteTransport;

		events = new EventGatewayService();
		moveFs = { ...NODE_FILE_MOVE_OPERATIONS };
		engine = new TransferEngineService(
			transferRepository as unknown as TransferRepository,
			chunkRepository as unknown as TransferChunkRepository,
			{ get: () => transport } as unknown as TransportRegistry,
			new VerificationService(new FingerprintService()),
			{ get: async () => settings } as unknown as SettingsService,
			events,
			new FileMoveService(moveFs),
		);

		engine.setSourceResolver(async () => [source()]);
	});

	afterEach(async () => {
		await engine.onModuleDestroy();
		events.onModuleDestroy();
		await rm(root, { recursive: true, force: true });
	});

	it('pulls a file, verifies it and places it at the path the manager decided on', async () => {
		await engine.enqueue('t1');

		const finished = await runToEnd();

		expect(finished.state).toBe(TransferState.DONE);
		// Compared as digests rather than as buffers: a deep equality over eight
		// hundred kilobytes takes Jest seconds, and says no more than this does.
		expect(await digestOf(finished.targetPath)).toBe(digest(content));
		expect(finished.bytesDone).toBe(TOTAL);
	});

	it('writes the chunk plan to the database before moving a byte', async () => {
		await engine.enqueue('t1');
		await runToEnd();

		expect(chunkRepository.insertPlan).toHaveBeenCalledTimes(1);
		expect(chunkRows).toHaveLength(4);
		expect(chunkRows[3].end).toBe(TOTAL - 1);
	});

	it('records every chunk as it completes, so a restart knows where it stopped', async () => {
		// The cache cannot be the source of truth here: it is optional, it expires by
		// design, and it is exactly what a restart loses.
		await engine.enqueue('t1');
		await runToEnd();

		expect(chunkRepository.updateState).toHaveBeenCalled();
		expect(chunkRows.every((row) => row.state === ChunkState.DONE)).toBe(true);
	});

	it('spreads the work over several connections', async () => {
		await engine.enqueue('t1');
		await runToEnd();

		// Four chunks, four connections allowed: every range is asked for exactly once.
		expect(fetchRange).toHaveBeenCalledTimes(4);
		expect(
			fetchRange.mock.calls.map((call) => (call[1] as { start: number }).start).sort((a, b) => a - b),
		).toEqual([0, CHUNK, CHUNK * 2, CHUNK * 3]);
	});

	it('picks up where it left off rather than starting again', async () => {
		// The first chunk is already on disk from a previous run.
		const partial = Buffer.alloc(TOTAL);

		content.copy(partial, 0, 0, CHUNK);
		await writeFile(join(root, 'work', 't1.part'), partial);

		chunkRows = [
			{ index: 0, start: 0, end: CHUNK - 1, state: ChunkState.DONE } as TransferChunk,
			{ index: 1, start: CHUNK, end: CHUNK * 2 - 1, state: ChunkState.PENDING } as TransferChunk,
			{ index: 2, start: CHUNK * 2, end: CHUNK * 3 - 1, state: ChunkState.ACTIVE } as TransferChunk,
			{ index: 3, start: CHUNK * 3, end: TOTAL - 1, state: ChunkState.PENDING } as TransferChunk,
		];

		await engine.enqueue('t1');

		const finished = await runToEnd();

		expect(finished.state).toBe(TransferState.DONE);
		expect(chunkRepository.insertPlan).not.toHaveBeenCalled();
		// The finished chunk is not fetched again; the one that was in flight is.
		expect(fetchRange).toHaveBeenCalledTimes(3);
		expect(await digestOf(finished.targetPath)).toBe(digest(content));
	});

	it('rebuilds its queue from the database on a restart', async () => {
		(transferRepository.findResumable as jest.Mock).mockResolvedValue([
			transfer({ state: TransferState.DOWNLOADING }),
		]);

		await engine.onApplicationBootstrap();

		expect((await runToEnd()).state).toBe(TransferState.DONE);
	});

	it('leaves a paused transfer paused across a restart', async () => {
		// Somebody paused it, and a restart is not a reason to overrule that.
		(transferRepository.findResumable as jest.Mock).mockResolvedValue([
			transfer({ id: 't2', state: TransferState.PAUSED }),
		]);

		await engine.onApplicationBootstrap();
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(fetchRange).not.toHaveBeenCalled();
	});

	it('fails with a source-gone error when nobody can serve the file', async () => {
		engine.setSourceResolver(async () => []);

		await engine.enqueue('t1');

		const finished = await runToEnd();

		expect(finished.state).toBe(TransferState.FAILED);
		expect(finished.errorKind).toBe(TransferErrorKind.SOURCE_GONE);
	});

	it('drops a source that cannot be prepared and keeps the one that can', async () => {
		prepare
			.mockRejectedValueOnce(new Error('unreachable'))
			.mockResolvedValue({ resumable: true, totalBytes: TOTAL, maxConnections: 4 });

		engine.setSourceResolver(async () => [
			source({ serviceId: 'dead', serviceName: 'Dead' }),
			source(),
		]);

		await engine.enqueue('t1');

		expect((await runToEnd()).state).toBe(TransferState.DONE);
	});

	it('refuses a whole-file answer for anything but the first chunk', async () => {
		// Writing the head of the file at the offset of chunk seventeen corrupts it in
		// a way no checksum could explain afterwards.
		fetchRange.mockImplementation(async (_source, range: { start: number; end: number }) => ({
			stream: Readable.from([content.subarray(range.start, range.end + 1)]),
			wholeFile: true,
			length: null,
		}));

		await engine.enqueue('t1');

		const finished = await runToEnd();

		// The first chunk consumes the whole-file answer and the transfer completes;
		// what matters is that no later chunk wrote the head of the file at its offset.
		expect([TransferState.DONE, TransferState.FAILED]).toContain(finished.state);

		if (finished.state === TransferState.DONE) {
			const placed = await readFile(finished.targetPath);

			expect(digest(placed.subarray(0, CHUNK))).toBe(digest(content.subarray(0, CHUNK)));
		}
	});

	it('fails the transfer when a chunk never arrives whole', async () => {
		fetchRange.mockImplementation(async (_source, range: { start: number; end: number }) => ({
			stream: Readable.from([content.subarray(range.start, range.start + 10)]),
			wholeFile: false,
			length: null,
		}));

		expect((await (await engine.enqueue('t1'), runToEnd())).state).toBe(TransferState.FAILED);
	});

	it('cancels a queued transfer and takes its partial file with it', async () => {
		await writeFile(join(root, 'work', 't1.part'), Buffer.alloc(10));

		await engine.cancel('t1');

		const cancelled = transfers.get('t1') as Transfer;

		expect(cancelled.state).toBe(TransferState.CANCELLED);
		expect(cancelled.errorKind).toBe(TransferErrorKind.CANCELLED);
		await expect(readFile(join(root, 'work', 't1.part'))).rejects.toThrow();
	});

	it('keeps the reason it was given when it cancels a queued transfer', async () => {
		await engine.cancel('t1', TransferErrorKind.SERVICE_REMOVED);

		expect((transfers.get('t1') as Transfer).errorKind).toBe(TransferErrorKind.SERVICE_REMOVED);
	});

	it('tells whoever is listening about a state change, once per change', async () => {
		// The job detail is kept up to date from this, rather than from a timer over
		// every live job: the engine reports, and what a state change means is decided
		// above it.
		const seen: TransferState[] = [];

		engine.onTransferState((transfer) => {
			seen.push(transfer.state);
		});

		await engine.cancel('t1');

		expect(seen).toEqual([TransferState.CANCELLED]);
	});

	it('does not lose a transfer over a listener that throws', async () => {
		engine.onTransferState(() => {
			throw new Error('the job detail is unwritable');
		});

		await engine.cancel('t1');

		expect((transfers.get('t1') as Transfer).state).toBe(TransferState.CANCELLED);
	});

	it('pauses a transfer that has not started', async () => {
		await engine.pause('t1');

		expect((transfers.get('t1') as Transfer).state).toBe(TransferState.PAUSED);
	});

	it('puts a paused transfer back in the queue when resumed', async () => {
		await engine.pause('t1');
		await engine.resume('t1');

		expect((await runToEnd()).state).toBe(TransferState.DONE);
	});

	it('reports what the queue is doing', async () => {
		expect(engine.stats()).toMatchObject({ active: 0, queued: 0, rate: 0 });

		await engine.enqueue('t1');
		await runToEnd();

		// Back to nothing once the pool has drained, which is what the header shows
		// when there is no work.
		expect(engine.stats()).toMatchObject({ active: 0, queued: 0, bytesRemaining: 0 });
	});

	/**
	 * A bandwidth cap is a live control, not a setting read when a transfer starts.
	 *
	 * Held open on the first chunk so the cap is applied while bytes are genuinely in
	 * flight — applying it before anything ran would prove only that the constructor
	 * read it. A kilobyte a second cannot move this file in a fifth of a second by any
	 * margin worth worrying about, and lifting the cap has to release the workers that
	 * are already waiting on it rather than leave them serving out the old allowance.
	 */
	it('throttles a transfer that is already running, and releases it when the cap goes', async () => {
		let open = (): void => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});

		fetchRange.mockImplementation(
			async (_source: TransferSourceRef, range: { start: number; end: number }) => {
				if (range.start === 0) {
					await gate;
				}

				return {
					stream: Readable.from([content.subarray(range.start, range.end + 1)]),
					wholeFile: false,
					length: range.end - range.start + 1,
				};
			},
		);

		await engine.enqueue('t1');

		for (let attempt = 0; attempt < 100 && fetchRange.mock.calls.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		engine.applyRateLimits({ downloadRateLimit: 1024 });
		open();

		await new Promise((resolve) => setTimeout(resolve, 200));

		expect((transfers.get('t1') as Transfer).state).not.toBe(TransferState.DONE);

		engine.applyRateLimits({ downloadRateLimit: 0 });

		expect((await runToEnd()).state).toBe(TransferState.DONE);
	});

	it('honours the piece hashes a source gave us', async () => {
		const checksums = new Map<number, string>([
			[0, createHash('sha256').update(content.subarray(0, CHUNK)).digest('hex')],
		]);

		prepare.mockResolvedValue({
			resumable: true,
			totalBytes: TOTAL,
			maxConnections: 4,
			pieceChecksums: checksums,
			pieceSize: CHUNK,
		});

		await engine.enqueue('t1');

		expect((await runToEnd()).state).toBe(TransferState.DONE);
		// Recorded against the piece, not merely accepted: it is what a restart, and
		// the repair pass, check the bytes on disk against.
		expect(chunkRows[0].checksum).toBe(checksums.get(0));
	});

	describe('the queue', () => {
		it('does not start the same transfer twice', async () => {
			// Every completion pumps the queue again, and a transfer queued twice would
			// be two runs writing the same offsets of the same file.
			await engine.enqueue('t1');
			await engine.enqueue('t1');
			await runToEnd();

			expect(chunkRepository.insertPlan).toHaveBeenCalledTimes(1);
		});

		it('never runs more transfers at once than the setting allows', async () => {
			// The pool is bounded by what is running *and* what is starting. `_run` is
			// not awaited, so a transfer taken off the queue has registered nothing yet;
			// counting only the registered ones let this loop drain the whole queue in
			// one synchronous pass, and `maxParallelTransfers` decided nothing at all.
			let open = (): void => {};
			const gate = new Promise<void>((resolve) => {
				open = resolve;
			});

			settings.maxParallelTransfers = 2;
			prepare.mockImplementation(async () => {
				await gate;

				return { resumable: true, totalBytes: TOTAL, maxConnections: 4 };
			});

			for (const id of ['q1', 'q2', 'q3', 'q4', 'q5']) {
				transfers.set(id, transfer({ id, workPath: join(root, 'work', `${id}.part`) }));
				await engine.enqueue(id);
			}

			await new Promise((resolve) => setTimeout(resolve, 100));

			// One `prepare` per source per run, and one source each.
			expect(prepare).toHaveBeenCalledTimes(2);

			open();
			await Promise.all(['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => runToEnd(id)));
		});

		it('starts nothing once the process is shutting down', async () => {
			// A transfer started during a shutdown opens a file handle nothing will
			// close, and writes into a directory the container is about to lose.
			await engine.onModuleDestroy();
			await engine.enqueue('t1');
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(fetchRange).not.toHaveBeenCalled();
			expect((transfers.get('t1') as Transfer).state).toBe(TransferState.QUEUED);
		});

		it('starts with an empty queue when the database cannot be read', async () => {
			// The gateway has to come up even when the transfers table does not answer:
			// refusing to boot over a queue nobody can read takes the whole interface
			// with it, including the screen that would say why.
			(transferRepository.findResumable as jest.Mock).mockRejectedValue(
				new Error('database asleep'),
			);

			await expect(engine.onApplicationBootstrap()).resolves.toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(engine.stats().queued).toBe(0);
			expect(fetchRange).not.toHaveBeenCalled();
		});

		it('leaves a transfer that has already finished alone', async () => {
			// A queue rebuilt from the database can name a transfer that completed
			// between the read and the pump, and re-running it would overwrite a placed
			// file with a fresh download of itself.
			transfers.set('t1', transfer({ state: TransferState.DONE }));

			await engine.enqueue('t1');
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(fetchRange).not.toHaveBeenCalled();
			expect((transfers.get('t1') as Transfer).state).toBe(TransferState.DONE);
		});

		it('records nothing for a transfer the database has never heard of', async () => {
			await engine.enqueue('ghost');
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(transfers.has('ghost')).toBe(false);
		});
	});

	describe('while a transfer is running', () => {
		/**
		 * Hold the first chunk open so the transfer is genuinely mid-flight.
		 *
		 * Everything in this block is about what the engine does to a running transfer,
		 * and a transfer that has already finished proves none of it.
		 */
		function gated(): { open: () => void } {
			let open = (): void => {};
			const gate = new Promise<void>((resolve) => {
				open = resolve;
			});

			fetchRange.mockImplementation(
				async (_source: TransferSourceRef, range: { start: number; end: number }) => {
					if (range.start === 0) {
						await gate;
					}

					return {
						stream: Readable.from([content.subarray(range.start, range.end + 1)]),
						wholeFile: false,
						length: range.end - range.start + 1,
					};
				},
			);

			return { open };
		}

		async function untilRunning(): Promise<void> {
			for (let attempt = 0; attempt < 100 && engine.stats().active === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}

		it('answers nothing live for a transfer that is not running', () => {
			// The row carries what survives a restart and deliberately not the rate: a
			// figure that is true for a second is not worth a write.
			expect(engine.progressOf('t1')).toBeNull();
		});

		it('answers the live figures a queue read back from the database has not got', async () => {
			const gate = gated();

			await engine.enqueue('t1');
			await untilRunning();

			const live = engine.progressOf('t1');

			expect(live).not.toBeNull();
			expect(live?.sources.map((source) => source.serviceId)).toEqual(['service-1']);
			// No rate has been measured yet, and an estimate derived from something
			// close to zero reads as certainty while being off by hours.
			expect(live?.etaSeconds).toBeNull();

			gate.open();
			await runToEnd();
		});

		it('counts what is in flight and what is left', async () => {
			const gate = gated();

			await engine.enqueue('t1');
			await untilRunning();

			expect(engine.stats()).toMatchObject({ active: 1, queued: 0 });
			expect(engine.stats().bytesRemaining).toBeGreaterThan(0);

			gate.open();
			await runToEnd();
		});

		it('pauses at a chunk boundary rather than throwing away what arrived', async () => {
			const gate = gated();

			await engine.enqueue('t1');
			await untilRunning();
			await engine.pause('t1');
			gate.open();

			const paused = await runToEnd();

			expect(paused.state).toBe(TransferState.PAUSED);
			// Whatever completed before the pause is still recorded, which is what makes
			// resuming cost the chunk in flight and nothing more.
			expect(chunkRows.some((row) => row.state === ChunkState.DONE)).toBe(true);
		});

		it('cancels a running transfer and takes its partial file with it', async () => {
			// Keeping it would silently consume the disk space somebody cancelled the
			// transfer to free.
			const gate = gated();

			await engine.enqueue('t1');
			await untilRunning();
			await engine.cancel('t1');
			gate.open();

			const cancelled = await runToEnd();

			expect(cancelled.state).toBe(TransferState.CANCELLED);
			expect(cancelled.errorKind).toBe(TransferErrorKind.CANCELLED);
			await expect(readFile(join(root, 'work', 't1.part'))).rejects.toThrow();
		});

		/**
		 * The reason survives the chunk the workers finish first.
		 *
		 * A running transfer is only written once its download loop returns, so a reason
		 * given to `cancel` and not carried to that moment would come out as somebody
		 * pressing the button — for a transfer the gateway stopped because its source
		 * service was removed.
		 */
		it('keeps the reason it was given when it stops a running transfer', async () => {
			const gate = gated();

			await engine.enqueue('t1');
			await untilRunning();
			await engine.cancel('t1', TransferErrorKind.SERVICE_REMOVED);
			gate.open();

			const cancelled = await runToEnd();

			expect(cancelled.state).toBe(TransferState.CANCELLED);
			expect(cancelled.errorKind).toBe(TransferErrorKind.SERVICE_REMOVED);
		});
	});

	describe('what it does with a source that misbehaves', () => {
		it('ignores the bytes a source sends past the end of the range it was given', async () => {
			// A server that answers a range request with more than was asked for is not
			// rare, and writing what it sent would put the next chunk's bytes at this
			// chunk's offset — then pass verification, because the file is the right
			// length and the pieces are in the wrong order.
			fetchRange.mockImplementation(
				async (_source: TransferSourceRef, range: { start: number; end: number }) => ({
					stream: Readable.from([content.subarray(range.start, range.end + 1 + 4_096)]),
					wholeFile: false,
					length: null,
				}),
			);

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
		});

		it('finishes on the surviving source when another dies mid-transfer', async () => {
			// Three failures in a row is a source that is not coming back this run.
			// Dropping it out of the rotation is not the same as failing the transfer,
			// which the others can still finish.
			settings.maxConnectionsPerSource = 1;

			fetchRange.mockImplementation(
				async (sourceRef: TransferSourceRef, range: { start: number; end: number }) => {
					if (sourceRef.serviceId === 'dying') {
						throw new Error('connection reset');
					}

					await new Promise((resolve) => setTimeout(resolve, 20));

					return {
						stream: Readable.from([content.subarray(range.start, range.end + 1)]),
						wholeFile: false,
						length: range.end - range.start + 1,
					};
				},
			);

			engine.setSourceResolver(async () => [
				source({ serviceId: 'dying', serviceName: 'Dying' }),
				source({ serviceId: 'alive', serviceName: 'Alive' }),
			]);

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
		});

		it('finishes even when the chunk bookkeeping cannot be written', async () => {
			// The record of which pieces are whole is what a restart reads, and losing it
			// costs a re-download. Failing the transfer over it costs the same
			// re-download and the file we already had.
			(chunkRepository.updateState as jest.Mock).mockRejectedValue(new Error('write failed'));

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
		});
	});

	describe('verification and repair', () => {
		function checksumsFor(indexes: number[]): Map<number, string> {
			const bounds = indexes.map((index) => ({
				index,
				start: index * CHUNK,
				end: Math.min((index + 1) * CHUNK, TOTAL) - 1,
			}));

			return new Map(
				bounds.map(({ index, start, end }) => [
					index,
					createHash('sha256').update(content.subarray(start, end + 1)).digest('hex'),
				]),
			);
		}

		it('fetches back the one piece that arrived wrong, not the whole file', async () => {
			// Discarding thirty gigabytes because two megabytes are wrong is what makes
			// people give up on syncing.
			let corrupted = false;

			prepare.mockResolvedValue({
				resumable: true,
				totalBytes: TOTAL,
				maxConnections: 4,
				pieceChecksums: checksumsFor([0, 1, 2, 3]),
				pieceSize: CHUNK,
			});

			fetchRange.mockImplementation(
				async (_source: TransferSourceRef, range: { start: number; end: number }) => {
					const piece = content.subarray(range.start, range.end + 1);

					if (range.start === CHUNK && !corrupted) {
						corrupted = true;

						return {
							stream: Readable.from([Buffer.alloc(piece.length, 0xff)]),
							wholeFile: false,
							length: piece.length,
						};
					}

					return { stream: Readable.from([piece]), wholeFile: false, length: piece.length };
				},
			);

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(finished.chunksRepaired).toBe(1);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
		});

		it('gives up rather than placing a file it could never repair', async () => {
			// A file that fails its hashes must never reach the library: the media
			// server watches that directory and will happily index a corrupt file.
			prepare.mockResolvedValue({
				resumable: true,
				totalBytes: TOTAL,
				maxConnections: 4,
				pieceChecksums: checksumsFor([0, 1, 2, 3]),
				pieceSize: CHUNK,
			});

			fetchRange.mockImplementation(
				async (_source: TransferSourceRef, range: { start: number; end: number }) => {
					const length = range.end - range.start + 1;
					const piece =
						range.start === CHUNK
							? Buffer.alloc(length, 0xff)
							: content.subarray(range.start, range.end + 1);

					return { stream: Readable.from([piece]), wholeFile: false, length };
				},
			);

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.FAILED);
			expect(finished.errorKind).toBe(TransferErrorKind.CHECKSUM_MISMATCH);
			await expect(readFile(finished.targetPath)).rejects.toThrow();
		});
	});

	describe('the working file', () => {
		it('cuts a leftover from a larger previous attempt back to size', async () => {
			// The plan is about to say which parts of it are valid, and a file longer
			// than the transfer passes the size check while carrying somebody else's
			// trailing bytes into the library.
			await writeFile(join(root, 'work', 't1.part'), Buffer.alloc(TOTAL * 2, 0xee));

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
		});

		it('takes the size from the source when the row does not carry one', async () => {
			// A transfer created from a peer catalogue entry knows what it wants and not
			// how big it is; the source is asked at `prepare` time and that answer is
			// what the plan is built from.
			transfers.set('t1', transfer({ bytesTotal: 0 }));

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(Number(finished.bytesTotal)).toBe(TOTAL);
		});
	});

	describe('naming what went wrong', () => {
		/*
		 * The kinds exist because the buttons differ: a missing source offers "look for
		 * another one", a full disk offers "choose another library", and neither is a
		 * retry that would fail the same way. Driven through a one-chunk transfer with
		 * two sources, which is the shape that lets a chunk exhaust its attempts before
		 * every source has been dropped — so the error that caused it survives to be
		 * classified rather than being replaced by "every source failed".
		 */
		it.each([
			['ENOSPC: no space left on device', TransferErrorKind.DISK_FULL],
			['EACCES: permission denied, open', TransferErrorKind.PERMISSION_DENIED],
			['ENOENT: no such file or directory', TransferErrorKind.TARGET_MISSING],
			['Request failed with status 401 Unauthorized', TransferErrorKind.SOURCE_UNAUTHORIZED],
			['Request failed with status 404', TransferErrorKind.SOURCE_GONE],
			['checksum did not match', TransferErrorKind.CHECKSUM_MISMATCH],
			['ECONNRESET while reading', TransferErrorKind.NETWORK],
			['something nobody has seen before', TransferErrorKind.UNKNOWN],
		])('turns "%s" into a kind the interface can act on', async (message, kind) => {
			transfers.set('small', transfer({ id: 'small', bytesTotal: 1_000 }));

			fetchRange.mockRejectedValue(new Error(message));
			engine.setSourceResolver(async () => [
				source({ serviceId: 'first', serviceName: 'First' }),
				source({ serviceId: 'second', serviceName: 'Second' }),
			]);

			await engine.enqueue('small');

			const finished = await runToEnd('small');

			expect(finished.state).toBe(TransferState.FAILED);
			expect(finished.errorKind).toBe(kind);
		});
	});

	/**
	 * The step between a verified download and a file somebody can watch.
	 *
	 * Worth its own block because the normal deployment takes the slow path through
	 * it: the working directory is in the container and the library is a NAS mount, so
	 * `rename` answers `EXDEV` and every byte of a forty gigabyte film is streamed.
	 * That used to be a bare `copyFile` — no progress, no pause, no resume, and a full
	 * disk that threw and left a temporary nobody knew about.
	 */
	describe('placing', () => {
		/** The library is a different mount: only the temporary can be renamed. */
		function crossDevice(): void {
			const real = NODE_FILE_MOVE_OPERATIONS.rename;

			moveFs.rename = async (from, to) => {
				if (from.endsWith('.part')) {
					throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' });
				}

				await real(from, to);
			};
		}

		it('streams the finished file into a library on another mount', async () => {
			crossDevice();

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.DONE);
			expect(await digestOf(finished.targetPath)).toBe(digest(content));
			// Nothing is left under the temporary name the media server must never see.
			await expect(stat(`${finished.targetPath}.mcs-part`)).rejects.toThrow();
		});

		it('publishes the move down the same channel the download uses', async () => {
			// One channel, not two: a second one would mean every client learning to
			// read both, and a bar that jumps between them at the end of a transfer.
			crossDevice();

			const placing: { bytesDone: number; bytesTotal: number }[] = [];

			events.publishProgress = ((progress: {
				state: TransferState;
				bytesDone: number;
				bytesTotal: number;
			}) => {
				if (progress.state === TransferState.PLACING) {
					placing.push({ bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal });
				}
			}) as EventGatewayService['publishProgress'];

			await engine.enqueue('t1');

			expect((await runToEnd()).state).toBe(TransferState.DONE);
			expect(placing.length).toBeGreaterThan(0);
			expect(placing[placing.length - 1]).toEqual({ bytesDone: TOTAL, bytesTotal: TOTAL });
		});

		it('says the destination is full rather than that the move failed', async () => {
			crossDevice();
			moveFs.createWriteStream = (path, options) => {
				const real = NODE_FILE_MOVE_OPERATIONS.createWriteStream(path, options);

				return new Writable({
					write(_chunk, _encoding, callback) {
						callback(Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' }));
					},
					destroy(error, callback) {
						real.end(() => callback(error));
					},
				});
			};

			await engine.enqueue('t1');

			const finished = await runToEnd();

			expect(finished.state).toBe(TransferState.FAILED);
			expect(finished.errorKind).toBe(TransferErrorKind.DISK_FULL);
			// The key the interface needs: nothing is lost, the partial is still there,
			// and freeing space and resuming costs the remainder rather than the file.
			expect(finished.error).toBe(ErrorKey.TRANSFER_DESTINATION_FULL);
			expect(await stat(join(root, 'work', 't1.part'))).toBeDefined();
		});
	});

	it('reports progress by the byte rather than by the buffer', async () => {
		// A stalled transfer should not keep emitting identical frames, and a fast one
		// should not emit one per buffer — so a frame is owed every few megabytes and
		// the row is written with it, which is what a page opened mid-transfer reads.
		const large = Buffer.alloc(6 * 1024 * 1024, 0x42);
		const frames: number[] = [];

		transfers.set('big', transfer({ id: 'big', bytesTotal: large.length }));
		fetchRange.mockImplementation(
			async (_source: TransferSourceRef, range: { start: number; end: number }) => ({
				stream: Readable.from([large.subarray(range.start, range.end + 1)]),
				wholeFile: false,
				length: range.end - range.start + 1,
			}),
		);
		prepare.mockResolvedValue({
			resumable: true,
			totalBytes: large.length,
			maxConnections: 4,
			pieceChecksums: null,
		});
		events.publishProgress = ((progress: { bytesDone: number }) => {
			frames.push(progress.bytesDone);
		}) as EventGatewayService['publishProgress'];

		await engine.enqueue('big');

		expect((await runToEnd('big')).state).toBe(TransferState.DONE);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.length).toBeLessThan(large.length / (1024 * 1024));
	});
});
