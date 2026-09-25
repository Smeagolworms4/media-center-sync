<script lang="ts" setup>
	import {
		type CategoryProposal as Candidate,
		type ClassificationProposal,
		isEmptyReleasePreference,
		type MediaItem,
		RELEASE_PREFERENCE_DIMENSIONS,
		RELEASE_PREFERENCE_SUGGESTIONS,
		type ReleasePreferenceDimension,
		type ReleasePreferenceRank,
	} from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import CategoryProposalBlock from '@/components/media/CategoryProposal.vue';
	import OverrideField from '@/components/media/OverrideField.vue';
	import Window from '@/components/Window.vue';
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
	import { useForm } from '@/composables/useForm';
	import { OVERRIDE_ID_FIELDS, useMediaOverride } from '@/composables/useMediaOverride';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { useReleasesStore } from '@/stores/releases';
	import { useServicesStore } from '@/stores/services';

	/**
	 * Correcting what a media server got wrong, here and only here.
	 *
	 * A server files by the folder it found something in, and is sometimes wrong: a
	 * documentary under Films, an anime numbered by absolute order, a show under a
	 * name nobody in the house uses. Correcting it on the server means moving files
	 * and fighting the next scrape; correcting it here is one row, and a rescan
	 * re-applies it rather than undoing it.
	 *
	 * Two things this dialog exists to get right. An absent field is not a cleared
	 * one — leaving a box alone keeps the service's answer, emptying it on purpose
	 * removes the value — and every corrected field says what the service had said,
	 * with one button to put all of it back.
	 */
	const props = withDefaults(defineProps<{
		/** The index row being corrected: one service's record, not the group. */
		itemId: string;
		/** Given when the caller already holds the row, fetched here otherwise. */
		item?: MediaItem | null;
	}>(), {
		item: null,
	});

	const emit = defineEmits<{ saved: [item: MediaItem] }>();

	const open = defineModel<boolean>({ default: false });

	const mediaStore = useMediaStore();
	const librariesStore = useLibrariesStore();
	const releasesStore = useReleasesStore();
	const servicesStore = useServicesStore();
	const validators = useValidators();
	const { notify, tryCallback } = useNotifier();
	const { t } = useI18n();

	const item = ref<MediaItem | null>(props.item);
	const loading = ref(false);
	const failed = ref(false);
	const restoring = ref(false);

	const {
		draft,
		reported,
		hasOverride,
		correctedFields,
		libraryChanged,
		preferenceChanged,
		reportedValue,
		fillFromReported,
		payload,
		suggestedFolder,
	} = useMediaOverride(item);

	const { destinations } = useDestinationLibraries();

	/**
	 * Put the service's answer back into the boxes, without saving it.
	 *
	 * The two ways out of a correction are deliberately not the same thing, and they
	 * deliberately do not sit together. "Put it all back" writes at once and closes, and
	 * lives with the actions because it acts on the record. This one only fills the
	 * form, so it lives with the form — the values can be read before anybody agrees to
	 * them, and somebody who looks at them and changes their mind can simply cancel.
	 *
	 * Saving after it removes the correction rather than recording one identical to what
	 * the service says. That distinction decides everything afterwards: an item with no
	 * correction goes on following its server and picks up the day it fixes a title,
	 * while an item corrected to today's values is frozen on them for ever.
	 */
	function resetToReported (): void {
		fillFromReported();
		void notify('override.reset_done');
	}

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const [node] = await Promise.all([
				mediaStore.node(props.itemId),
				// The library list is what reclassifying is chosen from, and it is the
				// one thing this dialog needs that the item does not carry.
				librariesStore.loaded ? Promise.resolve() : librariesStore.load(),
				/*
				 * And the services, because which libraries may be offered is a fact
				 * about them rather than about the libraries: a library is a place a file
				 * can land only when its service's folders are mounted here. Without this
				 * the list comes out empty on a freshly opened tab, which reads as "there
				 * is nowhere to reclassify into" on a gateway that has five shelves.
				 *
				 * Failing is survivable and must not take the dialog down: somebody
				 * allowed to correct media may not be allowed to read services, and what
				 * they came here for is the title and the numbers.
				 */
				servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			]);
			item.value = node;
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	/**
	 * Where the gateway thinks this media might belong, read once per opening.
	 *
	 * Beside the library field because it is an answer to that field's question, and read
	 * here rather than on the media page for the same reason: this is the only screen from
	 * which agreeing with it can be done, and the act of agreeing is the write this dialog
	 * already performs. There is no apply route, no job and nothing to post to.
	 *
	 * It carries its own loading and failure flags rather than the dialog's. A suggestion
	 * is the least important thing on this form — somebody came here to fix a title — so a
	 * route that cannot answer says so in its own block and leaves the rest working.
	 */
	const classification = ref<ClassificationProposal | null>(null);
	const classifying = ref(false);
	const classificationFailed = ref(false);

	/** Which suggestion is being agreed with, for its button and for what the save reports. */
	const accepting = ref<string | null>(null);

	async function loadClassification (): Promise<void> {
		classifying.value = true;
		classificationFailed.value = false;
		try {
			classification.value = await mediaStore.classification(props.itemId);
		} catch {
			classification.value = null;
			classificationFailed.value = true;
		} finally {
			classifying.value = false;
		}
	}

	/**
	 * How long the form waits for the suggestion before drawing itself anyway.
	 *
	 * The suggestion block sits above the fields, so it growing from a spinner into a
	 * proposal moves every box below it — and a box that moves while somebody is reaching
	 * for the eraser beside it is a click that lands somewhere else. Two journeys caught
	 * exactly that, on two different fields, before anybody typed a word.
	 *
	 * So the form waits for it. Bounded, because the wait is the one thing that must not
	 * depend on a route being quick: past this the block is drawn late, which is the
	 * behaviour that was wrong only because it was the *usual* one.
	 */
	const SUGGESTION_GRACE_MS = 2000;

	// Immediate, because a dialog can be mounted already open — and re-read on every
	// opening rather than once: the row may have been corrected from another tab,
	// and a stale "was" line would be a lie about what the service says. The suggestion is
	// re-read with it, or a media somebody has just re-filed would still be offered the
	// shelf it is now on.
	watch(open, async isOpen => {
		if (!isOpen) {
			return;
		}

		const suggested = loadClassification();

		await Promise.all([
			load(),
			Promise.race([
				suggested,
				new Promise(resolve => setTimeout(resolve, SUGGESTION_GRACE_MS)),
			]),
		]);
	}, { immediate: true });

	watch(() => props.item, next => {
		if (next) {
			item.value = next;
		}
	});

	/**
	 * The folders of our own this media can be moved onto, listed by their name.
	 *
	 * **Never a remote library.** Reclassifying decides which category the media appears
	 * under *and* which folder a pull of it lands in, so a library on somebody else's
	 * server is not a choice: there is nothing there this gateway can write, and picking
	 * one would produce a transfer that succeeds and files nothing — the failure this
	 * whole product exists to avoid. `useDestinationLibraries` already answers exactly
	 * that question for the sync screens, and answering it twice is how the two lists end
	 * up disagreeing. This list offered every library it knew about, a friend's included.
	 *
	 * **The name is the label**, because it is what the shelf is called everywhere else —
	 * on the media server, on the libraries screen, in the category mapping. This listed
	 * the paths instead, and a closed select then read `/share/FilmsHD/Films ·
	 * /share/FilmsHD2`, which is a disk layout rather than an answer to "which library".
	 *
	 * The paths keep their place on the second line, because the argument for them is
	 * real: two servers commonly have a library called `Films`, and the name alone would
	 * not be a choice anybody could make. So the server and every root are named there —
	 * every one of them, since a shelf really is five directories and naming one would be
	 * picking a folder on somebody's behalf.
	 *
	 * **Never a remote library**, and that rule is above, not here.
	 */
	const libraryItems = computed(() => destinations.value.map(one => ({
		value: one.id,
		title: one.name,
		props: {
			subtitle: one.roots.length > 0
				? `${one.serviceName} — ${one.roots.join(' · ')}`
				: `${one.serviceName}${one.path === null ? '' : ` — ${one.path}`}`,
		},
	})));

	/**
	 * Where the gateway would put it, offered as the folder field's starting value.
	 *
	 * Asked of the gateway rather than guessed here, because the answer is a rule with
	 * four steps in it and the first one — a series we already hold keeps its folder — is
	 * the one somebody actually wants and the one the interface cannot work out. A field
	 * that opened blank had somebody typing a path the gateway already knew, or inventing
	 * one beside the folder the series is in.
	 *
	 * Only when nothing is pinned: a folder somebody chose is a decision, and overwriting
	 * it with a suggestion would undo it silently.
	 */
	const browsingFolder = ref(false);

	async function suggestFolder (): Promise<void> {
		const id = item.value?.id ?? null;

		if (id === null || draft.libraryId === null) {
			suggestedFolder.value = null;

			return;
		}

		try {
			suggestedFolder.value = await releasesStore.plannedFolder(id, draft.libraryId);
		} catch {
			// A prefill nobody could work out is a field that opens empty, which is the
			// honest state: the rule still decides at placement, exactly as it did before
			// this field existed.
			suggestedFolder.value = null;
		}

		if (draft.targetFolder === null || draft.targetFolder.trim() === '') {
			draft.targetFolder = suggestedFolder.value;
		}
	}

	watch(() => draft.libraryId, (next, previous) => {
		if (next === previous) {
			return;
		}

		/*
		 * A folder of the shelf somebody just left sits under no root of the new one, so
		 * keeping it would pin a path the gateway will refuse. Cleared and asked again,
		 * which is what the redirect dialog does for the same reason.
		 */
		if (previous !== null) {
			draft.targetFolder = null;
		}

		void suggestFolder();
	});

	/** Every directory of the chosen shelf, which is as far as browsing may go. */
	const chosenRoots = computed<string[]>(() => {
		const chosen = destinations.value.find(one => one.id === draft.libraryId);

		return chosen ? (chosen.roots.length > 0 ? chosen.roots : [chosen.path ?? '']) : [];
	});

	/**
	 * What the select shows, which is nothing when it cannot show a name.
	 *
	 * The list only offers shelves this gateway can write into, and the media's own is
	 * very often not one of them — a film on a friend's server, a library whose folders
	 * are not mounted here. Bound straight to `draft.libraryId`, the control was handed a
	 * value matching none of its options and did what Vuetify does with one: it printed
	 * the raw identifier, `876cf493-3c7f-4975-bff8-24c553ffc13c`, where a library name
	 * belongs.
	 *
	 * Empty is the honest reading — nothing is selected, because nothing selectable is
	 * where this media currently is — and the line under the field says where it really
	 * sits. Writing still goes to the draft, so choosing a shelf works exactly as before.
	 */
	const librarySelection = computed<string | null>({
		get: () => (libraryItems.value.some(one => one.value === draft.libraryId)
			? draft.libraryId
			: null),
		set: value => {
			draft.libraryId = value;
		},
	});

	const reportedLibraryName = computed(() => {
		const library = librariesStore.byId[reported.value?.libraryId ?? ''];
		return library ? (library.alias ?? library.name) : '';
	});

	/**
	 * Where the media sits now, when that is not somewhere we could move it to.
	 *
	 * The ordinary case for anything worth reclassifying before it is pulled: the row
	 * came from a friend's server or from a service whose folders nobody mapped, so the
	 * library it is in cannot be offered and the select has nothing selected. A blank
	 * control with no explanation reads as a list that failed to load — this says which
	 * shelf it is on and that choosing one of ours is what moves it.
	 */
	const elsewhereLibraryName = computed(() => {
		const current = item.value?.libraryId ?? null;

		if (current === null || destinations.value.some(one => one.id === current)) {
			return '';
		}

		const library = librariesStore.byId[current];

		return library ? (library.alias ?? library.name) : current;
	});

	const changedCount = computed(() => {
		const library = libraryChanged.value ? 1 : 0;
		const preference = preferenceChanged.value ? 1 : 0;

		return correctedFields.value.length + library + preference;
	});

	/**
	 * The media's own search order, edited here because this is the dialog that writes it.
	 *
	 * It is one of the corrections — it lives in the same instruction blob as the title
	 * and the reclassification, for the reason `MediaOverride` gives — so it is saved by
	 * the same button and undone by the same "put it all back". What the media *page*
	 * carries is the statement that an order is in force and the one press that cancels
	 * it; reordering five dimensions is not something to do from a caption.
	 *
	 * `null` is "follows the category's order" and is not the same as an order with no
	 * values, which says "order by nothing, on purpose" — see `isEmptyReleasePreference`.
	 * The two are separate states here because a control that collapsed them would make
	 * the second unsayable.
	 */
	const preferenceDrafts = ref<Record<string, string>>({});

	const ranks = computed<ReleasePreferenceRank[]>(() => draft.releasePreference?.ranks ?? []);

	const preferenceSeparatesNothing = computed(
		() => isEmptyReleasePreference(draft.releasePreference));

	const unusedDimensions = computed(() => RELEASE_PREFERENCE_DIMENSIONS
		.filter(dimension => !ranks.value.some(rank => rank.dimension === dimension)));

	/**
	 * Started empty rather than as a copy of the category's order, and deliberately.
	 *
	 * The dialog has not read the settings and has no business doing so: a copy of an
	 * order it had to fetch would be a copy of whatever that screen happened to say a
	 * moment ago, presented as this media's own opinion. An empty order says exactly what
	 * is true — nothing has been decided here yet — and the caption below says what an
	 * empty one would mean if it were saved as it stands.
	 */
	function givePreference (): void {
		draft.releasePreference = { ranks: [] };
	}

	/** Cancelled, not emptied: the media goes back to following its category's order. */
	function dropPreference (): void {
		draft.releasePreference = null;
	}

	/**
	 * Replaced rather than mutated, for the reason the settings editor states.
	 *
	 * The draft is what `payload()` compares against what the item already carries, and
	 * that comparison is by value: assigning into the same array would change both sides
	 * of it at once, so the change would read as no change and the save would send
	 * nothing. It looks exactly like a button that does not work.
	 */
	function setRanks (next: ReleasePreferenceRank[]): void {
		draft.releasePreference = { ranks: next };
	}

	function rewrite (
		dimension: ReleasePreferenceDimension,
		values: (current: string[]) => string[],
	): void {
		setRanks(ranks.value.map(rank => (
			rank.dimension === dimension ? { dimension, values: values(rank.values) } : rank
		)));
	}

	function moveDimension (index: number, delta: number): void {
		const next = [...ranks.value];

		[next[index], next[index + delta]] = [next[index + delta], next[index]];
		setRanks(next);
	}

	function dropDimension (dimension: ReleasePreferenceDimension): void {
		setRanks(ranks.value.filter(rank => rank.dimension !== dimension));
	}

	/** Added last, because a dimension nobody has ranked yet cannot outrank a ranked one. */
	function addDimension (dimension: ReleasePreferenceDimension): void {
		setRanks([...ranks.value, { dimension, values: [] }]);
	}

	function promoteValue (dimension: ReleasePreferenceDimension, index: number): void {
		rewrite(dimension, current => {
			const values = [...current];

			[values[index - 1], values[index]] = [values[index], values[index - 1]];

			return values;
		});
	}

	function dropValue (dimension: ReleasePreferenceDimension, value: string): void {
		rewrite(dimension, current => current.filter(one => one !== value));
	}

	function suggestionsFor (dimension: ReleasePreferenceDimension, values: string[]): string[] {
		return RELEASE_PREFERENCE_SUGGESTIONS[dimension]
			.filter(one => !values.some(value => value.toLowerCase() === one.toLowerCase()));
	}

	/**
	 * A value committed in the add field, chosen from the list or typed outright.
	 *
	 * `update:modelValue` on a combobox is the commit — enter, blur or choosing an item —
	 * and never the keystroke, which is `update:search`. Listening to the wrong one would
	 * rank a team called `N`, then `NT`, then `NTb`.
	 */
	function addValue (dimension: ReleasePreferenceDimension, value: string | null): void {
		const wanted = (value ?? '').trim();

		preferenceDrafts.value = { ...preferenceDrafts.value, [dimension]: '' };

		if (wanted === '') {
			return;
		}

		rewrite(dimension, current => (
			current.some(one => one.toLowerCase() === wanted.toLowerCase())
				? current
				: [...current, wanted]
		));
	}

	const form = useForm({
		fallbackError: 'override.failed',
		fields: {
			title: { rules: [validators.maxlength({ max: 500 })] },
			seriesTitle: { rules: [validators.maxlength({ max: 500 })] },
			year: { rules: [validators.range({ min: 1800, max: 2999 })] },
			seasonNumber: { rules: [validators.range({ min: 0, max: 999 })] },
			episodeNumber: { rules: [validators.range({ min: 0, max: 9999 })] },
			overview: { rules: [validators.maxlength({ max: 5000 })] },
		},
		handle: async () => {
			const agreed = accepting.value;
			const saved = await mediaStore.setOverride(props.itemId, payload());
			item.value = saved;
			emit('saved', saved);
			/*
			 * Which sentence the toast carries says which of two things happened.
			 *
			 * The same write either way, and deliberately so — but "Correction saved" is
			 * the wrong account of having agreed with a suggestion, and somebody who
			 * pressed "file it there" wants to be told where it went rather than that a
			 * form was accepted.
			 */
			void notify(agreed === null
				? 'override.saved'
				: t('classification.accepted', { value: agreedName(agreed) }));
			open.value = false;
		},
	});

	/**
	 * Agreeing with a suggestion is the correction this dialog already writes.
	 *
	 * It fills the library field and saves through the same handler the save button uses,
	 * which is what "there is no second mechanism" has to mean in practice: one request,
	 * one record of why the media moved, and every other correction still in force
	 * travelling with it. Posting `{ libraryId }` on its own would have been the shorter
	 * code and would have withdrawn the corrected title, the cleared year and the search
	 * order on the way, because a `PUT` replaces the whole instruction rather than
	 * patching it.
	 *
	 * `libraryId` is non-null exactly when `blocker` is null — that is the invariant of
	 * `CategoryProposal` — so the guard is belt and braces against a request that would
	 * half-work. The block offers no button on a blocked suggestion at all.
	 */
	async function acceptProposal (candidate: Candidate): Promise<void> {
		if (candidate.libraryId === null) {
			return;
		}

		accepting.value = candidate.category;
		draft.libraryId = candidate.libraryId;
		try {
			await form.handle();
		} finally {
			accepting.value = null;
		}
	}

	/** The shelf a suggestion named, for the sentence the save reports. */
	function agreedName (category: string): string {
		const candidate = classification.value?.proposals.find(one => one.category === category);

		return candidate?.categoryName ?? t(`classification.category.${category}`);
	}

	const restore = tryCallback(async () => {
		restoring.value = true;
		try {
			const saved = await mediaStore.clearOverride(props.itemId);
			item.value = saved;
			emit('saved', saved);
			void notify('override.restored');
			open.value = false;
		} finally {
			restoring.value = false;
		}
	});
</script>

<template>
	<Window
		v-model="open"
		data-test="override-dialog"
		:max-width="720"
		:title="$t('override.title')"
	>
		<div v-if="loading" class="text-center py-8">
			<v-progress-circular color="primary" indeterminate size="36" />
		</div>

		<ErrorState v-else-if="failed" @retry="load" />

		<v-form v-else v-form="form" class="override" data-test="override-form">
			<p class="text-body-2 text-medium-emphasis">{{ $t('override.intro') }}</p>

			<v-alert
				class="mb-4"
				density="compact"
				icon="mdi-eraser"
				:text="$t('override.clear_help')"
				variant="tonal"
			/>

			<!--
				In the form and not beside "restore", because that is what it acts on. One
				changes the record and closes; this one only fills the boxes, so it belongs
				where the boxes are — and keeping them apart is also what stops a person
				reaching for the wrong one when all they wanted was to look at what the
				service says.

				Only when there is something to reset: an action that cannot do anything
				teaches people not to read the row it sits in.
			-->
			<div v-if="hasOverride" class="override_reset mb-2">
				<v-btn
					data-test="override-reset"
					prepend-icon="mdi-undo-variant"
					size="small"
					variant="tonal"
					@click="resetToReported"
				>
					{{ $t('override.reset') }}
				</v-btn>
			</div>

			<v-select
				v-model="librarySelection"
				data-test="override-library"
				:hint="libraryChanged
					? $t('override.state.was', { value: reportedLibraryName })
					: $t('override.library_hint')"
				item-props
				item-title="title"
				item-value="value"
				:items="libraryItems"
				:label="$t('override.library')"
				persistent-hint
			/>

			<!--
				The folder inside that shelf, once a shelf is chosen: a library is commonly
				several directories on several disks, so naming one answers only half of
				"where does this go". Prefilled with what the gateway would answer — the
				folder the series is already in, when we hold it — because the alternative
				is somebody typing a path that already exists two lines above them.

				Emptying it is how the pin is removed, which is why it is clearable and why
				an empty field is never sent as one.
			-->
			<div v-if="draft.libraryId">
				<v-text-field
					v-model="draft.targetFolder"
					clearable
					data-test="override-folder"
					density="compact"
					:hint="$t('override.folder_hint')"
					:label="$t('override.folder')"
					persistent-hint
					:placeholder="suggestedFolder ?? ''"
				>
					<template #append-inner>
						<v-btn
							data-test="override-browse"
							icon="mdi-folder-open-outline"
							size="small"
							:title="$t('browse.open')"
							variant="text"
							@click="browsingFolder = true"
						/>
					</template>
				</v-text-field>

				<!--
					Bounded by the chosen shelf's own directories: a field about one library
					has no business offering the whole disk, and a folder picked outside it
					is a destination that library will never scan.
				-->
				<DirectoryPicker
					v-model="browsingFolder"
					:path="draft.targetFolder ?? suggestedFolder"
					:roots="chosenRoots"
					@choose="draft.targetFolder = $event"
				/>
			</div>

			<!--
				Where it sits now, when that is not somewhere we could move it to — which is
				the ordinary case for anything worth reclassifying before it is pulled. The
				select then has nothing selected, and a blank control with no explanation
				reads as a list that failed to load rather than as an invitation to choose.
			-->
			<p
				v-if="elsewhereLibraryName && !libraryChanged"
				class="text-caption text-medium-emphasis mb-0"
				data-test="override-library-elsewhere"
			>
				{{ $t('override.library_elsewhere', { value: elsewhereLibraryName }) }}
			</p>

			<!--
				Said rather than left as an empty menu. A gateway nobody has mapped folders
				for has nowhere to reclassify into, which is a real state with a real
				remedy — and a select that opens on nothing sends somebody looking for a
				fault in this dialog instead.
			-->
			<p
				v-if="libraryItems.length === 0"
				class="text-caption text-warning mb-0"
				data-test="override-library-none"
			>
				{{ $t('override.library_none') }}
			</p>

			<!--
				Beside the library field, because it is an answer to that field's question:
				"where does this belong" is what somebody is being asked, and a suggestion on
				another screen would be a suggestion about a decision made here.

				Nothing here writes. Pressing its button fills the field above and saves
				through the same handler as the save button — one request, one record of why
				the media moved.
			-->
			<CategoryProposalBlock
				:accepting="accepting"
				class="mt-4"
				:failed="classificationFailed"
				:loading="classifying"
				:proposal="classification"
				@accept="acceptProposal"
				@retry="loadClassification"
			/>

			<v-divider class="my-4" />

			<OverrideField
				v-model="draft.values.title"
				v-model:cleared="draft.cleared.title"
				:field="form.field('title')"
				:label="$t('override.field.title')"
				name="title"
				:reported="reportedValue('title')"
			/>

			<OverrideField
				v-model="draft.values.seriesTitle"
				v-model:cleared="draft.cleared.seriesTitle"
				:field="form.field('seriesTitle')"
				:hint="$t('override.field.series_title_hint')"
				:label="$t('override.field.series_title')"
				name="series-title"
				:reported="reportedValue('seriesTitle')"
			/>

			<v-row density="compact">
				<v-col cols="12" sm="4">
					<OverrideField
						v-model="draft.values.year"
						v-model:cleared="draft.cleared.year"
						:field="form.field('year')"
						:label="$t('override.field.year')"
						name="year"
						:reported="reportedValue('year')"
						type="number"
					/>
				</v-col>

				<v-col cols="6" sm="4">
					<OverrideField
						v-model="draft.values.seasonNumber"
						v-model:cleared="draft.cleared.seasonNumber"
						:field="form.field('seasonNumber')"
						:label="$t('override.field.season')"
						name="season"
						:reported="reportedValue('seasonNumber')"
						type="number"
					/>
				</v-col>

				<v-col cols="6" sm="4">
					<OverrideField
						v-model="draft.values.episodeNumber"
						v-model:cleared="draft.cleared.episodeNumber"
						:field="form.field('episodeNumber')"
						:label="$t('override.field.episode')"
						name="episode"
						:reported="reportedValue('episodeNumber')"
						type="number"
					/>
				</v-col>
			</v-row>

			<OverrideField
				v-model="draft.values.overview"
				v-model:cleared="draft.cleared.overview"
				:field="form.field('overview')"
				:label="$t('override.field.overview')"
				name="overview"
				:reported="reportedValue('overview')"
				type="textarea"
			/>

			<v-divider class="my-4" />

			<!--
				The third level of a search order, edited where the other corrections are.
				What the media page carries is the statement that one is in force and the
				press that cancels it; five dimensions cannot be reordered from a caption.
			-->
			<div class="override_preference" data-test="override-preference">
				<div class="override_preference-head">
					<span class="text-subtitle-2">{{ $t('override.preference.title') }}</span>

					<v-btn
						v-if="draft.releasePreference !== null"
						data-test="override-preference-drop"
						prepend-icon="mdi-close"
						size="small"
						variant="text"
						@click="dropPreference"
					>
						{{ $t('override.preference.follow') }}
					</v-btn>
				</div>

				<p class="text-caption text-medium-emphasis mb-2">
					{{ $t('override.preference.intro') }}
				</p>

				<v-btn
					v-if="draft.releasePreference === null"
					data-test="override-preference-give"
					prepend-icon="mdi-plus"
					size="small"
					variant="tonal"
					@click="givePreference"
				>
					{{ $t('override.preference.give') }}
				</v-btn>

				<template v-else>
					<!--
						An order that separates nothing says so. Empty is a decision here —
						"order by nothing, on purpose", which is how one series opts out of
						a household order that is wrong for it — and an unlabelled empty
						list reads as a control that failed to load.
					-->
					<p
						v-if="preferenceSeparatesNothing"
						class="text-caption text-medium-emphasis mb-1"
						data-test="override-preference-none"
					>
						{{ $t('settings.preference.separates_nothing') }}
					</p>

					<ol class="override_ranks text-body-2" data-test="override-preference-ranks">
						<li
							v-for="(rank, index) of ranks"
							:key="rank.dimension"
							:data-test="`override-preference-rank-${rank.dimension}`"
						>
							<div class="override_rank-head">
								<span>{{ $t(`settings.preference.dimension.${rank.dimension}`) }}</span>

								<span class="override_rank-actions">
									<v-btn
										:aria-label="$t('settings.preference.move_up')"
										:data-test="`override-preference-up-${rank.dimension}`"
										density="comfortable"
										:disabled="index === 0"
										icon="mdi-arrow-up"
										size="small"
										:title="$t('settings.preference.move_up')"
										variant="text"
										@click="moveDimension(index, -1)"
									/>

									<v-btn
										:aria-label="$t('settings.preference.move_down')"
										:data-test="`override-preference-down-${rank.dimension}`"
										density="comfortable"
										:disabled="index === ranks.length - 1"
										icon="mdi-arrow-down"
										size="small"
										:title="$t('settings.preference.move_down')"
										variant="text"
										@click="moveDimension(index, 1)"
									/>

									<v-btn
										:aria-label="$t('settings.preference.drop')"
										:data-test="`override-preference-drop-${rank.dimension}`"
										density="comfortable"
										icon="mdi-close"
										size="small"
										:title="$t('settings.preference.drop')"
										variant="text"
										@click="dropDimension(rank.dimension)"
									/>
								</span>
							</div>

							<div class="override_values">
								<!--
									Numbered, because the order inside a dimension is the
									other half of the setting: an unnumbered chip strip
									reads as a set, and `2160p, 1080p` and `1080p, 2160p`
									would look like the same answer.
								-->
								<span
									v-for="(value, place) of rank.values"
									:key="value"
									class="override_value"
								>
									<v-btn
										:aria-label="$t('settings.preference.promote')"
										:data-test="`override-preference-promote-${rank.dimension}-${place}`"
										density="compact"
										:disabled="place === 0"
										icon="mdi-arrow-left"
										size="x-small"
										:title="$t('settings.preference.promote')"
										variant="text"
										@click="promoteValue(rank.dimension, place)"
									/>

									<v-chip
										closable
										:data-test="`override-preference-value-${rank.dimension}-${value}`"
										label
										size="small"
										variant="tonal"
										@click:close="dropValue(rank.dimension, value)"
									>
										<span class="text-medium-emphasis mr-1">{{ place + 1 }}.</span>{{ value }}
									</v-chip>
								</span>

								<!--
									A combobox and not a select: it offers what a tracker
									usually prints and still takes a tag nothing here has
									heard of, which the release group dimension is made of.
								-->
								<v-combobox
									class="override_preference-input"
									:data-test="`override-preference-add-value-${rank.dimension}`"
									density="compact"
									hide-details
									:items="suggestionsFor(rank.dimension, rank.values)"
									:label="$t('settings.preference.add_value')"
									:model-value="preferenceDrafts[rank.dimension] ?? ''"
									@update:model-value="addValue(rank.dimension, $event)"
								/>

								<span
									v-if="rank.values.length === 0"
									class="text-caption text-medium-emphasis"
									:data-test="`override-preference-no-value-${rank.dimension}`"
								>
									{{ $t('settings.preference.no_value') }}
								</span>
							</div>
						</li>
					</ol>

					<!--
						The dimensions nobody ranked are shown rather than hidden: a list
						holding only what is in use cannot say what else there was, and a
						setting somebody cannot see is one they conclude does not exist.
					-->
					<div v-if="unusedDimensions.length > 0" class="override_unused">
						<span class="text-caption text-medium-emphasis">
							{{ $t('settings.preference.unused') }}
						</span>

						<v-btn
							v-for="dimension of unusedDimensions"
							:key="dimension"
							:data-test="`override-preference-add-${dimension}`"
							prepend-icon="mdi-plus"
							size="small"
							variant="tonal"
							@click="addDimension(dimension)"
						>
							{{ $t(`settings.preference.dimension.${dimension}`) }}
						</v-btn>
					</div>
				</template>
			</div>

			<v-divider class="my-4" />

			<p class="text-subtitle-2 mb-1">{{ $t('override.identifiers') }}</p>

			<p class="text-caption text-medium-emphasis mb-2">{{ $t('override.identifiers_hint') }}</p>

			<v-row density="compact">
				<v-col v-for="key of OVERRIDE_ID_FIELDS" :key="key" cols="12" sm="4">
					<v-text-field
						v-model="draft.externalIds[key]"
						:data-test="`override-id-${key}`"
						density="compact"
						:label="$t(`override.id.${key}`)"
					/>
				</v-col>
			</v-row>

			<FormMainError :form="form" />
		</v-form>

		<template #actions>
			<v-btn
				v-if="hasOverride"
				data-test="override-restore"
				:loading="restoring"
				prepend-icon="mdi-backup-restore"
				variant="text"
				@click="restore"
			>
				{{ $t('override.restore') }}
			</v-btn>

			<v-spacer />

			<span v-if="changedCount > 0" class="text-caption text-medium-emphasis mr-3">
				{{ $t('override.changed_count', { count: changedCount }, changedCount) }}
			</span>

			<v-btn variant="text" @click="open = false">{{ $t('actions.cancel') }}</v-btn>

			<v-btn
				color="primary"
				data-test="override-save"
				:disabled="loading || failed"
				:loading="form.loading"
				@click="form.handle"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</template>
	</Window>
</template>

<style lang="scss">
	.override {
		// The dialog is a form of many short fields; a comfortable density would push
		// the identifiers below the fold on a laptop.
		.v-input {
			margin-bottom: 4px;
		}

		// Left, under the note it belongs with, rather than stretched across the form.
		&_reset {
			display: flex;
		}

		&_preference-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}

		&_ranks {
			padding-left: 20px;
		}

		// Tabular numbers so the list reads as an order at a glance rather than as a
		// column of digits of different widths.
		&_ranks li::marker {
			font-variant-numeric: tabular-nums;
		}

		&_rank-head {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_rank-actions {
			display: inline-flex;
			gap: 2px;
			margin-left: auto;
		}

		// One wrapping strip. As blocks, five dimensions with four values each pushed the
		// identifiers below the fold of a dialog that already holds nine fields.
		&_values {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 4px;
			margin: 2px 0 6px;
		}

		&_value {
			display: inline-flex;
			align-items: center;
		}

		&_unused {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
			margin-top: 4px;
		}

		&_preference-input {
			max-width: 200px;
		}
	}
</style>
