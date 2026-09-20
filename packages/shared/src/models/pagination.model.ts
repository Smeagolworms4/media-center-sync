export interface Pagination {
	page: number;
	limit: number;
	total: number;
	pages: number;
}

export interface ResultList<T> {
	items: T[];
	pagination: Pagination;
}

/**
 * Which half of a list a screen is asking for.
 *
 * Sync runs and transfers are both lists where the interesting rows are the few that
 * are still moving, and the rest is history that grows without bound. Splitting them
 * on the server rather than in the page is what lets a screen show the live work
 * without pulling a page of finished rows first and discarding them — and what makes
 * "the finished ones are still there" a query away rather than a claim.
 *
 * `ALL` stays the default of every route on purpose. A listing that silently dropped
 * rows would have taken the dashboard's failed-transfer panel down with it, and that
 * panel is the only thing on the home screen that reports a transfer that went wrong.
 * Screens that want the live half ask for it.
 */
export enum HistoryView {
	/** Still pending, running or paused — anything that will move again on its own. */
	LIVE = 'live',
	/** Done, failed or cancelled. What retention eventually removes. */
	FINISHED = 'finished',
	ALL = 'all',
}
