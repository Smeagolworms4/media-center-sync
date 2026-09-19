<script lang="ts" setup>
	import type { TrailStep } from '@/composables/useMediaTrail';
	import type { LibraryKind, MediaCategory, MediaGroup, MediaGroupQuery, SyncState } from '@mcs/shared';
	import { MediaKind, MediaOrigin } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import LibrarySection from '@/components/media/LibrarySection.vue';
	import MediaBreadcrumb from '@/components/media/MediaBreadcrumb.vue';
	import MediaFilters from '@/components/media/MediaFilters.vue';
	import Pagination from '@/components/paginate/Pagination.vue';
	import { useViewMode } from '@/composables/useViewMode';
	import { useDebounce } from '@/hooks/useDebounce';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'LibraryPage' });

	/**
	 * The library, as a media server draws it: one poster per media, in bands.
	 *
	 * The index keeps a row per service — the same episode on three servers is three
	 * rows — so a table of items showed the same film three times and answered none of
	 * the questions somebody opens this screen with. `GET /media/groups` is the other
	 * view of the same data: one media, with the servers that hold it underneath,
	 * which is what a poster can actually represent.
	 *
	 * **The bands are categories: libraries of the same name, merged.** A household
	 * with two servers has two libraries called `Shows`, and a friend makes a third;
	 * they are one thing to whoever is looking at them, and three bands under the same
	 * word shows somebody the plumbing rather than their media. The words are still
	 * theirs — `Animes`, `Emissions`, `FilmsHD` — because they are the only labels on
	 * this screen that did not come from us. `LibraryKind` survives as structure — it
	 * decides an icon and the shape of a cover — and is never shown.
	 *
	 * The home screen is a glance at what is new: each band is the latest additions of
	 * its category, and opening one paginates everything in it. That is why the counts
	 * are the category's own totals rather than what fits on the row.
	 *
	 * Every filter lives in the URL rather than in component state: a filtered view is
	 * then a link somebody can send — "here is what I am missing from that series" —
	 * and it survives the reload that follows starting a sync from it.
	 */
	const mediaStore = useMediaStore();
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const peersStore = usePeersStore();
	const syncStore = useSyncStore();
	const { notify, tryCallback } = useNotifier();
	const { t } = useI18n();

	interface Band {
		/** What the band is keyed by in the store, and in the address. */
		key: string;
		title: string;
		/** What settles a heading the name alone does not. */
		subtitle: string | null;
		categoryKey: string | null;
		libraryId: string | null;
		libraryKind: LibraryKind | null;
		local: boolean;
	}

	/** The band that ignores the categories entirely. */
	const ALL_BAND_KEY = 'all';

	/**
	 * How many tiles a band shows before it offers to open on its own.
	 *
	 * A home screen is a glance, not an inventory: paging seven bands at once would
	 * need a page number per band in the address and would still put four hundred
	 * posters in front of somebody who wanted to see what is new.
	 */
	const OVERVIEW_LIMIT = 24;

	const search = queryRef<string>('search');
	/** The merged category, which is what a band filters on. */
	const category = queryRef<string>('category');
	const serviceIds = queryRef<string[]>('serviceIds', queryTypes.delimitedArray<string>());
	const origins = queryRef<MediaOrigin[]>('origins', queryTypes.delimitedArray<MediaOrigin>({
		itemParse: value => value as MediaOrigin,
		validate: values => values.every(
			one => (Object.values(MediaOrigin) as string[]).includes(one)),
	}));
	/** One library, which is the diagnostic question rather than the browsing one. */
	const libraryId = queryRef<string>('libraryId');
	const kind = queryRef<MediaKind>('kind', queryTypes.stringEnum({ values: Object.values(MediaKind) }));
	const states = queryRef<SyncState[]>('states', queryTypes.delimitedArray<SyncState>({
		itemParse: value => value as SyncState,
	}));
	const sort = queryRef<string>('sort', queryTypes.string({ defaultValue: 'title' }));
	const direction = queryRef<string>('direction', queryTypes.string({ defaultValue: 'asc' }));
	const page = queryRef<number>('page', queryTypes.integer({ defaultValue: 0 }));
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 60 }));

	/**
	 * Browsing across every category, for the moment somebody is looking for one title
	 * and does not want to guess which category it landed in. In the address, because
	 * that is a view worth linking to.
	 */
	const everything = queryRef<boolean>('all', queryTypes.boolean());

	const view = useViewMode('mcs.library.view');

	const failed = ref(false);
	const selection = ref<Set<string>>(new Set());
	const selecting = ref(false);
	const syncing = ref(false);

	/**
	 * The pagination control works on plain numbers while a query parameter is always
	 * nullable — an address with no `page` in it is the first page.
	 */
	const pageModel = computed({
		get: () => page.value ?? 0,
		set: (value: number) => {
			page.value = value;
		},
	});
	const limitModel = computed({
		get: () => limit.value ?? 60,
		set: (value: number) => {
			limit.value = value;
		},
	});

	function bandOfCategory (one: MediaCategory): Band {
		return {
			key: one.key,
			title: one.name,
			subtitle: null,
			categoryKey: one.key,
			libraryId: null,
			libraryKind: one.kind,
			local: one.local,
		};
	}

	/**
	 * One band per category, or the single band that an opened category — a chosen
	 * library, or the everything switch — narrows the wall down to.
	 */
	const bands = computed<Band[]>(() => {
		if (category.value) {
			const chosen = librariesStore.categoryByKey[category.value] ?? null;
			return [{
				// A category key this browser has not loaded is still a filter worth
				// honouring: the address may have been sent by somebody who can see it.
				...(chosen
					? bandOfCategory(chosen)
					: {
						key: category.value,
						title: category.value,
						subtitle: null,
						categoryKey: category.value,
						libraryKind: null,
						local: false,
					}),
				key: category.value,
				// A library chosen inside an opened category narrows it further, which is
				// how somebody asks which of the two servers actually holds this.
				libraryId: libraryId.value,
			}];
		}
		if (libraryId.value || everything.value) {
			const library = libraryId.value ? librariesStore.byId[libraryId.value] : null;
			return [{
				key: ALL_BAND_KEY,
				title: library?.name ?? '',
				subtitle: library ? servicesStore.byId[library.serviceId]?.name ?? null : null,
				categoryKey: null,
				libraryId: libraryId.value,
				libraryKind: library?.kind ?? null,
				local: false,
			}];
		}
		return librariesStore.orderedCategories.map(one => bandOfCategory(one));
	});

	/** One band, and it is paginated: an opened category, one library, or everything. */
	const focused = computed(
		() => Boolean(category.value) || Boolean(libraryId.value) || everything.value === true);

	// An opened category wins over the switch, so the switch must not claim to be on
	// while one category is on screen.
	const showingEverything = computed(
		() => everything.value === true && !category.value && !libraryId.value);

	/**
	 * What a band shows of the whole tree.
	 *
	 * Roots — a series, a film, a collection — unless somebody asked for a kind by
	 * hand, in which case they asked for exactly that and every episode is the answer.
	 * Derived from the library's kind this used to break on anything that is neither
	 * films nor shows: a library of concerts or audiobooks has no kind this model
	 * names, and its parents and its children ended up side by side on the same wall.
	 */
	const rootsOnly = computed(() => !kind.value);

	/**
	 * A media filed in two categories belongs to the first of them.
	 *
	 * The categories are already in the order that settles it — lowest position, ours
	 * before a friend's — so the first band to show a media keeps it and the later ones
	 * do not repeat it. Without this a series filed in both `Shows` and `Animes` is two
	 * posters on one screen, and somebody syncing from the wall picks it twice.
	 *
	 * Matched on the identity of the media rather than on the group identifier alone: a
	 * group is computed per query, so the same media answered under two categories can
	 * come back represented by two different copies. The title, the kind and the
	 * numbering are what make it the same thing to a person.
	 */
	const deduplicated = computed<Record<string, MediaGroup[]>>(() => {
		const result: Record<string, MediaGroup[]> = {};
		const seen = new Set<string>();
		for (const band of bands.value) {
			const held = mediaStore.groups[band.key] ?? [];
			if (focused.value) {
				result[band.key] = held;
				continue;
			}
			const kept: MediaGroup[] = [];
			for (const one of held) {
				const signature = [
					one.kind,
					one.normalizedTitle || one.title,
					one.year ?? '',
					one.seasonNumber ?? '',
					one.episodeNumber ?? '',
				].join('|');
				if (seen.has(one.id) || seen.has(signature)) {
					continue;
				}
				seen.add(one.id);
				seen.add(signature);
				kept.push(one);
			}
			result[band.key] = kept;
		}
		return result;
	});

	function groupsOf (band: Band): MediaGroup[] {
		return deduplicated.value[band.key] ?? [];
	}

	function totalOf (band: Band): number {
		return mediaStore.groupPagination[band.key]?.total ?? 0;
	}

	function truncated (band: Band): boolean {
		return !focused.value && totalOf(band) > groupsOf(band).length;
	}

	const displayed = computed(() => bands.value.flatMap(band => groupsOf(band)));
	const total = computed(() => (focused.value ? totalOf(bands.value[0]) : 0));
	const selectedCount = computed(() => selection.value.size);

	/** A gateway with no library at all is a real state, and not an empty search. */
	const noLibrary = computed(
		() => librariesStore.categoriesLoaded && librariesStore.categories.length === 0);

	const nothingAtAll = computed(() => {
		if (mediaStore.groupsLoading || bands.value.length === 0) {
			return false;
		}
		return bands.value.every(band => totalOf(band) === 0);
	});

	/**
	 * Where the wall is, in the words the wall itself uses.
	 *
	 * Two steps at most here — the library, then the category — because that is as
	 * deep as this screen goes; the item page carries the rest of the same trail.
	 */
	const trail = computed<TrailStep[]>(() => {
		const steps: TrailStep[] = [
			{ key: 'root', label: t('pages.library'), to: { name: 'library' } },
		];
		if (category.value) {
			steps.push({
				key: `category-${category.value}`,
				label: librariesStore.categoryByKey[category.value]?.name ?? category.value,
				to: null,
			});
			return steps;
		}
		if (showingEverything.value) {
			steps.push({ key: 'everything', label: t('library.everything'), to: null });
			return steps;
		}
		if (libraryId.value) {
			steps.push({
				key: `library-${libraryId.value}`,
				label: librariesStore.byId[libraryId.value]?.name ?? t('media.filter.library'),
				to: null,
			});
		}
		return steps;
	});

	function queryOf (band: Band): MediaGroupQuery {
		return {
			...(search.value ? { search: search.value } : {}),
			...(serviceIds.value?.length ? { serviceIds: serviceIds.value } : {}),
			...(origins.value?.length ? { origins: origins.value } : {}),
			...(states.value?.length ? { states: states.value } : {}),
			...(band.categoryKey ? { categoryKey: band.categoryKey } : {}),
			...(band.libraryId ? { libraryId: band.libraryId } : {}),
			...(kind.value ? { kind: kind.value } : {}),
			...(rootsOnly.value ? { rootsOnly: true } : {}),
			// A band of the home screen is what is new in that category; an opened one
			// is a list somebody is working through, and there the order is theirs.
			sort: (focused.value ? sort.value ?? 'title' : 'addedAt') as 'title' | 'year' | 'addedAt',
			direction: (focused.value ? direction.value ?? 'asc' : 'desc') as 'asc' | 'desc',
			// The pagination control counts from zero; the API counts from one.
			page: focused.value ? (page.value ?? 0) + 1 : 1,
			limit: focused.value ? (limit.value ?? 60) : OVERVIEW_LIMIT,
		};
	}

	async function runSearch (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all(bands.value.map(band => mediaStore.searchGroups(band.key, queryOf(band))));
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

	watch([category, libraryId, everything], () => {
		// The bands about to be drawn are not the ones on screen, and a band nobody is
		// looking at must not keep answering with what it held for another filter.
		mediaStore.clearGroups();
		page.value = 0;
		void runSearch();
	});

	watch([serviceIds, origins, kind, states, sort, direction, limit], () => {
		page.value = 0;
		void runSearch();
	});

	watch(page, () => {
		void runSearch();
	});

	onMounted(async () => {
		// The bands are the categories, so there is nothing to ask for until they are
		// known: searching first would fire one call for a wall of no bands. The peers
		// come along because a card cannot tell a friend from a friend of a friend
		// without them, and a mark that changes meaning a second later is worse than
		// one that waits.
		await Promise.all([
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			librariesStore.categoriesLoaded
				? Promise.resolve()
				: librariesStore.loadCategories().catch(() => undefined),
			peersStore.loaded ? Promise.resolve() : peersStore.load().catch(() => undefined),
		]);
		await runSearch();
	});

	function toggle (id: string, value: boolean): void {
		const next = new Set(selection.value);
		if (value) {
			next.add(id);
		} else {
			next.delete(id);
		}
		selection.value = next;
		// Picking one tile puts the wall into selection mode, so the next click picks
		// rather than navigates. Anything else means a second tile opens a page and the
		// first choice is silently lost.
		if (next.size > 0) {
			selecting.value = true;
		}
	}

	function toggleAll (value: boolean): void {
		selection.value = value ? new Set(displayed.value.map(one => one.id)) : new Set();
	}

	function clearSelection (): void {
		selection.value = new Set();
		selecting.value = false;
	}

	const allSelected = computed(
		() => displayed.value.length > 0 && displayed.value.every(one => selection.value.has(one.id)));

	function openBand (band: Band): void {
		// Opening a band is opening its category, not one of the libraries it merged:
		// the whole point of the merge is that which server holds what is a question
		// for later, and the library filter is still there to ask it.
		everything.value = null;
		category.value = band.categoryKey;
		libraryId.value = band.libraryId;
	}

	function browseEverything (value: boolean): void {
		// Choosing to see everything and having opened one category are the same switch
		// pointed two ways; leaving the key behind would show one category under a
		// heading that says everything.
		category.value = null;
		libraryId.value = null;
		everything.value = value;
	}

	const syncSelected = tryCallback(async () => {
		syncing.value = true;
		try {
			await syncStore.run({ itemIds: [...selection.value] });
			void notify('library.sync_started');
			clearSelection();
		} finally {
			syncing.value = false;
		}
	});
</script>

<template>
	<div
		class="page-container library"
		:class="{ 'library--selecting': selecting || selectedCount > 0 }"
	>
		<PageHeader
			icon="mdi-bookshelf"
			:loading="mediaStore.groupsLoading"
			:subtitle="$t('library.subtitle')"
			:title="$t('pages.library')"
		>
			<template #actions>
				<v-btn
					data-test="library-select-mode"
					:prepend-icon="selecting
						? 'mdi-checkbox-multiple-marked-outline'
						: 'mdi-checkbox-multiple-blank-outline'"
					size="small"
					:variant="selecting ? 'tonal' : 'text'"
					@click="selecting ? clearSelection() : selecting = true"
				>
					{{ $t('library.select') }}
				</v-btn>

				<v-btn-toggle
					v-model="view"
					data-test="library-view-toggle"
					density="compact"
					mandatory
					variant="outlined"
				>
					<v-btn
						:aria-label="$t('library.view.grid')"
						data-test="library-view-grid"
						icon="mdi-view-grid-outline"
						size="small"
						value="grid"
					/>

					<v-btn
						:aria-label="$t('library.view.list')"
						data-test="library-view-list"
						icon="mdi-format-list-bulleted"
						size="small"
						value="list"
					/>
				</v-btn-toggle>
			</template>
		</PageHeader>

		<MediaBreadcrumb :steps="trail" />

		<v-card class="library_toolbar mb-5" variant="tonal">
			<v-card-text class="py-3">
				<MediaFilters
					v-model:direction="direction"
					v-model:kind="kind"
					v-model:library-id="libraryId"
					v-model:origins="origins"
					v-model:search="search"
					v-model:service-ids="serviceIds"
					v-model:sort="sort"
					v-model:states="states"
					:libraries="librariesStore.libraries"
					:loading="mediaStore.groupsLoading"
					:services="servicesStore.services"
					:sortable="focused"
				/>

				<!--
					Browsing by category is the default because that is how the media is
					organised for the person looking at it. The switch is for the other
					question — "where is that one title" — which nobody should have to
					answer by opening three categories in turn.
				-->
				<v-switch
					class="library_everything mt-1"
					color="primary"
					data-test="library-everything"
					density="compact"
					hide-details
					:label="$t('library.everything')"
					:model-value="showingEverything"
					@update:model-value="browseEverything(!!$event)"
				/>
			</v-card-text>
		</v-card>

		<ErrorState v-if="failed" @retry="runSearch" />

		<EmptyState
			v-else-if="noLibrary"
			icon="mdi-bookshelf"
			:text="$t('library.empty_service_text')"
			:title="$t('library.empty_service_title')"
		/>

		<EmptyState
			v-else-if="nothingAtAll"
			icon="mdi-movie-search-outline"
			:text="$t('library.empty_text')"
			:title="$t('library.empty_title')"
		/>

		<template v-else>
			<LibrarySection
				v-for="band of bands"
				:key="band.key"
				:category-key="band.categoryKey"
				:groups="groupsOf(band)"
				:latest="!focused"
				:library-id="band.libraryId"
				:library-kind="band.libraryKind"
				:loading="mediaStore.groupsLoading"
				:local="band.local"
				:selecting="selecting"
				:selection="selection"
				:subtitle="band.subtitle"
				:title="band.title || $t('library.everything')"
				:total="totalOf(band)"
				:truncated="truncated(band)"
				:view="view"
				@see-all="openBand(band)"
				@update:selected="toggle"
			/>

			<Pagination
				v-if="focused"
				v-model:limit="limitModel"
				v-model:page="pageModel"
				:label="$t('components.paginate.table.lines_per_page')"
				:total="total"
			/>
		</template>

		<!--
			The selection bar is what makes picking on a poster wall workable: a grid has
			no row to put a checkbox in and no header to count from, so the count, the
			select-all and the action live in one bar that appears with the first tile
			picked and follows the page down.
		-->
		<div
			v-if="selecting || selectedCount > 0"
			class="library_selectionBar"
			data-test="library-selection-bar"
		>
			<v-checkbox-btn
				:aria-label="$t('library.select_all')"
				data-test="media-select-all"
				density="compact"
				:model-value="allSelected"
				@update:model-value="toggleAll(!!$event)"
			/>

			<span class="text-body-2">
				{{ $t('library.selected_count', { count: selectedCount }, selectedCount) }}
			</span>

			<v-spacer />

			<v-btn
				data-test="library-selection-clear"
				size="small"
				variant="text"
				@click="clearSelection"
			>
				{{ $t('actions.cancel') }}
			</v-btn>

			<v-btn
				color="primary"
				data-test="library-sync-selected"
				:disabled="selectedCount === 0"
				:loading="syncing"
				prepend-icon="mdi-sync"
				size="small"
				@click="syncSelected"
			>
				{{ $t('library.sync_selected', { count: selectedCount }) }}
			</v-btn>
		</div>
	</div>
</template>

<style lang="scss">
	.library {
		// The selection bar floats over the bottom of the wall; without this the last
		// row of posters sits underneath it and cannot be picked at all.
		&--selecting {
			padding-bottom: 64px;
		}

		&_toolbar {
			background: rgba(var(--v-theme-surface-light), 0.5);
		}

		&_everything {
			display: inline-flex;
		}

		&_selectionBar {
			position: sticky;
			bottom: 12px;
			z-index: 4;
			display: flex;
			align-items: center;
			gap: 10px;
			margin-top: 16px;
			padding: 8px 12px;
			border-radius: 10px;
			background: rgb(var(--v-theme-surface-light));
			box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);

			.v-selection-control {
				flex: 0 0 auto;
			}
		}
	}
</style>
