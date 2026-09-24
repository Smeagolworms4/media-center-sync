<script lang="ts" setup>
	import { MediaKind } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';

	/**
	 * The artwork the request source serves, or what stands in for it.
	 *
	 * The address is the source's own and the browser fetches it directly: the gateway
	 * hands over a URL and never the bytes, which is the whole of its relationship with
	 * a request source. So this is the one image in the interface that is not behind the
	 * API, and it fails the way a third party fails — a plain `<img>` and its native
	 * `error` event are what let a dead address become the placeholder instead of a
	 * broken frame, exactly as the media poster does for a service with no artwork.
	 */
	const props = withDefaults(defineProps<{
		url?: string | null;
		kind?: MediaKind.MOVIE | MediaKind.SERIES | null;
		/** Read out to somebody who cannot see it; a nameless request has nothing to read. */
		title?: string | null;
	}>(), {
		url: null,
		kind: null,
		title: null,
	});

	const failed = ref(false);

	// A row is reused as the list is refiltered, so a new address has to clear the
	// failure of the old one — otherwise one dead image turns every later request in
	// that slot into a placeholder.
	watch(() => props.url, () => {
		failed.value = false;
	});

	const shown = computed(() => Boolean(props.url) && !failed.value);

	const icon = computed(
		() => (props.kind === MediaKind.SERIES ? 'mdi-television-classic' : 'mdi-movie-open-outline'));
</script>

<template>
	<div class="request-artwork" data-test="request-artwork">
		<img
			v-if="shown"
			:alt="title ?? ''"
			class="request-artwork_image"
			data-test="request-artwork-image"
			loading="lazy"
			:src="url ?? undefined"
			@error="failed = true"
		>

		<v-icon
			v-else
			class="request-artwork_placeholder"
			data-test="request-artwork-placeholder"
			:icon="icon"
			size="28"
		/>
	</div>
</template>

<style lang="scss">
	.request-artwork {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 48px;
		// Two by three, the shape every poster a request source serves comes in, so a
		// row's height does not change with whether the artwork answered.
		height: 72px;
		overflow: hidden;
		border-radius: 4px;
		background: rgba(var(--v-theme-on-surface), 0.06);

		&_image {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}

		&_placeholder {
			opacity: 0.4;
		}
	}
</style>
