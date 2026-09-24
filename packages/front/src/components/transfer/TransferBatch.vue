<script lang="ts" setup>
	import type { TransferAction } from '@/composables/useTransferError';
	import type { Transfer, TransferProgress } from '@mcs/shared';
	import { FINISHED_TRANSFER_STATES, TransferState } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';
	import TransferRow from '@/components/transfer/TransferRow.vue';

	/**
	 * One run, shown the way a torrent is: one line, one destination, one percentage,
	 * and the files inside it a fold away.
	 *
	 * Fetching a season produced eleven rows in the queue, each with its own
	 * destination, its own progress bar and its own three buttons — so the answer to
	 * "how far is Spartacus" was eleven numbers to add up, and stopping it was eleven
	 * clicks. It is one piece of work made of many files, and that is what a batch says.
	 *
	 * A run of one file is not folded: a single row inside a container that says "one
	 * file" is a frame around nothing.
	 *
	 * **The grouping is of what the page holds**, deliberately. Paginating by run
	 * instead would mean a page of one batch and a page of eighty, and a queue screen
	 * that cannot say how many rows it will draw. A run longer than a page therefore
	 * shows as two batches; sorting by activity keeps its files together, since they
	 * were created in one act.
	 */
	const props = defineProps<{
		transfers: Transfer[];
		progress: (transfer: Transfer) => TransferProgress;
		busyId?: string | null;
	}>();

	const emit = defineEmits<{
		action: [action: TransferAction, transfer: Transfer];
		/** Send the whole run elsewhere, files already landed included. */
		retarget: [transfers: Transfer[]];
	}>();

	const expanded = ref(false);

	const bytes = computed(() => props.transfers.reduce(
		(total, one) => {
			const live = props.progress(one);

			return {
				done: total.done + live.bytesDone,
				total: total.total + live.bytesTotal,
			};
		},
		{ done: 0, total: 0 },
	));

	const percent = computed(
		() => (bytes.value.total > 0 ? Math.min(100, (bytes.value.done / bytes.value.total) * 100) : 0));

	const rate = computed(
		() => props.transfers.reduce((total, one) => total + props.progress(one).rate, 0));

	const finished = computed(
		() => props.transfers.filter(one => props.progress(one).state === TransferState.DONE).length);

	/**
	 * The folder every file of this run shares, which is where the run lands.
	 *
	 * Computed from the paths rather than stored, because a run has no destination of
	 * its own: each file is placed on its own, and they agree in practice because the
	 * placement puts a season in one library. Compared by whole path components — a
	 * prefix on the raw strings would call `/mnt/media2` a parent of `/mnt/media`.
	 */
	const destination = computed(() => {
		const parts = props.transfers.map(one => one.targetPath.split('/').slice(0, -1));

		if (parts.length === 0) {
			return null;
		}

		const [first, ...rest] = parts;
		let shared = first;

		for (const other of rest) {
			let index = 0;

			while (index < shared.length && index < other.length && shared[index] === other[index]) {
				index += 1;
			}

			shared = shared.slice(0, index);
		}

		return shared.join('/') || '/';
	});

	/** The title a run goes by: what it is fetching, taken from its first file. */
	const title = computed(() => props.transfers[0]?.title ?? '');

	const running = computed(
		() => props.transfers.filter(one => !FINISHED_TRANSFER_STATES.includes(one.state)));

	const busy = computed(() => props.transfers.some(one => one.id === props.busyId));

	/**
	 * One action over the whole run, applied to every file it still makes sense for.
	 *
	 * A finished file is skipped rather than refused: pressing pause on a season that is
	 * half done means "stop the rest", and answering with an error about the four that
	 * already landed would be answering a question nobody asked.
	 */
	function all (action: TransferAction): void {
		for (const transfer of running.value) {
			emit('action', action, transfer);
		}
	}
</script>

<template>
	<v-card class="transfer-batch" data-test="transfer-batch" variant="tonal">
		<v-card-text class="py-3">
			<div class="transfer-batch_head">
				<v-btn
					:icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
					size="small"
					variant="text"
					@click="expanded = !expanded"
				/>

				<div class="transfer-batch_identity">
					<strong data-test="transfer-batch-title">{{ title }}</strong>

					<span class="text-caption text-medium-emphasis">
						{{ $t('transfer.batch.files', { done: finished, total: transfers.length }) }}
					</span>
				</div>

				<span class="text-caption text-medium-emphasis">
					<ByteSize :bytes="bytes.done" /> / <ByteSize :bytes="bytes.total" />
				</span>

				<!--
					The rate of the run and not of one file: several files move at once, and
					what somebody wants to know is how fast the season is coming.
				-->
				<span v-if="rate > 0" class="text-caption text-medium-emphasis" data-test="transfer-batch-rate">
					<Rate :rate="rate" />
				</span>
			</div>

			<v-progress-linear
				class="mt-2"
				data-test="transfer-batch-progress"
				height="6"
				:model-value="percent"
				rounded
			/>

			<!--
				The destination once for the run rather than once per file: eleven lines
				saying the same folder is eleven lines nobody reads.
			-->
			<p class="text-caption text-medium-emphasis mt-1 mb-0 text-break-anywhere">
				{{ $t('transfer.batch.into') }}
				<span class="transfer-batch_path" data-test="transfer-batch-path">{{ destination }}</span>
			</p>

			<div class="transfer-batch_actions mt-2">
				<v-btn
					v-if="running.length > 0"
					data-test="transfer-batch-pause"
					:disabled="busy"
					prepend-icon="mdi-pause"
					size="small"
					variant="text"
					@click="all('pause' as TransferAction)"
				>
					{{ $t('transfer.action.pause') }}
				</v-btn>

				<!--
					On the batch and not only on each row, because a destination is a
					property of the run: a season redirected file by file ends half in one
					library and half in another, which is the state somebody pressing this
					is trying to get out of. Offered whatever the run's state — a run that
					has entirely landed is exactly the one worth moving, and the files that
					landed are moved for real rather than left behind.
				-->
				<v-btn
					data-test="transfer-batch-retarget"
					:disabled="busy"
					prepend-icon="mdi-folder-move-outline"
					size="small"
					variant="text"
					@click="emit('retarget', transfers)"
				>
					{{ $t('transfer.retarget.action') }}
				</v-btn>

				<v-btn
					v-if="running.length > 0"
					color="error"
					data-test="transfer-batch-cancel"
					:disabled="busy"
					prepend-icon="mdi-close"
					size="small"
					variant="text"
					@click="all('cancel' as TransferAction)"
				>
					{{ $t('transfer.action.cancel') }}
				</v-btn>
			</div>

			<v-expand-transition>
				<div v-if="expanded" class="transfer-batch_files mt-3">
					<TransferRow
						v-for="transfer of transfers"
						:key="transfer.id"
						:busy="busyId === transfer.id"
						:progress="progress(transfer)"
						:transfer="transfer"
						@action="(action, one) => emit('action', action, one)"
					/>
				</div>
			</v-expand-transition>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.transfer-batch {
		&_head {
			display: flex;
			align-items: center;
			gap: 10px;
		}

		&_identity {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-width: 0;
		}

		&_path {
			font-family: monospace;
			opacity: 0.85;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}

		&_files > * + * {
			margin-top: 8px;
		}
	}
</style>
