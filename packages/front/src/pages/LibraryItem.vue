<script lang="ts" setup>
	import type { MediaItem, MediaMatch, MediaNode } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import MatchesDialog from '@/components/media/MatchesDialog.vue';
	import MediaRow from '@/components/media/MediaRow.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SourcePicker from '@/components/media/SourcePicker.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'LibraryItemPage' });

	/**
	 * One series, season, film or collection.
	 *
	 * The children that are *missing* are listed alongside the ones we hold, greyed
	 * and carrying the name of whoever does hold them. That is the whole point of
	 * the page: a season that only showed the six episodes on this disk would leave
	 * the two a friend has invisible, which is the question people came to ask.
	 */
	const props = defineProps<{ itemId: string }>();

	const mediaStore = useMediaStore();
	const servicesStore = useServicesStore();
	const peersStore = usePeersStore();
	const syncStore = useSyncStore();
	const { notify, tryCallback } = useNotifier();

	const node = ref<MediaNode | null>(null);
	const children = ref<MediaItem[]>([]);
	const matches = ref<MediaMatch[]>([]);
	const loading = ref(true);
	const failed = ref(false);
	const running = ref(false);
	const chosenSource = ref<string | null>(null);
	const matchesOpen = ref(false);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const [loadedNode, loadedChildren] = await Promise.all([
				mediaStore.node(props.itemId),
				mediaStore.children(props.itemId, { limit: 200 }).catch(() => null),
			]);
			node.value = loadedNode;
			children.value = loadedChildren?.items ?? [];
			// The matches are what says which other services hold this item at all,
			// so they decide whether a source can be picked for this run.
			matches.value = await mediaStore.matches(props.itemId).catch(() => []);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(async () => {
		await Promise.all([
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			peersStore.loaded ? Promise.resolve() : peersStore.load().catch(() => undefined),
		]);
		await load();
	});

	watch(() => props.itemId, () => {
		void load();
	});

	const artwork = computed(() => (node.value ? mediaStore.artworkUrl(node.value.id) : null));

	const peerNames = computed(() => {
		const map: Record<string, string> = {};
		for (const peer of peersStore.peers) {
			map[peer.id] = peer.name;
		}
		return map;
	});

	/** The services a match says hold this media, in the order the gateway ranks them. */
	const sourceServices = computed(() => {
		const ids = new Set(matches.value.map(one => one.remoteServiceId));
		return servicesStore.services.filter(one => ids.has(one.id));
	});

	const missingChildren = computed(
		() => children.value.filter(one => one.sync === SyncState.MISSING));

	function holdersOf (item: MediaItem): string[] {
		if (item.sync !== SyncState.MISSING) {
			return [];
		}
		// A missing child is a row that came from somebody else's index, so the
		// service that reported it is the one that has the file.
		const service = servicesStore.byId[item.serviceId];
		return service ? [service.name] : [];
	}

	const syncThis = tryCallback(async () => {
		running.value = true;
		try {
			await syncStore.run({
				itemIds: [props.itemId],
				...(chosenSource.value ? { sourceServiceIds: [chosenSource.value] } : {}),
			});
			void notify('library.sync_started');
		} finally {
			running.value = false;
		}
	});

	const syncMissing = tryCallback(async () => {
		running.value = true;
		try {
			await syncStore.run({
				rootItemId: props.itemId,
				filter: { missingOnly: true },
				...(chosenSource.value ? { sourceServiceIds: [chosenSource.value] } : {}),
			});
			void notify('library.sync_started');
		} finally {
			running.value = false;
		}
	});
</script>

<template>
	<div class="page-container library-item">
		<ErrorState v-if="failed" @retry="load" />

		<template v-else-if="node">
			<PageHeader :loading="loading" :title="node.title">
				<template #actions>
					<v-btn
						data-test="item-matches"
						prepend-icon="mdi-link-variant"
						variant="text"
						@click="matchesOpen = true"
					>
						{{ $t('media.match.action') }}
					</v-btn>

					<v-btn
						color="primary"
						data-test="item-sync"
						:loading="running"
						prepend-icon="mdi-sync"
						@click="syncThis"
					>
						{{ $t('media.sync_this') }}
					</v-btn>

					<v-btn
						v-if="missingChildren.length > 0"
						data-test="item-sync-missing"
						:loading="running"
						prepend-icon="mdi-cloud-download-outline"
						variant="tonal"
						@click="syncMissing"
					>
						{{ $t('media.sync_missing', { count: missingChildren.length }) }}
					</v-btn>
				</template>
			</PageHeader>

			<v-card class="library-item_header">
				<v-card-text class="library-item_headerBody">
					<v-img
						v-if="artwork"
						class="library-item_artwork"
						cover
						:height="220"
						:src="artwork"
						:width="150"
					>
						<template #error>
							<div class="library-item_artworkFallback">
								<v-icon icon="mdi-image-off-outline" size="32" />
							</div>
						</template>
					</v-img>

					<div class="library-item_meta">
						<div class="library-item_chips">
							<SyncStateIcon :state="node.sync" with-label />
							<QualityChip :quality="node.quality" />

							<v-chip label size="small" variant="tonal">
								{{ $t(`media.kind.${node.kind}`) }}
							</v-chip>

							<v-chip v-if="node.year" label size="small" variant="tonal">{{ node.year }}</v-chip>
						</div>

						<p v-if="node.overview" class="library-item_overview text-body-2 mt-3">
							{{ node.overview }}
						</p>

						<p class="text-caption text-medium-emphasis mt-2 mb-0">
							{{ $t('media.child_count', { count: node.childCount }, node.childCount) }}
							<template v-if="node.quality">
								· <ByteSize :bytes="node.quality.totalBytes" />
							</template>
						</p>

						<SourcePicker
							v-if="sourceServices.length > 0"
							v-model="chosenSource"
							class="mt-4"
							:peer-names="peerNames"
							:services="sourceServices"
						/>
					</div>
				</v-card-text>
			</v-card>

			<v-card class="mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('media.children') }}</v-card-title>

				<EmptyState
					v-if="children.length === 0"
					icon="mdi-file-tree-outline"
					:text="$t('media.no_children_text')"
					:title="$t('media.no_children_title')"
				/>

				<v-table v-else data-test="media-list" density="compact">
					<thead>
						<tr>
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
							v-for="child of children"
							:key="child.id"
							:holders="holdersOf(child)"
							:item="child"
						/>
					</tbody>
				</v-table>
			</v-card>

			<MatchesDialog v-model="matchesOpen" :item-id="itemId" />
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
			border-radius: 6px;
			flex: 0 0 auto;
			background: rgba(var(--v-theme-on-surface), 0.06);
		}

		&_artworkFallback {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			opacity: 0.4;
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
	}
</style>
