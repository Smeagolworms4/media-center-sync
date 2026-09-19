<script lang="ts" setup>
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { describeCron } from '@/composables/useCron';

	/**
	 * What a cron field means, in a sentence, next to the field itself.
	 *
	 * Written once and used by both screens that take an expression, so a schedule
	 * never reads one way in a sync plan and another way in the settings.
	 */
	const props = withDefaults(defineProps<{
		expression?: string | null;
	}>(), {
		expression: null,
	});

	const { t } = useI18n();

	const text = computed(() => {
		const description = describeCron(props.expression);
		if (!description) {
			return null;
		}
		const params: Record<string, string | number> = { ...description.params };
		if (typeof params.day === 'number' && description.key === 'cron.describe.weekly_at') {
			params.day = t(`cron.day.${params.day}`);
		}
		return t(description.key, params);
	});
</script>

<template>
	<p v-if="text" class="cron-hint text-caption text-medium-emphasis mb-0" data-test="cron-hint">
		<v-icon class="mr-1" icon="mdi-clock-outline" size="14" />{{ text }}
	</p>
</template>
