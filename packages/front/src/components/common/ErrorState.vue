<script lang="ts" setup>
	import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

	/**
	 * Shown where data should have been.
	 *
	 * It always offers a retry: nearly every failure here is a gateway that was
	 * busy or a media service that blinked, and a dead end for a transient fault
	 * is what makes people reload the whole application.
	 *
	 * What it will not do any more is name a culprit it has not got. The default
	 * sentence used to say the gateway had not answered, and a laptop changing
	 * network kills every request in flight at once — three endpoints, one instant,
	 * `ERR_NETWORK_CHANGED` — so somebody was sent to inspect a server that never
	 * received the question. Now it says the request did not get through, which is
	 * true either way, and the precise sentence is kept for the case the browser
	 * actually knows: that this machine is offline.
	 */
	withDefaults(defineProps<{
		title?: string | null;
		text?: string | null;
		icon?: string;
		retrying?: boolean;
	}>(), {
		title: null,
		text: null,
		icon: 'mdi-alert-circle-outline',
		retrying: false,
	});

	const emit = defineEmits<{ retry: [] }>();

	/*
	 * Read once and then followed, because it moves: a machine that was offline when
	 * this rendered is routinely back by the time somebody reaches for the button, and
	 * a sentence that still blamed the connection would be the same lie in reverse.
	 */
	const offline = ref(typeof navigator === 'undefined' ? false : !navigator.onLine);

	function follow (): void {
		offline.value = !navigator.onLine;
	}

	onMounted(() => {
		window.addEventListener('online', follow);
		window.addEventListener('offline', follow);
	});

	onBeforeUnmount(() => {
		window.removeEventListener('online', follow);
		window.removeEventListener('offline', follow);
	});

	const icons = computed(() => (offline.value ? 'mdi-wifi-off' : null));
</script>

<template>
	<div class="error-state text-center py-10">
		<v-icon class="mb-3" color="error" :icon="icons ?? icon" size="44" />
		<p class="text-subtitle-1">{{ title ?? $t('common.error_title') }}</p>

		<p class="text-body-2 text-medium-emphasis">
			{{ text ?? $t(offline ? 'common.error_offline' : 'common.error_text') }}
		</p>

		<v-btn
			class="mt-4"
			color="primary"
			:loading="retrying"
			variant="tonal"
			@click="emit('retry')"
		>
			{{ $t('actions.retry') }}
		</v-btn>
	</div>
</template>
