<script lang="ts" setup>
	import type { DiscoveredFailure, MediaService, MediaServiceType } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import FormMainError from '@/components/FormMainError.vue';
	import DiscoveredServerList from '@/components/service/DiscoveredServerList.vue';
	import { SIGN_IN_POLL_MS, useDirectorySignIn } from '@/composables/useDirectorySignIn';
	import { useForm } from '@/composables/useForm';
	import { useDirectoriesStore } from '@/stores/directories';

	/**
	 * Adding media servers by signing in to the account service that knows them.
	 *
	 * For Plex this is the default way in, because nobody knows the address of their
	 * Plex server: plex.tv does. The person approves the gateway on plex.tv's own page
	 * — the password is typed there, never here — and gets back the list of every server
	 * the account reaches, their own and those friends share with them, each already
	 * tried from this gateway.
	 *
	 * Every state is on screen, the failures most of all. Waiting says what it is waiting
	 * for and where; an expired request says so and offers a new one; anything plex.tv or
	 * the gateway refused is shown in words next to the step it happened in. A dialog
	 * that sat on a spinner after plex.tv had given up is exactly the invisible failure
	 * this product has shipped before.
	 */
	const props = withDefaults(defineProps<{
		type: MediaServiceType;
		/** How often to ask whether the person approved. Shortened by tests only. */
		pollMs?: number;
	}>(), {
		pollMs: SIGN_IN_POLL_MS,
	});

	const emit = defineEmits<{
		saved: [services: MediaService[]];
		manual: [];
		cancel: [];
	}>();

	const directoriesStore = useDirectoriesStore();
	const { phase, signIn, servers, error, popupBlocked, start, cancel, loadServers } = useDirectorySignIn({ pollMs: props.pollMs });

	const selected = ref<string[]>([]);
	const created = ref<MediaService[]>([]);
	const failures = ref<DiscoveredFailure[]>([]);

	// A new list is a new question: whatever was ticked in the previous one may no
	// longer be offered.
	watch(servers, () => {
		selected.value = [];
	});

	const offered = computed(() =>
		servers.value.filter(server => server.reachable && server.registeredServiceId === null).length);

	const form = useForm({
		fallbackError: 'error.directory.unreachable',
		handle: async () => {
			if (!signIn.value || selected.value.length === 0) {
				return;
			}

			const result = await directoriesStore.register(signIn.value.id, selected.value);

			created.value = [...created.value, ...result.created];
			failures.value = result.failed;

			if (result.failed.length === 0) {
				emit('saved', created.value);
				return;
			}

			// Some came in and some did not: the list is read again so the ones that
			// did show as registered, and the failures stay on screen by name.
			await loadServers();
		},
	});

	function failureName (failure: DiscoveredFailure): string {
		return failure.name ?? failure.identifier;
	}

	async function restart (): Promise<void> {
		failures.value = [];
		await start(props.type);
	}

	/** Leaving the step: with something registered it is a success, and says so. */
	async function stop (): Promise<void> {
		await cancel();
		if (created.value.length > 0) {
			emit('saved', created.value);
			return;
		}
		emit('cancel');
	}
</script>

<template>
	<div class="directory-sign-in" :data-phase="phase" data-test="directory-sign-in">
		<template v-if="phase === 'idle' || phase === 'starting'">
			<p class="mb-2">{{ $t('service.discovery.intro') }}</p>
			<p class="text-caption text-medium-emphasis mb-4">{{ $t('service.discovery.password_note') }}</p>

			<v-btn
				color="primary"
				data-test="directory-start"
				:loading="phase === 'starting'"
				prepend-icon="mdi-plex"
				@click="start(type)"
			>
				{{ $t('service.discovery.sign_in') }}
			</v-btn>
		</template>

		<v-alert
			v-else-if="phase === 'waiting'"
			data-test="directory-waiting"
			density="comfortable"
			type="info"
			variant="tonal"
		>
			<div class="directory-sign-in_waiting">
				<v-progress-circular class="mr-3" indeterminate size="20" width="2" />
				<strong>{{ $t('service.discovery.waiting') }}</strong>
			</div>

			<p class="mt-2 mb-1">{{ $t('service.discovery.waiting_hint') }}</p>

			<p
				v-if="popupBlocked"
				class="mb-1 text-warning"
				data-test="directory-popup-blocked"
			>
				{{ $t('service.discovery.popup_blocked') }}
			</p>

			<p v-if="signIn" class="text-caption mb-2">
				{{ $t('service.discovery.code', { code: signIn.code }) }}
			</p>

			<div class="directory-sign-in_actions">
				<v-btn
					v-if="signIn"
					data-test="directory-open"
					:href="signIn.authUrl"
					prepend-icon="mdi-open-in-new"
					rel="noopener"
					size="small"
					target="_blank"
					variant="tonal"
				>
					{{ $t('service.discovery.open_again') }}
				</v-btn>

				<v-btn data-test="directory-cancel" size="small" variant="text" @click="stop">
					{{ $t('actions.cancel') }}
				</v-btn>
			</div>
		</v-alert>

		<v-alert
			v-else-if="phase === 'expired'"
			data-test="directory-expired"
			density="comfortable"
			type="warning"
			variant="tonal"
		>
			<p class="mb-2">{{ $t('service.discovery.expired') }}</p>

			<v-btn data-test="directory-retry" size="small" variant="tonal" @click="restart">
				{{ $t('service.discovery.retry') }}
			</v-btn>
		</v-alert>

		<v-alert
			v-else-if="phase === 'failed'"
			data-test="directory-failed"
			density="comfortable"
			type="error"
			variant="tonal"
		>
			<p class="mb-2">{{ error }}</p>

			<v-btn data-test="directory-retry" size="small" variant="tonal" @click="restart">
				{{ $t('service.discovery.retry') }}
			</v-btn>
		</v-alert>

		<div v-else-if="phase === 'listing'" class="directory-sign-in_waiting" data-test="directory-listing">
			<v-progress-circular class="mr-3" indeterminate size="20" width="2" />
			{{ $t('service.discovery.listing') }}
		</div>

		<v-form v-else v-form="form" class="directory-sign-in_servers">
			<p v-if="servers.length === 0" class="mb-2" data-test="directory-empty">
				{{ $t('service.discovery.empty') }}
			</p>

			<DiscoveredServerList v-else v-model="selected" :servers="servers" />

			<v-alert
				v-if="failures.length > 0"
				class="mt-3"
				data-test="directory-failures"
				density="compact"
				type="error"
				variant="tonal"
			>
				<p class="mb-1">{{ $t('service.discovery.failed_title') }}</p>

				<ul class="directory-sign-in_failures">
					<li
						v-for="failure of failures"
						:key="failure.identifier"
						:data-identifier="failure.identifier"
						data-test="directory-failure"
					>
						{{ $t('service.discovery.failure', { name: failureName(failure), reason: $t(failure.error) }) }}
					</li>
				</ul>
			</v-alert>

			<p v-if="created.length > 0" class="mt-2 text-success" data-test="directory-created">
				{{ $t('service.discovery.created', { names: created.map(service => service.name).join(', ') }) }}
			</p>

			<FormMainError class="mt-2" :form="form" />

			<div class="directory-sign-in_actions mt-3">
				<v-btn data-test="directory-cancel" variant="text" @click="stop">
					{{ created.length > 0 ? $t('service.discovery.done') : $t('actions.cancel') }}
				</v-btn>

				<v-spacer />

				<v-btn
					v-if="offered > 0"
					color="primary"
					data-test="directory-add"
					:disabled="selected.length === 0"
					:loading="form.loading"
					type="submit"
				>
					{{ $t('service.discovery.add', { count: selected.length }) }}
				</v-btn>
			</div>
		</v-form>

		<div class="directory-sign-in_manual mt-4">
			<v-btn
				class="px-0"
				data-test="directory-manual"
				size="small"
				variant="plain"
				@click="emit('manual')"
			>
				{{ $t('service.discovery.manual') }}
			</v-btn>
		</div>
	</div>
</template>

<style lang="scss">
	.directory-sign-in {
		&_waiting {
			display: flex;
			align-items: center;
		}

		&_actions {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		&_failures {
			margin: 0;
			padding-left: 18px;
		}
	}
</style>
