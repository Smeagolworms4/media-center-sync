<script lang="ts" setup>
	import type { MediaGroup } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SourceMarks from '@/components/media/SourceMarks.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';

	/**
	 * The same grouped media as one line.
	 *
	 * The dense view is not a fallback: somebody reconciling four hundred episodes
	 * wants rows they can scan and a size column they can compare, and a poster wall
	 * is the wrong tool for that. It carries exactly the same facts as the card —
	 * state, quality, who holds it — so switching view never changes what is known.
	 */
	const props = withDefaults(defineProps<{
		group: MediaGroup;
		selectable?: boolean;
		selected?: boolean;
	}>(), {
		selectable: false,
		selected: false,
	});

	const emit = defineEmits<{ 'update:selected': [value: boolean] }>();

	const missing = computed(() => props.group.sync === SyncState.MISSING);
	const bytes = computed(() => props.group.quality?.totalBytes ?? null);
	const to = computed(() => ({ name: 'library-item', params: { itemId: props.group.id } }));
</script>

<template>
	<tr
		class="media-row"
		:class="{ 'media-row--missing': missing }"
		:data-state="group.sync"
		data-test="media-row"
	>
		<td v-if="selectable" class="media-row_select">
			<v-checkbox-btn
				:aria-label="group.title"
				data-test="media-select"
				density="compact"
				:model-value="selected"
				@update:model-value="emit('update:selected', !!$event)"
			/>
		</td>

		<td class="media-row_state">
			<SyncStateIcon :state="group.sync" />
		</td>

		<td class="media-row_title">
			<router-link class="media-row_link" :to="to">{{ group.title }}</router-link>

			<span v-if="group.seasonNumber !== null" class="text-caption text-medium-emphasis ml-2">
				{{ $t('media.season_episode', {
					season: group.seasonNumber,
					episode: group.episodeNumber ?? 0,
				}) }}
			</span>

			<span v-if="group.missingCount > 0" class="media-row_missing text-caption ml-2">
				{{ $t('media.missing_count', { count: group.missingCount }, group.missingCount) }}
			</span>
		</td>

		<td class="media-row_kind text-caption">{{ $t(`media.kind.${group.kind}`) }}</td>

		<td class="media-row_year text-caption">{{ group.year ?? '—' }}</td>

		<td class="media-row_sources">
			<SourceMarks :sources="group.sources" />
		</td>

		<td class="media-row_quality">
			<QualityChip :quality="group.quality" />
		</td>

		<td class="media-row_size text-caption">
			<ByteSize :bytes="bytes" />
		</td>
	</tr>
</template>

<style lang="scss">
	.media-row {
		&_missing {
			color: rgb(var(--v-theme-state-missing));
			font-weight: 600;
		}
	}
</style>
