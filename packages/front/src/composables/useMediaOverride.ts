import type { ExternalIds, MediaItem, MediaOverride, MediaReported } from '@mcs/shared';
import { computed, reactive, type Ref, watch } from 'vue';

/** The text fields a correction can carry, in the order the dialog shows them. */
export const OVERRIDE_TEXT_FIELDS = ['title', 'seriesTitle', 'overview'] as const;

/** The numeric ones, kept apart because an empty box has to parse rather than pass. */
export const OVERRIDE_NUMBER_FIELDS = ['year', 'seasonNumber', 'episodeNumber'] as const;

/** The identifiers worth correcting by hand; the rest are the services' own. */
export const OVERRIDE_ID_FIELDS = ['tvdb', 'tmdb', 'imdb'] as const;

export type OverrideTextField = typeof OVERRIDE_TEXT_FIELDS[number];
export type OverrideNumberField = typeof OVERRIDE_NUMBER_FIELDS[number];
export type OverrideIdField = typeof OVERRIDE_ID_FIELDS[number];
export type OverrideField = OverrideTextField | OverrideNumberField;

export interface OverrideDraft {
	libraryId: string | null;
	/** Every correctable field as typed, numbers included: an input holds text. */
	values: Record<OverrideField, string>;
	/**
	 * Which fields somebody asked to empty.
	 *
	 * Separate from the value on purpose. An empty box means "I am not correcting
	 * this", and clearing means "the service's answer is wrong and there is no
	 * right one" — two instructions the API spells `absent` and `null`, and which
	 * a single empty string could not tell apart.
	 */
	cleared: Record<OverrideField, boolean>;
	externalIds: Record<OverrideIdField, string>;
}

function emptyValues (): Record<OverrideField, string> {
	return { title: '', seriesTitle: '', overview: '', year: '', seasonNumber: '', episodeNumber: '' };
}

function emptyCleared (): Record<OverrideField, boolean> {
	return {
		title: false,
		seriesTitle: false,
		overview: false,
		year: false,
		seasonNumber: false,
		episodeNumber: false,
	};
}

/**
 * What the service said, whether or not it has ever been recorded separately.
 *
 * `reported` is written the first time a correction is made, so an item nobody
 * has corrected has none — and its own fields are then the service's answer.
 */
export function reportedOf (item: MediaItem | null): MediaReported | null {
	if (!item) {
		return null;
	}
	return item.reported ?? {
		libraryId: item.libraryId,
		title: item.title,
		seriesTitle: null,
		year: item.year,
		seasonNumber: item.seasonNumber,
		episodeNumber: item.episodeNumber,
		overview: item.overview,
		externalIds: item.externalIds,
	};
}

function text (value: string | number | null | undefined): string {
	return value === null || value === undefined ? '' : String(value);
}

/**
 * One item's correction, as a form and as the body the API expects.
 *
 * The whole point of this composable is the distinction the API draws and a form
 * does not: a field left alone is absent from the body, a field emptied on
 * purpose is `null` in it. Everything below exists to keep those two apart all
 * the way from a checkbox to the request.
 */
export function useMediaOverride (item: Ref<MediaItem | null>) {
	const draft = reactive<OverrideDraft>({
		libraryId: null,
		values: emptyValues(),
		cleared: emptyCleared(),
		externalIds: { tvdb: '', tmdb: '', imdb: '' },
	});

	const reported = computed(() => reportedOf(item.value));
	const overrides = computed<MediaOverride>(() => item.value?.overrides ?? {});
	const hasOverride = computed(() => Object.keys(overrides.value).length > 0);

	function reset (): void {
		const source = item.value;
		const answer = reported.value;
		draft.values = emptyValues();
		draft.cleared = emptyCleared();
		draft.externalIds = { tvdb: '', tmdb: '', imdb: '' };
		draft.libraryId = source?.libraryId ?? null;

		if (!source || !answer) {
			return;
		}

		const correction = source.overrides ?? {};
		for (const field of [...OVERRIDE_TEXT_FIELDS, ...OVERRIDE_NUMBER_FIELDS]) {
			const corrected = correction[field];
			if (field in correction && corrected === null) {
				// Cleared by hand: the box stays empty and says why, rather than
				// showing the service's answer as though nothing had been decided.
				draft.cleared[field] = true;
				continue;
			}
			draft.values[field] = text(
				field in correction ? corrected as string | number | null : answer[field]);
		}

		for (const key of OVERRIDE_ID_FIELDS) {
			draft.externalIds[key] = text(source.externalIds[key] ?? answer.externalIds[key]);
		}
	}

	watch(item, () => reset(), { immediate: true });

	/** What the service reported for one field, for the "was X" line beside it. */
	function reportedValue (field: OverrideField): string {
		return text(reported.value?.[field] ?? null);
	}

	/** Whether this field currently carries a correction, cleared or set. */
	function isCorrected (field: OverrideField): boolean {
		if (draft.cleared[field]) {
			return true;
		}
		return draft.values[field] !== reportedValue(field);
	}

	const correctedFields = computed(
		() => [...OVERRIDE_TEXT_FIELDS, ...OVERRIDE_NUMBER_FIELDS].filter(one => isCorrected(one)));

	const libraryChanged = computed(
		() => draft.libraryId !== null && draft.libraryId !== (reported.value?.libraryId ?? null));

	/**
	 * The body of the `PUT`, built field by field.
	 *
	 * A field is in it only when it is actually a correction: cleared, or set to
	 * something the service did not say. Everything else is left out, which is how
	 * the API is told to keep using the service's answer — including the next time
	 * it changes.
	 */
	function payload (): MediaOverride {
		const body: MediaOverride = {};

		if (libraryChanged.value && draft.libraryId) {
			body.libraryId = draft.libraryId;
		}

		for (const field of OVERRIDE_TEXT_FIELDS) {
			if (draft.cleared[field]) {
				body[field] = null;
				continue;
			}
			const value = draft.values[field].trim();
			// An empty box is not a cleared field: it is a field nobody corrected,
			// and turning it into `null` here would delete a title on the way out.
			if (value.length > 0 && value !== reportedValue(field)) {
				body[field] = value;
			}
		}

		for (const field of OVERRIDE_NUMBER_FIELDS) {
			if (draft.cleared[field]) {
				body[field] = null;
				continue;
			}
			const value = draft.values[field].trim();
			if (value.length === 0 || value === reportedValue(field)) {
				continue;
			}
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				body[field] = parsed;
			}
		}

		const ids: ExternalIds = {};
		for (const key of OVERRIDE_ID_FIELDS) {
			const value = draft.externalIds[key].trim();
			if (value.length > 0 && value !== text(reported.value?.externalIds[key] ?? null)) {
				ids[key] = value;
			}
		}
		if (Object.keys(ids).length > 0) {
			body.externalIds = ids;
		}

		return body;
	}

	return {
		draft,
		reported,
		overrides,
		hasOverride,
		correctedFields,
		libraryChanged,
		reset,
		reportedValue,
		isCorrected,
		payload,
	};
}
