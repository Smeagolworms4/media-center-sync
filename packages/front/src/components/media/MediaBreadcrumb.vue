<script lang="ts" setup>
	import type { TrailStep } from '@/composables/useMediaTrail';

	/**
	 * Where you are, and every way back out.
	 *
	 * A poster wall is four levels deep the moment somebody opens a series: category,
	 * series, season, episode. Without a trail the only way back is the browser's own
	 * button, which walks the history rather than the tree — six clicks back through a
	 * search to reach the category the episode is in, and nothing on the screen ever
	 * says which category that was.
	 *
	 * Every step but the last is a link. The last one is where you are, and rendering
	 * it as a link that goes nowhere is how people learn to distrust the whole trail.
	 */
	withDefaults(defineProps<{ steps?: TrailStep[] }>(), { steps: () => [] });
</script>

<template>
	<nav v-if="steps.length > 1" class="media-breadcrumb" data-test="media-breadcrumb">
		<template v-for="(step, index) of steps" :key="step.key">
			<v-icon
				v-if="index > 0"
				class="media-breadcrumb_separator"
				icon="mdi-chevron-right"
				size="14"
			/>

			<router-link
				v-if="step.to"
				class="media-breadcrumb_step"
				data-test="media-breadcrumb-step"
				:to="step.to"
			>
				{{ step.label }}
			</router-link>

			<span
				v-else
				aria-current="page"
				class="media-breadcrumb_step media-breadcrumb_step--current"
				data-test="media-breadcrumb-current"
			>
				{{ step.label }}
			</span>
		</template>
	</nav>
</template>

<style lang="scss">
	.media-breadcrumb {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px;
		margin-bottom: 10px;
		font-size: 13px;

		&_separator {
			opacity: 0.5;
		}

		&_step {
			padding: 2px 4px;
			border-radius: 4px;
			color: rgb(var(--v-theme-primary));
			text-decoration: none;

			&:hover {
				background: rgba(var(--v-theme-on-surface), 0.08);
				text-decoration: underline;
			}

			&--current {
				color: rgba(var(--v-theme-on-surface), 0.8);
				font-weight: 600;

				&:hover {
					background: none;
					text-decoration: none;
				}
			}
		}
	}
</style>
