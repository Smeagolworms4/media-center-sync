<script lang="ts" setup>
	import type { CreateMediaServiceRequest, MediaService, MediaServiceProbe } from '@mcs/shared';
	import { MediaServiceScope, MediaServiceType } from '@mcs/shared';
	import { computed, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useServicesStore } from '@/stores/services';

	/**
	 * Registering or editing a media service.
	 *
	 * The connection is probed before anything is written, and the probe's answer —
	 * server name, version, the libraries it found — is shown as it comes back, so
	 * somebody learns their token is wrong while they are still typing it rather
	 * than a week later when their library is still empty and nothing said why.
	 */
	const props = withDefaults(defineProps<{
		service?: MediaService | null;
	}>(), {
		service: null,
	});

	const emit = defineEmits<{
		saved: [service: MediaService];
		cancel: [];
	}>();

	const { t } = useI18n();
	const servicesStore = useServicesStore();
	const validators = useValidators();

	const editing = computed(() => props.service !== null);
	const showToken = ref(false);
	const probing = ref(false);
	const probe = ref<MediaServiceProbe | null>(null);

	const model = reactive<CreateMediaServiceRequest>({
		name: props.service?.name ?? '',
		type: props.service?.type ?? MediaServiceType.JELLYFIN,
		scope: props.service?.scope ?? MediaServiceScope.LOCAL,
		baseUrl: props.service?.baseUrl ?? '',
		token: '',
		authProvider: props.service?.authProvider ?? false,
		priority: props.service?.priority ?? 10,
		remoteRoot: props.service?.remoteRoot ?? '',
		localRoot: props.service?.localRoot ?? '',
	});

	/**
	 * Every type somebody can register by hand, which is not every type there is.
	 *
	 * A peer-backed service is created by linking a peer and removed by unlinking one:
	 * its address is a fingerprint rather than something anybody could type here, and
	 * offering it in this list produces a registration that can never work. The list is
	 * built by exclusion rather than by enumeration so that the next type added is
	 * offered without anybody remembering this file.
	 */
	const typeItems = Object.values(MediaServiceType)
		.filter(value => value !== MediaServiceType.PEER)
		.map(value => ({ value, title: value }));
	const scopeItems = computed(() => Object.values(MediaServiceScope).map(value => ({
		value,
		title: t(`service.scope.${value}`),
	})));

	/**
	 * The folder browser over `localRoot`, which is a directory on *this* gateway.
	 *
	 * Only the local side gets one: `remoteRoot` is a path inside the media server's
	 * own container and nothing here can see it, so offering the same icon next to it
	 * would list our directories for a field that is about theirs — the exact mix-up
	 * the two fields exist to keep apart.
	 */
	const browsingLocalRoot = ref(false);

	/** A probe answer stops describing what is in the form as soon as it changes. */
	watch(() => [model.baseUrl, model.token, model.type], () => {
		probe.value = null;
	});

	function request (): CreateMediaServiceRequest {
		return {
			name: model.name,
			type: model.type,
			scope: model.scope,
			baseUrl: model.baseUrl,
			// Secrets are write-only: an edit that leaves the field empty keeps the
			// token already registered rather than clearing it.
			...(model.token ? { token: model.token } : {}),
			authProvider: model.authProvider,
			priority: model.priority,
			// Both or neither: either half on its own derives nothing, and the API
			// refuses it by name rather than storing a mapping that does nothing. An
			// emptied pair is a mapping being withdrawn, which the API spells null.
			remoteRoot: model.remoteRoot || null,
			localRoot: model.localRoot || null,
		};
	}

	/**
	 * An edit with no new token cannot use `/services/probe`: that route takes the
	 * credentials in the body, and the registered token is never given back to us.
	 * The service's own probe route is the one that can use what is stored.
	 */
	async function runProbe (): Promise<MediaServiceProbe> {
		probing.value = true;
		try {
			const result = editing.value && !model.token
				? await servicesStore.probeService(props.service!.id)
				: await servicesStore.probe(request());
			probe.value = result;
			return result;
		} finally {
			probing.value = false;
		}
	}

	/**
	 * Testing the connection and registering the service are the same action up to
	 * its last step, so they are one handler: both validate the fields, both probe,
	 * and both report a refusal the same way — through the form's main error rather
	 * than through a second kind of message nobody would recognise.
	 */
	const mode = ref<'probe' | 'save'>('save');

	const form = useForm({
		fallbackError: 'error.service.unreachable',
		fields: {
			name: { rules: [validators.required(), validators.maxlength({ max: 120 })] },
			type: { rules: [validators.required()] },
			scope: { rules: [validators.required()] },
			baseUrl: { rules: [validators.required(), validators.urlWithPort()] },
			token: { rules: [] },
			priority: { rules: [validators.onlyInteger(), validators.range({ min: 0, max: 999 })] },
			remoteRoot: {
				rules: [validators.absolutePath(), validators.maxlength({ max: 1024 })],
			},
			localRoot: {
				rules: [validators.absolutePath(), validators.maxlength({ max: 1024 })],
			},
		},
		handle: async () => {
			// Saving a service that cannot be reached registers a row that will never
			// do anything; the probe runs first and its answer decides. A save that
			// follows a probe of the same values reuses its answer.
			const result = mode.value === 'probe' || probe.value === null
				? await runProbe()
				: probe.value;

			if (!result.reachable || !result.authenticated) {
				// A probe that failed answers a shape rather than throwing. Handing the
				// form the same payload the API would have sent keeps one path for
				// turning an error key into a sentence — and a service that answered
				// and refused us is a different sentence from one that never answered.
				const refusal = result.reachable
					? 'error.service.unauthorized'
					: 'error.service.unreachable';
				throw Response.json({ message: result.error ?? refusal }, { status: 400 });
			}

			if (mode.value === 'probe') {
				// The answer is on screen; nothing is written until somebody saves.
				return;
			}

			const saved = editing.value
				? await servicesStore.update(props.service!.id, request())
				: await servicesStore.create(request());
			emit('saved', saved);
		},
	});

	async function onProbeClick (): Promise<void> {
		// Set for the length of this run only: the directive that owns the submit
		// event listens in the capture phase, so a mode set from a submit handler
		// would arrive after the handler that reads it.
		mode.value = 'probe';
		try {
			await form.handle();
		} finally {
			mode.value = 'save';
		}
	}
</script>

<template>
	<v-form v-form="form" class="service-form">
		<v-text-field
			v-model="model.name"
			v-bind="form.field('name')"
			class="service-form_name"
			data-test="service-name"
			:label="$t('service.field.name')"
		/>

		<v-row density="compact">
			<v-col cols="12" sm="6">
				<v-select
					v-model="model.type"
					v-bind="form.field('type')"
					data-test="service-type"
					item-title="title"
					item-value="value"
					:items="typeItems"
					:label="$t('service.field.type')"
				/>
			</v-col>

			<v-col cols="12" sm="6">
				<v-select
					v-model="model.scope"
					v-bind="form.field('scope')"
					data-test="service-scope"
					item-title="title"
					item-value="value"
					:items="scopeItems"
					:label="$t('service.field.scope')"
				/>
			</v-col>
		</v-row>

		<v-text-field
			v-model="model.baseUrl"
			v-bind="form.field('baseUrl')"
			data-test="service-url"
			:hint="$t('service.field.base_url_hint')"
			:label="$t('service.field.base_url')"
			persistent-hint
		/>

		<v-text-field
			v-model="model.token"
			v-bind="form.field('token')"
			:append-inner-icon="showToken ? 'mdi-eye-off' : 'mdi-eye'"
			autocomplete="off"
			class="mt-4"
			data-test="service-token"
			:hint="editing ? $t('service.field.token_hint_edit') : $t('service.field.token_hint')"
			:label="$t('service.field.token')"
			persistent-hint
			:type="showToken ? 'text' : 'password'"
			@click:append-inner="showToken = !showToken"
		/>

		<v-row class="mt-2" density="compact">
			<v-col cols="12" sm="6">
				<v-text-field
					v-model.number="model.priority"
					v-bind="form.field('priority')"
					:hint="$t('service.field.priority_hint')"
					:label="$t('service.field.priority')"
					persistent-hint
					type="number"
				/>
			</v-col>

			<v-col cols="12" sm="6">
				<v-switch
					v-model="model.authProvider"
					color="primary"
					hide-details
					:label="$t('service.field.auth_provider')"
				/>

				<p class="text-caption text-medium-emphasis">
					{{ $t('service.field.auth_provider_hint') }}
				</p>
			</v-col>
		</v-row>

		<div class="service-form_roots mt-4">
			<p class="text-subtitle-2 mb-0">{{ $t('service.field.roots') }}</p>

			<p class="text-caption text-medium-emphasis mb-2">
				{{ $t('service.field.roots_hint') }}
			</p>

			<v-row density="compact">
				<v-col cols="12" sm="6">
					<v-text-field
						v-model="model.remoteRoot"
						v-bind="form.field('remoteRoot')"
						data-test="service-remote-root"
						:hint="$t('service.field.remote_root_hint')"
						:label="$t('service.field.remote_root')"
						persistent-hint
					/>
				</v-col>

				<v-col cols="12" sm="6">
					<v-text-field
						v-model="model.localRoot"
						v-bind="form.field('localRoot')"
						data-test="service-local-root"
						:hint="$t('service.field.local_root_hint')"
						:label="$t('service.field.local_root')"
						persistent-hint
					>
						<template #append-inner>
							<v-icon
								class="cursor-pointer"
								icon="mdi-folder-search-outline"
								:title="$t('browse.open')"
								@click="browsingLocalRoot = true"
							/>
						</template>
					</v-text-field>

					<DirectoryPicker
						v-model="browsingLocalRoot"
						:path="model.localRoot"
						@choose="model.localRoot = $event"
					/>
				</v-col>
			</v-row>
		</div>

		<v-alert
			v-if="probe"
			class="service-form_probe mt-2"
			data-test="service-probe-result"
			density="comfortable"
			:type="probe.reachable && probe.authenticated ? 'success' : 'error'"
			variant="tonal"
		>
			<template v-if="probe.reachable && probe.authenticated">
				<p class="mb-1">
					{{ $t('service.probe.ok', {
						name: probe.serverName ?? $t('common.unknown'),
						version: probe.version ?? $t('common.unknown'),
					}) }}
				</p>

				<p class="mb-1">
					{{ $t('service.probe.libraries', { count: probe.libraries.length }, probe.libraries.length) }}
				</p>

				<ul class="service-form_libraries">
					<li v-for="library of probe.libraries" :key="library.externalId">
						{{ library.name }} — {{ $t(`library.kind.${library.kind}`) }}
						<span v-if="library.paths.length > 0" class="text-medium-emphasis">
							({{ library.paths.join(', ') }})
						</span>
					</li>
				</ul>
			</template>

			<template v-else>
				{{ probe.reachable ? $t('service.probe.unauthorized') : $t('service.probe.unreachable') }}
			</template>
		</v-alert>

		<FormMainError :form="form" />

		<div class="service-form_actions mt-4">
			<v-btn
				data-test="service-probe"
				:loading="probing || form.loading"
				variant="tonal"
				@click="onProbeClick"
			>
				{{ $t('service.probe.action') }}
			</v-btn>

			<v-spacer />

			<v-btn variant="text" @click="emit('cancel')">{{ $t('actions.cancel') }}</v-btn>

			<v-btn
				color="primary"
				data-test="service-save"
				:loading="form.loading"
				type="submit"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</div>
	</v-form>
</template>

<style lang="scss">
	.service-form {
		&_actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_libraries {
			margin: 0;
			padding-left: 18px;
			font-size: 13px;
		}
	}
</style>
