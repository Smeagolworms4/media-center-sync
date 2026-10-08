import { NewsSignal } from '@mcs/shared';

/**
 * Which of the two things that can fill a gap were last seen, and recently enough.
 *
 * A free function rather than a method, for the same reason `episodeCoverage` is one:
 * the rule is read twice per request — once over the digests, to decide which groups the
 * filter keeps, and once over the full rows of the page, to say what each card shows —
 * and the one thing that must not happen is the two disagreeing. A screen that filtered
 * on "a torrent was found" and then drew no chip on half the cards it kept would read
 * as a broken filter, and the bug would be two readings of one rule rather than either
 * of them.
 */

/**
 * How long a sighting is believed.
 *
 * Seven days, which is a bound on the wrong answer rather than a guess at the right
 * one. The watch looks at a batch of followed shows per pass — forty, every six hours
 * by default — so a household following three hundred actionable shows takes some two
 * days to come round, and anything shorter than that would expire a sighting before it
 * could be refreshed and leave most of the wall permanently blank.
 *
 * The other end is what it costs to be wrong: a swarm that has emptied since the search
 * means somebody presses a card and finds nothing, which is a wasted click. A sighting
 * kept for a month would make that the normal experience of the screen.
 */
export const SIGHTED_FRESH_FOR = 7 * 24 * 60 * 60 * 1000;

/** The least a row has to say for its signals to be readable. */
export interface Sighted {
	releaseSeenAt: Date | string | null;
	copySeenAt: Date | string | null;
}

/**
 * When a stored sighting happened, in milliseconds, or null when it never did.
 *
 * Both shapes have to be read because both are stored by the same column: the grouped
 * index reads its digests with `getRawMany`, which hands back whatever the driver holds
 * — a `datetime` string on SQLite — while the rows read for the page come through the
 * entity and arrive as a `Date`. A reader that assumed either one would be right half
 * the time and silently wrong the other half, which on a date comparison means a chip
 * that appears on the page and never in the filter.
 *
 * SQLite's own spelling carries no zone and is written in UTC, so it is read as UTC
 * rather than as the machine's local time — a gateway in Paris would otherwise date
 * every sighting an hour or two out, which matters not at all against a seven-day
 * window and would matter very much to the next person who reused this.
 */
function at(value: Date | string | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (value instanceof Date) {
		return value.getTime();
	}

	const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
		? `${value.replace(' ', 'T')}Z`
		: value;
	const parsed = new Date(utc).getTime();

	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The signals a set of rows carries between them, freshest reading wins.
 *
 * A set over the rows rather than per row, because the rows are the copies of one media
 * on several services and the question is about the media: the watch searched the group
 * and wrote its answer on the row it was handed, which is whichever copy represented the
 * group that day.
 *
 * Ordered, so two readings of the same world produce the same array and a client can
 * compare them without sorting. Empty means nothing is known — never "nothing exists".
 */
export function fetchableOf(rows: readonly Sighted[], now: number = Date.now()): NewsSignal[] {
	const fresh = (pick: (row: Sighted) => Date | string | null): boolean =>
		rows.some((row) => {
			const seen = at(pick(row));

			return seen !== null && now - seen <= SIGHTED_FRESH_FOR;
		});

	const signals: NewsSignal[] = [];

	// A copy first: it is the better of the two wherever both exist, and the order is
	// what a card reads from left to right.
	if (fresh((row) => row.copySeenAt)) {
		signals.push(NewsSignal.COPY);
	}

	if (fresh((row) => row.releaseSeenAt)) {
		signals.push(NewsSignal.RELEASE);
	}

	return signals;
}
