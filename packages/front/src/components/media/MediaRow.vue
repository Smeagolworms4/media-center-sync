<script lang="ts" setup>
	import type { MediaItem } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';

	/**
	 * One line of the index.
	 *
	 * An item the gateway knows about but does not hold is shown all the same,
	 * greyed: hiding it would turn "what am I missing" — the question this whole
	 * application answers — into something the interface cannot express.
	 */
	const props = withDefaults(defineProps<{
		item: MediaItem;
		selectable?: boolean;
		selected?: boolean;
		/** Services holding this item, when the row is a missing one. */
		holders?: string[];
	}>(), {
		selectable: false,
		selected: false,
		holders: () => [],
	});

	const emit = defineEmits<{ 'update:selected': [value: boolean] }>();

	const missing = computed(() => props.item.sync === SyncState.MISSING);
	const bytes = computed(() => props.item.file?.size ?? props.item.quality?.totalBytes ?? null);
	const to = computed(() => ({ name: 'library-item', params: { itemId: props.item.id } }));
</script>

<template>
	<tr
		class="media-row"
		:class="{ 'media-row--missing': missing }"
		:data-state="item.sync"
		data-test="media-row"
	>
		<td v-if="selectable" class="media-row_select">
			<v-checkbox-btn
				:aria-label="item.title"
				data-test="media-select"
				density="compact"
				:model-value="selected"
				@update:model-value="emit('update:selected', !!$event)"
			/>
		</td>

		<td class="media-row_state">
			<SyncStateIcon :state="item.sync" />
		</td>

		<td class="media-row_title">
			<router-link class="media-row_link" :to="to">{{ item.title }}</router-link>

			<span v-if="item.seasonNumber !== null" class="text-caption text-medium-emphasis ml-2">
				{{ $t('media.season_episode', {
					season: item.seasonNumber,
					episode: item.episodeNumber ?? 0,
				}) }}
			</span>

			<p v-if="holders.length > 0" class="media-row_holders text-caption text-medium-emphasis mb-0">
				{{ $t('media.held_by', { services: holders.join(', ') }) }}
			</p>
		</td>

		<td class="media-row_kind text-caption">{{ $t(`media.kind.${item.kind}`) }}</td>

		<td class="media-row_year text-caption">{{ item.year ?? '—' }}</td>

		<td class="media-row_quality">
			<QualityChip :quality="item.quality" />
		</td>

		<td class="media-row_size text-caption">
			<ByteSize :bytes="bytes" />
		</td>

		<td class="media-row_actions">
			<slot name="actions" />
		</td>
	</tr>
</template>

<style lang="scss">
	.media-row {
		&--missing {
			opacity: 0.62;
		}

		td {
			padding: 6px 8px;
			vertical-align: middle;
		}

		&_title {
			min-width: 0;
		}

		&_link {
			color: inherit;
			text-decoration: none;

			&:hover {
				text-decoration: underline;
			}
		}

		&_size,
		&_year {
			white-space: nowrap;
			text-align: right;
		}
	}
</style>
