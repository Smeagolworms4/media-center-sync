<script lang="ts" setup>
	import { type TransferProgress, TransferState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Duration from '@/components/common/Duration.vue';
	import Rate from '@/components/common/Rate.vue';

	/**
	 * One transfer's progress bar, fed by the event stream several times a second.
	 *
	 * How a list of these stays cheap: the parent keeps one `TransferProgress`
	 * object per transfer, keyed by identifier, and a frame mutates that object in
	 * place. Vue tracks dependencies per render effect, and the only effect that
	 * ever read those fields is this component's own — the list around it reads the
	 * identifiers, never the bytes, so it is not invalidated and nothing above this
	 * row re-renders. Keying the rows by transfer identifier completes the picture:
	 * rows are patched, never recreated, so a frame costs one style update on one
	 * element rather than a diff of the whole list.
	 */
	const props = withDefaults(defineProps<{
		progress: TransferProgress;
		/** Hides the byte counters where the row is too narrow for them. */
		compact?: boolean;
	}>(), {
		compact: false,
	});

	const percent = computed(() => {
		const { bytesDone, bytesTotal } = props.progress;
		if (!bytesTotal || bytesTotal <= 0) {
			return 0;
		}
		return Math.min(100, Math.max(0, (bytesDone / bytesTotal) * 100));
	});

	/**
	 * A verification or a repair has no meaningful byte position — it walks pieces
	 * it already holds — so the bar says "working" rather than showing a figure
	 * that would sit still or, worse, jump backwards.
	 */
	const UNMEASURABLE_STATES: Set<TransferState> = new Set([
		TransferState.CONNECTING,
		TransferState.VERIFYING,
		TransferState.REPAIRING,
	]);

	const indeterminate = computed(() => UNMEASURABLE_STATES.has(props.progress.state));

	const color = computed(() => {
		switch (props.progress.state) {
		case TransferState.FAILED: { return 'error';
		}
		case TransferState.CANCELLED: { return 'state-unknown';
		}
		case TransferState.PAUSED: { return 'state-unknown';
		}
		case TransferState.DONE: { return 'state-in-sync';
		}
		case TransferState.REPAIRING: { return 'state-outdated';
		}
		default: { return 'primary';
		}
		}
	});

	const running = computed(() =>
		props.progress.state === TransferState.DOWNLOADING && props.progress.rate > 0);
</script>

<template>
	<div class="transfer-progress" :data-state="progress.state">
		<v-progress-linear
			class="transfer-progress_bar"
			:color="color"
			height="6"
			:indeterminate="indeterminate"
			:model-value="percent"
			rounded
		/>

		<div class="transfer-progress_meta text-caption text-medium-emphasis">
			<span class="transfer-progress_state">
				{{ $t(`transfer.state.${progress.state}`) }}
			</span>

			<template v-if="!compact">
				<span class="transfer-progress_bytes">
					<ByteSize :bytes="progress.bytesDone" />
					/
					<ByteSize :bytes="progress.bytesTotal" />
				</span>
			</template>

			<span v-if="running" class="transfer-progress_rate">
				<Rate :rate="progress.rate" />
			</span>

			<span v-if="running" class="transfer-progress_eta">
				<template v-if="progress.etaSeconds !== null">
					<Duration :seconds="progress.etaSeconds" />
				</template>

				<template v-else>{{ $t('transfer.no_eta') }}</template>
			</span>

			<span v-if="progress.sourceCount > 0" class="transfer-progress_sources">
				{{ $t('transfer.sources', { count: progress.sourceCount }, progress.sourceCount) }}
			</span>
		</div>
	</div>
</template>

<style lang="scss">
	.transfer-progress {
		&_meta {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 12px;
			margin-top: 4px;
		}

		&_state {
			font-weight: 500;
		}
	}
</style>
