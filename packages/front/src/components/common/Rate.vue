<script lang="ts" setup>
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { formatRate } from '@/composables/useFormat';

	const props = withDefaults(defineProps<{
		/** Bytes per second, as every rate in the API is expressed. */
		rate?: number | null;
	}>(), {
		rate: null,
	});

	const { locale } = useI18n();

	const text = computed(() => formatRate(props.rate, locale.value));
</script>

<template>
	<span class="rate">{{ text }}</span>
</template>
