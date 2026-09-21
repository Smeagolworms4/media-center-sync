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
export const DEFAULT_LANDING_GRACE_MS = 12 * 60 * 60 * 1000;

/**
 * The grace actually in force: the constant above, unless a test says otherwise.
 *
 * `MCS_LANDING_GRACE_MS` is a **test hook, not a user setting**, and it is kept out of
 * `Settings` for the reason the constant exists: the wait describes media servers, not
 * the household. It exists because the terminal state of a landing, `not_indexed`, is
 * otherwise reachable only by waiting twelve hours — so no journey could ever check
 * the badge, the wording or the dashboard row that are the only places anybody learns
 * a file was never indexed. A gateway started with a few seconds here lets one.
 *
 * Read once, at start-up: a wait that changed under landings already recorded would
 * give two rows written a minute apart two different deadlines. Anything that is not a
 * positive integer is ignored rather than refused, so a typo leaves production on the
 * twelve hours instead of stopping it from starting.
 */
export function landingGraceMs(raw: string | undefined = process.env.MCS_LANDING_GRACE_MS): number {
	const parsed = Number(raw);

	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LANDING_GRACE_MS;
}

export const LANDING_GRACE_MS = landingGraceMs();

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
