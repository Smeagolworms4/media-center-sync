<script lang="ts" setup>
	import { MediaServiceStatus, PeerStatus, Right, SyncState } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import Rate from '@/components/common/Rate.vue';
	import StatTile from '@/components/common/StatTile.vue';
	import LibraryHints from '@/components/library/LibraryHints.vue';
	import JobRow from '@/components/sync/JobRow.vue';
	import UnconfiguredPlacements from '@/components/transfer/UnconfiguredPlacements.vue';
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSettingsStore } from '@/stores/settings';
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
	const settingsStore = useSettingsStore();
	const { notify, tryCallback } = useNotifier();
	const { destinations } = useDestinationLibraries();

	const loading = ref(true);
	const failed = ref(false);
	const missingCount = ref<number | null>(null);
	/** Downloaded, on the disk, and not yet in any media server's index. */
	const awaitingCount = ref<number | null>(null);
	/** On the disk long enough that no ordinary scan schedule explains it any more. */
	const notIndexedCount = ref<number | null>(null);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			await Promise.all([
				servicesStore.load(),
				librariesStore.load(),
				librariesStore.loadCategories(),
				librariesStore.loadChecks(),
				// Failing to read the hints leaves the dashboard exactly as it was before
				// they existed, which is better than a home page that will not draw
				// because the line explaining it could not be fetched.
				librariesStore.loadHints().catch(() => undefined),
				peersStore.load(),
				transfersStore.load({ page: 1, limit: 10 }),
				transfersStore.loadStats(),
				transfersStore.loadUnconfigured(),
				syncStore.loadJobs({ page: 1, limit: 5 }),
				// Counted rather than searched: the answer lives in the pagination, and
				// pulling a page of forty thousand missing episodes to count them would
				// not. Three separate questions on purpose — what is still to fetch, what
				// has been fetched and is waiting, and what a server never took — because
				// only the first is a list anybody can act on by downloading.
				mediaStore.count([SyncState.MISSING])
					.then(total => {
						missingCount.value = total;
					}),
				mediaStore.count([SyncState.AWAITING_INDEX])
					.then(total => {
						awaitingCount.value = total;
					}),
				mediaStore.count([SyncState.NOT_INDEXED])
					.then(total => {
						notIndexedCount.value = total;
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
		/*
		 * A file on the disk that no media server ever took.
		 *
		 * It belongs here and not on a tile because it is never normal and it is always
		 * a misconfiguration somebody has to go and fix — the library the gateway writes
		 * into is not the directory the server scans, or that server's scanner is off.
		 * Nothing else reports it: the transfer succeeded, so there is no failure, no
		 * error and no log line anybody would go looking for.
		 */
		...((notIndexedCount.value ?? 0) > 0
			? [{
				key: 'not-indexed',
				icon: 'mdi-database-alert-outline',
				text: 'dashboard.problem.not_indexed',
				params: { count: notIndexedCount.value as number },
				to: { name: 'library', query: { states: SyncState.NOT_INDEXED } },
			}]
			: []),
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

	/**
	 * The categories, which is what the library screen is made of.
	 *
	 * A dashboard that counts services and transfers and never names a single library
	 * sends everybody through the navigation to find out what is in there. These are
	 * the same merged bands the wall draws, in the same order, and each one opens on
	 * its own — so the first click from the home page can be the one people actually
	 * want.
	 */
	const categories = computed(() => librariesStore.orderedCategories);

	/**
	 * Put one organisation hint away for good.
	 *
	 * Through the store, because it is a setting on the gateway rather than something
	 * this browser remembers: dismissed on the laptop and back on the phone is a notice
	 * nobody can be rid of.
	 */
	const dismissHint = tryCallback(
		async (key: string) => {
			await librariesStore.dismissHint(key);
		},
	);

	/** Move this one file. Cheap while it is still downloading, a real move once it landed. */
	const move = tryCallback(
		async (transferId: string, libraryId: string, folder: string | null = null) => {
			await transfersStore.setDestination(transferId, libraryId, folder);
			await notify('transfer.unconfigured.moved');
		},
	);

	/**
	 * Point a whole category somewhere, which is what actually fixes this.
	 *
	 * The file already on disk is left where it is on purpose: this answers "where do
	 * the next ones go", and silently moving what has already been indexed would be a
	 * second, larger action nobody asked for. The row stays, so the move is still one
	 * click away.
	 */
	const remember = tryCallback(
		async (categoryKey: string, libraryId: string) => {
			await settingsStore.save({
				categoryTargets: {
					...settingsStore.settings?.categoryTargets,
					[categoryKey]: libraryId,
				},
			});
			await notify('transfer.unconfigured.remembered');
		},
	);
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
			<LibraryHints
				class="mb-4"
				:dismissable="$isGranted(Right.SETTINGS_MANAGE)"
				:hints="librariesStore.hints"
				@dismiss="dismissHint"
			/>

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
					>
						<!--
							Under the missing figure rather than beside it: it is the same
							question — what am I short of — with the answer "nothing, wait a
							moment". Somebody who has just watched a download finish looks
							here first, and a tile that only counted what is still absent
							would tell them it is still absent.
						-->
						<p
							v-if="(awaitingCount ?? 0) > 0"
							class="text-caption mb-0"
							data-test="tile-awaiting"
						>
							<router-link
								class="dashboard_awaiting"
								:to="{ name: 'library', query: { states: SyncState.AWAITING_INDEX } }"
							>
								{{ $t('dashboard.awaiting_index', { count: awaitingCount }) }}
							</router-link>
						</p>
					</StatTile>
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
				<v-col cols="12">
					<UnconfiguredPlacements
						:destinations="destinations"
						:items="transfersStore.unconfigured"
						:loading="loading"
						@move="move"
						@remember="remember"
					/>
				</v-col>

				<v-col v-if="categories.length > 0" cols="12">
					<v-card class="dashboard_card" data-test="dashboard-categories">
						<v-card-title class="text-subtitle-1">{{ $t('library.categories') }}</v-card-title>

						<v-card-subtitle>{{ $t('library.categories_hint') }}</v-card-subtitle>

						<v-card-text class="dashboard_categories">
							<v-chip
								v-for="category of categories"
								:key="category.key"
								:data-local="category.local"
								data-test="dashboard-category"
								label
								:prepend-icon="category.local ? 'mdi-harddisk' : 'mdi-cloud-outline'"
								:to="{ name: 'library', query: { category: category.key } }"
								variant="tonal"
							>
								{{ category.name }}

								<span class="dashboard_categoryCount text-caption text-medium-emphasis ml-2">
									{{ category.itemCount }}
								</span>
							</v-chip>
						</v-card-text>
					</v-card>
				</v-col>

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

		&_awaiting {
			color: rgb(var(--v-theme-state-awaiting-index));
			text-decoration: none;
		}

		&_categories {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
	}
</style>
