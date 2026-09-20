import { MediaLandingState, SyncState } from '@mcs/shared';

/**
 * How long a media server is given to notice a file we put in its folder.
 *
 * Twelve hours, and the number is chosen against the slowest honest case rather than
 * the common one. A server that watches its folders indexes within seconds; one that
 * only scans on a schedule is normally set to do so overnight, and a gateway that
 * declared the file lost at two in the morning would be wrong every single night on a
 * perfectly healthy installation. Past twelve hours no ordinary schedule explains it
 * any more, and the honest reading changes from "not yet" to "something is wrong".
 *
 * A constant rather than a setting on purpose. It describes how long media servers
 * plausibly take, which is not a property of this household and not a number anybody
 * could reason about from a settings screen — and the right fix for a server that
 * never indexes is never to lengthen the wait, it is the state at the end of it.
 */
export const LANDING_GRACE_MS = 12 * 60 * 60 * 1000;

/**
 * How long after asking a media server to rescan we go and look ourselves.
 *
 * Long enough that a server handed a refresh has had time to walk the folder, short
 * enough that somebody who has just watched a download finish and switched to the
 * library screen sees it resolve while they are still there. Nothing depends on it
 * being right: missing the window only means the media stays `awaiting_index` until
 * the periodic refresh comes round, which is the behaviour without this at all.
 */
export const LANDING_SETTLE_MS = 60_000;

/**
 * What a landing makes of the media it belongs to.
 *
 * One function, because this mapping is read in two places that must never disagree —
 * the moment a file lands, and every correlation pass afterwards that recomputes the
 * item's state from scratch. Two copies of it would drift the day a third state is
 * added, and the symptom would be a media reading one thing on the wall and another on
 * its own page.
 */
export const landingSyncState = (state: MediaLandingState): SyncState =>
	state === MediaLandingState.STALE ? SyncState.NOT_INDEXED : SyncState.AWAITING_INDEX;
