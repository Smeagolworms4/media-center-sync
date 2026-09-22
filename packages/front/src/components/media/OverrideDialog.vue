<script lang="ts" setup>
	import type { MediaItem } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import OverrideField from '@/components/media/OverrideField.vue';
	import Window from '@/components/Window.vue';
	import { useForm } from '@/composables/useForm';
	import { OVERRIDE_ID_FIELDS, useMediaOverride } from '@/composables/useMediaOverride';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
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
	const servicesStore = useServicesStore();
	const validators = useValidators();
	const { notify, tryCallback } = useNotifier();

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
		reportedValue,
		fillFromReported,
		payload,
	} = useMediaOverride(item);

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
			]);
			item.value = node;
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	// Immediate, because a dialog can be mounted already open — and re-read on every
	// opening rather than once: the row may have been corrected from another tab,
	// and a stale "was" line would be a lie about what the service says.
	watch(open, async isOpen => {
		if (!isOpen) {
			return;
		}
		await load();
	}, { immediate: true });

	watch(() => props.item, next => {
		if (next) {
			item.value = next;
		}
	});

	/**
	 * Every library, named as this gateway names it, and by the service holding it.
	 *
	 * The service is in the same line rather than in a subtitle because two servers
	 * commonly have a library called `Films`, and a list of identical names is not a
	 * choice anybody can make.
	 */
	const libraryItems = computed(() => librariesStore.libraries.map(one => {
		const name = one.alias ?? one.name;
		const service = servicesStore.byId[one.serviceId]?.name ?? '';
		return { value: one.id, title: service ? `${name} — ${service}` : name };
	}));

	const reportedLibraryName = computed(() => {
		const library = librariesStore.byId[reported.value?.libraryId ?? ''];
		return library ? (library.alias ?? library.name) : '';
	});

	const changedCount = computed(
		() => correctedFields.value.length + (libraryChanged.value ? 1 : 0));

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
			const saved = await mediaStore.setOverride(props.itemId, payload());
			item.value = saved;
			emit('saved', saved);
			void notify('override.saved');
			open.value = false;
		},
	});

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
				v-model="draft.libraryId"
				data-test="override-library"
				:hint="libraryChanged
					? $t('override.state.was', { value: reportedLibraryName })
					: $t('override.library_hint')"
				item-title="title"
				item-value="value"
				:items="libraryItems"
				:label="$t('override.library')"
				persistent-hint
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
	}
</style>
