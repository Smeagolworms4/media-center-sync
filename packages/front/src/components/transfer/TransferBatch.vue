<script lang="ts" setup>
	import type { TransferAction } from '@/composables/useTransferError';
	import type { Transfer, TransferProgress } from '@mcs/shared';
	import { FINISHED_TRANSFER_STATES, MediaLandingState, TransferState } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';
	import TransferRow from '@/components/transfer/TransferRow.vue';

	/**
	 * One download, shown the way a torrent is: one line, one destination, one
	 * percentage, and the files inside it a fold away.
	 *
	 * Fetching a season produced eleven rows in the queue, each with its own
	 * destination, its own progress bar and its own three buttons — so the answer to
	 * "how far is Spartacus" was eleven numbers to add up, and stopping it was eleven
	 * clicks. It is one piece of work made of many files, and that is what a batch says.
	 *
	 * **A download is not a run**, and the difference is visible here. The files of one
	 * block can come from several runs — a season pulled over three nights is one season —
	 * so nothing in this component may read a run: the destination is computed from the
	 * paths, the title from the first file, and redirecting hands the whole list up rather
	 * than a job identifier. What decides the grouping is `QueueBatch` in the store.
	 *
	 * A download of one file is not folded: a single row inside a container that says
	 * "one file" is a frame around nothing.
	 *
	 * **The grouping is of what the page holds**, deliberately. Paginating by download
	 * instead would mean a page of one batch and a page of eighty, and a queue screen
	 * that cannot say how many rows it will draw. A download longer than a page therefore
	 * shows as two batches; sorting by activity keeps its files adjacent, since they
	 * were created in one act.
	 */
	const props = defineProps<{
		transfers: Transfer[];
		progress: (transfer: Transfer) => TransferProgress;
		busyId?: string | null;
	}>();

	const emit = defineEmits<{
		action: [action: TransferAction, transfer: Transfer];
		/** Send the whole download elsewhere, files already landed included. */
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

	/**
	 * The files of the run that are still on their way onto a media server.
	 *
	 * Kept apart from the states because it outlives them: a transfer is `done` the
	 * moment the last byte is written, and the file only exists for whoever is looking
	 * at their media server once a scan has taken it.
	 *
	 * Read through `?? null` rather than against `null` alone: a gateway answering
	 * without the field at all — an older image — would otherwise have every finished
	 * run of its history counted as still landing, so the card would say `0 of 11` and
	 * carry a warning about files that were indexed months ago.
	 */
	const landing = computed(() => props.transfers.filter(one => (one.landing ?? null) !== null));

	/**
	 * `stale` wins over `waiting` when both are in the run: one file nothing indexed is
	 * the thing somebody has to act on, and a line counting the ones still on schedule
	 * would bury it.
	 */
	const stale = computed(
		() => landing.value.filter(one => one.landing === MediaLandingState.STALE));

	/**
	 * A file counts as done when its bytes are in **and** nothing is still waiting for
	 * it to appear on a media server.
	 *
	 * "11 of 11 files" over a run no server had indexed is the claim that hid this:
	 * every number on the card agreed the work was over, so nobody looked, and the
	 * episodes were never there to play. The run is over when the files have landed,
	 * not when the download has.
	 */
	const finished = computed(() => props.transfers.filter(
		one => props.progress(one).state === TransferState.DONE && (one.landing ?? null) === null,
	).length);

	/**
	 * The folder every file of this download shares, which is where the download lands.
	 *
	 * Computed from the paths rather than stored, because a download has no destination
	 * of its own: each file is placed on its own, and they agree in practice because the
	 * planner pins every file of a lot under one root. Compared by whole path components —
	 * a prefix on the raw strings would call `/mnt/media2` a parent of `/mnt/media`.
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

	/** The title a download goes by: what it is fetching, taken from its first file. */
	const title = computed(() => props.transfers[0]?.title ?? '');

	const running = computed(
		() => props.transfers.filter(one => !FINISHED_TRANSFER_STATES.includes(one.state)));

	const busy = computed(() => props.transfers.some(one => one.id === props.busyId));

	/**
	 * One action over the whole download, applied to every file it still makes sense for.
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

			<!--
				Said on the run and not only inside the fold, because the fold is shut: a
				season whose bytes are all in shows a full bar and a closed card, and the
				files nothing indexed would be three clicks away from anybody's attention.
			-->
			<p
				v-if="landing.length > 0"
				class="text-caption mt-1 mb-0"
				:class="stale.length > 0 ? 'text-warning' : 'text-medium-emphasis'"
				:data-landing="stale.length > 0 ? 'stale' : 'waiting'"
				data-test="transfer-batch-landing"
			>
				{{ stale.length > 0
					? $t('transfer.landing.batch_stale', { count: stale.length }, stale.length)
					: $t('transfer.landing.batch_waiting', { count: landing.length }, landing.length) }}
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
					property of the download: a season redirected file by file ends half in
					one library and half in another, which is the state somebody pressing
					this is trying to get out of. Offered whatever the state — a download
					that has entirely landed is exactly the one worth moving, and the files
					that landed are moved for real rather than left behind, including the
					ones an earlier run brought in.
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
