<script lang="ts" setup>
	import type { CatalogueEntry, Library, MediaService, Peer } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import CatalogueList from '@/components/peer/CatalogueList.vue';
	import { toCatalogueEntry } from '@/composables/useCatalogue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'PeerPage' });

	/**
	 * One peer: what they hold, and how to pull from it.
	 *
	 * Their libraries are browsed here as a catalogue — their titles, not the shape
	 * of their disk — and the full index view is one link away for anybody who wants
	 * our own state alongside. What this page adds is the shortcut that matters:
	 * pulling what they have and we do not.
	 */
	const props = defineProps<{ id: string }>();

	const peersStore = usePeersStore();
	const servicesStore = useServicesStore();
	const mediaStore = useMediaStore();
	const syncStore = useSyncStore();
	const { notify, tryCallback } = useNotifier();

	const peer = ref<Peer | null>(null);
	const services = ref<MediaService[]>([]);
	const libraries = ref<Record<string, Library[]>>({});
	const loading = ref(true);
	const failed = ref(false);
	const busy = ref(false);
	const browsing = ref<{ serviceId: string; libraryId: string | null } | null>(null);
	const catalogue = ref<CatalogueEntry[]>([]);
	const catalogueLoading = ref(false);

	/**
	 * A catalogue entry carries their identifier, not ours, so the row cannot say
	 * which of our index rows to sync. The correspondence is kept here, for the
	 * rows this page rendered, rather than smuggled into the shared shape.
	 */
	const itemIdByExternalId = ref<Record<string, string>>({});

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const [loadedPeer, loadedServices] = await Promise.all([
				peersStore.get(props.id),
				peersStore.services(props.id),
			]);
			peer.value = loadedPeer;
			services.value = loadedServices;

			// One call per service rather than one big one: the libraries route is
			// per service, and a peer holding two of them is the common case.
			const entries = await Promise.all(loadedServices.map(async service => [
				service.id,
				await servicesStore.libraries(service.id).catch(() => [] as Library[]),
			] as const));
			libraries.value = Object.fromEntries(entries);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	const serviceIds = computed(() => services.value.map(one => one.id));

	/**
	 * What this peer holds, read from our own index of their services.
	 *
	 * `/peer/catalogue` is not a route a browser may call — it carries a peer
	 * credential rather than a session — so the gateway's index of the same
	 * services is what this screen has, reduced to what a peer actually tells us.
	 */
	const browse = tryCallback(async (serviceId: string, libraryId: string | null = null) => {
		browsing.value = { serviceId, libraryId };
		catalogueLoading.value = true;
		try {
			const result = await mediaStore.search({
				serviceId,
				...(libraryId ? { libraryId } : {}),
				limit: 100,
			});
			const entries: CatalogueEntry[] = [];
			const ids: Record<string, string> = {};
			for (const item of result.items) {
				const entry = toCatalogueEntry(item);
				entries.push(entry);
				ids[entry.externalId] = item.id;
			}
			catalogue.value = entries;
			itemIdByExternalId.value = ids;
		} finally {
			catalogueLoading.value = false;
		}
	});

	const pullEntry = tryCallback(async (entry: CatalogueEntry) => {
		const itemId = itemIdByExternalId.value[entry.externalId];
		if (!itemId) {
			return;
		}
		busy.value = true;
		try {
			await syncStore.run({
				scope: { itemIds: [itemId] },
				...(browsing.value ? { sourceServiceIds: [browsing.value.serviceId] } : {}),
			});
			void notify('peer.pull_started');
		} finally {
			busy.value = false;
		}
	});

	const pullAll = tryCallback(async () => {
		busy.value = true;
		try {
			await syncStore.run({
				sourceServiceIds: serviceIds.value,
				filter: { missingOnly: true },
			});
			void notify('peer.pull_started');
		} finally {
			busy.value = false;
		}
	});

	const pullService = tryCallback(async (service: MediaService) => {
		busy.value = true;
		try {
			await syncStore.run({
				sourceServiceIds: [service.id],
				filter: { missingOnly: true },
			});
			void notify('peer.pull_started');
		} finally {
			busy.value = false;
		}
	});
</script>

<template>
	<div class="page-container peer">
		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<PageHeader
				icon="mdi-server-network"
				:loading="loading"
				:subtitle="peer?.fingerprint ?? null"
				:title="peer?.name ?? $t('pages.peer')"
			>
				<template #actions>
					<v-btn
						color="primary"
						data-test="peer-pull-all"
						:disabled="services.length === 0"
						:loading="busy"
						prepend-icon="mdi-cloud-download-outline"
						@click="pullAll"
					>
						{{ $t('peer.pull_all') }}
					</v-btn>
				</template>
			</PageHeader>

			<v-card v-if="peer">
				<v-card-text class="peer_details">
					<v-chip data-test="peer-status" label size="small" variant="tonal">
						{{ $t(`peer.status.${peer.status}`) }}
					</v-chip>

					<v-chip label size="small" variant="tonal">
						{{ peer.trust === 'friend_of_friend' && peer.viaPeerName
							? $t('peer.trust.friend_of_friend_via', { peer: peer.viaPeerName })
							: $t(`peer.trust.${peer.trust}`) }}
					</v-chip>

					<v-chip v-if="peer.linkMode" label size="small" variant="tonal">
						{{ $t(`peer.link_mode.${peer.linkMode}`) }}
					</v-chip>

					<span class="text-caption text-medium-emphasis">
						{{ $t('peer.last_seen') }} <RelativeDate :date="peer.lastSeenAt" />
						<template v-if="peer.address"> · {{ peer.address }}</template>
					</span>

					<!--
						Their node identifier, learned when the link was established. It is
						what both ends quote when an announcement loops, so it is shown
						rather than kept for a log nobody has.
					-->
					<span
						v-if="peer.nodeId"
						class="peer_node-id text-caption text-medium-emphasis"
						data-test="peer-node-id"
					>
						{{ $t('peer.identity.node_id') }}: <code>{{ peer.nodeId }}</code>
					</span>
				</v-card-text>
			</v-card>

			<EmptyState
				v-if="!loading && services.length === 0"
				icon="mdi-share-off-outline"
				:text="$t('peer.no_services_text')"
				:title="$t('peer.no_services_title')"
			/>

			<v-card v-for="service of services" :key="service.id" class="mt-4" data-test="peer-service">
				<v-card-item>
					<v-card-title class="text-subtitle-1">{{ service.name }}</v-card-title>

					<v-card-subtitle>
						{{ service.type }}
						· {{ $t('service.counts', {
							libraries: service.libraryCount,
							items: service.itemCount,
						}) }}
					</v-card-subtitle>
				</v-card-item>

				<v-card-text>
					<v-list v-if="(libraries[service.id] ?? []).length > 0" density="compact">
						<v-list-item
							v-for="library of libraries[service.id]"
							:key="library.id"
							:active="browsing?.libraryId === library.id"
							data-test="peer-library"
							:subtitle="$t('library.item_count', { count: library.itemCount }, library.itemCount)"
							:title="library.name"
							@click="browse(service.id, library.id)"
						/>
					</v-list>

					<p v-else class="text-caption text-medium-emphasis mb-0">
						{{ $t('peer.no_libraries') }}
					</p>
				</v-card-text>

				<CatalogueList
					v-if="browsing?.serviceId === service.id"
					:busy="busy"
					:entries="catalogue"
					:loading="catalogueLoading"
					@pull="pullEntry"
				/>

				<v-card-actions>
					<v-btn data-test="peer-browse" variant="text" @click="browse(service.id)">
						{{ $t('peer.browse') }}
					</v-btn>

					<v-btn
						:to="{ name: 'library', query: { serviceId: service.id } }"
						variant="text"
					>
						{{ $t('peer.open_in_library') }}
					</v-btn>

					<v-spacer />

					<v-btn
						data-test="peer-pull-service"
						:loading="busy"
						variant="tonal"
						@click="pullService(service)"
					>
						{{ $t('peer.pull_missing') }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</template>
	</div>
</template>

<style lang="scss">
	.peer {
		&_node-id {
			// The whole identifier matters when it is being compared with another
			// gateway's, so it wraps rather than being cut.
			overflow-wrap: anywhere;
		}

		&_details {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}
	}
</style>
