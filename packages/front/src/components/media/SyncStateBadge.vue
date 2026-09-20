<script lang="ts" setup>
	import type { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import { describeSyncState } from '@/composables/useSyncState';

	/**
	 * The state of a media, said loudly enough to be found without reading.
	 *
	 * The dense list uses `SyncStateIcon`; a poster does not have a column to put
	 * an icon in, and a bare icon floating over artwork is a decoration. This is
	 * the same vocabulary — same colours, same icons, from the same descriptor —
	 * rendered as a solid badge that sits on the corner of the tile.
	 *
	 * Four states carry their word as well as their icon. `missing` and `outdated`
	 * are what people scan a wall for, and they must not depend on telling blue from
	 * amber at a glance. The two landed states are labelled for a different reason:
	 * they are the ones somebody has never seen before, they occupy the place a
	 * `missing` badge sat five minutes ago, and an unlabelled icon there reads as
	 * "still missing, different colour" — which is the misreading the whole state
	 * exists to prevent. The rest are self-evident once one of those has caught the
	 * eye, and labelling all of them would put a word on every tile of a library that
	 * is mostly in sync.
	 */
	const props = withDefaults(defineProps<{
		state?: SyncState | null;
		/** Forces the label on, for a detail header where there is room for it. */
		withLabel?: boolean;
		size?: string | number;
	}>(), {
		state: null,
		withLabel: false,
		size: 16,
	});

	const descriptor = computed(() => describeSyncState(props.state));

	const LOUD_STATES = new Set(['missing', 'outdated', 'awaiting_index', 'not_indexed']);
	const labelled = computed(() => props.withLabel || LOUD_STATES.has(descriptor.value.state));
</script>

<template>
	<v-tooltip location="top">
		<template #activator="{ props: tooltipProps }">
			<span
				v-bind="tooltipProps"
				class="sync-state-badge"
				:class="{ 'sync-state-badge--labelled': labelled }"
				:data-state="descriptor.state"
				data-test="sync-state"
				:style="{ backgroundColor: `rgb(var(--v-theme-${descriptor.color}))` }"
			>
				<v-icon :icon="descriptor.icon" :size="size" />

				<span v-if="labelled" class="sync-state-badge_label">
					{{ $t(descriptor.labelKey) }}
				</span>
			</span>
		</template>

		<div class="sync-state-badge_tooltip">
			<strong>{{ $t(descriptor.labelKey) }}</strong>
			<div>{{ $t(descriptor.helpKey) }}</div>
		</div>
	</v-tooltip>
</template>

<style lang="scss">
	.sync-state-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px;
		border-radius: 999px;
		// The badge sits on artwork of any brightness, so it carries its own
		// contrast rather than borrowing the card's.
		color: #0c1117;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
		white-space: nowrap;

		&--labelled {
			padding: 2px 8px 2px 5px;
		}

		&_label {
			font-size: 11px;
			font-weight: 700;
			line-height: 1;
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}

		&_tooltip {
			max-width: 280px;
		}
	}
</style>
