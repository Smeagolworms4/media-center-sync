<script lang="ts" setup>
	import type { MediaService } from '@mcs/shared';
	import { MediaServiceType } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import DirectorySignIn from '@/components/service/DirectorySignIn.vue';
	import ServiceForm from '@/components/service/ServiceForm.vue';
	import { useApiError } from '@/hooks/useApiError';
	import { useDirectoriesStore } from '@/stores/directories';

	/**
	 * "Add a service": the kind first, then the way in that suits it.
	 *
	 * A kind with a directory — Plex, through plex.tv — leads with signing in, because
	 * that is how its owner finds the server: nobody knows their Plex's address. The
	 * address form stays one click away on the same screen, for a server not linked to
	 * plex.tv or an owner who prefers to type it; discovery is the default path, not the
	 * only one. A kind without a directory — Jellyfin — goes straight to the form, which
	 * is also what every journey written before discovery expects to find.
	 */
	const emit = defineEmits<{
		saved: [];
		cancel: [];
	}>();

	const directoriesStore = useDirectoriesStore();
	const { parseApiError } = useApiError();

	/** Registrable by hand: a peer is created by linking one, never here. */
	const types = Object.values(MediaServiceType).filter(value => value !== MediaServiceType.PEER);

	const type = ref<MediaServiceType>(MediaServiceType.JELLYFIN);
	const manual = ref(false);
	/** Why the sign-in cannot be offered, when asking which kinds have one failed. */
	const unavailable = ref<string | null>(null);

	const hasDirectory = computed(() => (directoriesStore.types ?? []).includes(type.value));

	// Every change of kind starts at that kind's default way in.
	watch(type, () => {
		manual.value = false;
	});

	onMounted(async () => {
		if (directoriesStore.types !== null) {
			return;
		}
		try {
			await directoriesStore.loadTypes();
		} catch (error) {
			// Not fatal — the address form still works for every kind — but said, next
			// to the form it falls back to, rather than a Plex that silently lost its
			// sign-in button.
			unavailable.value = (await parseApiError(error, {
				fallback: 'error.general',
				mappedFields: new Set(),
			})).mainError;
		}
	});

	function onSigned (_services: MediaService[]): void {
		emit('saved');
	}
</script>

<template>
	<div class="service-add">
		<v-btn-toggle
			v-model="type"
			class="service-add_types mb-4"
			color="primary"
			data-test="service-add-type"
			density="comfortable"
			mandatory
			variant="outlined"
		>
			<v-btn
				v-for="one of types"
				:key="one"
				:data-test="`service-add-type-${one}`"
				:value="one"
			>
				{{ $t(`service.type.${one}`) }}
			</v-btn>
		</v-btn-toggle>

		<DirectorySignIn
			v-if="hasDirectory && !manual"
			:key="type"
			:type="type"
			@cancel="emit('cancel')"
			@manual="manual = true"
			@saved="onSigned"
		/>

		<template v-else>
			<p
				v-if="unavailable && type === MediaServiceType.PLEX"
				class="text-caption text-warning mb-2"
				data-test="directory-unavailable"
			>
				{{ $t('service.discovery.unavailable', { reason: unavailable }) }}
			</p>

			<v-btn
				v-if="hasDirectory"
				class="px-0 mb-2"
				data-test="directory-back"
				size="small"
				variant="plain"
				@click="manual = false"
			>
				{{ $t('service.discovery.back') }}
			</v-btn>

			<ServiceForm
				:key="type"
				:locked-type="type"
				@cancel="emit('cancel')"
				@saved="emit('saved')"
			/>
		</template>
	</div>
</template>

<style lang="scss">
	.service-add {
		&_types {
			flex-wrap: wrap;
			height: auto;
		}
	}
</style>
