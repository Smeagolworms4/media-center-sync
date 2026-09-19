<script lang="ts" setup>
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { formatDuration } from '@/composables/useFormat';

	const props = withDefaults(defineProps<{
		seconds?: number | null;
	}>(), {
		seconds: null,
	});

	const { locale } = useI18n();

	const text = computed(() => formatDuration(props.seconds, locale.value));
</script>

<template>
	<span class="duration">{{ text }}</span>
</template>
