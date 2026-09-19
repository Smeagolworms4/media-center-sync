<script lang="ts" setup>
	import { MediaServiceStatus, PeerStatus, SyncState } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import Rate from '@/components/common/Rate.vue';
	import StatTile from '@/components/common/StatTile.vue';
	import JobRow from '@/components/sync/JobRow.vue';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';
	import { useTransfersStore } from '@/stores/transfers';

	defineOptions({ name: 'DashboardPage' });

	/**
	 * What is worth knowing at a glance.
	 *
	 * Every tile is a link, because the figure is never the end of the thought: the
	 * question after "seven missing" is "which seven", and a dashboard that cannot
	 * answer it is a screenshot.
	 */
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const mediaStore = useMediaStore();
	const peersStore = usePeersStore();
	const syncStore = useSyncStore();
	const transfersStore = useTransfersStore();

	const loading = ref(true);
	const failed = ref(false);
	const missingCount = ref<number | null>(null);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			await Promise.all([
				servicesStore.load(),
				librariesStore.load(),
				librariesStore.loadChecks(),
				peersStore.load(),
				transfersStore.load({ page: 1, limit: 10 }),
				transfersStore.loadStats(),
				syncStore.loadJobs({ page: 1, limit: 5 }),
				// One row is enough: the count lives in the pagination, and pulling a
				// page of forty thousand missing episodes to count them would not.
				mediaStore.search({ states: [SyncState.MISSING], page: 1, limit: 1 })
					.then(result => {
						missingCount.value = result.pagination?.total ?? 0;
					}),
			]);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	/** A service that answered and refused us is as unusable as one that is down. */
	const OFFLINE_STATUSES: Set<MediaServiceStatus> = new Set([
		MediaServiceStatus.OFFLINE,
		MediaServiceStatus.UNAUTHORIZED,
	]);

	const offlineServices = computed(
		() => servicesStore.services.filter(one => OFFLINE_STATUSES.has(one.status)));

	const unreachablePeers = computed(() => peersStore.peers.filter(
		one => one.status === PeerStatus.UNREACHABLE));

	const unwritable = computed(() => librariesStore.unwritableChecks);

	const failedTransfers = computed(() => transfersStore.failed);

	/** Everything that needs somebody to do something, in one place. */
	const problems = computed(() => [
		...unwritable.value.map(check => ({
			key: `library-${check.libraryId}`,
			icon: 'mdi-folder-alert-outline',
			text: 'dashboard.problem.library_not_writable',
			params: { name: check.name },
			to: { name: 'services' },
		})),
		...offlineServices.value.map(service => ({
			key: `service-${service.id}`,
			icon: 'mdi-server-off',
			text: service.status === MediaServiceStatus.UNAUTHORIZED
				? 'dashboard.problem.service_unauthorized'
				: 'dashboard.problem.service_offline',
			params: { name: service.name },
			to: { name: 'service', params: { id: service.id } },
		})),
		...unreachablePeers.value.map(peer => ({
			key: `peer-${peer.id}`,
			icon: 'mdi-account-off-outline',
			text: 'dashboard.problem.peer_unreachable',
			params: { name: peer.name },
			to: { name: 'peer', params: { id: peer.id } },
		})),
		...failedTransfers.value.map(transfer => ({
			key: `transfer-${transfer.id}`,
			icon: 'mdi-download-off-outline',
			text: 'dashboard.problem.transfer_failed',
			params: { name: transfer.title },
			to: { name: 'transfers' },
		})),
	]);

	const recentJobs = computed(() => syncStore.jobs.slice(0, 5));
</script>

<template>
	<div class="page-container dashboard">
		<PageHeader
			icon="mdi-view-dashboard-outline"
			:loading="loading"
			:subtitle="$t('dashboard.subtitle')"
			:title="$t('pages.dashboard')"
		>
			<template #actions>
				<v-btn
					data-test="dashboard-refresh"
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
			<v-row density="compact">
				<v-col cols="12" md="3" sm="6">
					<StatTile
						data-test="tile-services"
						icon="mdi-server-network"
						:loading="loading"
						:subtitle="offlineServices.length > 0
							? $t('dashboard.services_offline', { count: offlineServices.length })
							: $t('dashboard.services_all_online')"
						:title="$t('dashboard.services')"
						:to="{ name: 'services' }"
						:tone="offlineServices.length > 0 ? 'warning' : 'neutral'"
						:value="servicesStore.services.length"
					/>
				</v-col>

				<v-col cols="12" md="3" sm="6">
					<StatTile
						data-test="tile-missing"
						icon="mdi-cloud-download-outline"
						:loading="loading"
						:subtitle="$t('dashboard.missing_hint')"
						:title="$t('dashboard.missing')"
						:to="{ name: 'library', query: { states: SyncState.MISSING } }"
						:value="missingCount"
					/>
				</v-col>

				<v-col cols="12" md="3" sm="6">
					<StatTile
						data-test="tile-transfers"
						icon="mdi-transfer-down"
						:loading="loading"
						:title="$t('dashboard.active_transfers')"
						:to="{ name: 'transfers' }"
						:tone="transfersStore.stats.failed > 0 ? 'error' : 'neutral'"
						:value="transfersStore.stats.active"
					>
						<p class="text-caption text-medium-emphasis mb-0">
							<Rate :rate="transfersStore.stats.rate" />
							· {{ $t('dashboard.queued', { count: transfersStore.stats.queued }) }}
						</p>
					</StatTile>
				</v-col>

				<v-col cols="12" md="3" sm="6">
					<StatTile
						data-test="tile-peers"
						icon="mdi-account-network-outline"
						:loading="loading"
						:subtitle="unreachablePeers.length > 0
							? $t('dashboard.peers_unreachable', { count: unreachablePeers.length })
							: null"
						:title="$t('dashboard.peers')"
						:to="{ name: 'peers' }"
						:tone="unreachablePeers.length > 0 ? 'warning' : 'neutral'"
						:value="peersStore.peers.length"
					/>
				</v-col>
			</v-row>

			<v-row class="mt-2" density="compact">
				<v-col cols="12" md="6">
					<v-card class="dashboard_card" data-test="dashboard-problems">
						<v-card-title class="text-subtitle-1">{{ $t('dashboard.needs_attention') }}</v-card-title>

						<v-card-text>
							<EmptyState
								v-if="problems.length === 0"
								icon="mdi-check-circle-outline"
								:text="$t('dashboard.all_well_text')"
								:title="$t('dashboard.all_well_title')"
							/>

							<v-list v-else density="compact">
								<v-list-item
									v-for="problem of problems"
									:key="problem.key"
									data-test="dashboard-problem"
									:prepend-icon="problem.icon"
									:title="$t(problem.text, problem.params)"
									:to="problem.to"
								/>
							</v-list>
						</v-card-text>
					</v-card>
				</v-col>

				<v-col cols="12" md="6">
					<v-card class="dashboard_card" data-test="dashboard-jobs">
						<v-card-title class="text-subtitle-1">{{ $t('dashboard.recent_jobs') }}</v-card-title>

						<v-card-text>
							<EmptyState
								v-if="recentJobs.length === 0"
								icon="mdi-sync-off"
								:text="$t('dashboard.no_jobs_text')"
								:title="$t('dashboard.no_jobs_title')"
							>
								<v-btn :to="{ name: 'sync' }" variant="tonal">
									{{ $t('dashboard.go_to_sync') }}
								</v-btn>
							</EmptyState>

							<template v-else>
								<JobRow v-for="job of recentJobs" :key="job.id" :job="job" />

								<v-btn
									class="mt-3"
									:to="{ name: 'sync' }"
									variant="text"
								>
									{{ $t('dashboard.all_jobs') }}
								</v-btn>
							</template>
						</v-card-text>
					</v-card>
				</v-col>
			</v-row>
		</template>
	</div>
</template>

<style lang="scss">
	.dashboard {
		&_card {
			height: 100%;
		}
	}
</style>
