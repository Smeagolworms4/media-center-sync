<script setup lang="ts">
	import type { ViewMode } from '@/composables/useViewMode';
	import { computed } from 'vue';

	/**
	 * Grid or list, as one button rather than two.
	 *
	 * A two-button group was the obvious shape and it was wrong three times over. At
	 * `size="small"` the pair reads as a single speckled blob — two dense glyphs with a
	 * divider between them — and nothing about it says which one is chosen: the selected
	 * state is a background tint that, on this dark theme, swallows the icon it is meant
	 * to highlight.
	 *
	 * So: one button, showing the view you would switch *to*, with a tooltip that says so
	 * in words. There is no selected state to render because there are not two things to
	 * choose between — there is a current view and the other one. It is also what every
	 * application that solved this does.
	 */
	const mode = defineModel<ViewMode>({ required: true });

	const other = computed<ViewMode>(() => (mode.value === 'grid' ? 'list' : 'grid'));

	const icon = computed(() =>
		other.value === 'grid' ? 'mdi-view-grid-outline' : 'mdi-format-list-bulleted');

	function toggle (): void {
		mode.value = other.value;
	}
</script>

<template>
	<v-tooltip location="bottom" :text="$t(`library.view.switch_to_${other}`)">
		<template #activator="{ props: tip }">
			<v-btn
				v-bind="tip"
				:aria-label="$t(`library.view.switch_to_${other}`)"
				data-test="view-mode-toggle"
				density="comfortable"
				:icon="icon"
				size="small"
				variant="text"
				@click="toggle"
			/>
		</template>
	</v-tooltip>
</template>
