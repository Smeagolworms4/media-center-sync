<script lang="ts" setup>
	import type { RouteLocationRaw } from 'vue-router';

	/**
	 * One figure on the dashboard, and the page that explains it.
	 *
	 * Every tile links somewhere: a number nobody can act on is decoration, and the
	 * question that follows "seven missing" is always "which seven".
	 */
	withDefaults(defineProps<{
		title: string;
		value?: string | number | null;
		subtitle?: string | null;
		icon?: string | null;
		to?: RouteLocationRaw | null;
		/** Colours the figure when it is something to deal with rather than to read. */
		tone?: 'neutral' | 'success' | 'warning' | 'error';
		loading?: boolean;
	}>(), {
		value: null,
		subtitle: null,
		icon: null,
		to: null,
		tone: 'neutral',
		loading: false,
	});

	const TONE_COLOR: Record<string, string | undefined> = {
		neutral: undefined,
		success: 'state-in-sync',
		warning: 'state-outdated',
		error: 'state-conflict',
	};
</script>

<template>
	<v-card
		class="stat-tile"
		:data-tone="tone"
		:link="!!to"
		:to="to ?? undefined"
		variant="tonal"
	>
		<v-card-text class="stat-tile_body">
			<v-icon
				v-if="icon"
				class="stat-tile_icon"
				:color="TONE_COLOR[tone]"
				:icon="icon"
				size="28"
			/>

			<div class="stat-tile_text">
				<p class="stat-tile_title text-caption text-medium-emphasis">{{ title }}</p>

				<p
					class="stat-tile_value text-h6"
					:class="`text-${TONE_COLOR[tone] ?? 'high-emphasis'}`"
					data-test="stat-tile-value"
				>
					<v-progress-circular v-if="loading" indeterminate size="18" width="2" />

					<!--
						A figure that needs a unit — a rate, a size — brings its own
						component through this slot rather than arriving pre-formatted.
					-->
					<slot v-else name="value">{{ value ?? '—' }}</slot>
				</p>

				<p v-if="subtitle" class="stat-tile_subtitle text-caption text-medium-emphasis">
					{{ subtitle }}
				</p>

				<slot />
			</div>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.stat-tile {
		height: 100%;

		&_body {
			display: flex;
			align-items: flex-start;
			gap: 12px;
		}

		&_text {
			min-width: 0;
		}

		&_title,
		&_value,
		&_subtitle {
			margin: 0;
		}

		&_value {
			line-height: 1.3;
		}
	}
</style>
