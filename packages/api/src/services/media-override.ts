import type { ExternalIds, MediaOverride, MediaReported } from '@mcs/shared';

/** The parts of an item an override can touch, as either half of it sees them. */
export interface OverridableItem {
	libraryId: string;
	title: string;
	normalizedTitle: string;
	seriesTitle?: string | null;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	overview: string | null;
	externalIds: ExternalIds;
	overrides: MediaOverride | null;
	reported: MediaReported | null;
	/**
	 * Resolved here rather than read from the blob downstream.
	 *
	 * It has no `reported` counterpart on purpose: no media server has an opinion
	 * about whether an episode counts, so there is nothing of the service's to
	 * restore. Its baseline is simply false.
	 */
	ignored: boolean;
}

/**
 * The correctable fields whose value can simply be compared with the service's.
 *
 * `externalIds` is an object and `ignored` has nothing on the other side to compare
 * with, so both are handled on their own below.
 */
const COMPARABLE = [
	'libraryId',
	'title',
	'seriesTitle',
	'year',
	'seasonNumber',
	'episodeNumber',
	'overview',
] as const;

/**
 * Drop from a correction every field that says exactly what the service already says.
 *
 * This is the difference between "I am not correcting this any more" and "I am
 * correcting this to the value it already had", and it decides everything that happens
 * afterwards. An item with no correction keeps following its server: when Jellyfin
 * finally fixes a title or a year, the next scan picks it up. An item whose correction
 * happens to equal today's reported values is frozen on them for ever, and no scan will
 * ever change it again — invisible the day it is made, and impossible to explain six
 * months later.
 *
 * Pruned per field rather than only when the whole correction matches, because they are
 * the same rule at two scales and the per-field one is the one that stays honest: a
 * form sends every box it renders, so an item corrected only on its year would
 * otherwise be frozen on the title, the overview and the identifiers the person never
 * touched. The whole-correction case then falls out on its own — every field dropped
 * leaves nothing, and nothing is already spelled "no correction" here.
 *
 * `ignored` has no reported counterpart: no media server has an opinion about whether
 * an episode counts, so its baseline is false and only an explicit `true` is an
 * instruction at all.
 */
const withoutUnchanged = (
	override: MediaOverride | null | undefined,
	reported: MediaReported,
): MediaOverride => {
	if (override === null || override === undefined) {
		return {};
	}

	const kept: MediaOverride = { ...override };

	for (const field of COMPARABLE) {
		if (field in kept && kept[field] === reported[field]) {
			delete kept[field];
		}
	}

	if (kept.externalIds !== undefined) {
		const identifiers = Object.entries(kept.externalIds).filter(
			([key, value]) => value !== reported.externalIds[key as keyof ExternalIds],
		);

		if (identifiers.length === 0) {
			delete kept.externalIds;
		} else {
			kept.externalIds = Object.fromEntries(identifiers);
		}
	}

	if (kept.ignored !== true) {
		delete kept.ignored;
	}

	return kept;
};

/** What the service said, as it stands right now. */
export const snapshotReported = (item: OverridableItem): MediaReported => ({
	libraryId: item.libraryId,
	title: item.title,
	seriesTitle: item.seriesTitle ?? null,
	year: item.year,
	seasonNumber: item.seasonNumber,
	episodeNumber: item.episodeNumber,
	overview: item.overview,
	externalIds: { ...item.externalIds },
});

/**
 * Write a correction into the fields everything else reads.
 *
 * Resolved on write rather than on read, and that is the whole design. A season
 * reassigned by hand has to change what correlates with what, which folder a pull
 * lands in and which category the item appears under — so the effective value belongs
 * in the column, not in a layer every query would have to remember to apply. Forgetting
 * it in one place is how a correction works on the screen that made it and nowhere
 * else.
 *
 * An absent field means "not corrected" and leaves the reported value alone. An
 * explicit `null` means "cleared", which is a different instruction: it is how somebody
 * removes a year a scraper invented. `undefined` and `null` therefore cannot be
 * collapsed here, however tempting.
 */
export const applyOverride = (
	item: OverridableItem,
	instruction: MediaOverride | null | undefined,
	normalize: (title: string) => string,
): void => {
	const reported = item.reported ?? snapshotReported(item);
	/*
	 * What is left once every field that agrees with the service is dropped.
	 *
	 * A correction that reproduces the service's own answer is not a correction, and
	 * storing it would freeze the item on today's values for ever. `withoutUnchanged`
	 * says why at length; the consequence here is that pressing "reset" in the dialog
	 * and saving removes the correction rather than rewriting it with identical
	 * content.
	 */
	const override = withoutUnchanged(instruction, reported);

	// Always start from what the service said, so clearing one field does not leave the
	// previous correction behind and so two edits in a row do not compound. `ignored`
	// has no reported counterpart — no media server has an opinion about whether an
	// episode counts — so its baseline is simply false.
	item.ignored = false;
	item.libraryId = reported.libraryId;
	item.title = reported.title;
	item.year = reported.year;
	item.seasonNumber = reported.seasonNumber;
	item.episodeNumber = reported.episodeNumber;
	item.overview = reported.overview;
	item.externalIds = { ...reported.externalIds };

	if ('seriesTitle' in item) {
		item.seriesTitle = reported.seriesTitle;
	}

	/*
	 * Nothing left to apply, which absent, cleared and "identical to the service's
	 * answer" all reduce to.
	 *
	 * `withoutUnchanged` has already turned `null` and `undefined` into an empty
	 * object, which is why the nullish check that used to be here is gone from this
	 * line — it is the first thing that function does, and for the reason that cost an
	 * afternoon: a row freshly built from what a service reported has no `overrides`
	 * property at all, and `Object.keys(undefined)` throws `Cannot convert undefined or
	 * null to object`. That threw inside the indexing loop, so every service reported
	 * `Indexing <id> failed` with nothing indexed and an error naming neither overrides
	 * nor the scan.
	 */
	if (Object.keys(override).length === 0) {
		item.overrides = null;
		item.reported = null;
		item.ignored = false;
		item.normalizedTitle = normalize(seriesOrOwn(item));

		return;
	}

	if (override.libraryId !== undefined && override.libraryId !== null) {
		item.libraryId = override.libraryId;
	}

	if (override.title !== undefined && override.title !== null) {
		item.title = override.title;
	}

	if (override.seriesTitle !== undefined && 'seriesTitle' in item) {
		item.seriesTitle = override.seriesTitle;
	}

	if (override.year !== undefined) {
		item.year = override.year;
	}

	if (override.seasonNumber !== undefined) {
		item.seasonNumber = override.seasonNumber;
	}

	if (override.episodeNumber !== undefined) {
		item.episodeNumber = override.episodeNumber;
	}

	if (override.overview !== undefined) {
		item.overview = override.overview;
	}

	if (override.externalIds !== undefined) {
		// Merged rather than replaced: correcting a TVDB number should not throw away
		// the IMDb one the service got right.
		item.externalIds = { ...reported.externalIds, ...override.externalIds };
	}

	/*
	 * Only an explicit `true` ignores. `undefined` leaves the baseline above, which is
	 * what "I did not mention this field" has to mean for every field here.
	 */
	if (override.ignored !== undefined) {
		item.ignored = override.ignored === true;
	}

	item.overrides = override;
	item.reported = reported;

	// The comparison form follows the correction, or renaming a show would leave it
	// correlating under the name nobody uses any more.
	item.normalizedTitle = normalize(seriesOrOwn(item));
};

/**
 * What the normalised form is built from.
 *
 * An episode compares under its show's name, not its own — two libraries agree about
 * the name of a series far more often than about the name of an episode.
 */
const seriesOrOwn = (item: OverridableItem): string => {
	const series = item.seriesTitle?.trim();

	return series ? series : item.title;
};
