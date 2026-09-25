<script lang="ts" setup>
	import type {
		ItemSyncPlans,
		MediaGroup,
		MediaGroupSource,
		MediaItem,
		TransferProgress,
	} from '@mcs/shared';
	import { MediaKind, SyncState } from '@mcs/shared';
	import { computed, onMounted, provide, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import ByteSize from '@/components/common/ByteSize.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import CompanionMarks from '@/components/media/CompanionMarks.vue';
	import GroupSources from '@/components/media/GroupSources.vue';
	import MatchesDialog from '@/components/media/MatchesDialog.vue';
	import MediaBreadcrumb from '@/components/media/MediaBreadcrumb.vue';
	import MediaCard from '@/components/media/MediaCard.vue';
	import MediaGroupRow from '@/components/media/MediaGroupRow.vue';
	import MediaPoster from '@/components/media/MediaPoster.vue';
	import OverrideDialog from '@/components/media/OverrideDialog.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import ReleasePreferenceNote from '@/components/media/ReleasePreferenceNote.vue';
	import ReleaseSearch from '@/components/media/ReleaseSearch.vue';
	import SyncStateBadge from '@/components/media/SyncStateBadge.vue';
	import KeepInSyncDialog from '@/components/sync/KeepInSyncDialog.vue';
	import { OPEN_OVERRIDE, withoutReleasePreference } from '@/composables/useMediaOverride';
	import { useMediaTrail } from '@/composables/useMediaTrail';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';
	import { useTransfersStore } from '@/stores/transfers';

	defineOptions({ name: 'LibraryItemPage' });

	/**
	 * One media, with every copy of it and everything under it.
	 *
	 * Read from the grouped routes rather than from the index rows: the page is
	 * about a film or a series, not about one server's record of it, and the source
	 * list underneath is precisely the difference between the two views.
	 *
	 * The children that are *missing* are listed alongside the ones we hold, dimmed
	 * and badged. That is the whole point of the page: a season that only showed the
	 * six episodes on this disk would leave the two a friend has invisible, which is
	 * the question people came to ask.
	 *
	 * The trail at the top is how somebody four levels down knows where they are. An
	 * episode reached from a search looks exactly like an episode reached from the
	 * wall, and without the breadcrumb the only way back to the category it belongs
	 * to is the browser's own button, which walks the history rather than the tree.
	 */
	const props = defineProps<{ itemId: string }>();

	const mediaStore = useMediaStore();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();
	const peersStore = usePeersStore();
	const syncStore = useSyncStore();
	const transfersStore = useTransfersStore();
	const { notify, tryCallback } = useNotifier();
	const { t } = useI18n();

	const group = ref<MediaGroup | null>(null);
	/**
	 * The representative's own index row, which the group does not carry.
	 *
	 * A group is the merged view of a media across every server and has no corrections on
	 * it: they belong to one service's record of the thing. The page needs that record for
	 * one reason — a search order set on this media has to be *said* here, because this is
	 * the only screen it can be seen from, and a preference nobody can see is the defect
	 * the whole feature most easily reintroduces.
	 *
	 * Failing is ordinary and must not take the page down: what somebody came for is the
	 * media and its copies.
	 */
	const item = ref<MediaItem | null>(null);
	const children = ref<MediaGroup[]>([]);
	const loading = ref(true);
	const failed = ref(false);
	const running = ref(false);
	/**
	 * The copy somebody has asked to erase, held only while they are being asked twice.
	 *
	 * The whole source rather than its identifier, because the confirmation names the
	 * file — that is the point of asking — and a dialog that had to look the path back
	 * up would show nothing for the one second the list is reloading.
	 */
	/** What holds other media rather than a file of its own. See `downloadOne`. */
	const CONTAINER_KINDS = new Set<string>([
		MediaKind.SERIES,
		MediaKind.SEASON,
		MediaKind.COLLECTION,
	]);

	const removing = ref<MediaGroupSource | null>(null);
	const erasing = ref(false);
	const matchesOpen = ref(false);
	const overrideOpen = ref(false);
	/**
	 * Which row the correction dialog is about: this media, or one of its children.
	 *
	 * The children are drawn by the same card and row as the wall, and they offer the same
	 * action for the same reason — the shelf a season belongs on is obvious from a list and
	 * not from opening it. One dialog serves both; it is told which row by this rather than
	 * by each card carrying one of its own. See `OPEN_OVERRIDE`.
	 */
	const correcting = ref<string>(props.itemId);
	const keepOpen = ref(false);
	/**
	 * Which plans already speak for this media, and what a new one would be called.
	 *
	 * Loaded with the page and not only when the dialog opens, because it is what puts
	 * the way back to the plan on the screen: somebody who kept a show in sync in March
	 * and wants to change it in September arrives here, not on the sync screen, and a
	 * plan nobody can navigate to is a plan nobody edits.
	 */
	const plans = ref<ItemSyncPlans | null>(null);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const [loadedGroup, loadedChildren, loadedPlans, loadedItem] = await Promise.all([
				mediaStore.group(props.itemId),
				// A group with no children below it is ordinary — a film — so a
				// failure here must not take the page down with it.
				mediaStore.groupChildren(props.itemId, { limit: 200 }).catch(() => null),
				// Nor must the plans: somebody who may read media and not syncs is
				// answered 403 here, and the page they asked for is the media.
				syncStore.itemPlans(props.itemId).catch(() => null),
				// The corrections on this one row, for the search order note. Not worth
				// the page: a gateway that cannot answer leaves the screen as it was
				// before the note existed.
				mediaStore.node(props.itemId).catch(() => null),
			]);
			group.value = loadedGroup;
			children.value = loadedChildren?.items ?? [];
			plans.value = loadedPlans;
			item.value = loadedItem;
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	const { steps } = useMediaTrail(group);

	/** The trail, in the words the wall uses: the library, the category, then the tree. */
	const trail = computed(() => steps(t('pages.library')));

	onMounted(async () => {
		// The categories come along because the first step of the trail is one, and the
		// peers because a source cannot be told apart from a friend of a friend without
		// them. Neither failing takes the page down: the media is what was asked for.
		await Promise.all([
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			peersStore.loaded ? Promise.resolve() : peersStore.load().catch(() => undefined),
			librariesStore.categoriesLoaded
				? Promise.resolve()
				: librariesStore.loadCategories().catch(() => undefined),
			// The transfers in flight, so a copy being fetched shows how far along it is
			// rather than offering to be fetched again. Failing is ordinary — somebody
			// allowed to read media may not be allowed to read transfers — and leaves
			// the rows with their buttons, which is what they had before.
			transfersStore.loaded
				? Promise.resolve()
				: transfersStore.load({ page: 1, limit: 100 }).catch(() => undefined),
		]);
		await load();
	});

	watch(() => props.itemId, () => {
		removing.value = null;
		// The dialog follows the page: left pointing at the media somebody navigated away
		// from, it would correct the previous series from the next one's screen.
		correcting.value = props.itemId;
		void load();
	});

	/**
	 * What is being fetched right now, by the copy being fetched.
	 *
	 * Keyed by item because that is what a source row knows about itself. The live
	 * frames are read from `progress` rather than from the rows, so a bar moves without
	 * the list around it re-rendering — see the store.
	 */
	const transfersByItem = computed(() => {
		const map: Record<string, TransferProgress> = {};

		for (const transfer of transfersStore.transfers) {
			const live = transfersStore.progress[transfer.id];

			if (live) {
				map[transfer.itemId] = live;
			}
		}

		return map;
	});

	const artwork = computed(() => mediaStore.artworkUrl(group.value?.artworkItemId ?? null));

	/**
	 * Whose companions the header reads: our own copy when there is one.
	 *
	 * What matters here is whether *this* library has the `.nfo` and the artwork — a
	 * friend's copy having them is a reason to pull, and that belongs in the source
	 * list below rather than at the top.
	 */
	const ownCopy = computed(
		() => group.value?.sources.find(one => one.local) ?? group.value?.sources[0] ?? null);

	const companions = computed(() => ownCopy.value?.companions ?? null);
	const companionsUnknown = computed(() => ownCopy.value !== null && companions.value === null);

	/**
	 * Never inspected is a different problem from incomplete, and it has a different
	 * remedy: the gateway has not read that directory yet, and a scan is what makes
	 * it. Offering "fetch the companions" there would ask for files nobody knows are
	 * missing.
	 */
	const scanning = ref(false);

	const scanSource = tryCallback(async () => {
		const serviceId = ownCopy.value?.serviceId;
		if (!serviceId) {
			return;
		}
		scanning.value = true;
		try {
			await servicesStore.scan(serviceId);
			void notify('companions.scan_started');
		} finally {
			scanning.value = false;
		}
	});

	function artworkOf (child: MediaGroup): string | null {
		return mediaStore.artworkUrl(child.artworkItemId);
	}

	const peerNames = computed(() => {
		const map: Record<string, string> = {};
		for (const peer of peersStore.peers) {
			map[peer.id] = peer.name;
		}
		return map;
	});

	/**
	 * How much is missing below this node.
	 *
	 * Two different answers to the same question, and the larger one is the true
	 * one: the group counts what is missing directly under it, while a child that is
	 * itself in sync can still be two episodes short.
	 */
	const missingBelow = computed(() => {
		// What the children themselves are short of counts too, and it is the only
		// signal a series has: its one season is in sync, and two of that season's
		// episodes are somebody else's. "Sync everything missing below this" has to
		// mean below, not one level down.
		const deeper = children.value.reduce(
			(total, child) => total + (child.sync === SyncState.MISSING ? 1 : 0) + child.missingCount,
			0,
		);
		return Math.max(group.value?.missingCount ?? 0, deeper);
	});

	/**
	 * Seasons are posters, episodes are rows.
	 *
	 * A season is a thing with artwork and a number missing — worth a tile. An
	 * episode is a title, a number and a size, and twenty-four of them as posters
	 * is a wall nobody can read; they get a table, which is also where a size
	 * column can be compared down a column.
	 */
	const asCards = computed(
		() => children.value.length > 0 && children.value[0].kind !== MediaKind.EPISODE);

	/**
	 * A correction is re-read rather than patched into the page.
	 *
	 * It can reclassify the media into another library, and so under another
	 * category — which is exactly what the trail at the top is built from. Writing the
	 * corrected fields into the group in place would leave a breadcrumb pointing at
	 * the category the media just left.
	 */
	async function onCorrected (): Promise<void> {
		await load();
	}

	function correct (itemId: string): void {
		correcting.value = itemId;
		overrideOpen.value = true;
	}

	provide(OPEN_OVERRIDE, correct);

	/**
	 * Back to the category's order, in one press, from the line that says there is one.
	 *
	 * The whole instruction is re-sent with the preference nulled rather than only the
	 * null: a `PUT` replaces the correction outright, so sending the null alone would
	 * withdraw the title, the year and the reclassification along with the search order.
	 */
	const cancellingPreference = ref(false);

	const cancelPreference = tryCallback(async () => {
		cancellingPreference.value = true;
		try {
			item.value = await mediaStore.setOverride(
				props.itemId,
				withoutReleasePreference(item.value?.overrides),
			);
			void notify('media.preference.cancelled');
		} finally {
			cancellingPreference.value = false;
		}
	});

	/**
	 * Which of the two questions the card is answering: what exists, or what could.
	 *
	 * Not in the address, deliberately. A link to a media is a link to the media, and
	 * carrying a tab in it would make somebody's shared URL open on a tracker search
	 * they never ran.
	 */
	const sourceTab = ref<'sources' | 'search'>('sources');

	/**
	 * Where this media sits on the gateway's own disks.
	 *
	 * The first copy that has one, which on a household with one server is the only
	 * one. A show and a season have no file of their own, so the gateway answers the
	 * folder every file beneath them shares — which is the thing somebody wants when
	 * they ask where a series is.
	 */
	const localPath = computed(
		() => (group.value?.sources ?? []).find(one => one.localPath)?.localPath ?? null);

	/**
	 * Fetch this exact copy, now.
	 *
	 * Named by item and never by service: one server can hold two versions of a film,
	 * so a service identifier cannot say which of them was asked for — and that
	 * ambiguity is the whole reason this button sits on a row rather than above the
	 * list.
	 */
	const downloadOne = tryCallback(async (itemId: string) => {
		const source = (group.value?.sources ?? []).find(one => one.itemId === itemId) ?? null;

		/*
		 * A series is a folder, and the planner refuses anything carrying no file — so
		 * pressing fetch on a show used to answer "a sync has started" and plan nothing.
		 * Expanding the container into its episodes is what makes the button do anything
		 * at all.
		 *
		 * **Only the episodes we hold no copy of.** This said `includeHeld` for a while,
		 * on the reasoning that pressing fetch on a show names that server as the source
		 * for the whole show — and it was wrong in the only way that matters: a show of
		 * six seasons with one season missing planned all six, so the queue filled with
		 * copies of episodes already on the disk and the one gap somebody actually wanted
		 * came last. What arrived overnight was season one, again.
		 *
		 * A version already held is a version held, whatever its quality: the run leaves
		 * it alone. That is the opposite of the single-row button below it, and
		 * deliberately so — naming one copy is a decision about that copy, while pressing
		 * fetch on a folder is a decision about the gaps in it.
		 */
		if (group.value && CONTAINER_KINDS.has(group.value.kind)) {
			await syncStore.run({
				scope: { rootItemIds: [props.itemId] },
				filter: { missingOnly: true },
				...(source ? { sourceServiceIds: [source.serviceId] } : {}),
			});
			void notify('library.sync_started');

			return;
		}

		await syncStore.run({
			scope: { itemIds: [itemId] },
			// Pressing fetch on one row of the source list is the decision, already
			// made. Without this the planner drops it for being a media we already hold
			// in another version, and answers with a run that plans nothing, finishes in
			// no time and says nothing. The copy lands beside the one we have, not over
			// it — see `SyncFilter.includeHeld`.
			filter: { includeHeld: true },
		});
		void notify('library.sync_started');
	});

	/**
	 * Erase the copy somebody confirmed, then re-read the page.
	 *
	 * Reloading rather than striking the row out: the media server still lists a file
	 * it no longer has, so the honest thing to show is whatever the gateway now knows,
	 * which is what it knew a second ago. The row goes when the next scan notices, and
	 * the notification says so.
	 */
	const confirmRemoval = tryCallback(async () => {
		const source = removing.value;

		if (source === null) {
			return;
		}

		erasing.value = true;
		try {
			await mediaStore.deleteFile(source.itemId);
			removing.value = null;
			void notify('media.source.deleted');
			await load();
		} finally {
			erasing.value = false;
		}
	});

	/**
	 * Ask the metadata source which episodes exist, and take the ones nothing here has.
	 *
	 * Offered on a show and nowhere else, because that is the only place the question
	 * means anything — and asked for rather than run on its own: it costs one call per
	 * season against somebody else's metadata server, and a gateway doing that over thirty
	 * thousand rows is a morning of requests.
	 *
	 * The count is said even when it is zero. "Nothing new" is an answer somebody pressed
	 * a button for, and a screen that stayed silent would read as a button that did not
	 * work.
	 */
	const discovering = ref(false);

	const discoverEpisodes = tryCallback(async () => {
		discovering.value = true;

		try {
			const added = await mediaStore.discoverEpisodes(props.itemId);

			// Translated here rather than by the notifier, which takes a key and no values:
			// the count is the whole of what this sentence says.
			void notify(added > 0 ? t('media.episodes.added', { count: added }, added) : t('media.episodes.none'));

			if (added > 0) {
				await load();
			}
		} finally {
			discovering.value = false;
		}
	});

	const syncMissing = tryCallback(async () => {
		running.value = true;
		try {
			await syncStore.run({
				// A subtree, which is now one shape with every other way of naming what a
				// sync covers — see `SyncScope`.
				scope: { rootItemIds: [props.itemId] },
				filter: { missingOnly: true },
			});
			void notify('library.sync_started');
		} finally {
			running.value = false;
		}
	});

	/**
	 * Which media are worth a standing plan, and which are a one-off.
	 *
	 * A show, a season and a collection are things that grow — that is what a plan is
	 * for. A film is finished: "keep this film in step for ever" is a schedule that
	 * will find nothing every night, and offering it would teach people that plans do
	 * nothing.
	 */
	/** A show, and nothing else: only a series carries the provider identifier to ask with. */
	const isSeries = computed(() => group.value?.kind === MediaKind.SERIES);

	const keepable = computed(() => group.value !== null && [
		MediaKind.SERIES,
		MediaKind.SEASON,
		MediaKind.COLLECTION,
	].includes(group.value.kind));

	/** The plan that already speaks for this media, and the way back to it. */
	const coveringPlan = computed(() => plans.value?.covering?.[0]?.plan ?? null);

	/**
	 * Re-read rather than patched in.
	 *
	 * What the header shows is coverage, and coverage is a rule about the whole parent
	 * chain: a plan created on the series changes what this season says about itself,
	 * and writing the created plan into the page by hand would only be right for the
	 * node somebody happened to be standing on.
	 */
	async function onKept (): Promise<void> {
		plans.value = await syncStore.itemPlans(props.itemId).catch(() => plans.value);
	}
</script>

<template>
	<div class="page-container library-item">
		<ErrorState v-if="failed" @retry="load" />

		<template v-else-if="group">
			<MediaBreadcrumb :steps="trail" />

			<PageHeader :loading="loading" :title="group.title">
				<template #actions>
					<v-btn
						data-test="item-override"
						prepend-icon="mdi-pencil-outline"
						variant="text"
						@click="correct(itemId)"
					>
						{{ $t('override.action') }}
					</v-btn>

					<v-btn
						data-test="item-matches"
						prepend-icon="mdi-link-variant"
						variant="text"
						@click="matchesOpen = true"
					>
						{{ $t('media.match.action') }}
					</v-btn>

					<!--
						Only on a show: a film has no episodes and a season is asked through
						its series, which is where the provider's identifier lives.
					-->
					<v-btn
						v-if="isSeries"
						data-test="item-discover-episodes"
						:loading="discovering"
						prepend-icon="mdi-playlist-plus"
						variant="text"
						@click="discoverEpisodes"
					>
						{{ $t('media.episodes.action') }}
					</v-btn>

					<v-btn
						v-if="keepable"
						data-test="item-keep"
						prepend-icon="mdi-calendar-sync-outline"
						variant="tonal"
						@click="keepOpen = true"
					>
						{{ $t('sync.keep.action') }}
					</v-btn>

					<v-btn
						v-if="missingBelow > 0"
						data-test="item-sync-missing"
						:loading="running"
						prepend-icon="mdi-cloud-download-outline"
						variant="tonal"
						@click="syncMissing"
					>
						{{ $t('media.sync_missing', { count: missingBelow }) }}
					</v-btn>
				</template>
			</PageHeader>

			<!--
				Above the media rather than buried in the search tab, because somebody
				wondering why a search on this one series answers differently from every
				other is looking at this screen and not at that tab. It is the only place
				this setting exists at all — it is not on the settings screen, by design —
				so it has to be visible without being looked for.
			-->
			<ReleasePreferenceNote
				v-if="item?.overrides?.releasePreference"
				:cancelling="cancellingPreference"
				class="mb-4"
				:preference="item.overrides.releasePreference"
				@cancel="cancelPreference"
			/>

			<v-card class="library-item_header">
				<v-card-text class="library-item_headerBody">
					<div class="library-item_artwork">
						<MediaPoster
							eager
							:kind="group.kind"
							:src="artwork"
							:title="group.title"
						/>
					</div>

					<div class="library-item_meta">
						<div class="library-item_chips">
							<SyncStateBadge :path="localPath" :state="group.sync" with-label />
							<QualityChip :quality="group.quality" />

							<v-chip label size="small" variant="tonal">
								{{ $t(`media.kind.${group.kind}`) }}
							</v-chip>

							<v-chip v-if="group.year" label size="small" variant="tonal">
								{{ group.year }}
							</v-chip>

							<!--
								The way back to the plan, from the thing the plan is about.
								Somebody who kept a show in sync in March and wants to change
								it in September comes here, not to the sync screen.
							-->
							<v-chip
								v-if="coveringPlan"
								color="primary"
								data-test="item-plan-link"
								label
								prepend-icon="mdi-calendar-sync-outline"
								size="small"
								:to="{ name: 'sync-plan', params: { id: coveringPlan.id } }"
								variant="tonal"
							>
								{{ coveringPlan.name }}
							</v-chip>
						</div>

						<p v-if="group.overview" class="library-item_overview text-body-2 mt-3">
							{{ group.overview }}
						</p>

						<p class="library-item_facts text-caption text-medium-emphasis mt-2 mb-0">
							<span v-if="group.childCount > 0">
								{{ $t('media.child_count', { count: group.childCount }, group.childCount) }}
							</span>

							<span
								v-if="group.missingCount > 0"
								class="library-item_missing"
								data-test="item-missing-count"
							>
								{{ $t('media.missing_count', { count: group.missingCount }, group.missingCount) }}
							</span>

							<span v-if="group.quality">
								<ByteSize :bytes="group.quality.totalBytes" />
							</span>
						</p>

						<div class="library-item_companions mt-3" data-test="item-companions">
							<span class="text-caption text-medium-emphasis">
								{{ $t('companions.title') }}
							</span>

							<CompanionMarks :companions="companions" detailed />

							<v-btn
								v-if="companionsUnknown"
								data-test="item-companions-scan"
								:loading="scanning"
								prepend-icon="mdi-magnify-scan"
								size="x-small"
								variant="text"
								@click="scanSource"
							>
								{{ $t('companions.scan') }}
							</v-btn>
						</div>

						<!--
							Two tabs and not one list, because they answer two different
							questions. The sources are what *exists* — our servers, a
							friend's gateway — and every row can be acted on with certainty.
							The search is what *could* exist: names on trackers, none of
							which is known to be what it claims until it has been fetched.
							Under one heading a guess would sit beside a fact.
						-->
						<v-tabs
							v-model="sourceTab"
							class="mt-4"
							data-test="item-source-tabs"
							density="compact"
						>
							<v-tab data-test="item-tab-sources" value="sources">
								{{ $t('media.source.title') }}
							</v-tab>

							<v-tab data-test="item-tab-search" value="search">
								{{ $t('release.title') }}
							</v-tab>
						</v-tabs>

						<GroupSources
							v-show="sourceTab === 'sources'"
							class="mt-4"
							:downloading="downloadOne.loading"
							:peer-names="peerNames"
							:services="servicesStore.services"
							:sources="group.sources"
							:transfers="transfersByItem"
							:versions="group.versions"
							@download="downloadOne"
							@remove="removing = $event"
						/>

						<!--
							Mounted only once the tab is opened. An indexer fans a query out
							to a dozen trackers and waits for the slowest, and the component
							loads what has already been grabbed on mount — neither is work
							worth doing on every media page for the once in fifty times
							somebody wants it.
						-->
						<ReleaseSearch
							v-if="sourceTab === 'search'"
							class="mt-4"
							:episode-number="group.episodeNumber"
							:group="group"
							:season-number="group.seasonNumber"
						/>
					</div>
				</v-card-text>
			</v-card>

			<!--
				Only when there is a level below. A film has none, and a card saying
				"nothing below this item" under every film is an empty frame repeated
				on most of the library.
			-->
			<v-card v-if="group.childCount > 0 || children.length > 0" class="mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('media.children') }}</v-card-title>

				<EmptyState
					v-if="children.length === 0"
					icon="mdi-file-tree-outline"
					:text="$t('media.no_children_text')"
					:title="$t('media.no_children_title')"
				/>

				<div v-else-if="asCards" class="library-item_children" data-test="media-list">
					<MediaCard
						v-for="child of children"
						:key="child.id"
						:artwork="artworkOf(child)"
						:group="child"
						:selectable="false"
					/>
				</div>

				<v-table v-else data-test="media-list" density="compact">
					<thead>
						<tr>
							<th />
							<th>{{ $t('media.column.title') }}</th>
							<th>{{ $t('media.column.kind') }}</th>
							<th class="text-right">{{ $t('media.column.year') }}</th>
							<th>{{ $t('media.column.sources') }}</th>
							<th>{{ $t('media.column.quality') }}</th>
							<th class="text-right">{{ $t('media.column.size') }}</th>
						</tr>
					</thead>

					<tbody>
						<MediaGroupRow v-for="child of children" :key="child.id" :group="child" />
					</tbody>
				</v-table>
			</v-card>

			<MatchesDialog v-model="matchesOpen" :item-id="itemId" />

			<OverrideDialog v-model="overrideOpen" :item-id="correcting" @saved="onCorrected" />

			<KeepInSyncDialog v-model="keepOpen" :group="group" @created="onKept" />

			<!--
				Erasing is the one thing here that destroys something no scan can bring
				back, so it is asked twice and the second asking names the file. The path
				is the server's own spelling, because that is the one somebody recognises
				from their Jellyfin — a mount point a container happens to see would prove
				nothing to the person agreeing to it.
			-->
			<v-dialog max-width="560" :model-value="removing !== null" @update:model-value="removing = null">
				<v-card v-if="removing" data-test="delete-confirm">
					<v-card-title class="text-subtitle-1">{{ $t('media.source.delete_title') }}</v-card-title>

					<v-card-text>
						<p class="mb-3">{{ $t('media.source.delete_text', { service: removing.serviceName }) }}</p>

						<p class="library-item_path" data-test="delete-path">{{ removing.path }}</p>

						<p v-if="removing.bytes !== null" class="text-caption text-medium-emphasis mt-2">
							<ByteSize :bytes="removing.bytes" />
						</p>

						<p class="text-caption text-medium-emphasis mt-3">
							{{ $t('media.source.delete_note') }}
						</p>
					</v-card-text>

					<v-card-actions>
						<v-spacer />

						<v-btn data-test="delete-cancel" variant="text" @click="removing = null">
							{{ $t('actions.cancel') }}
						</v-btn>

						<v-btn
							color="error"
							data-test="delete-accept"
							:loading="erasing"
							variant="flat"
							@click="confirmRemoval"
						>
							{{ $t('media.source.delete_accept') }}
						</v-btn>
					</v-card-actions>
				</v-card>
			</v-dialog>
		</template>

		<div v-else class="text-center py-10">
			<v-progress-circular color="primary" indeterminate size="36" />
		</div>
	</div>
</template>

<style lang="scss">
	.library-item {
		&_headerBody {
			display: flex;
			gap: 20px;
			flex-wrap: wrap;
		}

		&_artwork {
			flex: 0 0 auto;
			width: 168px;
		}

		&_meta {
			flex: 1 1 320px;
			min-width: 0;
		}

		&_chips {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_overview {
			max-width: 70ch;
		}

		&_companions {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_path {
			font-family: monospace;
			font-size: 0.85rem;
			word-break: break-all;
			// A path is quoted evidence, not prose: the tint separates it from the
			// sentence above it without turning it into a code block nobody reads.
			background: rgba(127, 127, 127, 0.12);
			padding: 8px 10px;
			border-radius: 4px;
		}

		&_facts {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;

			// The separator belongs to the layout rather than to the markup: which
			// facts exist depends on the media, and a dot written between two of them
			// is a dot left dangling the day one of them is absent.
			span + span::before {
				content: '· ';
			}
		}

		&_missing {
			color: rgb(var(--v-theme-state-missing));
			font-weight: 600;
		}

		&_children {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
			gap: 18px 14px;
			padding: 4px 16px 16px;
		}
	}
</style>
