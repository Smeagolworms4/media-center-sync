import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable, Writable } from 'node:stream';
import { ErrorKey, SpaceVerdict, type ErrorKeyValue } from '@mcs/shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { freeBytesAt, spaceVerdict } from './space';

/**
 * Bytes read and written in one go on the streaming path.
 *
 * Eight mebibytes, chosen for a network mount rather than for a local disk. The
 * library is an NFS or SMB share in every deployment this was written for, and there
 * the cost of a copy is dominated by round trips, not by throughput: Node's default
 * sixty-four kilobyte buffer turns a forty gigabyte film into six hundred thousand
 * request/response pairs, and on a link with a millisecond of latency that is ten
 * minutes of pure waiting. Eight mebibytes is a whole number of the one mebibyte
 * `rsize`/`wsize` most NFS mounts negotiate, so no read is split at the protocol
 * level, and it is still small enough that a pause takes effect within a fraction of
 * a second and that several moves at once stay inside a container's memory limit.
 */
export const COPY_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * How long a move waits before it touches the file: nothing, unless a test says so.
 *
 * `MCS_PLACING_HOLD_MS` is a **test hook, not a setting**, of the same kind as
 * `MCS_LANDING_GRACE_MS`. A transfer is `placing` only while this class runs, and on
 * the usual same-filesystem deployment that is one rename — a millisecond. The
 * gateway's refusal to re-point a file in that window (`error.transfer.being_placed`)
 * is the design point of changing a destination at all, and without a way to hold the
 * window open no journey can ever reach it: the one that checks it was a skipped
 * placeholder. A gateway started with a few seconds here holds every placement that
 * long, with the transfer already reading `placing`, and nothing else changes.
 *
 * Read once, at start-up. Anything that is not a positive integer means no hold, so a
 * typo leaves a deployment moving files at once rather than waiting.
 */
export function placingHoldMs(raw: string | undefined = process.env.MCS_PLACING_HOLD_MS): number {
	const parsed = Number(raw);

	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

const PLACING_HOLD_MS = placingHoldMs();

/**
 * Window over which the reported rate is measured.
 *
 * Matches the transfer engine's own window, because the two numbers are shown in the
 * same place: a download that reports over five seconds followed by a move that
 * reports over one would look like a speed change that never happened.
 */
const RATE_WINDOW_MS = 5_000;

/** Suffix of the file being streamed. Kept beside the destination, never inside it. */
const PARTIAL_SUFFIX = '.mcs-part';

/**
 * Abort with this reason to throw the partial away.
 *
 * A pause and a cancellation are the same event to an `AbortSignal`, and they must
 * not be the same thing here: pausing keeps the partial so the move can be finished
 * later, cancelling removes it because the disk space is exactly what somebody
 * cancelled to get back. The reason is how the caller says which one it meant.
 */
export const FILE_MOVE_CANCEL = 'file-move:cancel';

export interface FileMoveProgress {
	bytesDone: number;
	bytesTotal: number;
	/** Bytes per second over the last window. Zero until the first window closes. */
	rate: number;
}

export enum FileMoveOutcome {
	/** Same filesystem: the file was renamed, and not a byte was copied. */
	RENAMED = 'renamed',
	/** Cross-device: the file was streamed, verified and renamed into place. */
	COPIED = 'copied',
	/** Aborted without `FILE_MOVE_CANCEL`. The partial is still there to resume from. */
	PAUSED = 'paused',
	/** Aborted with `FILE_MOVE_CANCEL`. The partial is gone. */
	CANCELLED = 'cancelled',
}

export interface FileMoveResult {
	outcome: FileMoveOutcome;
	/** Bytes written by this call. Zero for a rename, and zero for a no-op resume. */
	bytesCopied: number;
	/** The partial left behind, when there is one to come back to. */
	partialPath: string | null;
}

export interface FileMoveRequest {
	source: string;
	/** Final path. Its directory is created if it does not exist. */
	destination: string;
	/**
	 * Stops the move. Abort with `FILE_MOVE_CANCEL` as the reason to discard the
	 * partial; abort with anything else, or nothing, to keep it.
	 */
	signal?: AbortSignal;
	/**
	 * Free space this gateway will not eat into — `Settings.diskReserveBytes`.
	 *
	 * Passed in rather than read here, because whether a reserve applies to a given
	 * move is a decision and this class does not make decisions.
	 */
	reserveBytes?: number;
	/** Called as bytes land. Never called on the rename path, where there are none. */
	onProgress?: (progress: FileMoveProgress) => void;
}

/**
 * A move that stopped for a reason the interface can word.
 *
 * The key is the point: a caller has to be able to tell "the destination is full"
 * from "the move failed", because the first one is answerable — free some space, or
 * pick another library — and the partial is still on disk waiting to be finished.
 * The message keeps the errno in it so the engine's error classifier, which reads
 * messages, still reaches the right `TransferErrorKind`.
 */
export class FileMoveError extends Error {
	public constructor(
		public readonly key: ErrorKeyValue,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = 'FileMoveError';
	}
}

/**
 * The filesystem, as this service uses it.
 *
 * A seam for tests, not an extension point: there is one way to move a file and this
 * class is it. `EXDEV` needs two filesystems and `ENOSPC` needs a full disk, and a
 * test suite that had to arrange either would not be run — so the calls that can
 * produce them are handed in and a test substitutes one. Nobody should grow a
 * registry, a decorator or a second implementation behind this; the day there is a
 * genuine second way to move bytes, it will not look like this.
 */
export interface FileMoveOperations {
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ size: number }>;
	statfs(path: string): Promise<{ bavail: number | bigint; bsize: number | bigint }>;
	mkdir(path: string): Promise<void>;
	unlink(path: string): Promise<void>;
	createReadStream(path: string, options: { start: number; highWaterMark: number }): Readable;
	createWriteStream(path: string, options: { flags: string; highWaterMark: number }): Writable;
}

/** The token the seam is injected under. See the constructor for why it exists. */
export const FILE_MOVE_OPERATIONS = Symbol('FileMoveOperations');

/** What the service does when nobody substitutes anything: the real filesystem. */
export const NODE_FILE_MOVE_OPERATIONS: FileMoveOperations = {
	rename: (from, to) => rename(from, to),
	stat: (path) => stat(path),
	statfs: (path) => statfs(path),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	unlink: (path) => unlink(path),
	createReadStream: (path, options) => createReadStream(path, options),
	createWriteStream: (path, options) => createWriteStream(path, options),
};

const errnoOf = (error: unknown): string | null =>
	typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code: unknown }).code)
		: null;

/**
 * Moves one finished file into the library, and says how it is going while it does.
 *
 * A rename when both ends are on the same filesystem, a resumable stream copy when
 * they are not — which is the normal case, because the working directory is in the
 * container and the library is a NAS mount. The copy it replaces was a bare
 * `copyFile`: for a forty gigabyte film over NFS that is a quarter of an hour in
 * which nothing reports anything, nothing can pause it, a broken link means starting
 * again from zero, and a full disk throws and leaves a partial nobody knows about.
 *
 * Decides nothing about whether it should be asked. Which file goes where, whether
 * the reserve applies, and what a failure means to a transfer all belong above this
 * class; it is handed two paths and a signal, and it reports.
 */
@Injectable()
export class FileMoveService {
	private readonly _logger = new Logger(FileMoveService.name);

	/**
	 * `@Optional()` and a token, rather than a plain defaulted parameter.
	 *
	 * `FileMoveOperations` is an interface, so the metadata Nest reads says `Object`
	 * and the container goes looking for a provider by that name: the application
	 * refuses to boot with "cannot resolve dependency (?)", which says nothing about
	 * the default sitting right there. Optional means nothing has to be registered —
	 * the real filesystem is used — while a test still constructs the class directly
	 * and hands in its own.
	 */
	public constructor(
		@Optional()
		@Inject(FILE_MOVE_OPERATIONS)
		private readonly _fs: FileMoveOperations = NODE_FILE_MOVE_OPERATIONS,
	) {}

	public async move(request: FileMoveRequest): Promise<FileMoveResult> {
		const partial = `${request.destination}${PARTIAL_SUFFIX}`;

		if (this._stopped(request.signal)) {
			return this._aborted(request.signal, partial, 0);
		}

		if (PLACING_HOLD_MS > 0) {
			await sleep(PLACING_HOLD_MS);

			// A pause or a cancel pressed during the hold is answered as it would have
			// been a moment earlier, rather than after a move nobody wants any more.
			if (this._stopped(request.signal)) {
				return this._aborted(request.signal, partial, 0);
			}
		}

		await this._fs.mkdir(dirname(request.destination));

		try {
			await this._fs.rename(request.source, request.destination);

			return { outcome: FileMoveOutcome.RENAMED, bytesCopied: 0, partialPath: null };
		} catch (error) {
			// Only `EXDEV`. Every other refusal — a permission, a missing source, a
			// read-only mount — is a real failure, and turning it into a stream copy
			// would spend a quarter of an hour discovering the same thing again. The
			// fast path is not an optimisation to be dropped either: on a same-mount
			// deployment a rename is instantaneous and a copy is not, and the whole
			// difference is this one comparison.
			if (errnoOf(error) !== 'EXDEV') {
				throw error;
			}
		}

		return this._stream(request, partial);
	}

	/**
	 * The cross-device path: check, resume, copy, verify, commit.
	 *
	 * Written to a temporary beside the destination rather than to the destination
	 * itself, because the media server watches that directory: a file appearing under
	 * its final name is indexed at once, and what it would index is a prefix.
	 */
	private async _stream(request: FileMoveRequest, partial: string): Promise<FileMoveResult> {
		const total = (await this._fs.stat(request.source)).size;
		const offset = await this._resumeOffset(partial, total);

		if (offset >= total && total > 0) {
			// Everything was already copied by an earlier call that was stopped between
			// its last write and its rename. Nothing left to do but commit it.
			return this._commit(request, partial, total, 0);
		}

		await this._refuseIfItCannotFit(request, total - offset);

		const started = await this._copy(request, partial, offset, total);

		if (started.aborted) {
			return this._aborted(request.signal, partial, started.bytesCopied);
		}

		return this._commit(request, partial, total, started.bytesCopied);
	}

	/**
	 * Where a second call picks the copy up.
	 *
	 * A resume that silently restarted from zero would be worse than no resume at all:
	 * it looks identical from the outside and costs the whole file again, every time,
	 * with nothing anywhere saying so. A partial longer than the source cannot be a
	 * prefix of it — it belongs to some other file that once had this name — so it is
	 * thrown away rather than appended to, which would produce a file that is the right
	 * length and wrong throughout.
	 */
	private async _resumeOffset(partial: string, total: number): Promise<number> {
		const size = await this._fs
			.stat(partial)
			.then((stats) => stats.size)
			.catch(() => 0);

		if (size > total) {
			this._logger.warn(`Discarding a partial longer than its source: ${partial}`);
			await this._fs.unlink(partial).catch(() => undefined);

			return 0;
		}

		if (size > 0) {
			this._logger.log(`Resuming a move at ${size} of ${total} bytes: ${partial}`);
		}

		return size;
	}

	/**
	 * Refuse before writing rather than at ninety per cent.
	 *
	 * The same probe placement uses, for the same reason it exists there: the numbers
	 * are all known in advance, and a move that starts anyway buys a truncated file and
	 * a disk with nothing left on it. Only what remains to be written is asked for, so
	 * a resume is not refused for room its partial is already occupying.
	 *
	 * `TIGHT` and `UNKNOWN` go ahead. The reserve is a question somebody answered
	 * before the run started, and refusing here would throw away a download that has
	 * already finished over a margin that was accepted; an unprobeable mount — `statfs`
	 * fails on plenty of them — is not evidence of anything. The full disk is still
	 * caught, mid-copy, with its own key and its partial kept.
	 */
	private async _refuseIfItCannotFit(request: FileMoveRequest, required: number): Promise<void> {
		const free = await freeBytesAt(dirname(request.destination), (path) =>
			this._fs.statfs(path),
		);
		const verdict = spaceVerdict(free, required, request.reserveBytes ?? 0);

		if (verdict === SpaceVerdict.INSUFFICIENT) {
			throw new FileMoveError(
				ErrorKey.TRANSFER_DESTINATION_FULL,
				`ENOSPC: ${free ?? 0} bytes free where ${required} are needed`,
			);
		}

		if (verdict === SpaceVerdict.TIGHT) {
			this._logger.warn(
				`Moving into ${request.destination} eats into the reserve (${free ?? 0} free)`,
			);
		}
	}

	/**
	 * The loop itself.
	 *
	 * Hand-written rather than `pipeline`, because three of the requirements live in
	 * the gap between two chunks: the progress callback, the rate window, and an abort
	 * that has to stop at a boundary with everything before it flushed. A pipeline
	 * gives none of those without wrapping it in a transform that would be longer than
	 * this.
	 */
	private async _copy(
		request: FileMoveRequest,
		partial: string,
		offset: number,
		total: number,
	): Promise<{ aborted: boolean; bytesCopied: number }> {
		const read = this._fs.createReadStream(request.source, {
			start: offset,
			highWaterMark: COPY_CHUNK_BYTES,
		});
		// Appended to, never truncated: the bytes already there are the resume, and
		// opening with `w` would be the silent restart from zero this exists to avoid.
		const write = this._fs.createWriteStream(partial, {
			flags: 'a',
			highWaterMark: COPY_CHUNK_BYTES,
		});

		let failure: unknown = null;
		let bytesCopied = 0;
		let aborted = false;
		let windowBytes = 0;
		let windowStart = Date.now();
		let rate = 0;

		// A write error arrives asynchronously and would otherwise only be noticed at
		// the very end, after the source has been read to its last byte — a full disk
		// discovered a quarter of an hour after it filled up.
		write.on('error', (error: unknown) => {
			failure = error;
			read.destroy();
		});

		try {
			for await (const chunk of read as AsyncIterable<Buffer>) {
				if (failure) {
					break;
				}

				if (this._stopped(request.signal)) {
					aborted = true;

					break;
				}

				if (!write.write(chunk)) {
					await this._drain(write);
				}

				bytesCopied += chunk.length;
				windowBytes += chunk.length;

				const elapsed = Date.now() - windowStart;

				if (elapsed >= RATE_WINDOW_MS) {
					rate = (windowBytes / elapsed) * 1000;
					windowBytes = 0;
					windowStart = Date.now();
				}

				request.onProgress?.({ bytesDone: offset + bytesCopied, bytesTotal: total, rate });
			}
		} catch (error) {
			failure = failure ?? error;
		} finally {
			// Ended and awaited even on an abort, and that is the whole of the resume
			// guarantee: what is in the stream's buffer is not on the disk, and a
			// partial that is one buffer shorter than it claims is a file with a hole
			// at the seam the next call will never look at again.
			if (!write.destroyed) {
				write.end();
			}

			await finished(write).catch((error: unknown) => {
				failure = failure ?? error;
			});
			read.destroy();
		}

		if (failure) {
			throw this._translate(failure, offset + bytesCopied, total);
		}

		return { aborted, bytesCopied };
	}

	/**
	 * Compare, then rename. Never the other way round.
	 *
	 * A truncated file renamed into a library is indexed by the media server as a real
	 * one: it appears in the interface, it plays for as long as the bytes last, and
	 * nothing ever reports that anything went wrong. The size check is cheap and it is
	 * the only thing standing between a short copy and that.
	 */
	private async _commit(
		request: FileMoveRequest,
		partial: string,
		total: number,
		bytesCopied: number,
	): Promise<FileMoveResult> {
		const written = await this._fs
			.stat(partial)
			.then((stats) => stats.size)
			.catch(() => -1);

		if (written !== total) {
			// A partial that is short is kept: it is a valid prefix and the next call
			// tops it up. A partial that is long, or missing, cannot be reasoned about.
			if (written > total) {
				await this._fs.unlink(partial).catch(() => undefined);
			}

			// The generic key, deliberately: there is no honest wording for this beyond
			// "the move failed", and borrowing the checksum key would tell somebody their
			// download is corrupt when what actually happened is that the destination
			// stopped accepting bytes. The detail in the message is for the log.
			throw new FileMoveError(
				ErrorKey.GENERAL,
				`the copy is ${written} bytes where the source is ${total}`,
			);
		}

		await this._fs.rename(partial, request.destination);
		// The source goes last and its failure is swallowed: the file is in the library
		// and the move succeeded. A working copy nobody could delete is a disk to tidy,
		// not a transfer to fail.
		await this._fs.unlink(request.source).catch((error: unknown) => {
			this._logger.warn(`Could not remove ${request.source}: ${String(error)}`);
		});

		return { outcome: FileMoveOutcome.COPIED, bytesCopied, partialPath: null };
	}

	/** Turn a filesystem failure into something the interface can offer to act on. */
	private _translate(error: unknown, bytesDone: number, total: number): unknown {
		if (errnoOf(error) !== 'ENOSPC') {
			return error;
		}

		// The partial stays exactly where it is. Somebody frees space, the move is
		// asked for again, and it carries on from here rather than from zero — which
		// is the only version of this that is worth the disk it is sitting on.
		return new FileMoveError(
			ErrorKey.TRANSFER_DESTINATION_FULL,
			`ENOSPC: the destination filled up at ${bytesDone} of ${total} bytes`,
			{ cause: error },
		);
	}

	/**
	 * Wait for the destination to catch up.
	 *
	 * `error` and `close` are waited on beside `drain`, and leaving them out is how
	 * this hangs for ever: the disk fills while a write is outstanding, the stream
	 * errors, and `drain` never comes — a transfer stuck in `placing` with no CPU, no
	 * bytes and no error, which nothing upstream can tell from a slow NAS. The
	 * listeners are removed rather than left as `once` handlers because a forty
	 * gigabyte copy goes round this loop five thousand times.
	 */
	private _drain(write: Writable): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = (): void => {
				write.removeListener('drain', done);
				write.removeListener('error', done);
				write.removeListener('close', done);
				resolve();
			};

			write.once('drain', done);
			write.once('error', done);
			write.once('close', done);
		});
	}

	private _stopped(signal: AbortSignal | undefined): boolean {
		return signal?.aborted === true;
	}

	private async _aborted(
		signal: AbortSignal | undefined,
		partial: string,
		bytesCopied: number,
	): Promise<FileMoveResult> {
		if (signal?.reason !== FILE_MOVE_CANCEL) {
			return { outcome: FileMoveOutcome.PAUSED, bytesCopied, partialPath: partial };
		}

		await this._fs.unlink(partial).catch(() => undefined);

		return { outcome: FileMoveOutcome.CANCELLED, bytesCopied, partialPath: null };
	}
}
