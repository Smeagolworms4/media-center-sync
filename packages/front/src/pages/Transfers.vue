<script lang="ts" setup>
	import type { Transfer } from '@mcs/shared';
	import { EventName, FINISHED_TRANSFER_STATES, HistoryView, TransferState } from '@mcs/shared';
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
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
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
	 *
	 * It opens on what is still moving. A finished transfer is not deleted and not
	 * hidden: it is one click away under "Finished", which is said on the screen rather
	 * than left to be discovered, because somebody who believes their history was
	 * destroyed will not trust the next screen either. The retention that eventually
	 * removes those rows is a separate, much slower thing — thirty days for what
	 * succeeded, six months for what failed.
	 */
	const transfersStore = useTransfersStore();
	const syncStore = useSyncStore();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();
	const router = useRouter();
	const { t } = useI18n();
	const events = useEvents();
	const { notify, tryCallback } = useNotifier();
	/**
	 * The libraries a pull may be sent to, and the ones left out with the reason why.
	 *
	 * The same composable the dashboard's zone uses, rather than the store's writable
	 * list: a library on a friend's server is writable *for them*, and offering it here
	 * would accept a transfer that reports success and produces nothing anybody can
	 * watch. Saying why a name is missing matters as much as leaving it out — a list
	 * somebody's own shelf has silently vanished from reads as a bug.
	 */
	const { destinations, rejected } = useDestinationLibraries();

	const state = queryRef<TransferState>('state', queryTypes.stringEnum({
		values: Object.values(TransferState),
	}));
	/**
	 * In the URL, so that a link to this screen carries which half it was showing.
	 *
	 * The default is the live half rather than everything: on a gateway that has been
	 * running for a month the first page is entirely finished work, and the one
	 * transfer actually moving is on page four.
	 */
	const view = queryRef<HistoryView>('view', queryTypes.stringEnum({
		values: Object.values(HistoryView),
		defaultValue: HistoryView.LIVE,
	}));
	/**
	 * Asking for a finished state overrules the live default.
	 *
	 * The two controls can contradict each other — "live" and "done" describe no
	 * transfer at all — and the gateway answers that honestly with an empty page.
	 * Honest is not helpful here: somebody who picks "Failed" is asking to see the
	 * failures, not to be told there are none. Computed rather than a watcher on
	 * purpose, so that a link somebody was sent carrying `?state=failed` opens on the
	 * failures too, instead of on an empty list nothing on the screen explains.
	 */
	const effectiveView = computed(() => {
		const chosen = view.value ?? HistoryView.LIVE;
		const asksForFinished = !!state.value && FINISHED_TRANSFER_STATES.includes(state.value);

		return chosen === HistoryView.LIVE && asksForFinished ? HistoryView.ALL : chosen;
	});

	const page = queryRef<number>('page', queryTypes.integer({ defaultValue: 0 }));
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 20 }));

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	const retargeting = ref<Transfer | null>(null);
	const targetLibraryId = ref<string | null>(null);
	const retargetBusy = ref(false);
	const resumingAll = ref(false);

	/**
	 * Whether pressing the button will move bytes or rewrite a row.
	 *
	 * The single most important thing this dialog says. A transfer that has not landed
	 * yet is writing into the scratch directory and its destination is not read until
	 * the very end, so changing it costs nothing and interrupts nothing. One that has
	 * landed is in a library, and the same button is a real copy between two real
	 * filesystems that can take three quarters of an hour on a season. Offering both
	 * under one unqualified "move" is how somebody starts forty gigabytes of disk
	 * traffic believing they corrected a form field.
	 */
	const movesBytes = computed(() => retargeting.value?.state === TransferState.DONE);

	// The path under the name, because a choice made against `Shows` and a choice made
	// against `/mnt/nas/shows` are not the same choice on a gateway with two of each.
	// The marks ride along on the same `item-props`, which is how the offer itself can
	// be read back — "only libraries this gateway writes into are proposed" is a
	// statement about the options, and nothing else on the screen shows them.
	const destinationItems = computed(() => destinations.value.map(one => ({
		'value': one.id,
		'title': one.name,
		'subtitle': one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
		'data-test': 'retarget-option',
		'data-library': one.id,
	})));

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
					view: effectiveView.value,
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

	watch([state, view, limit], () => {
		page.value = 0;
		void load();
	});

	watch(page, () => {
		void load();
	});

	// `item-props`, so an option carries a mark of its own: the labels are translated
	// and a journey that picked one by its wording would break the day the interface
	// is read in another language.
	const stateItems = computed(() => Object.values(TransferState).map(value => ({
		'value': value,
		'title': t(`transfer.state.${value}`),
		'data-test': 'transfer-state-option',
		'data-value': value,
	})));

	const viewItems = computed(() => Object.values(HistoryView).map(value => ({
		value,
		title: t(`history.view.${value}`),
	})));

	const viewModel = computed({
		get: () => effectiveView.value,
		set: (value: HistoryView) => {
			view.value = value;
		},
	});

	/** Said on the screen, so nobody has to guess that the finished rows still exist. */
	const showingLiveOnly = computed(() => viewModel.value === HistoryView.LIVE);

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
			scope: { itemIds: [transfer.itemId] },
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

	/**
	 * Send this transfer somewhere else, rather than planning the item again.
	 *
	 * Re-planning was what this button used to do, and it was the wrong answer to the
	 * question being asked: it starts the item over from its sources, so a season three
	 * quarters downloaded into the wrong library would be fetched again from the top.
	 * The gateway knows how to re-point a transfer where it stands — one row write
	 * before it lands, a tracked move after — so that is what is asked of it.
	 */
	const confirmRetarget = tryCallback(async () => {
		if (!retargeting.value || !targetLibraryId.value) {
			return;
		}
		retargetBusy.value = true;
		try {
			await transfersStore.setDestination(retargeting.value.id, targetLibraryId.value);
			void notify(movesBytes.value ? 'transfer.retarget.moved' : 'transfer.retarget.repointed');
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
				<v-btn-toggle
					v-model="viewModel"
					class="transfers_view"
					data-test="transfer-view"
					density="compact"
					mandatory
					variant="outlined"
				>
					<v-btn
						v-for="item of viewItems"
						:key="item.value"
						:data-test="`transfer-view-${item.value}`"
						size="small"
						:value="item.value"
					>
						{{ item.title }}
					</v-btn>
				</v-btn-toggle>

				<v-select
					v-model="state"
					class="transfers_filter"
					clearable
					data-test="transfer-state-filter"
					density="compact"
					hide-details
					item-props
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
				:text="showingLiveOnly ? $t('history.empty_live_text') : $t('transfer.empty_text')"
				:title="showingLiveOnly ? $t('history.empty_live_title') : $t('transfer.empty_title')"
			>
				<v-btn
					v-if="showingLiveOnly"
					data-test="transfer-see-finished"
					variant="tonal"
					@click="viewModel = HistoryView.FINISHED"
				>
					{{ $t('history.see_finished') }}
				</v-btn>
			</EmptyState>

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

			<p
				v-if="showingLiveOnly && transfers.length > 0"
				class="text-caption text-medium-emphasis mt-2"
				data-test="transfer-history-hint"
			>
				{{ $t('history.hint_transfers') }}
			</p>
		</template>

		<Window
			:max-width="560"
			:model-value="retargeting !== null"
			:title="$t('transfer.retarget.title')"
			@update:model-value="retargeting = null"
		>
			<p class="text-body-2 mb-1">{{ retargeting?.title }}</p>

			<!--
				Which of the two operations this is, said before the field and not after
				the click. The wording is the confirmation: a transfer still downloading
				is being re-pointed and nothing is copied, while a file already in a
				library is about to be moved between two filesystems.
			-->
			<p
				class="text-body-2 text-medium-emphasis mb-4"
				data-test="retarget-hint"
			>
				{{ movesBytes ? $t('transfer.retarget.hint_move') : $t('transfer.retarget.hint_repoint') }}
			</p>

			<v-select
				v-model="targetLibraryId"
				data-test="retarget-library"
				item-props
				item-title="title"
				item-value="value"
				:items="destinationItems"
				:label="$t('transfer.retarget.library')"
			/>

			<p
				v-if="destinations.length === 0"
				class="text-caption text-warning mb-0 mt-2"
				data-test="retarget-none"
			>
				{{ $t('settings.destination.none') }}
			</p>

			<!--
				A shelf somebody expects to see and cannot is a bug until it is explained.
				Listing the ones that were left out, with which of the two reasons applies,
				is the difference between "the gateway is broken" and "that disk is on a
				friend's machine".
			-->
			<p
				v-for="one of rejected"
				:key="one.id"
				class="text-caption text-medium-emphasis mb-0 mt-1"
				data-test="retarget-rejected"
			>
				{{ one.name }} ({{ one.serviceName }}) —
				{{ $t(`settings.destination.rejected.${one.reason}`) }}
			</p>

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
					{{ movesBytes ? $t('transfer.retarget.confirm_move') : $t('transfer.retarget.confirm') }}
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

		&_view {
			margin-right: 8px;
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
