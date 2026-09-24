<script lang="ts" setup>
	import type { MediaCategory, MediaOrigin, MediaService } from '@mcs/shared';
	import { MEDIA_VIDEO_CODECS, MediaKind, MediaResolution, SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { MEDIA_ORIGINS, useMediaOrigin } from '@/composables/useMediaOrigin';

	/**
	 * The filter bar of the library.
	 *
	 * Every value is a model owned by the page, which keeps them in the URL: a
	 * filtered view is then something somebody can send to a friend, and it survives
	 * the reload that follows a sync.
	 *
	 * Where a copy comes from is asked twice, on purpose. The service select names
	 * servers — several of them, because comparing two friends' shelves is the
	 * ordinary case — and the origin chips ask the question people actually have:
	 * "what do my friends have?" is one filter, and naming six servers to express it
	 * is not. The API intersects them, so naming a friend's server and ticking
	 * *friends* narrows rather than contradicts.
	 *
	 * The shelf select offers **categories**, which are the names on the wall. It used
	 * to offer libraries, on the argument that one library answers the diagnostic
	 * question — which of the two servers that both call it `Shows` is this title on.
	 * That question is real, and the control could not ask it: two libraries of one name
	 * came out as two identical lines with nothing to tell them apart, so the owner read
	 * `Emission TV` beside `Émissions TV` and `Films` twice and could only guess. A
	 * filter that offers a name the screen never shows is a filter nobody can use, and
	 * the diagnostic belongs on the media's own page, where each copy is named with the
	 * server holding it.
	 */
	const props = withDefaults(defineProps<{
		services?: MediaService[];
		/** The merged shelves, which are what the wall is built from. */
		categories?: MediaCategory[];
		loading?: boolean;
		/**
		 * Off on the overview, where every band is already the latest additions of its
		 * category and a sort control would only say something the screen ignores.
		 */
		sortable?: boolean;
	}>(), {
		services: () => [],
		categories: () => [],
		loading: false,
		sortable: true,
	});

	const { t } = useI18n();
	const { describeMediaOrigin } = useMediaOrigin();

	const search = defineModel<string | null>('search', { default: null });
	const serviceIds = defineModel<string[] | null>('serviceIds', { default: null });
	const origins = defineModel<MediaOrigin[] | null>('origins', { default: null });
	const categoryKey = defineModel<string | null>('categoryKey', { default: null });
	const kind = defineModel<MediaKind | null>('kind', { default: null });
	const states = defineModel<SyncState[] | null>('states', { default: null });
	const resolutions = defineModel<MediaResolution[] | null>('resolutions', { default: null });
	const videoCodecs = defineModel<string[] | null>('videoCodecs', { default: null });
	const sort = defineModel<string | null>('sort', { default: null });
	const direction = defineModel<string | null>('direction', { default: null });

	/**
	 * Choosing services narrows the shelves: offering a shelf no chosen server holds
	 * anything on produces a pair of filters that answers nothing.
	 */
	const categoryItems = computed(() => (serviceIds.value?.length
		? props.categories.filter(one => one.serviceIds.some(id => serviceIds.value!.includes(id)))
		: props.categories));

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

	/**
	 * The five bands the gateway derives, in the order somebody thinks of them.
	 *
	 * Not translated and not relabelled: `2160p` is the word on every release and on the
	 * quality chip beside the poster, and inventing a second vocabulary here would mean
	 * the control and the card naming the same file two different things.
	 */
	const resolutionItems = computed(() => [
		MediaResolution.UHD,
		MediaResolution.FULL_HD,
		MediaResolution.HD,
		MediaResolution.PAL,
		MediaResolution.NTSC,
	].map(value => ({ value, title: value })));

	/**
	 * One entry per codec, labelled with both spellings people use.
	 *
	 * The value is the folded one — the only spelling the index holds — and the label
	 * carries the standard's name beside it, because somebody looking for HEVC has no
	 * reason to know this gateway writes it `x265`.
	 */
	const codecItems = computed(() => MEDIA_VIDEO_CODECS.map(one => ({
		value: one.codec,
		title: one.label,
	})));

	const sortItems = computed(() => [
		{ value: 'title', title: t('media.sort.title') },
		{ value: 'year', title: t('media.sort.year') },
		{ value: 'addedAt', title: t('media.sort.added_at') },
	]);

	const originItems = computed(() => MEDIA_ORIGINS.map(origin => describeMediaOrigin(origin)));

	/** The chip group works on a plain array; an absent filter is no chip lit. */
	const originModel = computed({
		get: () => origins.value ?? [],
		set: (value: MediaOrigin[]) => {
			origins.value = value.length > 0 ? value : null;
		},
	});

	const hasFilter = computed(() => [
		search.value,
		serviceIds.value?.length,
		origins.value?.length,
		categoryKey.value,
		kind.value,
		states.value?.length,
		resolutions.value?.length,
		videoCodecs.value?.length,
	].some(Boolean));

	function clear (): void {
		search.value = null;
		serviceIds.value = null;
		origins.value = null;
		categoryKey.value = null;
		kind.value = null;
		states.value = null;
		resolutions.value = null;
		videoCodecs.value = null;
	}

	function onServicesChange (): void {
		// A shelf no chosen server holds anything on would filter everything out.
		if (categoryKey.value && !categoryItems.value.some(one => one.key === categoryKey.value)) {
			categoryKey.value = null;
		}
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
					v-model="serviceIds"
					chips
					clearable
					data-test="media-service"
					density="compact"
					hide-details
					item-title="name"
					item-value="id"
					:items="services"
					:label="$t('media.filter.services')"
					multiple
					@update:model-value="onServicesChange"
				/>
			</v-col>

			<v-col cols="12" md="2" sm="6">
				<v-select
					v-model="categoryKey"
					clearable
					data-test="media-library"
					density="compact"
					hide-details
					item-title="name"
					item-value="key"
					:items="categoryItems"
					:label="$t('media.filter.category')"
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

		<!--
			What the files actually are, on a row of their own.

			Two selects rather than a single "quality" control: they are independent
			questions — "anything in 4K" and "anything still in x264" are both asked, and
			often separately — and a control that mixed them would offer combinations the
			library does not hold. Both are multiple, because the useful filter is usually
			a couple of bands rather than exactly one.
		-->
		<v-row density="compact">
			<v-col cols="12" md="3" sm="6">
				<v-select
					v-model="resolutions"
					chips
					clearable
					data-test="media-resolutions"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="resolutionItems"
					:label="$t('media.filter.resolution')"
					multiple
				/>
			</v-col>

			<v-col cols="12" md="3" sm="6">
				<v-select
					v-model="videoCodecs"
					chips
					clearable
					data-test="media-codecs"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="codecItems"
					:label="$t('media.filter.codec')"
					multiple
				/>
			</v-col>
		</v-row>

		<!--
			Four chips rather than a fifth select: these are the four answers to one
			question people ask out loud, they are worth reading at a glance, and a
			select would hide the one that matters — a friend of a friend is somebody
			nobody here ever agreed to, and it has to be visible without opening a menu.
		-->
		<div class="media-filters_origins mt-2" data-test="media-origins">
			<span class="text-caption text-medium-emphasis">{{ $t('media.filter.origin') }}</span>

			<v-chip-group
				v-model="originModel"
				class="media-filters_originGroup"
				column
				multiple
				selected-class="media-filters_origin--on"
			>
				<v-tooltip
					v-for="item of originItems"
					:key="item.origin"
					location="bottom"
					:open-delay="200"
					:text="$t(item.helpKey)"
				>
					<template #activator="{ props: tooltipProps }">
						<v-chip
							v-bind="tooltipProps"
							class="media-filters_origin"
							:data-origin="item.origin"
							:data-test="`media-origin-${item.origin}`"
							filter
							label
							:prepend-icon="item.icon"
							size="small"
							:value="item.origin"
							variant="outlined"
						>
							{{ $t(item.labelKey) }}
						</v-chip>
					</template>
				</v-tooltip>
			</v-chip-group>
		</div>

		<div class="media-filters_row mt-2">
			<v-select
				v-if="sortable"
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
				v-if="sortable"
				data-test="media-direction"
				:icon="direction === 'desc' ? 'mdi-sort-descending' : 'mdi-sort-ascending'"
				size="small"
				variant="text"
				@click="toggleDirection"
			/>

			<span v-else class="text-caption text-medium-emphasis" data-test="media-sort-fixed">
				{{ $t('media.sort.latest_first') }}
			</span>

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

		&_origins {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_originGroup {
			padding: 0;
		}

		&_origin {
			&--on {
				border-color: rgb(var(--v-theme-primary));
				color: rgb(var(--v-theme-primary));
			}
		}
	}
</style>
