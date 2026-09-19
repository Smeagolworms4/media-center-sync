<script lang="ts" setup>
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { formatDateTime, formatRelativeDate } from '@/composables/useFormat';

	const props = withDefaults(defineProps<{
		/** An ISO timestamp, the shape every date in the API has. */
		date?: string | number | Date | null;
		/** Shown when there is no date, e.g. a service that was never probed. */
		emptyText?: string | null;
	}>(), {
		date: null,
		emptyText: null,
	});

	const { locale, t } = useI18n();

	const relative = computed(() => formatRelativeDate(props.date, locale.value));
	const absolute = computed(() => formatDateTime(props.date, locale.value));
	const fallback = computed(() => props.emptyText ?? t('common.never'));
</script>

<template>
	<v-tooltip v-if="relative" location="top" :text="absolute ?? ''">
		<template #activator="{ props: tooltipProps }">
			<span v-bind="tooltipProps" class="relative-date">{{ relative }}</span>
		</template>
	</v-tooltip>

	<span v-else class="relative-date relative-date--empty text-medium-emphasis">{{ fallback }}</span>
</template>
