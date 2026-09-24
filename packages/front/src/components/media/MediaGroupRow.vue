<script lang="ts" setup>
	import type { MediaGroup } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed, inject } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SourceMarks from '@/components/media/SourceMarks.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import { OPEN_OVERRIDE } from '@/composables/useMediaOverride';

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

	/**
	 * Correcting a media without opening it, when the page around us offers that.
	 *
	 * Null where nothing provides it, and the action then is not drawn at all: a row is
	 * also used on screens that own no correction dialog, and a button that opened
	 * nothing would be worse than no button. See `OPEN_OVERRIDE` for why this is injected
	 * rather than emitted.
	 *
	 * In the title cell rather than in a column of its own, because the header of this
	 * table is written by whoever draws the table: a cell added here would shift every
	 * row one place against a `thead` that knows nothing about it.
	 */
	const openOverride = inject(OPEN_OVERRIDE, null);

	const missing = computed(() => props.group.sync === SyncState.MISSING);
	const bytes = computed(() => props.group.quality?.totalBytes ?? null);
	const to = computed(() => ({ name: 'library-item', params: { itemId: props.group.id } }));

	/**
	 * Where a row's media sits on the gateway's own disks, for its tooltip.
	 *
	 * A function and not a computed because this component draws one row: the same
	 * question asked of the group it was handed, once.
	 */
	function localPathOf (group: MediaGroup): string | null {
		return group.sources.find(one => one.localPath)?.localPath ?? null;
	}
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
			<SyncStateIcon :path="localPathOf(group)" :state="group.sync" />
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

			<v-btn
				v-if="openOverride"
				:aria-label="$t('override.reassign')"
				class="media-row_override"
				data-test="media-row-override"
				density="comfortable"
				icon="mdi-pencil-outline"
				size="x-small"
				:title="$t('override.reassign')"
				variant="text"
				@click="openOverride(group.id)"
			/>
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

		// Shown on hover and on keyboard focus, so four hundred rows are not four hundred
		// pencils — and so it is still reachable by somebody who does not use a mouse.
		&_override {
			margin-left: 4px;
			opacity: 0;
			transition: opacity 120ms ease;
		}

		&:hover &_override,
		&_override:focus-visible {
			opacity: 1;
		}
	}
</style>
