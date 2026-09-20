<script lang="ts" setup>
	import type { MediaService } from '@mcs/shared';
	import { MediaServiceMode, MediaServiceScope, MediaServiceType } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import Confirm from '@/components/Confirm.vue';
	import ServiceForm from '@/components/service/ServiceForm.vue';
	import ServiceStatusChip from '@/components/service/ServiceStatusChip.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useServicesStore } from '@/stores/services';

	defineOptions({ name: 'ServicesPage' });

	/**
	 * The registered media services.
	 *
	 * Reachability is shown next to the counts on purpose: a service that stopped
	 * answering keeps its item count, and a row that showed only the count would
	 * look identical to a healthy one while nothing it holds is reachable.
	 */
	const servicesStore = useServicesStore();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const dialogOpen = ref(false);
	const editing = ref<MediaService | null>(null);
	const removing = ref<MediaService | null>(null);
	const removingBusy = ref(false);
	const busyId = ref<string | null>(null);

	const services = computed(() => servicesStore.byPriority);

	/**
	 * The same list, in three bands — presentation only, nothing about the rows changes.
	 *
	 * Flat, the page read as one heap in which a Jellyfin we can write into, a friend's
	 * Plex we merely have an account on, and a friend's gateway all looked alike. They
	 * are not alike in the one way that decides what can be done with them: only the
	 * first can be the target of a pull, the second is read-only because it is somebody
	 * else's disk, and the third shows us what its owner chose to share and nothing more.
	 *
	 * `mode` already draws exactly that line, so the grouping invents no vocabulary of
	 * its own — and empty bands are dropped rather than shown empty, because a heading
	 * over nothing is a promise of a feature somebody has not set up.
	 */
	const ORDER = [MediaServiceMode.LOCAL, MediaServiceMode.REMOTE, MediaServiceMode.PEER];

	/**
	 * Which band a row belongs to, derived rather than read straight off `mode`.
	 *
	 * Filtering on `mode` alone made a row with no mode — an older record, a service
	 * registered before the field existed — belong to no band and vanish from the
	 * page entirely. A service that is registered and does not appear is worse than
	 * one in the wrong band: nothing says it is missing, and the only way to find it
	 * is to notice that a count no longer adds up.
	 *
	 * So the answer is total: `mode` when it is there, and the same distinction
	 * rebuilt from `type` and `scope` when it is not.
	 */
	function bandOf (service: MediaService): MediaServiceMode {
		if (service.mode) {
			return service.mode;
		}
		if (service.type === MediaServiceType.PEER) {
			return MediaServiceMode.PEER;
		}
		return service.scope === MediaServiceScope.LOCAL
			? MediaServiceMode.LOCAL
			: MediaServiceMode.REMOTE;
	}

	// Empty bands are dropped rather than shown empty: a heading over nothing is a
	// promise of a feature somebody has not set up.
	const groups = computed(() =>
		ORDER
			.map(mode => ({ mode, services: services.value.filter(one => bandOf(one) === mode) }))
			.filter(group => group.services.length > 0));

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await servicesStore.load();
		} catch {
			failed.value = true;
		}
	}

	onMounted(() => {
		void load();
	});

	function add (): void {
		editing.value = null;
		dialogOpen.value = true;
	}

	function edit (service: MediaService): void {
		editing.value = service;
		dialogOpen.value = true;
	}

	async function onSaved (): Promise<void> {
		dialogOpen.value = false;
		void notify('service.saved');
		await load();
	}

	const probe = tryCallback(async (service: MediaService) => {
		busyId.value = service.id;
		try {
			const result = await servicesStore.probeService(service.id);
			void notify(
				result.reachable && result.authenticated ? 'service.probe.ok_short' : 'service.probe.failed',
				result.reachable && result.authenticated ? 'success' : 'error',
			);
		} finally {
			busyId.value = null;
		}
	});

	const scan = tryCallback(async (service: MediaService) => {
		busyId.value = service.id;
		try {
			await servicesStore.scan(service.id);
			// The call answers 202: the work reports itself on the event stream, and
			// waiting for it here would time out on any library worth scanning.
			void notify('service.scan_started');
		} finally {
			busyId.value = null;
		}
	});

	const refresh = tryCallback(async (service: MediaService) => {
		busyId.value = service.id;
		try {
			await servicesStore.refresh(service.id);
			void notify('service.refresh_started');
		} finally {
			busyId.value = null;
		}
	});

	const confirmRemove = tryCallback(async () => {
		if (!removing.value) {
			return;
		}
		removingBusy.value = true;
		try {
			await servicesStore.remove(removing.value.id);
			void notify('service.removed');
			removing.value = null;
		} finally {
			removingBusy.value = false;
		}
	});

	function scanProgress (serviceId: string): number | null {
		const progress = servicesStore.scans[serviceId];
		if (!progress || !progress.itemsTotal) {
			return null;
		}
		return Math.min(100, (progress.itemsSeen / progress.itemsTotal) * 100);
	}
</script>

<template>
	<div class="page-container services">
		<PageHeader
			icon="mdi-server-network"
			:loading="servicesStore.loading"
			:subtitle="$t('service.subtitle')"
			:title="$t('pages.services')"
		>
			<template #actions>
				<v-btn
					color="primary"
					data-test="service-add"
					prepend-icon="mdi-plus"
					@click="add"
				>
					{{ $t('service.add') }}
				</v-btn>
			</template>
		</PageHeader>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<v-card v-if="!servicesStore.loading && services.length === 0">
				<EmptyState
					icon="mdi-server-off"
					:text="$t('service.empty_text')"
					:title="$t('service.empty_title')"
				>
					<v-btn color="primary" @click="add">{{ $t('service.add') }}</v-btn>
				</EmptyState>
			</v-card>

			<!--
				A card per family rather than one list with headings inside it.
				The three do not behave alike in the one way that decides what can be done
				with them — only ours can receive a pull, a server we have an account on is
				somebody else’s disk, and a peer shows what its owner chose to share. A
				heading inside a shared list states that; a card of its own makes it hard to
				miss when scanning the page.
			-->
			<template v-else>
				<v-card
					v-for="group of groups"
					:key="group.mode"
					class="services_card"
					:data-mode="group.mode"
					data-test="service-band"
				>
					<v-card-title class="text-subtitle-1">
						{{ $t(`service.mode.${group.mode}`) }}
						<v-chip class="ml-2" label size="x-small" variant="tonal">
							{{ group.services.length }}
						</v-chip>
					</v-card-title>

					<v-card-subtitle class="services_card_hint">
						{{ $t(`service.mode_hint.${group.mode}`) }}
					</v-card-subtitle>

					<v-list data-test="service-list" lines="three">
						<v-list-item
							v-for="service of group.services"
							:key="service.id"
							class="services_row"
							:data-id="service.id"
							:data-mode="bandOf(service)"
							data-test="service-row"
						>
							<template #prepend>
								<v-icon icon="mdi-server" size="28" />
							</template>

							<v-list-item-title class="services_name">
								<router-link
									class="services_link"
									:to="{ name: 'service', params: { id: service.id } }"
								>
									{{ service.name }}
								</router-link>

								<ServiceStatusChip class="ml-2" :status="service.status" />

								<v-chip class="ml-2" label size="small" variant="tonal">
									{{ $t(`service.scope.${service.scope}`) }}
								</v-chip>

								<v-chip class="ml-2" label size="small" variant="tonal">{{ service.type }}</v-chip>
							</v-list-item-title>

							<v-list-item-subtitle>
								<span class="text-break-anywhere">{{ service.baseUrl }}</span>
								· {{ $t('service.counts', {
									libraries: service.libraryCount,
									items: service.itemCount,
								}) }}
							</v-list-item-subtitle>

							<v-list-item-subtitle>
								{{ $t('service.last_scan') }} <RelativeDate :date="service.lastScanAt" />
								· {{ $t('service.last_probe') }} <RelativeDate :date="service.lastProbeAt" />
							</v-list-item-subtitle>

							<v-progress-linear
								v-if="scanProgress(service.id) !== null"
								class="mt-1"
								color="state-syncing"
								data-test="service-scan-progress"
								height="4"
								:model-value="scanProgress(service.id) ?? 0"
								rounded
							/>

							<template #append>
								<div class="services_actions">
									<v-btn
										data-test="service-row-probe"
										:loading="busyId === service.id"
										size="small"
										variant="text"
										@click="probe(service)"
									>
										{{ $t('service.action.probe') }}
									</v-btn>

									<v-btn
										data-test="service-scan"
										:loading="busyId === service.id"
										size="small"
										variant="text"
										@click="scan(service)"
									>
										{{ $t('service.action.scan') }}
									</v-btn>

									<v-btn
										data-test="service-refresh"
										:loading="busyId === service.id"
										size="small"
										variant="text"
										@click="refresh(service)"
									>
										{{ $t('service.action.refresh') }}
									</v-btn>

									<v-btn
										data-test="service-edit"
										icon="mdi-pencil-outline"
										size="small"
										variant="text"
										@click="edit(service)"
									/>

									<v-btn
										color="error"
										data-test="service-remove"
										icon="mdi-delete-outline"
										size="small"
										variant="text"
										@click="removing = service"
									/>
								</div>
							</template>
						</v-list-item>
					</v-list>
				</v-card>
			</template>
		</template>

		<Window
			v-model="dialogOpen"
			:max-width="720"
			:title="editing ? $t('service.edit') : $t('service.add')"
		>
			<ServiceForm
				:key="editing?.id ?? 'new'"
				:service="editing"
				@cancel="dialogOpen = false"
				@saved="onSaved"
			/>
		</Window>

		<Confirm
			:loading="removingBusy"
			:model-value="removing !== null"
			:text="$t('service.remove_confirm', { name: removing?.name ?? '' })"
			:title="$t('service.remove_title')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>
	</div>
</template>

<style lang="scss">
	.services {
		&_card {
			margin-bottom: $cardGap;

			&_hint {
				padding-bottom: 4px;
			}
		}

		&_row {
			padding-top: 10px;
			padding-bottom: 10px;
		}

		&_name {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
		}

		&_link {
			color: inherit;
			text-decoration: none;

			&:hover {
				text-decoration: underline;
			}
		}

		&_actions {
			display: flex;
			align-items: center;
			gap: 2px;
			flex-wrap: wrap;
			justify-content: flex-end;
		}
	}
</style>
