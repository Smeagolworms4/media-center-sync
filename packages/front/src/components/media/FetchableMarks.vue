<script lang="ts" setup>
	import { NewsSignal } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * Whether the gaps beneath this media can actually be filled, in one mark each.
	 *
	 * The card already says something is missing. It never said whether anything could
	 * be done about it, and that is the difference between a list somebody acts on and a
	 * list of disappointments: twelve followed shows with holes, of which two are
	 * obtainable tonight, and no way to tell which two without opening each one and
	 * searching the trackers by hand.
	 *
	 * Two marks and not one, because they are two different evenings. A copy on a
	 * friend's server comes over the local network at disk speed and is the same file
	 * they are watching; a tracker release is a download of unknown length from
	 * strangers, in whatever encoding the release group chose.
	 *
	 * **Nothing is drawn when nothing is known, and that is not "unavailable".** The
	 * episode watch looks at a batch of followed shows per pass, so a show it has not
	 * reached carries no signal — and a card that said "nothing available" about it would
	 * be stating as fact something nobody has looked into. Silence is the honest
	 * rendering, which is also why there is no third mark for "none".
	 */
	const props = withDefaults(defineProps<{
		/** What the gateway last saw. Absent on an older gateway's answer. */
		fetchable?: NewsSignal[];
	}>(), {
		fetchable: () => [],
	});

	interface Mark {
		signal: NewsSignal;
		icon: string;
		labelKey: string;
	}

	/** The copy first, as the gateway orders them: it is the better of the two. */
	const MARKS: Mark[] = [
		{ signal: NewsSignal.COPY, icon: 'mdi-lan-connect', labelKey: 'media.fetchable.copy' },
		{ signal: NewsSignal.RELEASE, icon: 'mdi-magnet', labelKey: 'media.fetchable.release' },
	];

	const shown = computed(() => MARKS.filter(mark => props.fetchable.includes(mark.signal)));
</script>

<template>
	<span
		v-if="shown.length > 0"
		class="fetchable-marks"
		:data-signals="shown.map(mark => mark.signal).join(' ')"
		data-test="fetchable-marks"
	>
		<v-tooltip
			v-for="mark of shown"
			:key="mark.signal"
			location="bottom"
			:open-delay="150"
		>
			<template #activator="{ props: tooltipProps }">
				<span
					v-bind="tooltipProps"
					class="fetchable-marks_mark"
					:class="`fetchable-marks_mark--${mark.signal}`"
					:data-signal="mark.signal"
					:data-test="`fetchable-mark-${mark.signal}`"
				>
					<v-icon :icon="mark.icon" size="13" />
				</span>
			</template>

			{{ $t(mark.labelKey) }}
		</v-tooltip>
	</span>
</template>

<style lang="scss">
	.fetchable-marks {
		display: inline-flex;
		align-items: center;
		gap: 4px;

		&_mark {
			display: inline-flex;
			align-items: center;
			padding: 1px 5px;
			border-radius: 999px;
			line-height: 1;

			// Filled, both of them: unlike a source mark, this says something can be
			// done rather than where a copy sits, and a hollow pill at poster size
			// reads as one more thing that is merely known.
			&--copy {
				background: rgb(var(--v-theme-state-in-sync));
				color: #0c1117;
			}

			&--release {
				background: rgb(var(--v-theme-state-outdated));
				color: #0c1117;
			}
		}
	}
</style>
