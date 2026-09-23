<script lang="ts" setup>
	import type { Transfer, TransferProgress as TransferProgressShape } from '@mcs/shared';
	import { TransferState, TransferTransport } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import Duration from '@/components/common/Duration.vue';
	import Rate from '@/components/common/Rate.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import ChunkMap from '@/components/transfer/ChunkMap.vue';
	import RevalidationList from '@/components/transfer/RevalidationList.vue';
	import TransferActions from '@/components/transfer/TransferActions.vue';
	import TransferProgress from '@/components/transfer/TransferProgress.vue';
	import TransferSources from '@/components/transfer/TransferSources.vue';
	import { describeTransferError, type TransferAction } from '@/composables/useTransferError';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useTransfersStore } from '@/stores/transfers';

	/**
	 * One transfer in the queue.
	 *
	 * The chunk map and the revalidation history are only fetched when the row is
	 * opened: a queue of forty transfers would otherwise pull forty chunk lists of
	 * several thousand entries each to draw rows nobody expanded. Once fetched they
	 * live in the store, so a verification or a revalidation arriving on the stream
	 * updates an open row without it asking again.
	 */
	const props = withDefaults(defineProps<{
		transfer: Transfer;
		progress: TransferProgressShape;
		busy?: boolean;
	}>(), {
		busy: false,
	});

	const emit = defineEmits<{ action: [action: TransferAction, transfer: Transfer] }>();

	const transfersStore = useTransfersStore();
	const librariesStore = useLibrariesStore();

	/**
	 * Where this file is going, named rather than left to be guessed.
	 *
	 * The row offered "choose another library" beside a line that never said which one
	 * it was going to, so the only way to find out was to open the row and read a path.
	 * A control that offers to change something without showing it is asking somebody to
	 * decide blind.
	 *
	 * The library's name and not the path, for the same reason the whole placement area
	 * uses libraries: the name is what somebody recognises from their media server, and
	 * the path is already a line below for whoever wants it. A transfer landing in a
	 * folder no library covers has no name to give, and says so with the folder instead
	 * of with nothing.
	 */
	const destination = computed(() => {
		const id = props.transfer.targetLibraryId;

		if (id === null) {
			return null;
		}

		return librariesStore.libraries.find(one => one.id === id)?.name ?? null;
	});

	const expanded = ref(false);
	const details = ref(false);

	const descriptor = computed(
		() => (props.transfer.errorKind ? describeTransferError(props.transfer.errorKind) : null));

	const sources = computed(() => props.transfer.sources ?? []);
	const multiSource = computed(() => sources.value.length > 1);
	const swarming = computed(
		() => sources.value.some(one => one.transport === TransferTransport.SWARM));
	const unhealthy = computed(() => sources.value.filter(one => !one.healthy).length);

	/**
	 * A paused transfer is holding, not stalled. It keeps its bytes, its chunk map
	 * and its place in the queue, and the only thing it is waiting for is somebody
	 * to say go — which is worth stating, because a bar that simply stopped moving
	 * is the thing people read as a broken download.
	 */
	const paused = computed(() => props.transfer.state === TransferState.PAUSED);

	const chunks = computed(() => transfersStore.chunks[props.transfer.id] ?? []);
	const revalidations = computed(() => transfersStore.revalidations[props.transfer.id] ?? []);
	const verification = computed(() => transfersStore.verifications[props.transfer.id] ?? null);

	async function toggle (): Promise<void> {
		expanded.value = !expanded.value;
		if (!expanded.value || details.value) {
			return;
		}
		details.value = true;
		await Promise.all([
			transfersStore.loadChunks(props.transfer.id).catch(() => undefined),
			transfersStore.loadRevalidations(props.transfer.id).catch(() => undefined),
		]);
	}
</script>

<template>
	<v-card
		class="transfer-row"
		:class="{ 'transfer-row--paused': paused }"
		:data-state="transfer.state"
		data-test="transfer-row"
		variant="tonal"
	>
		<v-card-text>
			<div class="transfer-row_head">
				<v-btn
					class="transfer-row_toggle"
					data-test="transfer-expand"
					:icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
					size="small"
					variant="text"
					@click="toggle"
				/>

				<div class="transfer-row_title">
					<p class="text-subtitle-2 mb-0 text-break-anywhere">{{ transfer.title }}</p>

					<p class="text-caption text-medium-emphasis mb-0">
						<template v-if="sources.length === 0">{{ $t('transfer.no_source') }}</template>

						<template v-for="(source, index) of sources" :key="source.serviceId">
							<template v-if="index > 0"> · </template>
							{{ source.serviceName }}
							<template v-if="source.peerName">
								({{ $t('transfer.via_peer', { peer: source.peerName }) }})
							</template>
						</template>
					</p>
				</div>

				<v-spacer />

				<v-chip
					v-if="paused"
					color="state-unknown"
					data-test="transfer-paused"
					label
					prepend-icon="mdi-pause-circle-outline"
					size="small"
					variant="tonal"
				>
					{{ $t('transfer.paused_badge') }}
				</v-chip>

				<!--
					Several sources feeding one file is the feature; saying it only in
					the expanded view would hide the thing that explains the speed.
				-->
				<v-chip
					v-if="multiSource"
					color="state-syncing"
					data-test="transfer-multi-source"
					label
					:prepend-icon="swarming ? 'mdi-account-group-outline' : 'mdi-call-split'"
					size="small"
					variant="tonal"
				>
					{{ swarming
						? $t('transfer.swarm_sources', { count: sources.length })
						: $t('transfer.sources', { count: sources.length }, sources.length) }}
				</v-chip>

				<v-chip
					v-if="unhealthy > 0"
					color="state-conflict"
					data-test="transfer-unhealthy-sources"
					label
					size="small"
					variant="tonal"
				>
					{{ $t('transfer.unhealthy_sources', { count: unhealthy }) }}
				</v-chip>

				<span class="transfer-row_rate text-caption">
					<Rate :rate="progress.rate" />
				</span>

				<span class="transfer-row_eta text-caption text-medium-emphasis">
					<Duration v-if="progress.etaSeconds !== null" :seconds="progress.etaSeconds" />
					<template v-else>{{ $t('transfer.no_eta') }}</template>
				</span>
			</div>

			<TransferProgress class="mt-2" :progress="progress" />

			<p class="text-caption text-medium-emphasis mt-1 mb-0" data-test="transfer-destination-name">
				{{ destination
					? $t('transfer.going_to', { library: destination })
					: $t('transfer.going_to_folder', { path: transfer.targetPath }) }}
			</p>

			<p
				v-if="paused"
				class="transfer-row_pausedHint text-caption text-medium-emphasis mt-1 mb-0"
			>
				{{ $t('transfer.paused_hint') }}
			</p>

			<v-alert
				v-if="descriptor"
				class="mt-2"
				:data-kind="descriptor.kind"
				data-test="transfer-error"
				density="compact"
				type="error"
				variant="tonal"
			>
				<strong>{{ $t(descriptor.labelKey) }}</strong> — {{ $t(descriptor.helpKey) }}
			</v-alert>

			<v-alert
				v-if="verification"
				class="mt-2"
				data-test="transfer-verification"
				density="compact"
				:type="verification.ok ? 'success' : 'warning'"
				variant="tonal"
			>
				{{ verification.ok
					? $t('transfer.verification.ok', { count: verification.chunksChecked })
					: $t('transfer.verification.corrupt', { count: verification.chunksCorrupt }) }}
				<RelativeDate :date="verification.checkedAt" />
			</v-alert>

			<TransferActions
				:busy="busy"
				class="mt-2"
				:transfer="transfer"
				@action="emit('action', $event, transfer)"
			/>

			<v-expand-transition>
				<div v-if="expanded" class="transfer-row_details mt-3">
					<p class="text-caption text-medium-emphasis text-break-anywhere">
						{{ $t('transfer.target_path') }}: {{ transfer.targetPath }}
					</p>

					<p class="text-caption text-medium-emphasis mt-2 mb-1">
						{{ $t('transfer.sources_title') }}
					</p>

					<TransferSources :sources="sources" />

					<p class="text-caption text-medium-emphasis mt-3 mb-1">
						{{ $t('transfer.chunks.title') }}
					</p>

					<ChunkMap :chunks="chunks" :loading="!details" />

					<p class="text-caption text-medium-emphasis mt-3 mb-1">
						{{ $t('transfer.revalidation.title') }}
					</p>

					<RevalidationList :loading="!details" :revalidations="revalidations" />
				</div>
			</v-expand-transition>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.transfer-row {
		&--paused {
			opacity: 0.88;
		}

		&_head {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		&_title {
			min-width: 0;
		}

		&_rate,
		&_eta {
			white-space: nowrap;
		}
	}
</style>
