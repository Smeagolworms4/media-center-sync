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
		cleared.value = !cleared.value;
		// Coming back from cleared restores the service's answer rather than an empty
		// box: that is what "not corrected" means, and it is the state somebody is
		// asking for when they undo a clear.
		value.value = cleared.value ? '' : props.reported;
	}
</script>

<template>
	<div class="override-field" :class="{ 'override-field--cleared': cleared }">
		<v-textarea
			v-if="type === 'textarea'"
			v-bind="field ?? {}"
			:append-inner-icon="cleared ? 'mdi-backup-restore' : 'mdi-eraser'"
			auto-grow
			:data-test="`override-${name}`"
			:disabled="cleared"
			:label="label"
			:model-value="value"
			rows="3"
			@click:append-inner="toggleCleared"
			@update:model-value="value = $event"
		/>

		<v-text-field
			v-else
			v-bind="field ?? {}"
			:append-inner-icon="cleared ? 'mdi-backup-restore' : 'mdi-eraser'"
			:data-test="`override-${name}`"
			:disabled="cleared"
			:label="label"
			:model-value="value"
			:type="type"
			@click:append-inner="toggleCleared"
			@update:model-value="value = $event"
		/>

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
