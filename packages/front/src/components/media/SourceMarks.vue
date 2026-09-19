<script lang="ts" setup>
	import type { MediaGroupSource } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * Who holds this media, in the two marks a poster has room for.
	 *
	 * The question a grouped library exists to answer is "do I have this, or does
	 * only a friend?", and it has to be answerable without opening anything. So the
	 * card shows a filled mark when one of our own services holds it, a hollow one
	 * with a count for the servers that are not ours, and nothing more — the list of
	 * names, their qualities and their sizes belong on the detail page, where there
	 * is room to read them.
	 *
	 * Hiding the sources entirely was the other option and it is wrong: a media only
	 * a friend has and a media we hold would then look identical, which is the one
	 * distinction the whole screen is for.
	 */
	const props = withDefaults(defineProps<{
		sources?: MediaGroupSource[];
	}>(), {
		sources: () => [],
	});

	const localSources = computed(() => props.sources.filter(one => one.local));
	const remoteSources = computed(() => props.sources.filter(one => !one.local));

	const names = computed(() => props.sources.map(one => one.serviceName).join(', '));
</script>

<template>
	<span
		class="source-marks"
		:data-count="sources.length"
		:data-local="localSources.length > 0"
		:data-remote="remoteSources.length"
		data-test="source-marks"
	>
		<v-tooltip location="bottom" :open-delay="150">
			<template #activator="{ props: tooltipProps }">
				<span v-bind="tooltipProps" class="source-marks_group">
					<span
						v-if="localSources.length > 0"
						class="source-marks_mark source-marks_mark--local"
						data-test="source-mark-local"
					>
						<v-icon icon="mdi-harddisk" size="13" />
					</span>

					<span
						v-if="remoteSources.length > 0"
						class="source-marks_mark source-marks_mark--remote"
						data-test="source-mark-remote"
					>
						<v-icon icon="mdi-cloud-outline" size="13" />

						<span v-if="remoteSources.length > 1" class="source-marks_count">
							{{ remoteSources.length }}
						</span>
					</span>

					<span
						v-if="sources.length === 0"
						class="source-marks_mark source-marks_mark--none"
						data-test="source-mark-none"
					>
						<v-icon icon="mdi-help-circle-outline" size="13" />
					</span>
				</span>
			</template>

			<div class="source-marks_tooltip">
				<div v-if="localSources.length > 0">{{ $t('media.source.held_here') }}</div>
				<div v-else>{{ $t('media.source.not_held_here') }}</div>
				<div v-if="names">{{ names }}</div>
			</div>
		</v-tooltip>
	</span>
</template>

<style lang="scss">
	.source-marks {
		display: inline-flex;

		&_group {
			display: inline-flex;
			align-items: center;
			gap: 4px;
		}

		&_mark {
			display: inline-flex;
			align-items: center;
			gap: 2px;
			padding: 1px 5px;
			border-radius: 999px;
			line-height: 1;

			&--local {
				// Filled, because "we have it" is the answer people look for first.
				background: rgb(var(--v-theme-state-in-sync));
				color: #0c1117;
			}

			&--remote {
				background: rgba(var(--v-theme-on-surface), 0.1);
				color: rgb(var(--v-theme-on-surface));
				border: 1px solid rgba(var(--v-theme-on-surface), 0.25);
			}

			&--none {
				background: rgba(var(--v-theme-on-surface), 0.06);
				color: rgb(var(--v-theme-state-unknown));
			}
		}

		&_count {
			font-size: 11px;
			font-weight: 700;
		}
	}
</style>
