<script lang="ts" setup>
	withDefaults(defineProps<{
		title?: string | null;
		text?: string | null;
		icon?: string;
	}>(), {
		title: null,
		text: null,
		icon: 'mdi-tray-remove',
	});
</script>

<template>
	<div class="empty-state text-center py-10">
		<v-icon class="empty-state_icon mb-3" :icon="icon" size="44" />
		<p class="text-subtitle-1">{{ title ?? $t('common.empty_title') }}</p>
		<p class="text-body-2 text-medium-emphasis">{{ text ?? $t('common.empty_text') }}</p>

		<div class="empty-state_actions mt-4">
			<slot />
		</div>
	</div>
</template>

<style lang="scss">
	.empty-state {
		&_icon {
			opacity: 0.4;
		}
	}
</style>
