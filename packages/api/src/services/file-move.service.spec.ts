import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { ErrorKey } from '@mcs/shared';
import {
	COPY_CHUNK_BYTES,
	FILE_MOVE_CANCEL,
	FileMoveError,
	FileMoveOutcome,
	FileMoveService,
	NODE_FILE_MOVE_OPERATIONS,
	type FileMoveOperations,
	type FileMoveProgress,
} from './file-move.service';

/**
 * Big enough to be copied in three passes, so a resume has a middle to come back to.
 *
 * The chunk size is what it is for a network mount, not for a test, and a file
 * smaller than one chunk would make every one of these tests pass for the wrong
 * reason: a single write, no boundary to stop at and no offset to resume from.
 */
const TOTAL = COPY_CHUNK_BYTES * 2 + 4096;

function body(size = TOTAL): Buffer {
	const buffer = Buffer.alloc(size);

	for (let index = 0; index < size; index += 1) {
		buffer[index] = index % 251;
	}

	return buffer;
}

/** One opened read stream, and how much of the file it actually pulled. */
interface ReadRecord {
	start: number;
	stream: Readable & { bytesRead: number };
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

/**
 * Compared as digests, never as buffers.
 *
 * A `toEqual` over sixteen megabytes does not take Jest a long time, it takes it the
 * whole heap: the diff it builds when it thinks the two might differ is what runs the
 * process out of memory, and it says nothing this does not.
 */
function digest(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

async function digestOf(path: string): Promise<string> {
	return digest(await readFile(path));
}

async function sizeOf(path: string): Promise<number> {
	return stat(path)
		.then((stats) => stats.size)
		.catch(() => -1);
}

/**
 * A destination that stops taking bytes after a while.
 *
 * `'enospc'` is the full disk, `'drop'` is the mount that accepts a write and stores
 * less than it was given. Both are simulated here rather than arranged for real: a
 * test that needed an actual full filesystem, or an actual truncating SMB share,
 * would be a test nobody ever runs.
 */
function limitedWriteStream(
	path: string,
	options: { flags: string; highWaterMark: number },
	cap: number,
	behaviour: 'enospc' | 'drop',
): Writable {
	const real = createWriteStream(path, options);
	let written = 0;

	return new Writable({
		highWaterMark: options.highWaterMark,
		write(chunk: Buffer, _encoding, callback) {
			if (written >= cap) {
				callback(behaviour === 'enospc' ? errno('ENOSPC') : null);

				return;
			}

			const slice = chunk.subarray(0, cap - written);

			written += slice.length;
			real.write(slice, () => callback());
		},
		final(callback) {
			real.end(() => callback());
		},
		destroy(error, callback) {
			// The bytes that were accepted have to reach the disk even though the stream
			// is going down, because they are the partial the next call resumes from.
			real.end(() => callback(error));
		},
	});
}

describe('FileMoveService', () => {
	let root: string;
	let source: string;
	let destination: string;
	let partial: string;
	let content: Buffer;
	let reads: ReadRecord[];

	/**
	 * The real filesystem, with whatever this test needs to lie about.
	 *
	 * Every call goes to a real temporary tree — `mkdtemp`, not a mock — so the copy,
	 * the resume and the rename are all genuinely exercised. Only the answers that
	 * need a second filesystem or a full disk are substituted.
	 */
	function operations(overrides: Partial<FileMoveOperations> = {}): FileMoveOperations {
		const base: FileMoveOperations = {
			...NODE_FILE_MOVE_OPERATIONS,
			createReadStream: (path, options) => {
				// `bytesRead` rather than a `data` listener: attaching one puts the
				// stream into flowing mode, and a stream being iterated and flowing at
				// the same time reads the file twice over into memory.
				const stream = NODE_FILE_MOVE_OPERATIONS.createReadStream(path, options) as Readable & {
					bytesRead: number;
				};

				reads.push({ start: options.start, stream });

				return stream;
			},
		};

		return { ...base, ...overrides };
	}

	/** Cross-device: the file cannot be renamed into place, only the temporary can. */
	function crossDevice(overrides: Partial<FileMoveOperations> = {}): FileMoveOperations {
		return operations({
			rename: async (from, to) => {
				if (from === source) {
					throw errno('EXDEV');
				}

				await NODE_FILE_MOVE_OPERATIONS.rename(from, to);
			},
			...overrides,
		});
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcs-move-'));
		await mkdir(join(root, 'work'), { recursive: true });

		content = body();
		source = join(root, 'work', 'download.part');
		destination = join(root, 'library', 'Show', 'S01E02.mkv');
		partial = `${destination}.mcs-part`;
		reads = [];

		await writeFile(source, content);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('renames when both ends are on one filesystem, and copies nothing', async () => {
		const service = new FileMoveService(operations());

		const result = await service.move({ source, destination });

		expect(result.outcome).toBe(FileMoveOutcome.RENAMED);
		// The whole point of the fast path: a same-mount move is instantaneous, and it
		// stays that way only as long as nobody opens a stream on it.
		expect(reads).toHaveLength(0);
		expect(result.bytesCopied).toBe(0);
		expect(await sizeOf(source)).toBe(-1);
		expect(await digestOf(destination)).toBe(digest(content));
	});

	it('creates the destination directory before it moves anything into it', async () => {
		const service = new FileMoveService(operations());

		await service.move({ source, destination });

		expect(await sizeOf(destination)).toBe(TOTAL);
	});

	it('refuses anything but EXDEV rather than falling back to a copy', async () => {
		// A permission problem answered with a quarter of an hour of streaming is a
		// quarter of an hour spent discovering the same refusal again.
		const service = new FileMoveService(
			operations({
				rename: async () => {
					throw errno('EACCES');
				},
			}),
		);

		await expect(service.move({ source, destination })).rejects.toMatchObject({
			code: 'EACCES',
		});
		expect(reads).toHaveLength(0);
	});

	it('streams across a device boundary and lands byte-identical', async () => {
		const service = new FileMoveService(crossDevice());
		const progress: FileMoveProgress[] = [];

		const result = await service.move({
			source,
			destination,
			onProgress: (frame) => progress.push({ ...frame }),
		});

		expect(result.outcome).toBe(FileMoveOutcome.COPIED);
		expect(result.bytesCopied).toBe(TOTAL);
		expect(await digestOf(destination)).toBe(digest(content));
		// The working copy is gone and no temporary is left behind.
		expect(await sizeOf(source)).toBe(-1);
		expect(await sizeOf(partial)).toBe(-1);

		expect(progress.length).toBeGreaterThan(1);
		expect(progress.every((frame) => frame.bytesTotal === TOTAL)).toBe(true);
		expect(progress.map((frame) => frame.bytesDone)).toEqual([
			COPY_CHUNK_BYTES,
			COPY_CHUNK_BYTES * 2,
			TOTAL,
		]);
	});

	it('continues from an existing partial instead of reading the file again', async () => {
		// The exact failure this test exists for: a resume that silently starts from
		// zero looks identical from the outside and costs the whole file every time.
		const done = COPY_CHUNK_BYTES;

		await mkdir(join(root, 'library', 'Show'), { recursive: true });
		await writeFile(partial, content.subarray(0, done));

		const service = new FileMoveService(crossDevice());

		const result = await service.move({ source, destination });

		expect(result.outcome).toBe(FileMoveOutcome.COPIED);
		expect(result.bytesCopied).toBe(TOTAL - done);
		expect(await digestOf(destination)).toBe(digest(content));

		expect(reads).toHaveLength(1);
		expect(reads[0].start).toBe(done);
		expect(reads[0].stream.bytesRead).toBe(TOTAL - done);
	});

	it('throws away a partial that is longer than its source', async () => {
		// It cannot be a prefix of this file, so appending to it would produce
		// something of exactly the right length and wrong all the way through.
		await mkdir(join(root, 'library', 'Show'), { recursive: true });
		await writeFile(partial, body(TOTAL + 4096));

		const service = new FileMoveService(crossDevice());

		await service.move({ source, destination });

		expect(await digestOf(destination)).toBe(digest(content));
		expect(reads[0].start).toBe(0);
	});

	it('leaves the partial where it is when the move is paused, and finishes it later', async () => {
		const controller = new AbortController();
		const service = new FileMoveService(crossDevice());

		const paused = await service.move({
			source,
			destination,
			signal: controller.signal,
			onProgress: () => controller.abort(),
		});

		expect(paused.outcome).toBe(FileMoveOutcome.PAUSED);
		expect(paused.partialPath).toBe(partial);
		expect(await sizeOf(partial)).toBe(COPY_CHUNK_BYTES);
		// Nothing was renamed, so the media server has not been shown a prefix.
		expect(await sizeOf(destination)).toBe(-1);
		expect(await sizeOf(source)).toBe(TOTAL);

		reads = [];

		const finished = await service.move({ source, destination });

		expect(finished.outcome).toBe(FileMoveOutcome.COPIED);
		expect(reads[0].start).toBe(COPY_CHUNK_BYTES);
		expect(await digestOf(destination)).toBe(digest(content));
	});

	it('removes the partial when the move is cancelled', async () => {
		// The disk space is exactly what somebody cancelled the transfer to get back.
		const controller = new AbortController();
		const service = new FileMoveService(crossDevice());

		const result = await service.move({
			source,
			destination,
			signal: controller.signal,
			onProgress: () => controller.abort(FILE_MOVE_CANCEL),
		});

		expect(result.outcome).toBe(FileMoveOutcome.CANCELLED);
		expect(result.partialPath).toBeNull();
		expect(await sizeOf(partial)).toBe(-1);
		expect(await sizeOf(destination)).toBe(-1);
	});

	it('does not start at all when the signal is already aborted', async () => {
		const controller = new AbortController();

		controller.abort();

		const service = new FileMoveService(crossDevice());
		const result = await service.move({ source, destination, signal: controller.signal });

		expect(result.outcome).toBe(FileMoveOutcome.PAUSED);
		expect(reads).toHaveLength(0);
		expect(await sizeOf(source)).toBe(TOTAL);
	});

	it('refuses to rename a copy that is shorter than its source', async () => {
		// A truncated file renamed into a library is indexed by the media server as a
		// real one: it appears, it plays until the bytes run out, and nothing anywhere
		// says a word.
		const service = new FileMoveService(
			crossDevice({
				createWriteStream: (path, options) =>
					limitedWriteStream(path, options, COPY_CHUNK_BYTES, 'drop'),
			}),
		);

		await expect(service.move({ source, destination })).rejects.toThrow(FileMoveError);

		expect(await sizeOf(destination)).toBe(-1);
		expect(await sizeOf(source)).toBe(TOTAL);
	});

	it('answers a full destination with its own key and keeps the partial', async () => {
		const service = new FileMoveService(
			crossDevice({
				createWriteStream: (path, options) =>
					limitedWriteStream(path, options, COPY_CHUNK_BYTES, 'enospc'),
			}),
		);

		const failure = await service.move({ source, destination }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FileMoveError);
		expect((failure as FileMoveError).key).toBe(ErrorKey.TRANSFER_DESTINATION_FULL);
		// Kept on purpose: somebody frees space and the move carries on from here
		// rather than from zero, which is the only version of this worth the disk.
		expect(await sizeOf(partial)).toBe(COPY_CHUNK_BYTES);
		expect(await sizeOf(destination)).toBe(-1);
		expect(await sizeOf(source)).toBe(TOTAL);
	});

	it('resumes a move that a full disk stopped, once there is room', async () => {
		let cap = COPY_CHUNK_BYTES;
		const service = new FileMoveService(
			crossDevice({
				createWriteStream: (path, options) => limitedWriteStream(path, options, cap, 'enospc'),
			}),
		);

		await expect(service.move({ source, destination })).rejects.toThrow(FileMoveError);

		cap = TOTAL;
		reads = [];

		const result = await service.move({ source, destination });

		expect(result.outcome).toBe(FileMoveOutcome.COPIED);
		expect(reads[0].start).toBe(COPY_CHUNK_BYTES);
		expect(await digestOf(destination)).toBe(digest(content));
	});

	it('refuses before writing when the destination plainly cannot hold the file', async () => {
		const service = new FileMoveService(
			crossDevice({
				statfs: async () => ({ bavail: 1, bsize: 4096 }),
			}),
		);

		const failure = await service.move({ source, destination }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FileMoveError);
		expect((failure as FileMoveError).key).toBe(ErrorKey.TRANSFER_DESTINATION_FULL);
		// Refused up front, so not a byte was read and the working copy is untouched.
		expect(reads).toHaveLength(0);
		expect(await sizeOf(source)).toBe(TOTAL);
	});

	it('goes ahead when the reserve is the only thing in the way', async () => {
		// The reserve is a question somebody answered before the run started. Refusing
		// here would throw away a download that has already finished over a margin that
		// was accepted, which is not a trade this class is allowed to make.
		const service = new FileMoveService(
			crossDevice({
				statfs: async () => ({ bavail: TOTAL + 4096, bsize: 1 }),
			}),
		);

		const result = await service.move({
			source,
			destination,
			reserveBytes: 5 * 1024 * 1024 * 1024,
		});

		expect(result.outcome).toBe(FileMoveOutcome.COPIED);
		expect(await digestOf(destination)).toBe(digest(content));
	});

	it('goes ahead when the free space cannot be measured at all', async () => {
		// `statfs` is not implemented on some network mounts, and "we could not measure
		// it" read as "it is full" refuses a destination that is perfectly writable.
		const service = new FileMoveService(
			crossDevice({
				statfs: async () => {
					throw errno('ENOSYS');
				},
			}),
		);

		expect((await service.move({ source, destination })).outcome).toBe(FileMoveOutcome.COPIED);
	});

	it('commits a partial that is already complete without reading anything again', async () => {
		// The window between the last write and the rename: an earlier call copied
		// everything and was stopped before it could commit.
		await mkdir(join(root, 'library', 'Show'), { recursive: true });
		await writeFile(partial, content);

		const service = new FileMoveService(crossDevice());

		const result = await service.move({ source, destination });

		expect(result.outcome).toBe(FileMoveOutcome.COPIED);
		expect(result.bytesCopied).toBe(0);
		expect(reads).toHaveLength(0);
		expect(await digestOf(destination)).toBe(digest(content));
	});
});
