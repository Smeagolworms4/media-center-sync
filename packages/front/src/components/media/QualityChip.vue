<script lang="ts" setup>
	import type { QualitySummary } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';

	/**
	 * A `QualitySummary` at a glance, with the detail one hover away.
	 *
	 * A library is rarely uniform — a season ripped twice, three episodes
	 * re-encoded, one left in 720p — so the chip shows the dominant encoding, or
	 * says `mixed` when there is more than one. That is the only summary that does
	 * not lie, and the tooltip carries every variant with its file count and size
	 * for the moment somebody needs to know which episode is the odd one.
	 */
	const props = withDefaults(defineProps<{
		quality?: QualitySummary | null;
		size?: string;
	}>(), {
		quality: null,
		size: 'small',
	});

	const variants = computed(() => props.quality?.variants ?? []);

	/**
	 * `label` already arrives assembled, and for a uniform node it is exactly what
	 * to show. The mixed case is the one word in it worth translating, since it is
	 * a statement about the node rather than the name of a codec.
	 */
	const label = computed(() => props.quality?.label ?? null);
	const mixed = computed(() => props.quality?.mixed === true);
</script>

<template>
	<v-tooltip v-if="quality" location="bottom" :open-delay="150">
		<template #activator="{ props: tooltipProps }">
			<v-chip
				v-bind="tooltipProps"
				class="quality-chip"
				:color="mixed ? 'state-outdated' : 'state-unknown'"
				:data-mixed="mixed"
				data-test="quality-chip"
				label
				:size="size"
				variant="tonal"
			>
				<v-icon v-if="mixed" class="mr-1" icon="mdi-layers-triple-outline" size="14" />
				{{ mixed ? $t('quality.mixed') : label }}
			</v-chip>
		</template>

		<div class="quality-chip_tooltip">
			<table class="quality-chip_variants">
				<tbody>
					<tr v-for="variant of variants" :key="variant.label">
						<td class="quality-chip_variantLabel">{{ variant.label }}</td>

						<td class="quality-chip_variantCount">
							{{ $t('quality.variant_count', { count: variant.count }, variant.count) }}
						</td>

						<td class="quality-chip_variantBytes">
							<ByteSize :bytes="variant.bytes" />
						</td>
					</tr>
				</tbody>
			</table>

			<div class="quality-chip_total mt-1">
				{{ $t('quality.summary', { count: quality.fileCount }, quality.fileCount) }}
				·
				<ByteSize :bytes="quality.totalBytes" />
			</div>
		</div>
	</v-tooltip>

	<v-chip
		v-else
		class="quality-chip quality-chip--unknown"
		color="state-unknown"
		data-test="quality-chip"
		label
		:size="size"
		variant="tonal"
	>
		{{ $t('quality.unknown') }}
	</v-chip>
</template>

<style lang="scss">
	.quality-chip {
		&_variants {
			border-collapse: collapse;

			td {
				padding: 1px 0;
				white-space: nowrap;
			}
		}

		&_variantCount,
		&_variantBytes {
			padding-left: 12px !important;
			text-align: right;
		}

		&_total {
			opacity: 0.75;
		}
	}
</style>
