<script lang="ts" setup>
	import type { MediaGroup, MediaGroupQuery } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import LibrarySection from '@/components/media/LibrarySection.vue';
	import { useViewMode, VIEW_MODES } from '@/composables/useViewMode';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { useServicesStore } from '@/stores/services';

	defineOptions({ name: 'NewReleasesPage' });

	/**
	 * What has come out since, for the shows this household follows.
	 *
	 * Asked for in these words: a series comes up when a new episode has aired and the
	 * series is being watched. Both halves matter — an episode of something nobody here
	 * follows is not news, and a show being followed with nothing new is not either.
	 *
	 * "Watched" is either way of saying it: a sync plan covering the show, or an ask open on
	 * the request source. Nobody writes a plan for a series they have just asked Seerr for,
	 * and a screen that read plans alone would have been empty while the request list was
	 * full — see `MediaGroupQuery.watched`.
	 *
	 * **Two lists, because they are two different decisions.** What is missing is something
	 * to fetch. What is held in a worse copy than exists elsewhere is something to replace,
	 * and it was asked for explicitly that it not be counted among the missing: "if we have
	 * it but in a bad version, that is a version upgrade". Mixing them would put a file that
	 * plays tonight in the same list as one that does not exist here at all.
	 */
	const mediaStore = useMediaStore();

	/**
	 * Drawn the way the library is drawn, because it is the library asking one question.
	 *
	 * It had a list of its own and read as a second product: a bare table of episode names
	 * beside a wall of posters. The band component is the library's own, so the posters,
	 * the states, the quality chips and the grid-or-list preference are the same ones —
	 * and the preference is shared with the library on purpose, since somebody who browses
	 * in rows browses in rows everywhere.
	 */
	const view = useViewMode('mcs.library.view');

	const { t } = useI18n();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();

	/**
	 * Whether anything is still being read in, so an empty wall can say which empty it is.
	 *
	 * The two look identical and mean opposite things: "nothing new for the shows you
	 * follow" is an answer, and "nobody has finished reading your watchlist yet" is a
	 * wait. Shown as a wait, somebody comes back in a minute; shown as an answer, they
	 * conclude the feature does not work — which is what happened.
	 *
	 * Any service, not only the request source: a scan of the media servers moves rows
	 * between held and missing, so this screen is as unfinished during one of those.
	 */
	const scanning = computed(
		() => Object.values(servicesStore.scans).some(one => one !== undefined && !one.done));

	/** Every scan still going, which is what the two figures below are summed over. */
	const running = computed(
		() => Object.values(servicesStore.scans).filter(one => one !== undefined && !one.done));

	/** Rows read so far. */
	const scanned = computed(
		() => running.value.reduce((count, one) => count + (one?.itemsSeen ?? 0), 0));

	/**
	 * Rows expected, or null when nothing can say.
	 *
	 * The gateway reports what the previous scan of each library found — the honest
	 * estimate, since counting first would mean reading the library twice. Null on a first
	 * scan, and null here unless *every* running scan has a figure: summing the ones that
	 * do against the rows of the ones that do not would draw a bar past its own end.
	 */
	const expected = computed(() => {
		const totals = running.value.map(one => one?.itemsTotal ?? null);

		return totals.length > 0 && totals.every(one => one !== null)
			? totals.reduce((count: number, one) => count + (one as number), 0)
			: null;
	});

	/** How far along, as a percentage, capped: last time's count is an estimate. */
	const scannedPercent = computed(() => (expected.value === null || expected.value === 0
		? null
		: Math.min(100, Math.round((scanned.value / expected.value) * 100))));

	const failed = ref(false);
	const loading = ref(false);

	/**
	 * How much of the wall is drawn before somebody asks for more.
	 *
	 * Across every category rather than per category, because the wall is read in one
	 * request now — see `QUERY`. Twice the library's own band, since this is the whole
	 * screen and not one shelf of it.
	 */
	const WALL_LIMIT = 120;

	/**
	 * One band per category, exactly as the library draws its home screen.
	 *
	 * This screen used to ask for episodes and got what it asked for: a flat wall of sixty
	 * episode tiles with no posters, out of any series, out of any category. Seerr hands us
	 * *series* and the episodes are found inside them — so the wall is series, and opening
	 * one is how you reach its seasons and its episodes, like everywhere else.
	 *
	 * That one change answers all three complaints at once. A series carries the poster the
	 * request source named, where a season and an episode carry none. A series is what a
	 * category sorts. And a series with twelve gaps is one card rather than twelve.
	 */
	/**
	 * One read for the whole wall, cut into bands here rather than asked for band by band.
	 *
	 * It used to ask once per category, and on a household with eight of them that was
	 * eight of the most expensive query this product has: `rootsOnly` together with
	 * `actionable` makes the gateway re-read every descendant of the scope and build a
	 * skeleton for each, and doing that eight times over is where ten seconds of a reload
	 * went. The answer is the same wall either way — the categories are a *presentation*
	 * of what came back, and a category a media belongs to is already known here from the
	 * library it sits in.
	 */
	const KEY = 'new-releases';

	const QUERY: MediaGroupQuery = {
		/*
		 * Roots, never episodes. `actionable` is what makes it news rather than a
		 * catalogue: it keeps what has something to fetch or to replace beneath it, and
		 * drops what is complete.
		 */
		rootsOnly: true,
		watched: true,
		actionable: true,
		/*
		 * By the date something came out. For a row nothing holds, that is the only date it
		 * has — the handlers write the air date into `addedAt`, because no server ever
		 * added it. See `RequestsHandler` and `discoverEpisodes`.
		 */
		sort: 'addedAt',
		direction: 'desc',
		limit: WALL_LIMIT,
	};

	async function load (): Promise<void> {
		failed.value = false;
		loading.value = true;

		try {
			await librariesStore.loadCategories();
			await mediaStore.searchGroups(KEY, QUERY);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(load);

	/** Which category each library belongs to, so a group can be filed without asking. */
	const categoryOfLibrary = computed(() => {
		const map = new Map<string, string>();

		for (const category of librariesStore.orderedCategories) {
			for (const libraryId of category.libraryIds) {
				map.set(libraryId, category.key);
			}
		}

		return map;
	});

	const rows = computed<MediaGroup[]>(() => mediaStore.groups[KEY] ?? []);

	/**
	 * The wall, cut into its categories, in the order the library shows them.
	 *
	 * A category with nothing in it is left out rather than drawn as a heading over
	 * nothing, and anything whose library names no category keeps its place at the end:
	 * dropping it would be hiding a media because this screen could not file it.
	 */
	const filled = computed(() => {
		const byCategory = new Map<string, MediaGroup[]>();

		for (const group of rows.value) {
			const key = categoryOfLibrary.value.get(group.libraryId ?? '') ?? '';

			byCategory.set(key, [...(byCategory.get(key) ?? []), group]);
		}

		const bands = librariesStore.orderedCategories
			.filter(one => (byCategory.get(one.key) ?? []).length > 0)
			.map(one => ({ key: one.key, name: one.name, groups: byCategory.get(one.key) ?? [] }));
		const orphans = byCategory.get('') ?? [];

		return orphans.length > 0
			? [...bands, { key: 'other', name: t('news.other'), groups: orphans }]
			: bands;
	});

	const total = computed(() => rows.value.length);
</script>

<template>
	<div class="page-container new-releases">
		<PageHeader
			icon="mdi-new-box"
			:loading="loading"
			:subtitle="$t('news.subtitle')"
			:title="$t('pages.news')"
		>
			<template #actions>
				<!-- The library's own toggle, down to the icons. See `Library.vue`. -->
				<v-btn-toggle
					v-model="view"
					data-test="news-view-toggle"
					density="compact"
					divided
					mandatory
					variant="outlined"
				>
					<v-tooltip
						v-for="mode of VIEW_MODES"
						:key="mode"
						location="bottom"
						:text="$t(`library.view.${mode}`)"
					>
						<template #activator="{ props: tip }">
							<v-btn
								:aria-label="$t(`library.view.${mode}`)"
								:data-test="`news-view-${mode}`"
								:icon="mode === 'grid' ? 'mdi-view-grid' : 'mdi-view-list'"
								size="small"
								:value="mode"
								v-bind="tip"
							/>
						</template>
					</v-tooltip>
				</v-btn-toggle>

				<v-btn
					data-test="news-refresh"
					:loading="loading"
					prepend-icon="mdi-refresh"
					variant="text"
					@click="load"
				>
					{{ $t('actions.refresh') }}
				</v-btn>
			</template>
		</PageHeader>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<!--
				An empty wall during a scan is not an answer, it is a wait, and the two look
				exactly alike. Said as an answer, somebody reads "nothing new" off a screen
				that has not finished reading their watchlist and concludes the feature is
				broken — which is what happened.
			-->
			<EmptyState
				v-if="!loading && total === 0 && scanning"
				data-test="news-scanning"
				icon="mdi-radar"
				:text="scannedPercent === null
					? $t('news.scanning_text', { count: scanned })
					: $t('news.scanning_text_total', { count: scanned, total: expected })"
				:title="$t('news.scanning_title')"
			>
				<!--
					Determinate as soon as anything can say how far along it is, and
					indeterminate when nothing can. A bar that moves against a number is the
					difference between "it is working" and "it is nearly done".
				-->
				<v-progress-linear
					class="mt-4"
					color="primary"
					data-test="news-scanning-progress"
					:indeterminate="scannedPercent === null"
					:model-value="scannedPercent ?? 0"
					rounded
				/>
			</EmptyState>

			<EmptyState
				v-else-if="!loading && total === 0"
				data-test="news-empty"
				icon="mdi-new-box"
				:text="$t('news.empty_text')"
				:title="$t('news.empty_title')"
			/>

			<!--
				One band per category, which is the library's own home screen with one filter
				added. A series carries its poster and its gap count; its seasons and episodes
				are a click away, where they belong.
			-->
			<template v-else>
				<LibrarySection
					v-for="category of filled"
					:key="category.key"
					:data-test="`news-band-${category.key}`"
					:groups="category.groups"
					:loading="loading"
					:title="category.name"
					:total="category.groups.length"
					:view="view"
				/>
			</template>
		</template>
	</div>
</template>

<style lang="scss">
	.new-releases {
		// The bands bring their own spacing; nothing else here needs any.
	}
</style>
