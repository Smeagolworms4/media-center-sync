<script lang="ts" setup>
	import type { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import { describeSyncState } from '@/composables/useSyncState';

	/**
	 * The one place a `SyncState` becomes something to look at.
	 *
	 * Every list, every detail page and every season row renders this component
	 * rather than its own icon, which is what stops the same state from meaning two
	 * things on two screens. The tooltip carries the explanation, because the icon
	 * alone cannot say why an item is a conflict rather than merely outdated.
	 */
	const props = withDefaults(defineProps<{
		state?: SyncState | null;
		size?: string | number;
		/** Adds the label beside the icon, for detail pages where there is room. */
		withLabel?: boolean;
		/**
		 * Where this is on the gateway's own disks, said in the tooltip.
		 *
		 * The state answers "do I have it"; the very next question is "where". The
		 * gateway's spelling and not the media server's, because it is what somebody
		 * types into a shell.
		 */
		path?: string | null;
	}>(), {
		state: null,
		size: 20,
		withLabel: false,
		path: null,
	});

	const descriptor = computed(() => describeSyncState(props.state));
</script>

<template>
	<v-tooltip location="top">
		<template #activator="{ props: tooltipProps }">
			<span
				v-bind="tooltipProps"
				class="sync-state-icon"
				:data-state="descriptor.state"
				data-test="sync-state"
			>
				<v-icon
					:color="descriptor.color"
					:icon="descriptor.icon"
					:size="size"
				/>

				<span v-if="withLabel" class="sync-state-icon_label ml-2">
					{{ $t(descriptor.labelKey) }}
				</span>
			</span>
		</template>

		<div class="sync-state-icon_tooltip">
			<strong>{{ $t(descriptor.labelKey) }}</strong>
			<div>{{ $t(descriptor.helpKey) }}</div>

			<div v-if="path" class="sync-state-icon_path" data-test="sync-state-path">{{ path }}</div>
		</div>
	</v-tooltip>
</template>

<style lang="scss">
	.sync-state-icon {
		display: inline-flex;
		align-items: center;
		white-space: nowrap;

		&_tooltip {
			max-width: 280px;
		}

		&_path {
			margin-top: 4px;
			font-family: monospace;
			font-size: 11px;
			opacity: 0.85;
			// A media path is long and has no spaces, so it has to be allowed to break
			// anywhere or the tooltip grows past the viewport.
			overflow-wrap: anywhere;
		}
	}
</style>
