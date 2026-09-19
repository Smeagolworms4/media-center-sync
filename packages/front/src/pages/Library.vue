<script lang="ts" setup>
	import type { Library, MediaGroup, SyncState } from '@mcs/shared';
	import { LibraryKind, MediaKind } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import LibrarySection from '@/components/media/LibrarySection.vue';
	import MediaFilters from '@/components/media/MediaFilters.vue';
	import Pagination from '@/components/paginate/Pagination.vue';
	import { useViewMode } from '@/composables/useViewMode';
	import { useDebounce } from '@/hooks/useDebounce';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'LibraryPage' });

	/**
	 * The library, as a media server draws it: one poster per media, in bands.
	 *
	 * The index keeps a row per service — the same episode on three servers is three
	 * rows — so a table of items showed the same film three times and answered none
	 * of the questions somebody opens this screen with. `GET /media/groups` is the
	 * other view of the same data: one media, with the servers that hold it
	 * underneath, which is what a poster can actually represent.
	 *
	 * **The bands are the registered libraries, not a fixed pair of categories.**
	 * People have `Animes`, `Emissions`, `Documentaires`, `Concerts`, `FilmsHD2` —
	 * whatever they named the folders on their own server. Two hard-wired sections
	 * called Films and Series would fold all of that into two words nobody in that
	 * house uses, and throw away the only labels on this screen that did not come
	 * from us. `LibraryKind` survives as structure — it decides an icon and the shape
	 * of a cover — and is never shown.
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

	interface Band {
		/** What the band is keyed by in the store, and in the address. */
		key: string;
		title: string;
		/** The service this library belongs to, when its name alone is ambiguous. */
		subtitle: string | null;
		libraryId: string | null;
		libraryKind: LibraryKind | null;
	}

	/** The band that ignores the libraries entirely. */
	const ALL_BAND_KEY = 'all';

	/**
	 * What a band shows at its top level, from the library's structure.
	 *
	 * This is the one thing `LibraryKind` is for. Without it a shows library puts
	 * its series, its seasons and every one of its episodes side by side on the
	 * home screen — the wall then has four hundred tiles and none of the hierarchy
	 * the person built on their server. The episodes are not hidden: they are one
	 * click down, under the series that owns them.
	 *
	 * Music and "other" are left unconstrained on purpose. `MediaKind` has no word
	 * for an album, and guessing one would drop a whole library off the screen;
	 * showing what the library reports is wrong in a smaller, visible way.
	 */
	const BAND_KIND: Record<LibraryKind, MediaKind | null> = {
		[LibraryKind.MOVIES]: MediaKind.MOVIE,
		[LibraryKind.SHOWS]: MediaKind.SERIES,
		[LibraryKind.MUSIC]: null,
		[LibraryKind.OTHER]: null,
	};

	/**
	 * How many tiles a band shows before it offers to open on its own.
	 *
	 * A home screen is a glance, not an inventory: paging seven bands at once would
	 * need a page number per band in the address and would still put four hundred
	 * posters in front of somebody who wanted to see what is new.
	 */
	const OVERVIEW_LIMIT = 24;

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
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 60 }));

	/**
	 * Browsing across every library, for the moment somebody is looking for one
	 * title and does not want to guess which of their three series libraries it
	 * landed in. In the address, because that is a view worth linking to.
	 */
	const everything = queryRef<boolean>('all', queryTypes.boolean());

	const view = useViewMode('mcs.library.view');

	const failed = ref(false);
	const selection = ref<Set<string>>(new Set());
	const selecting = ref(false);
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
		get: () => limit.value ?? 60,
		set: (value: number) => {
			limit.value = value;
		},
	});

	/** The libraries this wall draws a band for, narrowed by the service filter. */
	const shownLibraries = computed<Library[]>(() => (serviceId.value
		? librariesStore.libraries.filter(one => one.serviceId === serviceId.value)
		: librariesStore.libraries));

	/**
	 * Library names are not unique: two media servers both call theirs `Movies`,
	 * and a band headed twice by the same word is two bands nobody can tell apart.
	 * The service name is added only where it settles that, because on the common
	 * single-server gateway it would be the same line repeated under every heading.
	 */
	const ambiguousNames = computed(() => {
		const seen = new Map<string, number>();
		for (const library of shownLibraries.value) {
			seen.set(library.name, (seen.get(library.name) ?? 0) + 1);
		}
		return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name));
	});

	function bandOf (library: Library): Band {
		return {
			key: library.id,
			title: library.name,
			subtitle: ambiguousNames.value.has(library.name)
				? servicesStore.byId[library.serviceId]?.name ?? null
				: null,
			libraryId: library.id,
			libraryKind: library.kind,
		};
	}

	/**
	 * One band per library, or the single band a chosen library — or the everything
	 * switch — narrows the wall down to.
	 */
	const bands = computed<Band[]>(() => {
		const chosen = libraryId.value
			? librariesStore.byId[libraryId.value]
			: null;
		if (chosen) {
			return [bandOf(chosen)];
		}
		if (libraryId.value || everything.value) {
			// A library identifier this browser has not loaded is still a filter worth
			// honouring: the address may have been sent by somebody who can see it.
			return [{
				key: ALL_BAND_KEY,
				title: '',
				subtitle: null,
				libraryId: libraryId.value,
				libraryKind: null,
			}];
		}
		return shownLibraries.value.map(one => bandOf(one));
	});

	/** One band, and it is paginated: a chosen library, or everything at once. */
	const focused = computed(() => Boolean(libraryId.value) || everything.value === true);

	// One library chosen wins over the switch, so the switch must not claim to be on
	// while a single library is on screen.
	const showingEverything = computed(() => everything.value === true && !libraryId.value);

	function kindOf (band: Band): MediaKind | null {
		return kind.value ?? (band.libraryKind ? BAND_KIND[band.libraryKind] : null);
	}

	function groupsOf (band: Band): MediaGroup[] {
		return mediaStore.groups[band.key] ?? [];
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
		() => librariesStore.loaded && librariesStore.libraries.length === 0);

	const nothingAtAll = computed(() => {
		if (mediaStore.groupsLoading || bands.value.length === 0) {
			return false;
		}
		return bands.value.every(band => totalOf(band) === 0);
	});

	async function runSearch (): Promise<void> {
		failed.value = false;
		const filters = {
			...(search.value ? { search: search.value } : {}),
			...(serviceId.value ? { serviceId: serviceId.value } : {}),
			...(states.value?.length ? { states: states.value } : {}),
			sort: (sort.value ?? 'title') as 'title' | 'year' | 'addedAt',
			direction: (direction.value ?? 'asc') as 'asc' | 'desc',
		};
		try {
			await Promise.all(bands.value.map(band => mediaStore.searchGroups(band.key, {
				...filters,
				...(band.libraryId ? { libraryId: band.libraryId } : {}),
				// The structural default, unless somebody asked for a kind by hand.
				...(kindOf(band) ? { kind: kindOf(band)! } : {}),
				// The pagination control counts from zero; the API counts from one.
				page: focused.value ? (page.value ?? 0) + 1 : 1,
				limit: focused.value ? (limit.value ?? 60) : OVERVIEW_LIMIT,
			})));
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

	watch([libraryId, everything, serviceId], () => {
		// The bands about to be drawn are not the ones on screen, and a band nobody
		// is looking at must not keep answering with what it held for another filter.
		mediaStore.clearGroups();
		page.value = 0;
		void runSearch();
	});

	watch([kind, states, sort, direction, limit], () => {
		page.value = 0;
		void runSearch();
	});

	watch(page, () => {
		void runSearch();
	});

	onMounted(async () => {
		// The bands are the libraries, so there is nothing to ask for until they are
		// known: searching first would fire one call for a wall of no bands.
		await Promise.all([
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
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
		// rather than navigates. Anything else means a second tile opens a page and
		// the first choice is silently lost.
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

	function seeAll (band: Band): void {
		libraryId.value = band.libraryId;
	}

	function browseEverything (value: boolean): void {
		// Choosing to see everything and having chosen one library are the same
		// switch pointed two ways; leaving the identifier behind would show one
		// library under a heading that says everything.
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

		<v-card class="library_toolbar mb-5" variant="tonal">
			<v-card-text class="py-3">
				<MediaFilters
					v-model:direction="direction"
					v-model:kind="kind"
					v-model:library-id="libraryId"
					v-model:search="search"
					v-model:service-id="serviceId"
					v-model:sort="sort"
					v-model:states="states"
					:libraries="librariesStore.libraries"
					:loading="mediaStore.groupsLoading"
					:services="servicesStore.services"
				/>

				<!--
					Browsing by library is the default because that is how the media is
					organised on the server it came from. The switch is for the other
					question — "where is that one title" — which nobody should have to
					answer by opening three series libraries in turn.
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
				:groups="groupsOf(band)"
				:library-id="band.libraryId"
				:library-kind="band.libraryKind"
				:loading="mediaStore.groupsLoading"
				:selecting="selecting"
				:selection="selection"
				:subtitle="band.subtitle"
				:title="band.title || $t('library.everything')"
				:total="totalOf(band)"
				:truncated="truncated(band)"
				:view="view"
				@see-all="seeAll(band)"
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
			The selection bar is what makes picking on a poster wall workable: a grid
			has no row to put a checkbox in and no header to count from, so the count,
			the select-all and the action live in one bar that appears with the first
			tile picked and follows the page down.
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
