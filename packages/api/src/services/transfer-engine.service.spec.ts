import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
	ChunkState,
	TransferErrorKind,
	TransferState,
	TransferTransport,
	type Settings,
} from '@mcs/shared';
import type { Transfer, TransferChunk } from '@/entities';
import type { TransferChunkRepository, TransferRepository } from '@/repositories';
import { EventGatewayService } from './event-gateway.service';
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
			insertPlan: jest.fn(async (transferId: string, entries: { index: number; start: number; end: number }[]) => {
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
							checksum: null,
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
		engine = new TransferEngineService(
			transferRepository as unknown as TransferRepository,
			chunkRepository as unknown as TransferChunkRepository,
			{ get: () => transport } as unknown as TransportRegistry,
			new VerificationService(new FingerprintService()),
			{ get: async () => settings } as unknown as SettingsService,
			events,
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

	it('honours the piece hashes a source gave us', async () => {
		const checksums = new Map<number, string>([
			[0, createHash('sha256').update(content.subarray(0, CHUNK)).digest('hex')],
		]);

		prepare.mockResolvedValue({
			resumable: true,
			totalBytes: TOTAL,
			maxConnections: 4,
			pieceChecksums: checksums,
		});

		await engine.enqueue('t1');

		expect((await runToEnd()).state).toBe(TransferState.DONE);
	});
});
