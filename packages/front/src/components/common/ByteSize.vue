<script lang="ts" setup>
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { formatBytes } from '@/composables/useFormat';

	const props = withDefaults(defineProps<{
		bytes?: number | null;
		/** Decimals shown above the byte unit. Lists usually want one, totals two. */
		digits?: number;
	}>(), {
		bytes: null,
		digits: 1,
	});

	const { locale } = useI18n();

	const text = computed(() => formatBytes(props.bytes, locale.value, props.digits));
</script>

<template>
	<span class="byte-size">{{ text }}</span>
</template>
