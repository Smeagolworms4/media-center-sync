<script lang="ts" setup>
	import type { Transfer } from '@mcs/shared';
	import { EventName, TransferState } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { useRouter } from 'vue-router';
	import ByteSize from '@/components/common/ByteSize.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import Rate from '@/components/common/Rate.vue';
	import StatTile from '@/components/common/StatTile.vue';
	import Pagination from '@/components/paginate/Pagination.vue';
	import TransferRow from '@/components/transfer/TransferRow.vue';
	import Window from '@/components/Window.vue';
	import { TransferAction } from '@/composables/useTransferError';
	import { useEvents } from '@/hooks/useEvents';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';
	import { useTransfersStore } from '@/stores/transfers';

	defineOptions({ name: 'TransfersPage' });

	/**
	 * The queue.
	 *
	 * Rows are keyed by transfer identifier and their numbers come from the store's
	 * progress objects, which the stream mutates in place — so a frame every half
	 * second costs one style update per bar rather than a diff of the whole list.
	 */
	const transfersStore = useTransfersStore();
	const syncStore = useSyncStore();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();
	const router = useRouter();
	const { t } = useI18n();
	const events = useEvents();
	const { notify, tryCallback } = useNotifier();

	const state = queryRef<TransferState>('state', queryTypes.stringEnum({
		values: Object.values(TransferState),
	}));
	const page = queryRef<number>('page', queryTypes.integer({ defaultValue: 0 }));
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 20 }));

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	const retargeting = ref<Transfer | null>(null);
	const targetLibraryId = ref<string | null>(null);
	const retargetBusy = ref(false);
	const resumingAll = ref(false);

	const pageModel = computed({
		get: () => page.value ?? 0,
		set: (value: number) => {
			page.value = value;
		},
	});
	const limitModel = computed({
		get: () => limit.value ?? 20,
		set: (value: number) => {
			limit.value = value;
		},
	});

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				transfersStore.load({
					// The pagination control counts from zero; the API counts from one.
					page: (page.value ?? 0) + 1,
					limit: limit.value ?? 20,
					state: state.value,
				}),
				transfersStore.loadStats(),
			]);
		} catch {
			failed.value = true;
		}
	}

	onMounted(async () => {
		await Promise.all([
			librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			librariesStore.loadChecks().catch(() => undefined),
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
		]);
		await load();
	});

	watch([state, limit], () => {
		page.value = 0;
		void load();
	});

	watch(page, () => {
		void load();
	});

	const stateItems = computed(() => Object.values(TransferState).map(value => ({
		value,
		title: t(`transfer.state.${value}`),
	})));

	const transfers = computed(() => transfersStore.transfers);

	const pausedTransfers = computed(
		() => transfers.value.filter(one => one.state === TransferState.PAUSED));

	/**
	 * A queue that is entirely paused is a state, not an empty one: nothing moves,
	 * every bar keeps its position, and the only thing missing is somebody pressing
	 * resume. Said once at the top rather than repeated on every row.
	 */
	const queuePaused = computed(
		() => transfersStore.stats.paused > 0 && transfersStore.stats.active === 0);

	const resumeAll = tryCallback(async () => {
		resumingAll.value = true;
		try {
			for (const transfer of pausedTransfers.value) {
				await transfersStore.resume(transfer.id);
			}
			void notify('transfer.resumed_all');
		} finally {
			resumingAll.value = false;
		}
	});

	/**
	 * A verification answers a question somebody asked minutes ago, possibly from
	 * another tab, so it is worth a notification even when nothing else changes:
	 * a clean answer means the source was fine and the problem is elsewhere.
	 */
	events.on(EventName.TRANSFER_VERIFIED, verification => {
		void notify(
			verification.ok ? 'transfer.verify_ok' : 'transfer.verify_corrupt',
			verification.ok ? 'success' : 'warning',
		);
	});

	// Only a revalidation that decided something is worth interrupting for; the
	// rest are history, and the expanded row already shows them.
	events.on(EventName.TRANSFER_REVALIDATED, revalidation => {
		if (revalidation.action) {
			void notify('transfer.revalidated', 'warning');
		}
	});

	function progressOf (transfer: Transfer) {
		return transfersStore.progress[transfer.id] ?? {
			id: transfer.id,
			state: transfer.state,
			bytesDone: transfer.bytesDone,
			bytesTotal: transfer.bytesTotal,
			rate: transfer.rate,
			etaSeconds: transfer.etaSeconds,
			chunksDone: transfer.chunksDone,
			chunksTotal: transfer.chunksTotal,
			sourceCount: transfer.sources?.length ?? 0,
		};
	}

	/**
	 * Planning the item again is how "look for another source" is expressed: the
	 * gateway re-picks the sources from the priority order, which is exactly what a
	 * source that has gone away calls for — and what a retry would refuse to do.
	 */
	const replan = tryCallback(async (transfer: Transfer, libraryId: string | null) => {
		await syncStore.run({
			itemIds: [transfer.itemId],
			...(libraryId ? { targetLibraryId: libraryId } : {}),
		});
		void notify('transfer.replanned');
	});

	const handle = tryCallback(async (action: TransferAction, transfer: Transfer) => {
		busyId.value = transfer.id;
		try {
			switch (action) {
			case TransferAction.PAUSE: {
				await transfersStore.pause(transfer.id);
				break;
			}
			case TransferAction.RESUME: {
				await transfersStore.resume(transfer.id);
				break;
			}
			case TransferAction.CANCEL: {
				await transfersStore.cancel(transfer.id);
				break;
			}
			case TransferAction.RETRY: {
				await transfersStore.retry(transfer.id);
				break;
			}
			case TransferAction.REPAIR: {
				await transfersStore.repair(transfer.id);
				break;
			}
			case TransferAction.VERIFY: {
				// No toast here: the answer lands in the row itself, and the gateway
				// also announces it — notifying as well would say it twice.
				await transfersStore.verify(transfer.id);
				break;
			}
			case TransferAction.ANOTHER_SOURCE: {
				await replan(transfer, null);
				break;
			}
			case TransferAction.ANOTHER_TARGET: {
				// The target is a choice, so it is asked for rather than guessed.
				retargeting.value = transfer;
				targetLibraryId.value = null;
				break;
			}
			case TransferAction.FIX_SERVICE: {
				const serviceId = transfer.sources[0]?.serviceId;
				await (serviceId
					? router.push({ name: 'service', params: { id: serviceId } })
					: router.push({ name: 'services' }));
				break;
			}
			}
		} finally {
			busyId.value = null;
		}
	});

	const confirmRetarget = tryCallback(async () => {
		if (!retargeting.value || !targetLibraryId.value) {
			return;
		}
		retargetBusy.value = true;
		try {
			await replan(retargeting.value, targetLibraryId.value);
			retargeting.value = null;
		} finally {
			retargetBusy.value = false;
		}
	});
</script>

<template>
	<div class="page-container transfers">
		<PageHeader
			icon="mdi-transfer-down"
			:loading="transfersStore.loading"
			:subtitle="$t('transfer.subtitle')"
			:title="$t('pages.transfers')"
		>
			<template #actions>
				<v-select
					v-model="state"
					class="transfers_filter"
					clearable
					data-test="transfer-state-filter"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="stateItems"
					:label="$t('transfer.filter_state')"
				/>

				<v-btn
					:loading="transfersStore.loading"
					prepend-icon="mdi-refresh"
					variant="text"
					@click="load"
				>
					{{ $t('actions.refresh') }}
				</v-btn>
			</template>
		</PageHeader>

		<v-alert
			v-if="queuePaused"
			class="mb-3"
			data-test="queue-paused"
			density="comfortable"
			type="info"
			variant="tonal"
		>
			<div class="transfers_pausedBanner">
				<span>{{ $t('transfer.queue_paused', { count: transfersStore.stats.paused }) }}</span>

				<v-spacer />

				<v-btn
					color="primary"
					data-test="transfer-resume-all"
					:disabled="pausedTransfers.length === 0"
					:loading="resumingAll"
					prepend-icon="mdi-play"
					size="small"
					variant="tonal"
					@click="resumeAll"
				>
					{{ $t('transfer.resume_all') }}
				</v-btn>
			</div>
		</v-alert>

		<v-row data-test="transfer-stats" density="compact">
			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-play-circle-outline"
					:title="$t('transfer.stats.active')"
					:value="transfersStore.stats.active"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-tray-full"
					:title="$t('transfer.stats.queued')"
					:value="transfersStore.stats.queued"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-pause-circle-outline"
					:title="$t('transfer.stats.paused')"
					:value="transfersStore.stats.paused"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-alert-circle-outline"
					:title="$t('transfer.stats.failed')"
					:tone="transfersStore.stats.failed > 0 ? 'error' : 'neutral'"
					:value="transfersStore.stats.failed"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile icon="mdi-speedometer" :title="$t('transfer.stats.rate')">
					<template #default>
						<p class="text-caption text-medium-emphasis mb-0">
							{{ $t('transfer.stats.remaining') }}
							<ByteSize :bytes="transfersStore.stats.bytesRemaining" />
						</p>
					</template>

					<template #value><Rate :rate="transfersStore.stats.rate" /></template>
				</StatTile>
			</v-col>
		</v-row>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<EmptyState
				v-if="!transfersStore.loading && transfers.length === 0"
				icon="mdi-download-off-outline"
				:text="$t('transfer.empty_text')"
				:title="$t('transfer.empty_title')"
			/>

			<div v-else class="transfers_list mt-3" data-test="transfer-list">
				<TransferRow
					v-for="transfer of transfers"
					:key="transfer.id"
					:busy="busyId === transfer.id"
					:progress="progressOf(transfer)"
					:transfer="transfer"
					@action="handle"
				/>
			</div>

			<Pagination
				v-if="transfers.length > 0"
				v-model:limit="limitModel"
				v-model:page="pageModel"
				class="mt-2"
				:label="$t('components.paginate.table.lines_per_page')"
				:total="transfersStore.pagination.total"
			/>
		</template>

		<Window
			:max-width="520"
			:model-value="retargeting !== null"
			:title="$t('transfer.retarget.title')"
			@update:model-value="retargeting = null"
		>
			<p class="text-body-2 mb-4">{{ $t('transfer.retarget.hint') }}</p>

			<v-select
				v-model="targetLibraryId"
				data-test="retarget-library"
				item-title="name"
				item-value="id"
				:items="librariesStore.writableLibraries"
				:label="$t('transfer.retarget.library')"
			/>

			<template #actions>
				<v-spacer />

				<v-btn variant="text" @click="retargeting = null">{{ $t('actions.cancel') }}</v-btn>

				<v-btn
					color="primary"
					data-test="retarget-confirm"
					:disabled="!targetLibraryId"
					:loading="retargetBusy"
					@click="confirmRetarget"
				>
					{{ $t('transfer.retarget.confirm') }}
				</v-btn>
			</template>
		</Window>
	</div>
</template>

<style lang="scss">
	.transfers {
		&_filter {
			min-width: 180px;
		}

		&_pausedBanner {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		&_list {
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
	}
</style>
