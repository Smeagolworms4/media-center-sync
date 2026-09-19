<script lang="ts" setup>
	import type { SyncJob } from '@mcs/shared';
	import { SyncJobState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';

	/**
	 * One run of a plan, or one manual sync.
	 *
	 * A finished job is worth as much as a running one: the reason a library is
	 * still missing something is usually in the last run's failure count, and a list
	 * that only showed what is in flight would never say so.
	 */
	const props = defineProps<{ job: SyncJob }>();

	const emit = defineEmits<{ cancel: [job: SyncJob] }>();

	const STATE_COLOR: Record<SyncJobState, string> = {
		[SyncJobState.PENDING]: 'state-unknown',
		[SyncJobState.RUNNING]: 'state-syncing',
		[SyncJobState.PAUSED]: 'state-unknown',
		[SyncJobState.DONE]: 'state-in-sync',
		[SyncJobState.FAILED]: 'state-conflict',
		[SyncJobState.CANCELLED]: 'state-unknown',
	};

	const running = computed(
		() => props.job.state === SyncJobState.RUNNING || props.job.state === SyncJobState.PENDING);

	const percent = computed(() => {
		if (props.job.itemsPlanned <= 0) {
			return 0;
		}
		return Math.min(100, (props.job.itemsDone / props.job.itemsPlanned) * 100);
	});
</script>

<template>
	<div class="job-row" :data-state="job.state" data-test="job-row">
		<div class="job-row_head">
			<v-chip
				:color="STATE_COLOR[job.state]"
				data-test="job-state"
				label
				size="small"
				variant="tonal"
			>
				{{ $t(`sync.job_state.${job.state}`) }}
			</v-chip>

			<span class="job-row_name">
				{{ job.planName ?? $t('sync.job.manual') }}
			</span>

			<span class="text-caption text-medium-emphasis">
				{{ $t(`sync.trigger.${job.trigger}`) }}
			</span>

			<v-spacer />

			<span class="text-caption text-medium-emphasis">
				<RelativeDate :date="job.finishedAt ?? job.startedAt ?? job.createdAt" />
			</span>

			<v-btn
				v-if="running"
				color="error"
				data-test="job-cancel"
				size="small"
				variant="text"
				@click="emit('cancel', job)"
			>
				{{ $t('actions.cancel') }}
			</v-btn>
		</div>

		<v-progress-linear
			v-if="running"
			class="mt-1"
			color="state-syncing"
			height="4"
			:model-value="percent"
			rounded
		/>

		<p class="job-row_meta text-caption text-medium-emphasis mb-0 mt-1">
			{{ $t('sync.job.items', { done: job.itemsDone, planned: job.itemsPlanned }) }}
			<template v-if="job.itemsFailed > 0">
				· <span class="text-error">{{ $t('sync.job.failed', { count: job.itemsFailed }) }}</span>
			</template>

			· <ByteSize :bytes="job.bytesDone" /> / <ByteSize :bytes="job.bytesPlanned" />
		</p>

		<p v-if="job.error" class="text-caption text-error mb-0" data-test="job-error">
			{{ $te(job.error) ? $t(job.error) : $t('error.general') }}
		</p>
	</div>
</template>

<style lang="scss">
	.job-row {
		padding: 8px 0;

		& + & {
			border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
		}

		&_head {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		&_name {
			font-weight: 500;
		}
	}
</style>
