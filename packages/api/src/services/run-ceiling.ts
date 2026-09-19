import { SyncStopReason } from '@mcs/shared';

/** A ceiling on one run. Null means no ceiling, which is a choice, not the default. */
export interface RunCeilings {
	maxItems: number | null;
	maxBytes: number | null;
}

export interface CeilingResult<T> {
	kept: T[];
	/** Planned, then dropped by a ceiling. Kept so the run can say what it left out. */
	dropped: T[];
	stoppedBy: SyncStopReason | null;
}

/**
 * Cut a planned run down to what its ceilings allow.
 *
 * The ceiling is not the same thing as the scope being small, and that is why this
 * exists at all: a scope that was three episodes in January is a season by June, and
 * a schedule nobody is watching will happily start it at four in the morning.
 *
 * It stops at the first item that does not fit rather than skipping it and carrying
 * on with smaller ones. Packing the remaining room would make the contents of a run
 * depend on the sizes of the files in it — two runs of the same plan on the same day
 * would pull different episodes — and `stoppedBy` would then be a half-truth. Stopping
 * keeps the order the plan chose, so tomorrow's run continues where this one ended.
 *
 * `maxItems` is tested before `maxBytes`, so an item that breaks both is reported as
 * the count. Either answer is defensible; one of them had to be written down.
 */
export const applyCeilings = <T extends { bytes: number }>(
	items: T[],
	ceilings: RunCeilings,
): CeilingResult<T> => {
	const kept: T[] = [];
	let bytes = 0;
	let stoppedBy: SyncStopReason | null = null;

	for (const item of items) {
		if (ceilings.maxItems !== null && kept.length >= ceilings.maxItems) {
			stoppedBy = SyncStopReason.MAX_ITEMS;

			break;
		}

		if (ceilings.maxBytes !== null && bytes + item.bytes > ceilings.maxBytes) {
			stoppedBy = SyncStopReason.MAX_BYTES;

			break;
		}

		kept.push(item);
		bytes += item.bytes;
	}

	return { kept, dropped: items.slice(kept.length), stoppedBy };
};
