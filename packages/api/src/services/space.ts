import { statfs } from 'node:fs/promises';
import { SpaceVerdict, type TargetSpace } from '@mcs/shared';

/** What a free-space probe has to be able to answer. `statfs` is the one that does. */
export type StatfsLike = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/**
 * Free bytes on the filesystem holding a path, or null when it cannot be measured.
 *
 * One probe for the whole application, because there are now three callers — placement
 * choosing a library, the move service refusing before it writes, and the library
 * check — and three copies of `Number(bavail) * Number(bsize)` would disagree the day
 * somebody noticed that `statfs` returns bigints on some platforms and not others.
 *
 * Null rather than zero when the call fails: `statfs` is not implemented on some
 * network mounts, and a zero would read as "full" and refuse a destination that is
 * perfectly writable. What to do about not knowing is `spaceVerdict`'s business.
 *
 * The probe is a parameter so a test can answer with a full disk without needing one.
 * It is a seam, not an extension point: there is exactly one way to ask a filesystem
 * how much room it has left.
 */
export const freeBytesAt = async (path: string, probe: StatfsLike = statfs): Promise<number | null> => {
	try {
		const stats = await probe(path);
		const free = Number(stats.bavail) * Number(stats.bsize);

		return Number.isFinite(free) ? free : null;
	} catch {
		return null;
	}
};

/** One destination, what it has, and what a run would put in it. */
export interface SpaceQuestion {
	libraryId: string;
	libraryName: string;
	localPath: string | null;
	/** What the filesystem reported, or null when there was nothing to probe. */
	freeBytes: number | null;
	requiredBytes: number;
	reserveBytes: number;
}

/**
 * Does it fit, and at what cost?
 *
 * Deliberately a pure function of four numbers, because this is the comparison the
 * whole feature exists to make and it is the one place an off-by-one is expensive: a
 * disk filled to the last byte does not fail politely, it fails at ninety per cent of
 * a forty-gigabyte file and leaves a truncated video the media server indexes as real.
 *
 * Unknown free space is its own answer rather than an optimistic one. `statfs` fails
 * on some network mounts, and "we could not measure it" read as "it fits" is the same
 * full disk with an alibi — so it is asked about instead of assumed.
 */
export const spaceVerdict = (
	freeBytes: number | null,
	requiredBytes: number,
	reserveBytes: number,
): SpaceVerdict => {
	// Nothing to write is not a question about the disk. Without this, a run that
	// plans no bytes against an unprobeable path would demand an acknowledgement for
	// room it is never going to use.
	if (requiredBytes <= 0) {
		return SpaceVerdict.FITS;
	}

	if (freeBytes === null || !Number.isFinite(freeBytes)) {
		return SpaceVerdict.UNKNOWN;
	}

	const remaining = freeBytes - requiredBytes;

	if (remaining < 0) {
		return SpaceVerdict.INSUFFICIENT;
	}

	// Crossing the reserve is allowed and said out loud, because the alternative — a
	// hard refusal — makes the reserve a limit somebody has to go and lower in the
	// settings before every large pull, which is how reserves end up set to zero.
	return remaining < reserveBytes ? SpaceVerdict.TIGHT : SpaceVerdict.FITS;
};

/** The question and its answer, in the shape the interface reads. */
export const targetSpace = (question: SpaceQuestion): TargetSpace => ({
	libraryId: question.libraryId,
	libraryName: question.libraryName,
	localPath: question.localPath,
	freeBytes: question.freeBytes,
	requiredBytes: question.requiredBytes,
	remainingBytes:
		question.freeBytes === null ? null : question.freeBytes - question.requiredBytes,
	reserveBytes: question.reserveBytes,
	verdict: spaceVerdict(question.freeBytes, question.requiredBytes, question.reserveBytes),
});

/** A destination that cannot take it. The run is refused, whatever anybody accepted. */
export const refusesRun = (targets: TargetSpace[]): boolean =>
	targets.some((target) => target.verdict === SpaceVerdict.INSUFFICIENT);

/**
 * A destination somebody has to answer for before the run starts.
 *
 * `TIGHT` and `UNKNOWN` sit together on purpose: both mean the gateway is about to
 * write without being able to promise the room, and the difference between them is
 * what the interface says, not whether it asks.
 */
export const needsAcknowledgement = (targets: TargetSpace[]): boolean =>
	targets.some(
		(target) =>
			target.verdict === SpaceVerdict.TIGHT || target.verdict === SpaceVerdict.UNKNOWN,
	);
