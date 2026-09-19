<script lang="ts" setup>
/**
	 * Generic dialog.
	 *
	 * Slots: `default` (body, receives `close`), `title`, `actions`, `activator`.
	 * Every other attribute falls through to `v-dialog`, which is why
	 * `inheritAttrs` is off — otherwise `max-width` would land on the card too.
	 */
	defineOptions({ inheritAttrs: false });

	const open = defineModel<boolean>({ default: false });

	withDefaults(defineProps<{
		title?: string;
		windowClass?: string;
	}>(), {
		title: '',
		windowClass: '',
	});
</script>

<template>
	<v-dialog
		v-model="open"
		v-bind="$attrs"
		class="components-window"
		scrollable
	>
		<template v-if="$slots.activator" #activator="activatorProps">
			<slot v-bind="activatorProps" :close="() => open = false" name="activator" />
		</template>

		<v-card class="elevation-12" :class="windowClass">
			<v-toolbar v-if="title || $slots.title" color="primary" dark flat>
				<v-toolbar-title>
					<slot name="title">{{ title }}</slot>
				</v-toolbar-title>

				<v-btn icon size="x-small" @click="open = false">
					<v-icon>mdi-close</v-icon>
				</v-btn>
			</v-toolbar>

			<v-card-text>
				<slot :close="() => open = false" />
			</v-card-text>

			<v-card-actions v-if="$slots.actions">
				<slot :close="() => open = false" name="actions" />
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>
