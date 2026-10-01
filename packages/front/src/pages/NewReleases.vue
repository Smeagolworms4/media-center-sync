<script lang="ts" setup>
	import type { MediaGroup } from '@mcs/shared';
	import { MediaKind, SyncState } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import LibrarySection from '@/components/media/LibrarySection.vue';
	import { useViewMode, VIEW_MODES } from '@/composables/useViewMode';
	import { useMediaStore } from '@/stores/media';

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

	const failed = ref(false);
	const loading = ref(false);

	const KEY = 'new-releases';

	async function load (): Promise<void> {
		failed.value = false;
		loading.value = true;

		try {
			await mediaStore.searchGroups(KEY, {
				kind: MediaKind.EPISODE,
				watched: true,
				// Both, in one read: the two lists below are the same query split by state,
				// and asking twice would be two round trips to say one thing.
				states: [SyncState.MISSING, SyncState.OUTDATED],
				/*
				 * By the date the episode came out. For a row nothing holds, that is the only
				 * date it has — the handlers write the air date into `addedAt`, because no
				 * server ever added it. See `RequestsHandler` and `discoverEpisodes`.
				 */
				sort: 'addedAt',
				direction: 'desc',
				limit: 60,
			});
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(load);

	const rows = computed<MediaGroup[]>(() => mediaStore.groups[KEY] ?? []);

	/** Nothing holds it. Something to fetch. */
	const missing = computed(() => rows.value.filter(one => one.sync === SyncState.MISSING));

	/** Held, and somebody has a better copy. Something to replace, which is not the same. */
	const upgrades = computed(() => rows.value.filter(one => one.sync === SyncState.OUTDATED));
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
			<EmptyState
				v-if="!loading && rows.length === 0"
				data-test="news-empty"
				icon="mdi-new-box"
				:text="$t('news.empty_text')"
				:title="$t('news.empty_title')"
			/>

			<template v-else>
				<section v-if="missing.length > 0" data-test="news-missing">
					<p class="text-caption text-medium-emphasis mb-1">{{ $t('news.missing_help') }}</p>

					<LibrarySection
						:groups="missing"
						:loading="loading"
						:title="$t('news.missing', { count: missing.length })"
						:total="missing.length"
						:view="view"
					/>
				</section>

				<!--
					Kept apart, and asked for that way: something held in a worse copy than
					exists elsewhere is not missing. Putting it among the missing would file a
					file that plays tonight beside one that does not exist here at all.
				-->
				<section v-if="upgrades.length > 0" class="mt-4" data-test="news-upgrades">
					<p class="text-caption text-medium-emphasis mb-1">{{ $t('news.upgrades_help') }}</p>

					<LibrarySection
						:groups="upgrades"
						:loading="loading"
						:title="$t('news.upgrades', { count: upgrades.length })"
						:total="upgrades.length"
						:view="view"
					/>
				</section>

				<p
					v-if="rows.length > 0"
					class="text-caption text-medium-emphasis mt-3"
					data-test="news-hint"
				>
					{{ $t('news.hint') }}
					<RelativeDate v-if="rows[0].addedAt" :date="rows[0].addedAt" />
				</p>
			</template>
		</template>
	</div>
</template>

<style lang="scss">
	.new-releases {
		// The bands bring their own spacing; nothing else here needs any.
	}
</style>
