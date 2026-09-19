<script lang="ts" setup>
	import { MediaKind } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import { posterPlaceholder } from '@/composables/useMediaPoster';

	/**
	 * One piece of artwork, or what stands in for it.
	 *
	 * A plain `<img>` rather than `v-img`: the browser's own lazy loading is what
	 * keeps a wall of two hundred posters from opening two hundred connections, and
	 * the native `error` event is the only reliable moment to swap in the
	 * placeholder — the gateway answers 404 for an item whose service never had
	 * artwork, which on this kind of library is most of them.
	 */
	const props = withDefaults(defineProps<{
		title: string;
		/** Already built by the store, token included. Null means there is none. */
		src?: string | null;
		kind?: MediaKind | null;
		/** Rendered eagerly for the one poster above the fold on a detail page. */
		eager?: boolean;
		/** A record sleeve rather than a poster: square instead of two by three. */
		square?: boolean;
	}>(), {
		src: null,
		kind: null,
		eager: false,
		square: false,
	});

	const failed = ref(false);

	// A card is reused as the wall re-renders, so a new source has to clear the
	// failure of the old one — otherwise one 404 turns every later tile in that
	// slot into a placeholder.
	watch(() => props.src, () => {
		failed.value = false;
	});

	const showImage = computed(() => Boolean(props.src) && !failed.value);
	const placeholder = computed(() => posterPlaceholder(props.title));

	const KIND_ICON: Record<MediaKind, string> = {
		[MediaKind.MOVIE]: 'mdi-movie-open-outline',
		[MediaKind.SERIES]: 'mdi-television-classic',
		[MediaKind.SEASON]: 'mdi-folder-multiple-outline',
		[MediaKind.EPISODE]: 'mdi-play-circle-outline',
		[MediaKind.COLLECTION]: 'mdi-animation-outline',
	};

	const kindIcon = computed(() => (props.kind ? KIND_ICON[props.kind] : null));
</script>

<template>
	<div class="media-poster" :class="{ 'media-poster--square': square }" data-test="media-poster">
		<img
			v-if="showImage"
			:alt="title"
			class="media-poster_image"
			:loading="eager ? 'eager' : 'lazy'"
			:src="src ?? undefined"
			@error="failed = true"
		>

		<div
			v-else
			class="media-poster_placeholder"
			data-test="media-poster-placeholder"
			:style="{ background: placeholder.background }"
		>
			<span class="media-poster_initials">{{ placeholder.initials }}</span>
			<v-icon v-if="kindIcon" class="media-poster_kind" :icon="kindIcon" size="18" />
		</div>

		<slot />
	</div>
</template>

<style lang="scss">
	.media-poster {
		position: relative;
		width: 100%;
		aspect-ratio: 2 / 3;

		&--square {
			aspect-ratio: 1 / 1;
		}
		overflow: hidden;
		border-radius: 8px;
		background: rgba(var(--v-theme-on-surface), 0.06);

		&_image {
			display: block;
			width: 100%;
			height: 100%;
			object-fit: cover;
		}

		&_placeholder {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 100%;
			height: 100%;
		}

		&_initials {
			font-size: clamp(22px, 2.6vw, 38px);
			font-weight: 700;
			letter-spacing: 0.06em;
			color: rgba(255, 255, 255, 0.86);
			text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
		}

		&_kind {
			position: absolute;
			right: 8px;
			bottom: 8px;
			color: rgba(255, 255, 255, 0.55);
		}
	}
</style>
