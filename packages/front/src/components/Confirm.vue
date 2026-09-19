<script lang="ts" setup>
	/**
	 * Boîte de dialogue de confirmation générique (adaptée d'un composant maison éprouvé,
	 * réécrite pour utiliser `defineModel` plutôt que `usePropSync` — cf. CLAUDE.md).
	 * Compose [[Window]] pour la chrome (toolbar + slot actions + close).
	 *
	 * Émet :
	 *  - `confirm` : l'utilisateur a validé. Le parent ferme la modale lui-même quand l'action
	 *    est terminée (ce qui permet de garder `loading` actif pendant l'action async).
	 *  - `cancel`  : l'utilisateur a annulé (la modale se ferme automatiquement).
	 *
	 * Slot `default` : le texte ou le contenu personnalisé du corps. À défaut, on affiche `text`.
	 */
	import Window from '@/components/Window.vue';

	const open = defineModel<boolean>({ default: false });

	withDefaults(defineProps<{
		title?: string,
		text?: string,
		confirmText?: string | null,
		cancelText?: string | null,
		loading?: boolean,
		width?: string | number,
		confirmColor?: string,
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
		confirm: [],
		cancel: [],
	}>();

	const onCancel = () => {
		emit('cancel');
		open.value = false;
	};
</script>

<template>
	<Window v-model="open" :max-width="width" persistent>
		<template v-if="title" #title>
			<v-icon color="warning" class="mr-2">mdi-alert-circle-outline</v-icon>
			{{ title }}
		</template>

		<slot>{{ text }}</slot>

		<template #actions>
			<v-spacer />
			<v-btn variant="flat" :disabled="loading" @click="onCancel">
				{{ cancelText ?? $t('front.actions.cancel') }}
			</v-btn>
			<v-btn variant="flat" :color="confirmColor" :loading="loading" @click="emit('confirm')">
				{{ confirmText ?? $t('front.actions.validate') }}
			</v-btn>
		</template>
	</Window>
</template>
