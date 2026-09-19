<script lang="ts" setup>
	import type { MediaCompanions } from '@mcs/shared';
	import { computed } from 'vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';

	/**
	 * What sits beside the video, and whether we have it.
	 *
	 * A media server reads far more than the file: the `.nfo` carries the title, the
	 * overview and the identifiers that stop it guessing; the poster and the fanart
	 * are what a library looks like; the subtitles are what make it watchable. A file
	 * pulled without them arrives perfectly and then shows up as an unnamed episode
	 * behind a grey rectangle — which reads as a broken transfer and is not one.
	 *
	 * **Null is not "everything false".** Null means never inspected: the gateway can
	 * only read what sits beside a file in a library it was told where to find, so a
	 * library with no local path never answers this at all. False means inspected and
	 * absent. Rendering the two the same way would report a complete library as empty
	 * and send somebody looking for files that are already there.
	 *
	 * An empty `missing` is not a claim of completeness either — it says nothing
	 * better is known to exist, which is a different sentence and the honest one
	 * before the other side has ever been scanned.
	 */
	const props = withDefaults(defineProps<{
		companions?: MediaCompanions | null;
		/** The full reading, for a detail page that has room for it. */
		detailed?: boolean;
	}>(), {
		companions: null,
		detailed: false,
	});

	const unknown = computed(() => props.companions === null);
	const missing = computed(() => props.companions?.missing ?? []);
	const incomplete = computed(() => missing.value.length > 0);

	const parts = computed(() => {
		const value = props.companions;
		if (!value) {
			return [];
		}
		return [
			{ key: 'nfo', icon: 'mdi-file-document-outline', present: value.nfo },
			{ key: 'poster', icon: 'mdi-image-outline', present: value.poster },
			{ key: 'fanart', icon: 'mdi-image-multiple-outline', present: value.fanart },
			{
				key: 'subtitles',
				icon: 'mdi-subtitles-outline',
				present: value.subtitles > 0,
				count: value.subtitles,
			},
		];
	});

	const color = computed(() => {
		if (unknown.value) {
			return 'state-unknown';
		}
		return incomplete.value ? 'state-outdated' : 'state-in-sync';
	});
</script>

<template>
	<v-tooltip location="bottom" :open-delay="150">
		<template #activator="{ props: tooltipProps }">
			<span
				v-bind="tooltipProps"
				class="companion-marks"
				:class="{ 'companion-marks--detailed': detailed }"
				:data-state="unknown ? 'unknown' : (incomplete ? 'incomplete' : 'known')"
				data-test="companion-marks"
			>
				<template v-if="unknown">
					<v-icon color="state-unknown" icon="mdi-help-circle-outline" size="14" />

					<span v-if="detailed" class="companion-marks_label">
						{{ $t('companions.never_checked') }}
					</span>
				</template>

				<template v-else>
					<span
						v-for="part of parts"
						:key="part.key"
						class="companion-marks_part"
						:class="{ 'companion-marks_part--absent': !part.present }"
						:data-companion="part.key"
						:data-present="part.present"
					>
						<v-icon :icon="part.icon" size="14" />

						<span v-if="part.key === 'subtitles' && part.count" class="companion-marks_count">
							{{ part.count }}
						</span>
					</span>

					<span v-if="detailed" class="companion-marks_label" :style="{ color: `rgb(var(--v-theme-${color}))` }">
						{{ incomplete
							? $t('companions.missing', { list: missing.join(', ') })
							: $t('companions.complete') }}
					</span>
				</template>
			</span>
		</template>

		<div class="companion-marks_tooltip">
			<template v-if="unknown">
				<strong>{{ $t('companions.never_checked') }}</strong>
				<div>{{ $t('companions.never_checked_help') }}</div>
			</template>

			<template v-else>
				<strong>{{ $t('companions.title') }}</strong>

				<div v-for="part of parts" :key="part.key">
					{{ $t(`companions.part.${part.key}`) }} —
					{{ part.present ? $t('companions.present') : $t('companions.absent') }}
				</div>

				<div v-if="incomplete" class="mt-1">
					{{ $t('companions.missing', { list: missing.join(', ') }) }}
				</div>

				<div v-if="companions?.checkedAt" class="mt-1">
					{{ $t('companions.checked_at') }} <RelativeDate :date="companions.checkedAt" />
				</div>
			</template>
		</div>
	</v-tooltip>
</template>

<style lang="scss">
	.companion-marks {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;

		&_part {
			display: inline-flex;
			align-items: center;
			gap: 1px;
			color: rgb(var(--v-theme-state-in-sync));

			// Absent is drawn rather than dropped: a missing subtitle track is only
			// visible as a gap if the other three are still in the row.
			&--absent {
				color: rgba(var(--v-theme-on-surface), 0.28);
			}
		}

		&_count {
			font-size: 10px;
			font-weight: 700;
		}

		&_label {
			font-size: 12px;
		}

		&_tooltip {
			max-width: 300px;
		}
	}
</style>
