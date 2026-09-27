<script lang="ts" setup>
	import type { ReleaseGrab } from '@mcs/shared';
	import { GrabState } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';
	import ReleaseGrabRow from '@/components/transfer/ReleaseGrabRow.vue';

	/**
	 * One download, as somebody asked for it: one line, one bar, one set of controls.
	 *
	 * Three seasons asked for in one act were three rows in the queue, each with its own
	 * progress, its own pause and its own archive — so "how far is Squid Game" was three
	 * numbers to add up and stopping it was three presses. It is one piece of work made of
	 * several torrents, and that is what a lot says. `TransferBatch` says the same thing
	 * about the files of a pull, and the two are deliberately the same shape: one screen,
	 * one way of reading a download, whichever machine is fetching it.
	 *
	 * **A lot is not a release.** The grouping is what somebody pressed download on, which
	 * the gateway cannot work out on its own — it sees one request per release — so it is
	 * minted where the press happens and carried on every row.
	 *
	 * A lot of one is not folded: a single row inside a container that says "one file" is
	 * a frame around nothing, and the page draws the row itself in that case.
	 */
	const props = defineProps<{
		grabs: ReleaseGrab[];
		busyId?: string | null;
	}>();

	const emit = defineEmits<{
		pause: [grabs: ReleaseGrab[]];
		resume: [grabs: ReleaseGrab[]];
		archive: [grabs: ReleaseGrab[]];
		retry: [grabs: ReleaseGrab[]];
		retarget: [grabs: ReleaseGrab[]];
	}>();

	const expanded = ref(false);

	/** Still going to move on their own, which is what a control acts on. */
	const LIVE: Set<GrabState> = new Set([GrabState.SENT, GrabState.DOWNLOADING, GrabState.PAUSED]);

	const bytes = computed(() => props.grabs.reduce(
		(total, one) => ({
			done: total.done + one.bytesDone,
			total: total.total + one.bytesTotal,
		}),
		{ done: 0, total: 0 },
	));

	const percent = computed(() => (bytes.value.total > 0
		? Math.min(100, (bytes.value.done / bytes.value.total) * 100)
		: 0));

	const rate = computed(() => props.grabs.reduce((total, one) => total + one.rate, 0));

	const title = computed(() => props.grabs[0]?.title ?? '');

	const placed = computed(() => props.grabs.filter(one => one.state === GrabState.PLACED).length);

	const failed = computed(() => props.grabs.filter(one => one.state === GrabState.FAILED));

	const running = computed(() => props.grabs.filter(one => LIVE.has(one.state)));

	const STOPPABLE: Set<GrabState> = new Set([GrabState.SENT, GrabState.DOWNLOADING]);

	const stoppable = computed(() => props.grabs.some(
		one => one.clientId !== null && STOPPABLE.has(one.state),
	));

	const startable = computed(() => props.grabs.some(
		one => one.clientId !== null && one.state === GrabState.PAUSED,
	));

	/**
	 * Where this download lands, from what its rows know.
	 *
	 * The prediction while it runs and the real path once a file is filed — the same
	 * order a single row reads them in. Only when every row agrees: a lot whose rows point
	 * at two folders has nothing to say in one line, and saying one of them would be
	 * saying the wrong thing about the other.
	 */
	const destination = computed(() => {
		const paths = props.grabs
			.map(one => one.targetPath ?? one.targetFolder ?? one.plannedPath)
			.filter((path): path is string => path !== null);

		if (paths.length === 0) {
			return null;
		}

		const folders = paths.map(path => (path.endsWith('/') ? path.slice(0, -1) : path));
		const [first, ...rest] = folders.map(path => path.split('/'));
		let shared = first;

		for (const other of rest) {
			let index = 0;

			while (index < shared.length && index < other.length && shared[index] === other[index]) {
				index += 1;
			}

			shared = shared.slice(0, index);
		}

		/*
		 * Only when what they share is a folder and not merely a disk.
		 *
		 * Two downloads under `/share/SeriesTV2/…` and `/share/Animes/…` have `/share` in
		 * common, which is true and says nothing — and printing it under a block would
		 * claim a destination the block does not have. Two components is the shallowest
		 * thing worth naming: a mount point plus a library.
		 */
		const named = shared.filter(part => part !== '');

		return named.length >= 2 ? shared.join('/') : null;
	});

	const busy = computed(() => props.grabs.some(one => one.id === props.busyId));
</script>

<template>
	<v-card class="grab-batch" data-test="grab-batch" variant="tonal">
		<v-card-text class="py-3">
			<div class="grab-batch_head">
				<v-btn
					data-test="grab-batch-toggle"
					:icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
					size="small"
					variant="text"
					@click="expanded = !expanded"
				/>

				<div class="grab-batch_identity">
					<strong data-test="grab-batch-title">{{ title }}</strong>

					<span class="text-caption text-medium-emphasis" data-test="grab-batch-count">
						{{ $t('release.batch.files', { done: placed, count: grabs.length }, grabs.length) }}
					</span>
				</div>

				<span class="text-caption text-medium-emphasis">
					<ByteSize :bytes="bytes.done" /> / <ByteSize :bytes="bytes.total" />
				</span>

				<span v-if="rate > 0" class="text-caption text-medium-emphasis">
					<Rate :rate="rate" />
				</span>
			</div>

			<v-progress-linear
				class="mt-2"
				data-test="grab-batch-progress"
				height="6"
				:model-value="percent"
				rounded
			/>

			<p
				v-if="destination"
				class="grab-batch_path text-caption text-medium-emphasis mb-0 mt-1"
				data-test="grab-batch-destination"
			>
				{{ $t('transfer.retarget.into', { path: destination }) }}
			</p>

			<p
				v-if="failed.length > 0"
				class="text-caption text-error mb-0 mt-1"
				data-test="grab-batch-failed"
			>
				{{ $t('release.batch.failed', { count: failed.length }, failed.length) }}
			</p>

			<!--
				On the block, because that is what somebody asked for: stopping a show is one
				press, not one per season. Every control acts on the rows it still means
				something for, which is why a half-finished lot can still be paused.
			-->
			<div class="grab-batch_actions mt-2">
				<v-btn
					v-if="stoppable"
					data-test="grab-batch-pause"
					:disabled="busy"
					prepend-icon="mdi-pause"
					size="small"
					variant="text"
					@click="emit('pause', running)"
				>
					{{ $t('transfer.action.pause') }}
				</v-btn>

				<v-btn
					v-if="startable"
					color="primary"
					data-test="grab-batch-resume"
					:disabled="busy"
					prepend-icon="mdi-play"
					size="small"
					variant="tonal"
					@click="emit('resume', running)"
				>
					{{ $t('transfer.action.resume') }}
				</v-btn>

				<v-btn
					v-if="failed.length > 0"
					data-test="grab-batch-retry"
					:disabled="busy"
					prepend-icon="mdi-restart"
					size="small"
					variant="text"
					@click="emit('retry', failed)"
				>
					{{ $t('release.retry') }}
				</v-btn>

				<v-btn
					data-test="grab-batch-retarget"
					:disabled="busy"
					prepend-icon="mdi-folder-move-outline"
					size="small"
					variant="text"
					@click="emit('retarget', grabs)"
				>
					{{ $t('transfer.retarget.action') }}
				</v-btn>

				<v-btn
					data-test="grab-batch-archive"
					:disabled="busy"
					prepend-icon="mdi-archive-outline"
					size="small"
					variant="text"
					@click="emit('archive', grabs)"
				>
					{{ $t('transfer.action.archive') }}
				</v-btn>
			</div>

			<v-expand-transition>
				<div v-if="expanded" class="grab-batch_files mt-3">
					<ReleaseGrabRow
						v-for="grab of grabs"
						:key="grab.id"
						:busy="busyId === grab.id"
						:grab="grab"
						@archive="emit('archive', [$event])"
						@pause="emit('pause', [$event])"
						@resume="emit('resume', [$event])"
						@retarget="emit('retarget', [$event])"
						@retry="emit('retry', [$event])"
					/>
				</div>
			</v-expand-transition>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.grab-batch {
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
			overflow-wrap: anywhere;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
	}
</style>
