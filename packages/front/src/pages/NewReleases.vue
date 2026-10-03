<script lang="ts" setup>
	import type { MediaGroup, MediaGroupQuery } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
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

	/**
	 * What a running scan has got through, when it says. Null while it has no total to
	 * measure against, which is most of a scan's life — a bar that jumped from nothing to
	 * eighty would be worse than a spinner that says it is working.
	 */
	const scanned = computed(() => {
		const running = Object.values(servicesStore.scans).filter(one => one && !one.done);

		return running.reduce((count, one) => count + (one?.itemsSeen ?? 0), 0);
	});

	const failed = ref(false);
	const loading = ref(false);

	/**
	 * How many of each category the wall shows before somebody opens it.
	 *
	 * The library's own number, because this is the library's own wall asking one
	 * question, and a band that scrolled differently here would read as another product.
	 */
	const BAND_LIMIT = 60;

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
	const bands = computed(() => librariesStore.orderedCategories);

	function queryOf (category: { key: string }): MediaGroupQuery {
		return {
			categoryKey: category.key,
			/*
			 * Roots, never episodes. `actionable` is what makes it news rather than a
			 * catalogue: it keeps the series that have something to fetch or to replace
			 * beneath them, and drops the ones that are complete.
			 */
			rootsOnly: true,
			watched: true,
			actionable: true,
			/*
			 * By the date something came out. For a row nothing holds, that is the only date
			 * it has — the handlers write the air date into `addedAt`, because no server
			 * ever added it. See `RequestsHandler` and `discoverEpisodes`.
			 */
			sort: 'addedAt',
			direction: 'desc',
			limit: BAND_LIMIT,
		};
	}

	async function load (): Promise<void> {
		failed.value = false;
		loading.value = true;

		try {
			await librariesStore.loadCategories();
			await Promise.all(
				bands.value.map(category => mediaStore.searchGroups(category.key, queryOf(category))),
			);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(load);

	function groupsOf (key: string): MediaGroup[] {
		return mediaStore.groups[key] ?? [];
	}

	/** Categories with something to show, so an empty shelf is not a heading over nothing. */
	const filled = computed(() => bands.value.filter(one => groupsOf(one.key).length > 0));

	const total = computed(
		() => filled.value.reduce((count, one) => count + groupsOf(one.key).length, 0));
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
				<v-btn-toggle
					v-model="view"
					data-test="news-view-toggle"
					density="compact"
					mandatory
					variant="outlined"
				>
					<v-btn
						v-for="mode of VIEW_MODES"
						:key="mode"
						:data-test="`news-view-${mode}`"
						:icon="mode === 'grid' ? 'mdi-view-grid-outline' : 'mdi-format-list-bulleted'"
						size="small"
						:value="mode"
					/>
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
				:text="$t('news.scanning_text', { count: scanned })"
				:title="$t('news.scanning_title')"
			>
				<v-progress-linear class="mt-4" color="primary" indeterminate rounded />
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
					:groups="groupsOf(category.key)"
					:loading="loading"
					:title="category.name"
					:total="groupsOf(category.key).length"
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
