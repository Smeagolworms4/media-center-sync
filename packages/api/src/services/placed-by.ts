import { isAbsolute, resolve } from 'node:path';
import { PlacedBy, PlacementStrategy } from '@mcs/shared';
import { isInside } from './path-containment';
import type { PlacementRequest, PlacementTarget } from './placement.service';

/** Everything the question needs, and nothing a caller has to go and fetch. */
export type PlacedByRequest = Pick<
	PlacementRequest,
	'settings' | 'categoryKey' | 'preferredLibraryId' | 'preferredBy'
>;

export type PlacedByTarget = Pick<PlacementTarget, 'libraryId' | 'path' | 'strategy'>;

/**
 * Which step of the placement rule is answerable for a destination.
 *
 * One function, called once — from `PlacementService.resolve`, which writes the
 * answer onto the target — because every caller downstream would otherwise re-derive
 * it from `strategy` and `fallback` and every one of them would be wrong in the same
 * way. `PlacementStrategy` has no value for "the library this category names": the
 * enum names the three answers somebody picks on the settings screen and deliberately
 * stops there, so `DEFAULT_LIBRARY` comes back for the category's library, for the
 * global one and for the last-resort walk of whatever is writable alike. Three of the
 * seven steps collapse onto one value, and the three that collapse are exactly the
 * ones this whole feature has to tell apart.
 *
 * So the step is worked out from what the settings actually said, against the library
 * that answered. The order below is the rule itself, top to bottom, and it mirrors
 * `PlacementService._candidates` step for step — the two orders have to stay in step
 * or a file would be reported as placed by a rule that never ran. Reading the default
 * library before the category, for instance, would report `Animés` as unconfigured on
 * every gateway whose category happens to point at the default.
 *
 * The existing copy is read before the preference for exactly the reason placement
 * tries it first: when a plan prefers the shelf a show already lives on, both rules
 * name the same library and the honest answer is the one that would still have
 * applied with no preference set at all. Saying `PLAN_PREFERENCE` there would credit
 * the preference with a decision it did not make, and somebody clearing it would be
 * surprised to find nothing moves.
 *
 * The fallback folder is recognised by containment rather than by identity, because
 * it is a path and may well belong to no library at all — that is the case it exists
 * for.
 */
export function placedByFor(target: PlacedByTarget, request: PlacedByRequest): PlacedBy {
	const { settings } = request;

	if (target.strategy === PlacementStrategy.BESIDE_EXISTING) {
		return PlacedBy.EXISTING_COPY;
	}

	// An explicit choice outranks the settings, including a strategy that would have
	// given the same answer: somebody named it for this pull, so nothing about it is
	// unconfigured even when the library underneath is also the fallback. Which of the
	// two kinds of choice it was comes from the caller — see `PlacementRequest.
	// preferredBy` — because a plan's preference and a run's request are fixed in
	// different places and the screen has to send people to the right one.
	if (request.preferredLibraryId && request.preferredLibraryId === target.libraryId) {
		return request.preferredBy ?? PlacedBy.REQUESTED;
	}

	if (target.strategy === PlacementStrategy.FIXED_PATH) {
		return PlacedBy.FIXED_PATH;
	}

	const perCategory = request.categoryKey
		? (settings.categoryTargets[request.categoryKey] ?? null)
		: null;

	// A category with an entry is a destination somebody chose, whatever the strategy
	// says: the table is the answer for that category and the strategy is the answer
	// for everything else.
	if (perCategory !== null && perCategory === target.libraryId) {
		return PlacedBy.CATEGORY;
	}

	if (settings.defaultTargetLibraryId && settings.defaultTargetLibraryId === target.libraryId) {
		return PlacedBy.DEFAULT_LIBRARY;
	}

	const fallbackPath = settings.defaultTargetPath?.trim();

	// A relative fallback path is never used as a candidate — it would resolve against
	// the gateway's working directory, which is inside the container — so it must not
	// be allowed to claim a destination here either.
	if (fallbackPath && isAbsolute(fallbackPath) && isInside(resolve(target.path), resolve(fallbackPath))) {
		return PlacedBy.FALLBACK_PATH;
	}

	return PlacedBy.ANY_WRITABLE;
}
