<script lang="ts" setup>
	import type { Revalidation } from '@mcs/shared';
	import { RevalidationOutcome } from '@mcs/shared';
	import RelativeDate from '@/components/common/RelativeDate.vue';

	/**
	 * Why a transfer changed its mind.
	 *
	 * A failed range is ambiguous from here — moved, re-encoded, deleted, or served
	 * badly — so the gateway asks the far end and decides from the answer. Showing
	 * the question, the answer and the decision is what keeps the queue from
	 * producing outcomes nobody can account for.
	 */
	withDefaults(defineProps<{
		revalidations: Revalidation[];
		loading?: boolean;
	}>(), {
		loading: false,
	});

	const OUTCOME_COLOR: Record<RevalidationOutcome, string> = {
		[RevalidationOutcome.CONFIRMED]: 'state-in-sync',
		[RevalidationOutcome.MOVED]: 'state-syncing',
		[RevalidationOutcome.CHANGED]: 'state-outdated',
		[RevalidationOutcome.GONE]: 'state-conflict',
		[RevalidationOutcome.UNREACHABLE]: 'state-unknown',
	};
</script>

<template>
	<div class="revalidation-list" data-test="revalidation-list">
		<div v-if="loading" class="text-center py-3">
			<v-progress-circular indeterminate size="22" width="2" />
		</div>

		<p
			v-else-if="revalidations.length === 0"
			class="text-caption text-medium-emphasis mb-0"
		>
			{{ $t('transfer.revalidation.empty') }}
		</p>

		<ul v-else class="revalidation-list_items">
			<li
				v-for="entry of revalidations"
				:key="entry.id"
				class="revalidation-list_item"
				data-test="revalidation-row"
			>
				<div class="revalidation-list_head">
					<strong>{{ entry.sourceServiceName }}</strong>

					<v-chip
						v-if="entry.outcome"
						:color="OUTCOME_COLOR[entry.outcome]"
						label
						size="x-small"
						variant="tonal"
					>
						{{ $t(`transfer.revalidation.outcome.${entry.outcome}`) }}
					</v-chip>

					<v-chip v-else label size="x-small" variant="tonal">
						{{ $t('transfer.revalidation.pending') }}
					</v-chip>

					<span class="text-caption text-medium-emphasis">
						<RelativeDate :date="entry.answeredAt ?? entry.requestedAt" />
					</span>
				</div>

				<p class="text-caption text-medium-emphasis mb-0">
					{{ $t('transfer.revalidation.asked_because') }}
					{{ $t(`transfer.error_kind.${entry.cause}`) }}
					<template v-if="entry.action">
						· {{ $t('transfer.revalidation.decided') }}
						{{ $t(`transfer.revalidation.action.${entry.action}`) }}
					</template>
				</p>

				<p
					v-if="entry.remoteFile"
					class="text-caption text-medium-emphasis text-break-anywhere mb-0"
				>
					{{ $t('transfer.revalidation.remote_path') }}: {{ entry.remoteFile.path }}
				</p>

				<p v-if="entry.note" class="text-caption text-medium-emphasis mb-0">{{ entry.note }}</p>
			</li>
		</ul>
	</div>
</template>

<style lang="scss">
	.revalidation-list {
		&_items {
			margin: 0;
			padding: 0;
			list-style: none;
		}

		&_item {
			padding: 6px 0;

			& + & {
				border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
			}
		}

		&_head {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
	}
</style>
