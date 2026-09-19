<script lang="ts" setup>
/**
	 * Shown where data should have been.
	 *
	 * It always offers a retry: nearly every failure here is a gateway that was
	 * busy or a media service that blinked, and a dead end for a transient fault
	 * is what makes people reload the whole application.
	 */
	withDefaults(defineProps<{
		title?: string | null;
		text?: string | null;
		icon?: string;
		retrying?: boolean;
	}>(), {
		title: null,
		text: null,
		icon: 'mdi-alert-circle-outline',
		retrying: false,
	});

	const emit = defineEmits<{ retry: [] }>();
</script>

<template>
	<div class="error-state text-center py-10">
		<v-icon class="mb-3" color="error" :icon="icon" size="44" />
		<p class="text-subtitle-1">{{ title ?? $t('common.error_title') }}</p>
		<p class="text-body-2 text-medium-emphasis">{{ text ?? $t('common.error_text') }}</p>

		<v-btn
			class="mt-4"
			color="primary"
			:loading="retrying"
			variant="tonal"
			@click="emit('retry')"
		>
			{{ $t('actions.retry') }}
		</v-btn>
	</div>
</template>
