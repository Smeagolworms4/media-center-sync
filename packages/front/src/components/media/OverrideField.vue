<script lang="ts" setup>
	import type { FieldBindings } from '@/composables/useForm';
	import { computed } from 'vue';

	/**
	 * One correctable field, in its three states.
	 *
	 * A media server's answer can be kept, replaced, or removed, and the third is
	 * not the second with an empty box: leaving a field alone means the service
	 * keeps deciding it, while clearing it says the value is wrong and there is no
	 * right one. The eraser is what expresses the difference, and the line
	 * underneath says which of the three this field is currently in.
	 */
	const props = withDefaults(defineProps<{
		name: string;
		label: string;
		/** What the service reported, shown whenever this field no longer matches it. */
		reported: string;
		field?: FieldBindings | null;
		type?: 'text' | 'number' | 'textarea';
		hint?: string | null;
	}>(), {
		field: null,
		type: 'text',
		hint: null,
	});

	const value = defineModel<string>({ required: true });
	const cleared = defineModel<boolean>('cleared', { required: true });

	const changed = computed(() => !cleared.value && value.value !== props.reported);
	const hasReported = computed(() => props.reported.length > 0);

	function toggleCleared (): void {
		/*
		 * The new state is decided once, and never read back off the model.
		 *
		 * `cleared` is a `defineModel`, so writing to it emits to the parent and the
		 * value only comes back on the next render: reading it on the line below
		 * answered the state before the click, and the box was emptied on the click
		 * that restored it and filled on the click that erased it — one interaction
		 * behind, for ever. Nothing failed, the two writes simply disagreed.
		 */
		const next = !cleared.value;
		cleared.value = next;
		// Coming back from cleared restores the service's answer rather than an empty
		// box: that is what "not corrected" means, and it is the state somebody is
		// asking for when they undo a clear.
		value.value = next ? '' : props.reported;
	}
</script>

<template>
	<div class="override-field" :class="{ 'override-field--cleared': cleared }">
		<!--
			`readonly`, never `disabled`.

			Vuetify puts `pointer-events: none` on a disabled input, and that includes
			the icon inside it — so a cleared field could be cleared and never restored:
			the one button that undoes the decision was the one button the browser would
			no longer deliver a click to. Nothing said so, the icon simply did nothing.
			Read-only says the same thing to somebody typing and keeps the way back.

			The eraser answers `mousedown` and not `click`, which is the second half of the
			same story. A `click` is only delivered when the press and the release land on
			the *same* element, and this icon lives inside a field that re-renders the
			moment it takes focus — which is what the press does. When the re-render falls
			between the two, the browser fires no click at all and the eraser does nothing,
			with no way for anybody to tell that from a misplaced press. Two journeys caught
			it, in both directions, and a unit test in jsdom cannot: there the field never
			re-renders in between.
		-->
		<v-textarea
			v-if="type === 'textarea'"
			v-bind="field ?? {}"
			auto-grow
			:data-test="`override-${name}`"
			:label="label"
			:model-value="value"
			:readonly="cleared"
			rows="3"
			@update:model-value="value = $event"
		>
			<template #append-inner>
				<v-icon
					:aria-label="label"
					:data-test="`override-${name}-clear`"
					:icon="cleared ? 'mdi-backup-restore' : 'mdi-eraser'"
					role="button"
					tabindex="0"
					@keydown.enter="toggleCleared"
					@mousedown="toggleCleared"
				/>
			</template>
		</v-textarea>

		<v-text-field
			v-else
			v-bind="field ?? {}"
			:data-test="`override-${name}`"
			:label="label"
			:model-value="value"
			:readonly="cleared"
			:type="type"
			@update:model-value="value = $event"
		>
			<template #append-inner>
				<v-icon
					:aria-label="label"
					:data-test="`override-${name}-clear`"
					:icon="cleared ? 'mdi-backup-restore' : 'mdi-eraser'"
					role="button"
					tabindex="0"
					@keydown.enter="toggleCleared"
					@mousedown="toggleCleared"
				/>
			</template>
		</v-text-field>

		<p
			v-if="cleared"
			class="override-field_note text-caption mb-0"
			:data-test="`override-${name}-cleared`"
		>
			{{ hasReported
				? $t('override.state.cleared_was', { value: reported })
				: $t('override.state.cleared') }}
		</p>

		<p
			v-else-if="changed"
			class="override-field_note text-caption text-medium-emphasis mb-0"
			:data-test="`override-${name}-was`"
		>
			{{ hasReported
				? $t('override.state.was', { value: reported })
				: $t('override.state.was_empty') }}
		</p>

		<p v-else-if="hint" class="override-field_note text-caption text-medium-emphasis mb-0">
			{{ hint }}
		</p>
	</div>
</template>

<style lang="scss">
	.override-field {
		margin-bottom: 4px;

		&_note {
			margin-top: -14px;
			padding-left: 16px;
		}

		// A cleared field is a decision, not a blank: it keeps the colour the rest of
		// the dialog uses for "this was changed".
		&--cleared &_note {
			color: rgb(var(--v-theme-primary));
		}
	}
</style>
