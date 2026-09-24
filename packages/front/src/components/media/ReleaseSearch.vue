<script lang="ts" setup>
	import type {
		MediaGroup,
		PeerCopy,
		ReleaseGroup,
		ReleaseKind,
		ReleaseSearchQuery,
	} from '@mcs/shared';
	import { GrabState, MediaKind, ReleaseSearchKind, SuggestionSource } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import ReleasePlan from '@/components/media/ReleasePlan.vue';
	import { describeMediaOrigin } from '@/composables/useMediaOrigin';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useReleasesStore } from '@/stores/releases';

	/**
	 * What could satisfy this media, from the trackers and from the peers.
	 *
	 * Its own tab and not another row in the sources list, deliberately. That list says
	 * what *exists here and elsewhere as a copy of this media*, copy by copy, and every row
	 * of it is a fact about one server. This tab answers the other question — "what would
	 * fill the gap" — and has to be able to put two very different answers side by side.
	 *
	 * **A tracker release and a peer copy are the same question and not the same kind of
	 * thing, and the screen says which is which.** A release is a name somebody uploaded:
	 * it claims to be the episode, nothing has checked that it is, it has seeders that can
	 * be zero, and fetching it hands a magnet to a torrent client and copies the result out
	 * afterwards. A peer copy is a file on a gateway we are already linked to, whose
	 * quality this gateway measured itself, and fetching it is the ordinary transfer every
	 * other byte in this product moves by. Neither is dressed as the other: the peer rows
	 * carry a holder and a path and no seeder count, the tracker rows carry seeders and no
	 * holder, and the button on each says what it does.
	 *
	 * The peer rows come first because the gateway put them first — see `orderSuggestions`.
	 * Nothing is re-sorted here: an order decided in two places is an order nobody can
	 * account for.
	 *
	 * Nothing is searched until somebody asks. An indexer fans a query out to a dozen
	 * trackers and waits for the slowest, so a search on page load would make every media
	 * page several seconds slower for the once in fifty times it is wanted — and would
	 * hammer somebody's trackers for pages nobody was looking at.
	 */
	const props = defineProps<{
		group: MediaGroup;
		/** Which season this page is about, when it is about one. */
		seasonNumber?: number | null;
		episodeNumber?: number | null;
	}>();

	const releases = useReleasesStore();
	const { notify, tryCallback } = useNotifier();

	const term = ref('');
	const seasonPack = ref(false);
	const grabbing = ref<string | null>(null);
	const pulling = ref<string | null>(null);

	const isShow = computed(
		() => props.group.kind !== MediaKind.MOVIE && props.group.kind !== MediaKind.COLLECTION);

	/*
	 * A season pack is what somebody wants on a season page, and never on an episode.
	 * Defaulted rather than left off so the first search on a season answers the question
	 * that page is about — "I am missing most of this season" — instead of returning one
	 * episode and looking broken.
	 */
	onMounted(() => {
		seasonPack.value = props.group.kind === MediaKind.SEASON;
	});

	// The held result belongs to one media. Showing the last page's would offer rows the
	// gateway has already forgotten and would refuse to grab.
	watch(() => props.group.id, () => {
		releases.clear();
		term.value = '';
	});

	/**
	 * What this screen is asking, built once for the search and the plan.
	 *
	 * `kind` is always said, and that is the whole of the fix it exists for: a search that
	 * leaves it out is asked of the television categories, which answers nothing for a film
	 * while reporting no fault — a search that succeeds and does nothing.
	 */
	function queryOf (): ReleaseSearchQuery {
		return {
			itemId: props.group.id,
			kind: isShow.value ? ReleaseSearchKind.SHOW : ReleaseSearchKind.MOVIE,
			...(term.value.trim() ? { term: term.value.trim() } : {}),
			...(props.seasonNumber === null || props.seasonNumber === undefined
				? {}
				: { seasonNumber: props.seasonNumber }),
			...(props.episodeNumber === null || props.episodeNumber === undefined
				? {}
				: { episodeNumber: props.episodeNumber }),
			...(isShow.value ? { seasonPack: seasonPack.value } : {}),
		};
	}

	const run = tryCallback(async () => {
		// A plan built against the previous search names rows this one may not answer, so
		// it goes rather than sitting under a list it no longer describes.
		releases.clearPlan();
		await releases.search(queryOf());
	});

	const buildPlan = tryCallback(async () => {
		await releases.planFor(queryOf());
	});

	const grab = tryCallback(async (group: ReleaseGroup) => {
		// The best-seeded copy of the group, which is the one the line is named after:
		// grabbing a different one would fetch a file whose name is not on screen.
		const release = group.releases[0];

		if (release === undefined) {
			return;
		}

		grabbing.value = group.key;
		try {
			await releases.grab(release.id, props.group.id);
			void notify('release.grabbed');
		} finally {
			grabbing.value = null;
		}
	});

	/**
	 * Pull a copy a peer holds, through the transfer machinery.
	 *
	 * A different call from `grab` and not a branch inside it. The two go to two different
	 * machines and both fail silently when crossed — a peer copy has no magnet for a
	 * torrent client to add, and a magnet names no file a transfer can read — so the store
	 * exposes one function per kind and neither takes the other's argument.
	 */
	const pull = tryCallback(async (copy: PeerCopy) => {
		pulling.value = copy.id;
		try {
			await releases.pull(copy);
			void notify('release.pulled');
		} finally {
			pulling.value = null;
		}
	});

	/**
	 * Every step of the plan, handed over one after another.
	 *
	 * In order and not at once: the steps are a cover of the gaps, and a client handed
	 * twelve torrents in one breath answers some of them and drops the rest without saying
	 * which. A partial step carries the episodes it was taken for, which is what makes a
	 * season pack cost four files rather than a season.
	 */
	const grabPlan = tryCallback(async () => {
		for (const step of releases.plan?.steps ?? []) {
			await releases.grab(
				step.releaseId,
				props.group.id,
				step.partial ? step.covers : undefined,
			);
		}

		releases.clearPlan();
		void notify('release.grabbed');
	});

	/** Only ever the result this page asked for: a stale one would offer forgotten rows. */
	const forThisMedia = computed(() => releases.searchedFor === props.group.id);

	const suggestions = computed(() => (forThisMedia.value ? releases.suggestions : []));

	const failures = computed(() =>
		forThisMedia.value ? (releases.result?.failed ?? []) : []);

	/** What was actually asked of the indexer, so a fruitless search can be corrected. */
	const asked = computed(() => (forThisMedia.value ? (releases.result?.query ?? null) : null));

	/** Gaps to cover, which is the only state in which a plan is worth offering. */
	const missing = computed(() => (forThisMedia.value ? (releases.result?.missing ?? []) : []));

	const plan = computed(() => (releases.plannedFor === props.group.id ? releases.plan : null));

	const mine = computed(() => releases.grabs.filter(one => one.itemId === props.group.id));

	/** Still moving, or waiting to be filed — the states a progress bar belongs on. */
	const LIVE: GrabState[] = [GrabState.SENT, GrabState.DOWNLOADING, GrabState.FETCHED];

	function percentOf (done: number, total: number): number {
		return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
	}

	function kindLabel (kind: ReleaseKind): string {
		return `release.kind.${kind}`;
	}

	/**
	 * How far away a holder is, in the same words and the same icon the library uses.
	 *
	 * The origin is taken as the gateway answered it rather than re-derived here: telling
	 * `friend` from `friend_of_friend` needs the peer's trust, and the API is the side that
	 * has it. `describeMediaOrigin` is then the one place that decides how either is drawn,
	 * so this row and the sources list cannot disagree about a distinction that exists
	 * precisely to be noticed.
	 */
	function originOfCopy (copy: PeerCopy) {
		return describeMediaOrigin(copy.origin);
	}

	onMounted(() => {
		// Caught, and `void` is not enough: a gateway with no download client configured
		// refuses this, as does one whose qBittorrent is down, and an unhandled rejection
		// from a tab nobody has pressed yet is a failure with no screen to report it on.
		// What is being read is "what have I already grabbed for this media" — worth
		// nothing on a gateway that has grabbed nothing, and never worth the tab.
		releases.loadGrabs(props.group.id).catch(() => undefined);
	});
</script>

<template>
	<div class="release-search" data-test="release-search">
		<p class="text-caption text-medium-emphasis mb-1">{{ $t('release.intro') }}</p>

		<!--
			The second half of what this screen answers, said before anybody presses. A list
			that quietly mixed a friend's season into the tracker rows would be read as
			forty tracker rows, and the one line worth pressing would be the one nobody
			looked at twice.
		-->
		<p class="text-caption text-medium-emphasis mb-2" data-test="release-peer-intro">
			{{ $t('release.intro_peers') }}
		</p>

		<div class="release-search_controls">
			<v-text-field
				v-model="term"
				clearable
				data-test="release-term"
				density="compact"
				hide-details
				:label="$t('release.term')"
				:placeholder="group.title"
				@keyup.enter="run"
			/>

			<!--
				Only for a show, and only where a pack is a thing that exists: asking a
				tracker for "season 2 of this film" returns the whole catalogue.
			-->
			<v-switch
				v-if="isShow"
				v-model="seasonPack"
				color="primary"
				data-test="release-season-pack"
				density="compact"
				hide-details
				:label="$t('release.season_pack')"
			/>

			<v-btn
				color="primary"
				data-test="release-search-run"
				:loading="releases.searching"
				prepend-icon="mdi-magnify"
				@click="run"
			>
				{{ $t('release.search') }}
			</v-btn>

			<!--
				Only once a search has said there are gaps. A plan of nothing is a button
				that answers an empty panel, and before a search there is no list for it to
				be a plan over.
			-->
			<v-btn
				v-if="missing.length > 0"
				data-test="release-plan-open"
				:loading="releases.planning"
				prepend-icon="mdi-format-list-numbered"
				variant="tonal"
				@click="buildPlan"
			>
				{{ $t('release.plan.open') }}
			</v-btn>
		</div>

		<p v-if="asked" class="text-caption text-medium-emphasis mt-2 mb-0" data-test="release-asked">
			{{ $t('release.asked', { query: asked }) }}
		</p>

		<!--
			An indexer that did not answer is named rather than shown as an empty list:
			"nothing found" and "nobody answered" are opposite answers, and showing the
			first for the second sends somebody hunting for a better search term while
			their key is wrong. The peer rows are unaffected — they are read out of the
			index and cost no network — which is what makes this screen useful anyway.
		-->
		<p
			v-for="failure of failures"
			:key="failure.indexer"
			class="text-caption text-warning mt-1 mb-0"
			data-test="release-failed"
		>
			{{ $t('release.failed', { indexer: failure.indexer }) }}
		</p>

		<ReleasePlan
			v-if="plan"
			class="mt-4"
			:grabbing="grabPlan.loading"
			:peers="releases.peerSuggestions"
			:plan="plan"
			@close="releases.clearPlan()"
			@grab="grabPlan"
		/>

		<!-- What is already being fetched for this media, above what could be. -->
		<div v-if="mine.length > 0" class="release-search_grabs mt-4">
			<p class="text-caption text-medium-emphasis mb-1">{{ $t('release.downloads') }}</p>

			<div
				v-for="one of mine"
				:key="one.id"
				class="release-search_grab"
				:data-state="one.state"
				data-test="release-grab"
			>
				<div class="release-search_grab-head">
					<span class="release-search_name">{{ one.title }}</span>

					<v-chip label size="x-small" variant="tonal">
						{{ $t(`release.state.${one.state}`) }}
					</v-chip>

					<span v-if="one.bytesTotal > 0" class="text-caption text-medium-emphasis">
						<ByteSize :bytes="one.bytesDone" /> / <ByteSize :bytes="one.bytesTotal" />
					</span>
				</div>

				<v-progress-linear
					v-if="LIVE.includes(one.state)"
					class="mt-1"
					height="6"
					:model-value="percentOf(one.bytesDone, one.bytesTotal)"
					rounded
				/>

				<p
					v-if="one.targetPath"
					class="release-search_path text-caption text-medium-emphasis mb-0 mt-1"
					data-test="release-grab-path"
				>
					{{ one.targetPath }}
				</p>

				<p
					v-if="one.error"
					class="text-caption text-error mb-0 mt-1"
					data-test="release-grab-error"
				>
					{{ one.error }}
				</p>
			</div>
		</div>

		<div v-if="suggestions.length > 0" class="release-search_results mt-4">
			<template v-for="one of suggestions" :key="one.key">
				<!--
					**A copy somebody already has.**

					No seeders, no tracker and no download client anywhere on this row, and
					that is not an omission: it has none of those things, and a row that
					showed "0 seeders" for a file sitting on a friend's disk would be saying
					the one thing that is not true about it. What it has instead is a holder,
					how far away they are, the quality this gateway measured, and a path.
				-->
				<div
					v-if="one.source === SuggestionSource.PEER"
					class="release-search_row"
					:data-held="one.copy.fills.length === 0"
					:data-source="one.source"
					data-test="release-row"
				>
					<div class="release-search_label">
						<span class="release-search_title">{{ one.copy.title }}</span>

						<div class="release-search_marks">
							<v-chip
								color="state-in-sync"
								data-test="release-peer-mark"
								label
								prepend-icon="mdi-check-decagram-outline"
								size="x-small"
								variant="tonal"
							>
								{{ $t('release.peer.exists') }}
							</v-chip>

							<v-chip
								:data-origin="originOfCopy(one.copy).origin"
								data-test="release-peer-origin"
								label
								:prepend-icon="originOfCopy(one.copy).icon"
								size="x-small"
								variant="outlined"
							>
								{{ $t(originOfCopy(one.copy).labelKey) }}
							</v-chip>

							<span class="release-search_holder" data-test="release-peer-holder">
								{{ one.copy.serviceName }}
							</span>

							<span
								v-if="one.copy.peerName"
								class="text-caption text-medium-emphasis"
								data-test="release-peer-name"
							>
								{{ $t('media.source.via_peer', { peer: one.copy.peerName }) }}
							</span>

							<QualityChip :quality="one.copy.quality" size="x-small" />

							<span v-if="(one.copy.size ?? 0) > 0" class="text-caption text-medium-emphasis">
								<ByteSize :bytes="one.copy.size" />
							</span>

							<!--
								How much of the gap it closes, which is what makes one holder a
								better offer than another and what a season pack is competing
								against.
							-->
							<span
								v-if="one.copy.fills.length > 0"
								class="text-caption"
								data-test="release-peer-fills"
							>
								{{ $t('release.peer.fills', { count: one.copy.fills.length }, one.copy.fills.length) }}
							</span>
						</div>

						<span
							v-if="one.copy.path"
							class="release-search_path text-caption text-medium-emphasis"
							data-test="release-peer-path"
						>
							{{ one.copy.path }}
						</span>
					</div>

					<v-btn
						data-test="release-pull-button"
						:loading="pulling === one.copy.id"
						prepend-icon="mdi-cloud-download-outline"
						size="small"
						variant="tonal"
						@click="pull(one.copy)"
					>
						{{ $t('release.pull') }}
					</v-btn>
				</div>

				<!-- A name on a tracker: seeders, a magnet, and a download client. -->
				<div
					v-else
					class="release-search_row"
					:data-held="one.release.heldAlready"
					:data-source="one.source"
					data-test="release-row"
				>
					<div class="release-search_label">
						<span class="release-search_name">{{ one.release.title }}</span>

						<div class="release-search_marks">
							<v-chip label size="x-small" variant="tonal">
								{{ $t(kindLabel(one.release.kind)) }}
							</v-chip>

							<v-chip v-if="one.release.quality" label size="x-small" variant="tonal">
								{{ one.release.quality }}
							</v-chip>

							<v-chip v-if="one.release.source" label size="x-small" variant="outlined">
								{{ one.release.source }}
							</v-chip>

							<v-chip
								v-for="language of one.release.languages"
								:key="language"
								label
								size="x-small"
								variant="outlined"
							>
								{{ language }}
							</v-chip>

							<span v-if="(one.release.size ?? 0) > 0" class="text-caption text-medium-emphasis">
								<ByteSize :bytes="one.release.size" />
							</span>

							<!--
								The seeders summed over the copies, because a release carried by
								four trackers really is better seeded than the same file on one —
								and a release nobody seeds is a download that never finishes,
								which is the one thing worth knowing before pressing anything.
							-->
							<span class="text-caption text-medium-emphasis" data-test="release-seeders">
								{{ $t('release.seeders', { count: one.release.seeders ?? 0 }) }}
							</span>

							<span
								v-if="one.release.releases.length > 1"
								class="text-caption text-medium-emphasis"
								data-test="release-copies"
							>
								{{ $t('release.on_indexers', { count: one.release.releases.length }) }}
							</span>

							<v-chip
								v-if="one.release.heldAlready"
								color="state-in-sync"
								data-test="release-held"
								label
								size="x-small"
								variant="tonal"
							>
								{{ $t('release.held') }}
							</v-chip>
						</div>
					</div>

					<v-btn
						data-test="release-grab-button"
						:loading="grabbing === one.release.key"
						prepend-icon="mdi-download"
						size="small"
						variant="tonal"
						@click="grab(one.release)"
					>
						{{ $t('release.grab') }}
					</v-btn>
				</div>
			</template>
		</div>

		<p
			v-else-if="asked && !releases.searching"
			class="text-caption text-medium-emphasis mt-4 mb-0"
			data-test="release-empty"
		>
			{{ $t('release.none') }}
		</p>
	</div>
</template>

<style lang="scss">
	.release-search {
		&_controls {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 12px;

			.v-text-field {
				min-width: 220px;
				flex: 1 1 260px;
			}
		}

		&_row,
		&_grab-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_row {
			padding: 6px 0;
			border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

			&[data-held='true'] {
				opacity: 0.7;
			}

			// A copy that exists is a different class of answer from a name on a tracker,
			// and the eye should not have to read the chips to tell which half of the list
			// it is in.
			&[data-source='peer'] {
				border-left: 2px solid rgb(var(--v-theme-state-in-sync));
				padding-left: 8px;
			}
		}

		&_grab {
			padding: 6px 0;
		}

		&_label {
			display: flex;
			flex-direction: column;
			gap: 4px;
			min-width: 0;
			flex: 1 1 320px;
		}

		&_marks {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 6px;
		}

		&_name {
			// A release name is long, has no spaces and is the thing being chosen: it has
			// to break rather than push the buttons off the row.
			font-family: monospace;
			font-size: 12px;
			overflow-wrap: anywhere;
		}

		// A peer copy is titled by the media, not by a scene name: it is prose and reads as
		// prose. Setting it in monospace beside the release names would suggest it is one.
		&_title {
			font-weight: 500;
			overflow-wrap: anywhere;
		}

		&_holder {
			font-weight: 500;
			font-size: 12px;
		}

		&_path {
			font-family: monospace;
			overflow-wrap: anywhere;
		}
	}
</style>
