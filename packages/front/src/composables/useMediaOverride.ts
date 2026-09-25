import type { ExternalIds, MediaItem, MediaOverride, MediaReported, ReleasePreference } from '@mcs/shared';
import { computed, type InjectionKey, reactive, ref, type Ref, watch } from 'vue';

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

/**
 * How a list row asks the page around it to correct one media.
 *
 * Provided by the page that owns the dialog and injected by the rows, rather than
 * emitted up through them. A card is drawn by `LibrarySection` on the wall and straight
 * by the media page for its children, so an event would have to be declared and
 * forwarded by every component in between — one of which is not the dialog's owner and
 * has no reason to know the feature exists. Injection also keeps there being exactly one
 * dialog per screen: two hundred posters each carrying their own would be two hundred
 * forms mounted to open one.
 *
 * A row where nothing provides it simply offers no action, which is what the children of
 * a page that does not own a dialog must do.
 */
export const OPEN_OVERRIDE: InjectionKey<(itemId: string) => void> = Symbol('openOverride');

/**
 * Cancel one media's own search order, leaving the rest of its correction alone.
 *
 * The whole instruction is replaced by a `PUT`, so cancelling means sending everything
 * that is still corrected plus an explicit `null` here. Sending only the null would
 * withdraw the title, the year and the reclassification along with it — the one press
 * the owner asked for would quietly undo every other correction on the media.
 */
export function withoutReleasePreference (
	overrides: MediaOverride | null | undefined,
): MediaOverride {
	return { ...overrides, releasePreference: null };
}

export interface OverrideDraft {
	libraryId: string | null;
	/**
	 * The folder inside that library this media's files go in, and null lets the rule
	 * decide.
	 *
	 * The second half of choosing a shelf: a library is commonly several directories on
	 * several disks, so naming one answered only half the question. It is a pin — every
	 * file of this media lands there — because the placement rule never splits a show, and
	 * a season in one folder with the next in another is not shown as one series by any
	 * media server.
	 */
	targetFolder: string | null;
	/**
	 * This media's own search order, or null when it follows its category's.
	 *
	 * Null and an order with no values are two different sentences — see
	 * `isEmptyReleasePreference` — so the draft holds the difference rather than
	 * flattening an empty order into "no order".
	 */
	releasePreference: ReleasePreference | null;
	/**
	 * Carried rather than edited: nothing in the dialog sets this one.
	 *
	 * The dialog still has to send it back, because the `PUT` replaces the whole
	 * instruction — a form that left it out would un-ignore a special every time
	 * somebody corrected a title on it, which nothing on the screen would explain.
	 */
	ignored: boolean;
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
		// `?? {}` because a row can legitimately arrive without any identifiers at all —
		// a media nothing ever matched, a peer's row read from a listing that omits them —
		// and every reader below indexes this by key. Left undefined it is not an empty
		// form, it is a page that throws while drawing.
		externalIds: item.externalIds ?? {},
	};
}

function text (value: string | number | null | undefined): string {
	return value === null || value === undefined ? '' : String(value);
}

/** A preference the editor can rewrite without touching the item it came from. */
function clonePreference (preference: ReleasePreference | null): ReleasePreference | null {
	return preference === null
		? null
		: { ranks: preference.ranks.map(rank => ({ dimension: rank.dimension, values: [...rank.values] })) };
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
		targetFolder: null,
		releasePreference: null,
		ignored: false,
		values: emptyValues(),
		cleared: emptyCleared(),
		externalIds: { tvdb: '', tmdb: '', imdb: '' },
	});

	/**
	 * What the gateway said it would choose, which is not what somebody chose.
	 *
	 * The folder field opens on the gateway's own answer so nobody has to type a path it
	 * already knows — and a prefilled value is a display of a default, not a decision. Sent
	 * back it would become one: opening the dialog and pressing save would pin the folder
	 * the rule would have picked anyway, and that pin then outranks the rule for ever,
	 * including the part of it that follows a series when it moves. The redirect dialog
	 * draws the same line, in the same words.
	 *
	 * Worse, it would break the undo: after a reset the body must be empty, and a body
	 * carrying a folder nobody asked for stores a correction instead of removing one.
	 */
	const suggestedFolder = ref<string | null>(null);

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
		// What is pinned today, not what the rule would answer: the field shows the
		// standing decision, and the gateway's own answer is only offered as a prefill
		// when there is no decision to show.
		draft.targetFolder = source?.overrides?.targetFolder ?? null;
		// Copied rather than referenced: the editor rewrites the ranks in place as
		// somebody reorders them, and a draft sharing the item's object would change
		// what the page shows before anything was saved — including the note that says
		// what the order currently is.
		draft.releasePreference = clonePreference(source?.overrides?.releasePreference ?? null);
		draft.ignored = source?.overrides?.ignored === true;

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
			draft.externalIds[key] = text(source.externalIds?.[key] ?? answer.externalIds[key]);
		}
	}

	/**
	 * Fill the form with what the service reports, and leave it there.
	 *
	 * Deliberately not a write. Somebody undoing a correction has to see the values
	 * they are about to go back to before agreeing to them — a button that silently
	 * saved would be indistinguishable from the "put it all back" one next to it, and
	 * there would be no way to look at the service's answer and change your mind.
	 *
	 * Saving afterwards removes the correction rather than storing one that repeats the
	 * service's answer, and the difference is the whole point: `payload()` leaves out
	 * every field equal to what was reported, so the body is empty and the API reads an
	 * empty correction as none at all. An item with no correction keeps following its
	 * server — the day Jellyfin fixes that title, the next scan picks it up — while an
	 * item frozen on today's values would never change again.
	 */
	function fillFromReported (): void {
		const answer = reported.value;
		draft.values = emptyValues();
		draft.cleared = emptyCleared();
		draft.externalIds = { tvdb: '', tmdb: '', imdb: '' };
		draft.libraryId = answer?.libraryId ?? item.value?.libraryId ?? null;
		/*
		 * The search order goes too, and no media server has an opinion to put back.
		 *
		 * "Put back what the service reported" is a statement about the fields a service
		 * reports, and this is not one of them — its baseline is simply "no order of its
		 * own", exactly as `ignored`'s is false. Leaving it in force here would make the
		 * one button that is supposed to undo everything the one that quietly kept a
		 * setting nobody could then see in the boxes.
		 */
		draft.releasePreference = null;
		draft.ignored = false;
		// The pin goes too, and no media server has one to put back: "put back what the
		// service reported" is a statement about the fields a service reports, and which
		// of our folders a file of ours belongs in is not one of them.
		draft.targetFolder = null;

		if (!answer) {
			return;
		}

		for (const field of [...OVERRIDE_TEXT_FIELDS, ...OVERRIDE_NUMBER_FIELDS]) {
			draft.values[field] = text(answer[field]);
		}

		for (const key of OVERRIDE_ID_FIELDS) {
			draft.externalIds[key] = text(answer.externalIds[key]);
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

	/** The order in force on the media right now, which is what the note reads. */
	const releasePreference = computed(() => item.value?.overrides?.releasePreference ?? null);

	/**
	 * Whether the search order is part of this correction, either way round.
	 *
	 * Presence and never emptiness: an order with no values is a decision — "order by
	 * nothing, on purpose" — and comparing on emptiness would make it indistinguishable
	 * from cancelling.
	 */
	const preferenceChanged = computed(
		() => JSON.stringify(draft.releasePreference) !== JSON.stringify(releasePreference.value));

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

		/*
		 * Sent whenever it is set, like `ignored` beside it and for the same reason: no
		 * media server reports which of our folders a file of ours belongs in, so there is
		 * nothing to compare it against and "unchanged" means "still in force". An emptied
		 * field is a pin somebody removed, which the API reads as no pin at all.
		 */
		const folder = draft.targetFolder?.trim() ?? '';

		if (folder !== '' && folder !== suggestedFolder.value) {
			body.targetFolder = folder;
		}

		/*
		 * Sent back whether or not this form touched it, because the `PUT` replaces the
		 * whole instruction rather than patching it.
		 *
		 * Neither of these has a reported counterpart to compare with — no media server
		 * has an opinion about whether an episode counts or about which copy the house
		 * prefers — so "unchanged" here means "still in force", and leaving it out is how
		 * correcting a title would silently un-ignore a special or cancel a search order
		 * set on another screen.
		 */
		if (draft.ignored) {
			body.ignored = true;
		}

		if (draft.releasePreference !== null) {
			body.releasePreference = draft.releasePreference;
		} else if (releasePreference.value !== null) {
			// Explicitly cancelled rather than merely absent, which is the same
			// distinction every other field here draws between `null` and missing.
			body.releasePreference = null;
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
		releasePreference,
		preferenceChanged,
		reset,
		fillFromReported,
		reportedValue,
		isCorrected,
		payload,
		suggestedFolder,
	};
}
