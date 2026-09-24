<script lang="ts" setup>
	import type { ReleaseGroup, ReleaseSearchResult, RequestSuggestion } from '@mcs/shared';
	import { isIndexerSuggestion, MediaKind, ReleaseSearchKind } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useReleasesStore } from '@/stores/releases';

	/**
	 * The search a request implies, run because somebody pressed it.
	 *
	 * This is the whole of the pre-search: the gateway worked out what it would look for
	 * and handed it over, and nothing happens until this panel is opened and the button
	 * used. That is deliberate and it is the feature's one hard rule — an ask on somebody
	 * else's Seerr must not be able to spend this gateway's disk or fan a query out to a
	 * dozen trackers.
	 *
	 * Nothing here can be fetched either, and that is not an omission. A grab files its
	 * file under one of our media rows, and a request for something no library of ours
	 * holds has none — which is exactly what a request usually is. So the lines are shown
	 * as what they are, names on a tracker, and the copy is taken from the media page
	 * where there is somewhere for it to land.
	 */
	const props = defineProps<{ suggestion: RequestSuggestion | null; title: string | null }>();

	const open = defineModel<boolean>({ default: false });

	const releases = useReleasesStore();
	const { tryCallback } = useNotifier();

	/** The suggested term, editable: a tracker knows some works under another title. */
	const term = ref('');
	/**
	 * Which season to ask for, because an indexer is asked for one at a time.
	 *
	 * A request for four missing seasons is four searches, and collapsing them into one
	 * query returns whatever a tracker makes of a sentence naming four numbers.
	 */
	const season = ref<number | null>(null);
	/**
	 * The answer this panel got, held here rather than read from the store.
	 *
	 * The store keeps one result at a time for the media page that asked, and a term
	 * search has no media to key it by — so reading it back would show whatever the last
	 * media page searched for, under a title from this list.
	 */
	const found = ref<ReleaseSearchResult | null>(null);

	/**
	 * The tracker half of what came back, which here is all of it.
	 *
	 * A search from this panel names no media of ours — that is what a request for
	 * something nobody here holds means — and a peer copy is only ever raised against a
	 * media row, so the union cannot contain one. Filtering rather than trusting that:
	 * were a peer row ever to arrive, this panel is the wrong screen for it, because
	 * pulling a copy is done where the copy has somewhere to land.
	 */
	const results = computed<ReleaseGroup[]>(() =>
		(found.value?.suggestions ?? [])
			.filter(isIndexerSuggestion)
			.map(suggestion => suggestion.release),
	);

	const seasons = computed(() => props.suggestion?.seasonNumbers ?? []);

	const isShow = computed(() => props.suggestion?.kind === MediaKind.SERIES);

	/*
	 * The term arrives from the gateway unchanged and is not rebuilt from the row's
	 * title: the suggestion is the one thing on the view that was worked out for the
	 * purpose, and a screen that re-derived it would search for something the gateway
	 * did not propose.
	 */
	watch(() => props.suggestion, suggestion => {
		term.value = suggestion?.term ?? '';
		season.value = suggestion?.seasonNumbers[0] ?? null;
		found.value = null;
	}, { immediate: true });

	const seasonItems = computed(() => seasons.value.map(number => ({
		'value': number,
		'title': String(number),
		'data-test': 'request-search-season-option',
	})));

	const run = tryCallback(async () => {
		found.value = await releases.search({
			term: term.value.trim(),
			/*
			 * Which categories to ask for, and it is not optional in practice.
			 *
			 * A free-text search that does not say is a search of the television
			 * categories, so a film asked for in Seerr would be looked for among the
			 * shows: the indexer answers an empty list, perfectly successfully, and the
			 * screen says nothing was found. That is the failure this whole feature keeps
			 * producing, and here it would be blamed on the tracker.
			 */
			kind: isShow.value ? ReleaseSearchKind.SHOW : ReleaseSearchKind.MOVIE,
			// A season pack rather than an episode: a request is for a season or a whole
			// show, and nobody asking in Seerr is asking for one episode of one.
			...(isShow.value && season.value !== null
				? { seasonNumber: season.value, seasonPack: true }
				: {}),
		});
	});
</script>

<template>
	<Window v-model="open" max-width="760" :title="$t('request.search_title')">
		<div class="request-search" data-test="request-search-dialog">
			<p class="text-body-2 mb-1" data-test="request-search-for">
				{{ title ?? $t('request.unnamed') }}
			</p>

			<p class="text-caption text-medium-emphasis">{{ $t('request.search_intro') }}</p>

			<div class="request-search_controls">
				<v-text-field
					v-model="term"
					data-test="request-search-term"
					density="compact"
					hide-details
					:label="$t('release.term')"
				/>

				<v-select
					v-if="isShow && seasons.length > 0"
					v-model="season"
					data-test="request-search-season"
					density="compact"
					hide-details
					:items="seasonItems"
					:label="$t('request.search_season')"
				/>

				<v-btn
					color="primary"
					data-test="request-search-run"
					:disabled="term.trim().length === 0"
					:loading="releases.searching"
					prepend-icon="mdi-magnify"
					@click="run"
				>
					{{ $t('release.search') }}
				</v-btn>
			</div>

			<p
				v-if="found"
				class="text-caption text-medium-emphasis mt-2 mb-0"
				data-test="request-search-asked"
			>
				{{ $t('release.asked', { query: found.query }) }}
			</p>

			<!--
				An indexer that did not answer is named rather than shown as an empty list:
				"nothing found" and "nobody answered" are opposite answers, and showing the
				first for the second sends somebody hunting for better words while their
				key is wrong.
			-->
			<p
				v-for="failure of found?.failed ?? []"
				:key="failure.indexer"
				class="text-caption text-warning mt-1 mb-0"
				data-test="request-search-failed"
			>
				{{ $t('release.failed', { indexer: failure.indexer }) }}
			</p>

			<div v-if="results.length > 0" class="request-search_results mt-3">
				<div
					v-for="one of results"
					:key="one.key"
					class="request-search_row"
					data-test="request-search-result"
				>
					<span class="request-search_name">{{ one.title }}</span>

					<div class="request-search_marks">
						<v-chip v-if="one.quality" label size="x-small" variant="tonal">
							{{ one.quality }}
						</v-chip>

						<span v-if="(one.size ?? 0) > 0" class="text-caption text-medium-emphasis">
							<ByteSize :bytes="one.size" />
						</span>

						<span class="text-caption text-medium-emphasis">
							{{ $t('release.seeders', { count: one.seeders ?? 0 }) }}
						</span>
					</div>
				</div>

				<p class="text-caption text-medium-emphasis mt-2 mb-0" data-test="request-search-no-grab">
					{{ $t('request.search_no_grab') }}
				</p>
			</div>

			<p
				v-else-if="found && !releases.searching"
				class="text-caption text-medium-emphasis mt-3 mb-0"
				data-test="request-search-empty"
			>
				{{ $t('release.none') }}
			</p>
		</div>

		<template #actions>
			<v-spacer />

			<v-btn data-test="request-search-close" variant="text" @click="open = false">
				{{ $t('actions.close') }}
			</v-btn>
		</template>
	</Window>
</template>

<style lang="scss">
	.request-search {
		&_controls {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 12px;

			.v-text-field {
				min-width: 220px;
				flex: 1 1 260px;
			}

			.v-select {
				max-width: 140px;
			}
		}

		&_row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-wrap: wrap;
			gap: 8px;
			padding: 6px 0;
			border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
		}

		&_marks {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 6px;
		}

		&_name {
			// A release name is long, has no spaces and is the thing being read: it has to
			// break rather than push the marks off the row.
			font-family: monospace;
			font-size: 12px;
			overflow-wrap: anywhere;
		}
	}
</style>
