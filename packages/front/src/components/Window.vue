<script lang="ts" setup>
	/**
	 * Boîte de dialogue générique (reprise d'un composant maison éprouvé,
	 * réécrite en `<script setup>` + `defineModel` selon CLAUDE.md).
	 *
	 * Slots :
	 *  - `default`   : corps de la modale (reçoit `close` pour fermer depuis l'intérieur).
	 *  - `title`     : remplace le titre par défaut affiché dans la toolbar.
	 *  - `actions`   : zone d'actions en bas (remplace le footer par défaut).
	 *  - `activator` : ouvre la modale via un déclencheur custom (sinon contrôle externe via `v-model`).
	 *
	 * Tous les autres attributs (`max-width`, `persistent`, etc.) sont transmis à `v-dialog`.
	 */
	defineOptions({ inheritAttrs: false });

	const open = defineModel<boolean>({ default: false });

	withDefaults(defineProps<{
		title?: string,
		windowClass?: string,
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
			<slot name="activator" v-bind="activatorProps" :close="() => open = false" />
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
				<slot name="actions" :close="() => open = false" />
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>
