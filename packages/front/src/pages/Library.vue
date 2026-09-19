<script lang="ts" setup>
	import type { MediaItem, SyncState } from '@mcs/shared';
	import { MediaKind } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import MediaFilters from '@/components/media/MediaFilters.vue';
	import MediaRow from '@/components/media/MediaRow.vue';
	import Pagination from '@/components/paginate/Pagination.vue';
	import { useDebounce } from '@/hooks/useDebounce';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'LibraryPage' });

	/**
	 * Browsing the index.
	 *
	 * Every filter lives in the URL rather than in component state: a filtered view
	 * is then a link somebody can send — "here is what I am missing from that
	 * series" — and it survives the reload that follows starting a sync from it.
	 */
	const mediaStore = useMediaStore();
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const syncStore = useSyncStore();
	const { notify, tryCallback } = useNotifier();

	const search = queryRef<string>('search');
	const serviceId = queryRef<string>('serviceId');
	const libraryId = queryRef<string>('libraryId');
	const kind = queryRef<MediaKind>('kind', queryTypes.stringEnum({ values: Object.values(MediaKind) }));
	const states = queryRef<SyncState[]>('states', queryTypes.delimitedArray<SyncState>({
		itemParse: value => value as SyncState,
	}));
	const sort = queryRef<string>('sort', queryTypes.string({ defaultValue: 'title' }));
	const direction = queryRef<string>('direction', queryTypes.string({ defaultValue: 'asc' }));
	const page = queryRef<number>('page', queryTypes.integer({ defaultValue: 0 }));
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 50 }));

	const failed = ref(false);
	const selection = ref<Set<string>>(new Set());
	const syncing = ref(false);

	/**
	 * The pagination control works on plain numbers while a query parameter is
	 * always nullable — an address with no `page` in it is the first page.
	 */
	const pageModel = computed({
		get: () => page.value ?? 0,
		set: (value: number) => {
			page.value = value;
		},
	});
	const limitModel = computed({
		get: () => limit.value ?? 50,
		set: (value: number) => {
			limit.value = value;
		},
	});

	const items = computed(() => mediaStore.items);
	const total = computed(() => mediaStore.pagination.total);
	const selectedCount = computed(() => selection.value.size);

	async function runSearch (): Promise<void> {
		failed.value = false;
		try {
			await mediaStore.search({
				...(search.value ? { search: search.value } : {}),
				...(serviceId.value ? { serviceId: serviceId.value } : {}),
				...(libraryId.value ? { libraryId: libraryId.value } : {}),
				...(kind.value ? { kind: kind.value } : {}),
				...(states.value?.length ? { states: states.value } : {}),
				sort: (sort.value ?? 'title') as 'title' | 'year' | 'addedAt',
				direction: (direction.value ?? 'asc') as 'asc' | 'desc',
				// The pagination control counts from zero; the API counts from one.
				page: (page.value ?? 0) + 1,
				limit: limit.value ?? 50,
			});
		} catch {
			failed.value = true;
		}
	}

	/** Typing must not fire one search per keystroke; the rest apply immediately. */
	const debouncedSearch = useDebounce(runSearch, 300);

	watch(search, () => {
		page.value = 0;
		void debouncedSearch();
	});

	watch([serviceId, libraryId, kind, states, sort, direction, limit], () => {
		page.value = 0;
		void runSearch();
	});

	watch(page, () => {
		void runSearch();
	});

	onMounted(async () => {
		await Promise.all([
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
		]);
		await runSearch();
	});

	function isSelected (item: MediaItem): boolean {
		return selection.value.has(item.id);
	}

	function toggle (item: MediaItem, value: boolean): void {
		const next = new Set(selection.value);
		if (value) {
			next.add(item.id);
		} else {
			next.delete(item.id);
		}
		selection.value = next;
	}

	function toggleAll (value: boolean): void {
		selection.value = value ? new Set(items.value.map(one => one.id)) : new Set();
	}

	const allSelected = computed(
		() => items.value.length > 0 && items.value.every(one => selection.value.has(one.id)));

	const syncSelected = tryCallback(async () => {
		syncing.value = true;
		try {
			await syncStore.run({ itemIds: [...selection.value] });
			void notify('library.sync_started');
			selection.value = new Set();
		} finally {
			syncing.value = false;
		}
	});
</script>

<template>
	<div class="page-container library">
		<PageHeader
			icon="mdi-bookshelf"
			:loading="mediaStore.loading"
			:subtitle="$t('library.subtitle')"
			:title="$t('pages.library')"
		>
			<template #actions>
				<v-btn
					v-if="selectedCount > 0"
					color="primary"
					data-test="library-sync-selected"
					:loading="syncing"
					prepend-icon="mdi-sync"
					@click="syncSelected"
				>
					{{ $t('library.sync_selected', { count: selectedCount }) }}
				</v-btn>
			</template>
		</PageHeader>

		<v-card>
			<v-card-text>
				<MediaFilters
					v-model:direction="direction"
					v-model:kind="kind"
					v-model:library-id="libraryId"
					v-model:search="search"
					v-model:service-id="serviceId"
					v-model:sort="sort"
					v-model:states="states"
					:libraries="librariesStore.libraries"
					:loading="mediaStore.loading"
					:services="servicesStore.services"
				/>
			</v-card-text>

			<ErrorState v-if="failed" @retry="runSearch" />

			<EmptyState
				v-else-if="!mediaStore.loading && items.length === 0"
				icon="mdi-movie-search-outline"
				:text="$t('library.empty_text')"
				:title="$t('library.empty_title')"
			/>

			<template v-else>
				<v-table class="library_table" data-test="media-list" density="compact">
					<thead>
						<tr>
							<th class="library_selectHead">
								<v-checkbox-btn
									:aria-label="$t('library.select_all')"
									data-test="media-select-all"
									density="compact"
									:model-value="allSelected"
									@update:model-value="toggleAll(!!$event)"
								/>
							</th>

							<th />
							<th>{{ $t('media.column.title') }}</th>
							<th>{{ $t('media.column.kind') }}</th>
							<th class="text-right">{{ $t('media.column.year') }}</th>
							<th>{{ $t('media.column.quality') }}</th>
							<th class="text-right">{{ $t('media.column.size') }}</th>
							<th />
						</tr>
					</thead>

					<tbody>
						<MediaRow
							v-for="item of items"
							:key="item.id"
							:item="item"
							selectable
							:selected="isSelected(item)"
							@update:selected="toggle(item, $event)"
						/>
					</tbody>
				</v-table>

				<Pagination
					v-model:limit="limitModel"
					v-model:page="pageModel"
					:label="$t('components.paginate.table.lines_per_page')"
					:total="total"
				/>
			</template>
		</v-card>
	</div>
</template>

<style lang="scss">
	.library {
		&_table {
			font-size: 13px;
		}

		&_selectHead {
			width: 42px;
		}
	}
</style>
