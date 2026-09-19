<script lang="ts" setup>
	import type { TransferChunk } from '@mcs/shared';
	import { ChunkState } from '@mcs/shared';
	import { computed } from 'vue';
	import { buildChunkMap, CHUNK_STATE_COLOR } from '@/composables/useChunkMap';

	/**
	 * Where the holes are.
	 *
	 * Verification is per piece and so is repair, so the useful question about a
	 * failing transfer is never "how far along is it" but "which parts are wrong" —
	 * and that is a shape, not a percentage.
	 */
	const props = withDefaults(defineProps<{
		chunks: TransferChunk[];
		loading?: boolean;
	}>(), {
		loading: false,
	});

	const map = computed(() => buildChunkMap(props.chunks));

	const legend = computed(() => Object.values(ChunkState).map(state => ({
		state,
		color: CHUNK_STATE_COLOR[state],
		count: map.value.counts[state] ?? 0,
	})));
</script>

<template>
	<div class="chunk-map" data-test="chunk-map">
		<div v-if="loading" class="text-center py-3">
			<v-progress-circular indeterminate size="22" width="2" />
		</div>

		<template v-else-if="map.cells.length === 0">
			<p class="text-caption text-medium-emphasis mb-0">{{ $t('transfer.chunks.empty') }}</p>
		</template>

		<template v-else>
			<div class="chunk-map_cells">
				<span
					v-for="cell of map.cells"
					:key="cell.from"
					class="chunk-map_cell"
					:data-state="cell.state"
					data-test="chunk-cell"
					:style="{ backgroundColor: `rgb(var(--v-theme-${CHUNK_STATE_COLOR[cell.state]}))` }"
					:title="$t('transfer.chunks.cell', { from: cell.from, to: cell.to })"
				/>
			</div>

			<p class="chunk-map_legend text-caption text-medium-emphasis mt-2 mb-0">
				<span v-for="entry of legend" :key="entry.state" class="chunk-map_legendItem">
					<span
						class="chunk-map_dot"
						:style="{ backgroundColor: `rgb(var(--v-theme-${entry.color}))` }"
					/>
					{{ $t(`transfer.chunk_state.${entry.state}`) }}: {{ entry.count }}
				</span>

				<span v-if="map.scale > 1" class="chunk-map_scale">
					{{ $t('transfer.chunks.scale', { count: map.scale }) }}
				</span>
			</p>
		</template>
	</div>
</template>

<style lang="scss">
	.chunk-map {
		&_cells {
			display: flex;
			flex-wrap: wrap;
			gap: 2px;
		}

		&_cell {
			width: 10px;
			height: 10px;
			border-radius: 2px;
			opacity: 0.85;
		}

		&_legend {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 12px;
		}

		&_dot {
			display: inline-block;
			width: 8px;
			height: 8px;
			border-radius: 2px;
			margin-right: 4px;
		}
	}
</style>
