<script lang="ts" setup>
	import type { Library, MediaService } from '@mcs/shared';
	import { MediaKind, SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';

	/**
	 * The filter bar of the library.
	 *
	 * Every value is a model owned by the page, which keeps them in the URL: a
	 * filtered view is then something somebody can send to a friend, and it
	 * survives the reload that follows a sync.
	 */
	const props = withDefaults(defineProps<{
		services?: MediaService[];
		libraries?: Library[];
		loading?: boolean;
	}>(), {
		services: () => [],
		libraries: () => [],
		loading: false,
	});

	const { t } = useI18n();

	const search = defineModel<string | null>('search', { default: null });
	const serviceId = defineModel<string | null>('serviceId', { default: null });
	const libraryId = defineModel<string | null>('libraryId', { default: null });
	const kind = defineModel<MediaKind | null>('kind', { default: null });
	const states = defineModel<SyncState[] | null>('states', { default: null });
	const sort = defineModel<string | null>('sort', { default: null });
	const direction = defineModel<string | null>('direction', { default: null });

	/**
	 * Choosing a service narrows the libraries: offering the libraries of a service
	 * nobody is looking at produces a pair of filters that answers nothing.
	 */
	const libraryItems = computed(() => (serviceId.value
		? props.libraries.filter(one => one.serviceId === serviceId.value)
		: props.libraries));

	/**
	 * Items carry their translated title rather than a key rendered in a slot: the
	 * select then needs no template at all, and the chips it draws for a multiple
	 * selection are already in the viewer's language.
	 */
	const kindItems = computed(() => Object.values(MediaKind).map(value => ({
		value,
		title: t(`media.kind.${value}`),
	})));

	const stateItems = computed(() => Object.values(SyncState).map(value => ({
		value,
		title: t(`sync.state.${value}`),
	})));

	const sortItems = computed(() => [
		{ value: 'title', title: t('media.sort.title') },
		{ value: 'year', title: t('media.sort.year') },
		{ value: 'addedAt', title: t('media.sort.added_at') },
	]);

	const hasFilter = computed(() => Boolean(
		search.value || serviceId.value || libraryId.value || kind.value || states.value?.length));

	function clear (): void {
		search.value = null;
		serviceId.value = null;
		libraryId.value = null;
		kind.value = null;
		states.value = null;
	}

	function onServiceChange (): void {
		// A library of another service would keep filtering everything out.
		libraryId.value = null;
	}

	function toggleDirection (): void {
		direction.value = direction.value === 'desc' ? 'asc' : 'desc';
	}
</script>

<template>
	<div class="media-filters" data-test="media-filters">
		<v-row density="compact">
			<v-col cols="12" md="4" sm="6">
				<v-text-field
					v-model="search"
					clearable
					data-test="media-search"
					density="compact"
					hide-details
					:label="$t('media.filter.search')"
					:loading="loading"
					prepend-inner-icon="mdi-magnify"
				/>
			</v-col>

			<v-col cols="12" md="2" sm="6">
				<v-select
					v-model="serviceId"
					clearable
					data-test="media-service"
					density="compact"
					hide-details
					item-title="name"
					item-value="id"
					:items="services"
					:label="$t('media.filter.service')"
					@update:model-value="onServiceChange"
				/>
			</v-col>

			<v-col cols="12" md="2" sm="6">
				<v-select
					v-model="libraryId"
					clearable
					data-test="media-library"
					density="compact"
					hide-details
					item-title="name"
					item-value="id"
					:items="libraryItems"
					:label="$t('media.filter.library')"
				/>
			</v-col>

			<v-col cols="12" md="2" sm="6">
				<v-select
					v-model="kind"
					clearable
					data-test="media-kind"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="kindItems"
					:label="$t('media.filter.kind')"
				/>
			</v-col>

			<v-col cols="12" md="2" sm="6">
				<v-select
					v-model="states"
					chips
					clearable
					data-test="media-states"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="stateItems"
					:label="$t('media.filter.state')"
					multiple
				/>
			</v-col>
		</v-row>

		<div class="media-filters_row mt-2">
			<v-select
				v-model="sort"
				class="media-filters_sort"
				data-test="media-sort"
				density="compact"
				hide-details
				item-title="title"
				item-value="value"
				:items="sortItems"
				:label="$t('media.filter.sort')"
			/>

			<v-btn
				data-test="media-direction"
				:icon="direction === 'desc' ? 'mdi-sort-descending' : 'mdi-sort-ascending'"
				size="small"
				variant="text"
				@click="toggleDirection"
			/>

			<v-spacer />

			<v-btn
				v-if="hasFilter"
				data-test="media-clear"
				prepend-icon="mdi-filter-remove-outline"
				size="small"
				variant="text"
				@click="clear"
			>
				{{ $t('media.filter.clear') }}
			</v-btn>
		</div>
	</div>
</template>

<style lang="scss">
	.media-filters {
		&_row {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_sort {
			max-width: 220px;
		}
	}
</style>
