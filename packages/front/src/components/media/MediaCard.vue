<script lang="ts" setup>
	import type { MediaGroup } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import MediaPoster from '@/components/media/MediaPoster.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SourceMarks from '@/components/media/SourceMarks.vue';
	import SyncStateBadge from '@/components/media/SyncStateBadge.vue';

	/**
	 * One media, whoever holds it, as a poster.
	 *
	 * Everything on the tile answers one question: what it is (artwork, title,
	 * year), whether we hold it (the source marks), what state it is in (the badge)
	 * and what it is made of (the quality chip, and the missing count for a series).
	 * Nothing else goes on a card — the servers by name, their sizes and the
	 * episode list are a click away and unreadable at this size.
	 */
	const props = withDefaults(defineProps<{
		group: MediaGroup;
		/** The artwork URL, built by the store. Null renders the placeholder. */
		artwork?: string | null;
		selected?: boolean;
		/**
		 * True while the wall is in selection mode: a click then picks the tile
		 * instead of opening it.
		 */
		selecting?: boolean;
		/**
		 * Off where nothing can be done with a selection — the children of a detail
		 * page, for instance. A tick nobody can act on is worse than no tick.
		 */
		selectable?: boolean;
		/** Square artwork, for the libraries whose covers are record sleeves. */
		square?: boolean;
	}>(), {
		artwork: null,
		selected: false,
		selecting: false,
		selectable: true,
		square: false,
	});

	const emit = defineEmits<{ 'update:selected': [value: boolean] }>();

	const to = computed(() => ({ name: 'library-item', params: { itemId: props.group.id } }));
	const missing = computed(() => props.group.sync === SyncState.MISSING);
	const subtitle = computed(() => {
		const parts: string[] = [];
		if (props.group.year !== null) {
			parts.push(String(props.group.year));
		}
		if (props.group.seasonNumber !== null && props.group.episodeNumber !== null) {
			parts.push(`S${props.group.seasonNumber}E${props.group.episodeNumber}`);
		}
		return parts.join(' · ');
	});

	/**
	 * The tile stays a real link even while the wall is selecting.
	 *
	 * Rendering a `div` in selection mode would cost the middle-click, the "copy
	 * link" and the keyboard focus that a grid of two hundred items genuinely needs;
	 * cancelling the navigation instead keeps all of that and still lets a plain
	 * click pick the tile, which is what a file manager does and what people try
	 * first.
	 */
	function onOpen (event: MouseEvent): void {
		if (props.selecting && props.selectable) {
			event.preventDefault();
			emit('update:selected', !props.selected);
		}
	}

	function onToggle (value: boolean): void {
		emit('update:selected', value);
	}
</script>

<template>
	<div
		class="media-card"
		:class="{ 'media-card--selected': selected, 'media-card--missing': missing }"
		:data-kind="group.kind"
		:data-state="group.sync"
		data-test="media-card"
	>
		<router-link class="media-card_link" :to="to" @click="onOpen">
			<MediaPoster :kind="group.kind" :square="square" :src="artwork" :title="group.title">
				<span class="media-card_badge">
					<SyncStateBadge :state="group.sync" />
				</span>

				<span class="media-card_marks">
					<SourceMarks :sources="group.sources" />
				</span>

				<span
					v-if="group.missingCount > 0"
					class="media-card_missing"
					data-test="media-missing-count"
				>
					{{ $t('media.missing_count', { count: group.missingCount }, group.missingCount) }}
				</span>
			</MediaPoster>
		</router-link>

		<!--
			Outside the link on purpose. Inside it, the only way to stop a click from
			navigating is to cancel the event — and cancelling it also cancels the
			checkbox toggling itself, which leaves a tick nobody can set. A browser
			found that; no unit test could, because setting a checkbox from a test
			never goes through the default action.
		-->
		<span
			v-if="selectable"
			class="media-card_select"
			:class="{ 'media-card_select--shown': selecting || selected }"
		>
			<v-checkbox-btn
				:aria-label="group.title"
				data-test="media-select"
				density="compact"
				:model-value="selected"
				@update:model-value="onToggle(!!$event)"
			/>
		</span>

		<div class="media-card_body">
			<router-link class="media-card_title" :to="to" @click="onOpen">
				{{ group.title }}
			</router-link>

			<p v-if="subtitle" class="media-card_subtitle text-caption text-medium-emphasis">
				{{ subtitle }}
			</p>

			<QualityChip class="media-card_quality" :quality="group.quality" size="x-small" />
		</div>
	</div>
</template>

<style lang="scss">
	.media-card {
		position: relative;
		border-radius: 10px;
		transition: transform 120ms ease, box-shadow 120ms ease;

		&:hover {
			transform: translateY(-2px);

			.media-card_select {
				opacity: 1;
			}
		}

		&--selected {
			outline: 2px solid rgb(var(--v-theme-primary));
			outline-offset: 3px;
		}

		&--missing .media-poster_image,
		&--missing .media-poster_placeholder {
			// A media nobody here holds is shown, and shown as not held: dimming it
			// is what keeps a wall of posters from claiming a library it does not have.
			opacity: 0.66;
		}

		&_link {
			display: block;
			color: inherit;
			text-decoration: none;
		}

		&_badge {
			position: absolute;
			top: 6px;
			left: 6px;
		}

		&_select {
			position: absolute;
			top: 2px;
			right: 2px;
			border-radius: 999px;
			background: rgba(12, 17, 23, 0.6);
			opacity: 0;
			transition: opacity 120ms ease;

			&--shown {
				opacity: 1;
			}
		}

		&_marks {
			position: absolute;
			right: 6px;
			bottom: 6px;
		}

		&_missing {
			position: absolute;
			bottom: 6px;
			left: 6px;
			padding: 2px 7px;
			border-radius: 999px;
			background: rgb(var(--v-theme-state-missing));
			color: #0c1117;
			font-size: 11px;
			font-weight: 700;
			line-height: 1.4;
		}

		&_body {
			padding: 8px 2px 0;
		}

		&_title {
			@include truncate;
			display: block;
			color: inherit;
			font-size: 13px;
			font-weight: 600;
			line-height: 1.3;
			text-decoration: none;

			&:hover {
				text-decoration: underline;
			}
		}

		&_subtitle {
			margin: 1px 0 0;
		}

		&_quality {
			margin-top: 4px;
		}
	}
</style>
