/**
 * Which episode numbers a set of rows actually covers.
 *
 * One file is usually one episode, and then this is a set of the numbers on the
 * rows. It exists for the case where it is not: a file named `S01E01-E02` is one
 * row carrying two episodes, and every question of the form "do we have episode
 * four" has to expand it or be wrong.
 *
 * It is a free function rather than a method on anything because the two callers
 * live in different layers and ask for different reasons — the gap detection, to
 * avoid minting a row for an episode already on the disk, and the group view, to
 * avoid drawing it as absent — and the one thing that must not happen is the two of
 * them disagreeing about what is held.
 */

/** The least a row has to say for its coverage to be readable. */
export interface EpisodeSpan {
	episodeNumber: number | null;
	episodeNumberEnd: number | null;
}

/**
 * The numbers a single row covers, in order.
 *
 * A row with no number covers nothing: it is a season, a series, or an episode
 * whose number nobody could work out, and guessing one would be worse than the gap.
 * An end below the start is ignored rather than reversed — `E05-E02` is a parse that
 * went wrong or a typo in somebody's file name, and running it backwards would claim
 * four episodes are held on the strength of a mistake.
 */
export function spanOf(row: EpisodeSpan): number[] {
	/*
	 * Absent is normalised to null before anything is compared, and that is not
	 * defensive noise. A row read with a partial `select`, or built by a test
	 * fixture written before this column existed, carries `undefined` here — and
	 * `undefined <= 1` is false rather than an error, so the guard below fell
	 * through to `Array.from({ length: NaN })` and quietly answered that the row
	 * covers nothing at all. An episode on the disk then read as a hole, which is
	 * exactly the bug this file exists to prevent, arrived at from the other side.
	 */
	const first = row.episodeNumber ?? null;

	if (first === null) {
		return [];
	}

	const last = row.episodeNumberEnd ?? null;

	if (last === null || last <= first) {
		return [first];
	}

	return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/** Every episode number covered by any of these rows. */
export function episodesCovered(rows: readonly EpisodeSpan[]): Set<number> {
	const covered = new Set<number>();

	for (const row of rows) {
		for (const number of spanOf(row)) {
			covered.add(number);
		}
	}

	return covered;
}
