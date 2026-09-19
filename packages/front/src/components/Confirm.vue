<script lang="ts" setup>
/**
	 * Confirmation dialog, built on [[Window]].
	 *
	 * `confirm` does not close the dialog: the parent closes it once its action has
	 * finished, which is what keeps the spinner on the button while that happens.
	 * `cancel` closes immediately, because nothing is running.
	 */
	import Window from '@/components/Window.vue';

	const open = defineModel<boolean>({ default: false });

	withDefaults(defineProps<{
		title?: string;
		text?: string;
		confirmText?: string | null;
		cancelText?: string | null;
		loading?: boolean;
		width?: string | number;
		confirmColor?: string;
	}>(), {
		title: '',
		text: '',
		confirmText: null,
		cancelText: null,
		loading: false,
		width: 450,
		confirmColor: 'primary',
	});

	const emit = defineEmits<{
		confirm: [];
		cancel: [];
	}>();

	function onCancel () {
		emit('cancel');
		open.value = false;
	}
</script>

<template>
	<Window v-model="open" :max-width="width" persistent>
		<template v-if="title" #title>
			<v-icon class="mr-2" color="warning">mdi-alert-circle-outline</v-icon>
			{{ title }}
		</template>

		<slot>{{ text }}</slot>

		<template #actions>
			<v-spacer />

			<v-btn :disabled="loading" variant="flat" @click="onCancel">
				{{ cancelText ?? $t('actions.cancel') }}
			</v-btn>

			<v-btn :color="confirmColor" :loading="loading" variant="flat" @click="emit('confirm')">
				{{ confirmText ?? $t('actions.validate') }}
			</v-btn>
		</template>
	</Window>
</template>
