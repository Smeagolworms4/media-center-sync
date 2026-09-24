<script lang="ts" setup>
	import { isEmptyReleasePreference, type ReleasePreference } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';

	/**
	 * This media has a search order of its own, and here is the way out of it.
	 *
	 * The defect this line exists to prevent is the one a per-media setting most easily
	 * reintroduces: a search on one series answers differently from every other, and
	 * nothing on the screen somebody is looking at mentions a setting. The preference is
	 * deliberately not on the settings screen — it belongs to the media — so the media is
	 * the only place it can be seen at all.
	 *
	 * It says the order out loud rather than only that one exists. "This series has its
	 * own order" sends somebody hunting for a dialog to find out what it is; `Resolution:
	 * 1080p › 2160p` answers the question that made them read the line. The full editor
	 * is still one press away in the correction dialog, because reordering five
	 * dimensions is not something to do from a caption.
	 *
	 * Cancelling is one press here and nowhere else. A setting that takes three screens
	 * to undo is one people work around instead.
	 */
	const props = withDefaults(defineProps<{
		preference: ReleasePreference;
		/** True while the cancellation is in flight, so the press cannot be repeated. */
		cancelling?: boolean;
	}>(), { cancelling: false });

	const emit = defineEmits<{ cancel: [] }>();

	const { t } = useI18n();

	/**
	 * An order that separates nothing, which is a decision rather than an empty control.
	 *
	 * A media whose order has no values has opted out of its category's — see
	 * `isEmptyReleasePreference` — so the line has to say that seeders and size decide
	 * here, not fall back to showing nothing and reading as a control that failed.
	 */
	const separatesNothing = computed(() => isEmptyReleasePreference(props.preference));

	/**
	 * The order in one line: the dimensions in their order, the values in theirs.
	 *
	 * Assembled here rather than in the template because the separators carry the
	 * meaning — `›` between values is "better than", `·` between dimensions is "and then"
	 * — and a template building that out of nested loops is where one of them goes
	 * missing on the day a dimension is added.
	 */
	const summary = computed(() => props.preference.ranks
		.filter(rank => rank.values.length > 0)
		.map(rank => `${t(`settings.preference.dimension.${rank.dimension}`)}: ${rank.values.join(' › ')}`)
		.join(' · '));
</script>

<template>
	<v-alert
		class="release-preference-note"
		data-test="release-preference-note"
		density="compact"
		icon="mdi-sort-variant"
		variant="tonal"
	>
		<div class="release-preference-note_body">
			<div>
				<p class="text-body-2 mb-0">{{ $t('media.preference.own') }}</p>

				<p
					v-if="separatesNothing"
					class="text-caption text-medium-emphasis mb-0"
					data-test="release-preference-note-none"
				>
					{{ $t('media.preference.none') }}
				</p>

				<p
					v-else
					class="release-preference-note_summary text-body-2 mb-0"
					data-test="release-preference-note-summary"
				>
					{{ summary }}
				</p>
			</div>

			<!--
				On the same line as what it undoes, which is the whole requirement: the
				press that cancels has to be where the statement is, or the statement is a
				dead end and the setting stays in force because nobody found the screen.
			-->
			<v-btn
				data-test="release-preference-note-cancel"
				:loading="cancelling"
				prepend-icon="mdi-close"
				size="small"
				variant="tonal"
				@click="emit('cancel')"
			>
				{{ $t('media.preference.cancel') }}
			</v-btn>
		</div>
	</v-alert>
</template>

<style lang="scss">
	.release-preference-note {
		&_body {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
			justify-content: space-between;
		}

		// The order is the content of the line, so it reads as a value rather than as
		// prose: the separators only mean something if the values stand out from them.
		&_summary {
			font-weight: 600;
		}
	}
</style>
