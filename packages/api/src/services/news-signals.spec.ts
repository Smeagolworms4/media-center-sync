import { NewsSignal } from '@mcs/shared';
import { fetchableOf, SIGHTED_FRESH_FOR } from './news-signals';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

const row = (
	releaseSeenAt: Date | string | null = null,
	copySeenAt: Date | string | null = null,
) => ({ releaseSeenAt, copySeenAt });

describe('news signals', () => {
	it('says nothing is known when nothing has been seen', () => {
		// Which is most of the catalogue: the watch looks at a batch of followed shows
		// per pass, so an empty answer means "not looked at yet" and must never be
		// worded as "nothing exists".
		expect(fetchableOf([row()], NOW)).toEqual([]);
		expect(fetchableOf([], NOW)).toEqual([]);
	});

	it('reads a tracker sighting and a held copy apart', () => {
		expect(fetchableOf([row(new Date(NOW))], NOW)).toEqual([NewsSignal.RELEASE]);
		expect(fetchableOf([row(null, new Date(NOW))], NOW)).toEqual([NewsSignal.COPY]);
	});

	it('puts the copy first, so two readings of one world compare equal', () => {
		// A card reads this left to right and a client compares it without sorting, so
		// the order is part of the answer rather than an accident of the implementation.
		expect(fetchableOf([row(new Date(NOW), new Date(NOW))], NOW))
			.toEqual([NewsSignal.COPY, NewsSignal.RELEASE]);
	});

	it('forgets a sighting nobody has refreshed', () => {
		/*
		 * The cost of being wrong here is somebody pressing a card and finding an empty
		 * swarm. Kept for a month that would be the normal experience of the screen;
		 * expired in an hour, most of the wall would be blank because a pass takes days
		 * to come round a large watchlist.
		 */
		expect(fetchableOf([row(new Date(NOW - SIGHTED_FRESH_FOR + 1000))], NOW))
			.toEqual([NewsSignal.RELEASE]);
		expect(fetchableOf([row(new Date(NOW - SIGHTED_FRESH_FOR - 1000))], NOW)).toEqual([]);
	});

	it('reads the spelling SQLite stores as the UTC it is', () => {
		/*
		 * Both shapes come out of the same column: the grouped index reads its digests
		 * raw, where a `datetime` is whatever the driver holds — a string on SQLite — and
		 * the rows read for one page come through the entity as a `Date`. A reader that
		 * assumed either would be right half the time and silently wrong the other half,
		 * which on this comparison means a chip that shows on the page and never in the
		 * filter.
		 *
		 * And read as UTC, which is how it is written. Read as local time a gateway in
		 * Paris dates every sighting two hours out — harmless against a seven-day window,
		 * and the next person to reuse this will not be measuring days.
		 */
		expect(fetchableOf([row('2026-10-08 12:00:00.000')], NOW)).toEqual([NewsSignal.RELEASE]);
		expect(fetchableOf([row('2026-10-08 12:00:00.000')], NOW))
			.toEqual(fetchableOf([row(new Date(NOW))], NOW));
	});

	it('ignores a date nothing can read rather than treating it as now', () => {
		// A column edited by hand, or written by a driver nobody here has tried. The
		// honest answer is the one an empty column gives.
		expect(fetchableOf([row('not a date')], NOW)).toEqual([]);
	});

	it('takes the sighting off whichever copy carries it', () => {
		/*
		 * The rows are the copies of one media on several services, and the watch wrote
		 * its answer on whichever one represented the group that day. Asking only the
		 * first would lose the sighting every time the ranking changed — a friend's
		 * server coming back online is enough.
		 */
		expect(fetchableOf([row(), row(null, new Date(NOW))], NOW)).toEqual([NewsSignal.COPY]);
	});
});
