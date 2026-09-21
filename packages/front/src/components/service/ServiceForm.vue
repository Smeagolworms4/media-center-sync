<script lang="ts" setup>
	import type {
		CreateMediaServiceRequest,
		MediaService,
		MediaServiceProbe,
		ProbeMediaServiceRequest,
	} from '@mcs/shared';
	import { MediaServiceMode, MediaServiceType, ShareVisibility } from '@mcs/shared';
	import { computed, onMounted, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useServicesStore } from '@/stores/services';
	import { useSettingsStore } from '@/stores/settings';

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
	const settingsStore = useSettingsStore();
	const validators = useValidators();

	const editing = computed(() => props.service !== null);
	const showToken = ref(false);
	const probing = ref(false);
	const probe = ref<MediaServiceProbe | null>(null);

	const model = reactive<CreateMediaServiceRequest>({
		name: props.service?.name ?? '',
		type: props.service?.type ?? MediaServiceType.JELLYFIN,
		/*
		 * A new service is shared; an existing one keeps whatever it already says.
		 *
		 * On by default for the same reason the gateway's default visibility is a real
		 * level rather than silence: a service registered and quietly invisible shows a
		 * friend an empty shelf, and they read that as a link that failed. Never
		 * re-defaulted on an edit — a form opened to correct a port must not switch
		 * sharing back on for something somebody deliberately turned off.
		 */
		shared: props.service?.shared ?? true,
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

	/**
	 * A peer-backed service is not offered the sharing switch, and that is the same
	 * class of decision as its type not being in the list above.
	 *
	 * What a friend's friend holds will be reached by introducing the two ends so they
	 * connect to each other, never by this gateway carrying the bytes through. A control
	 * offering to carry them would describe something the product does not do — and one
	 * people had started using would be the wrong path to take away later.
	 */
	const sharingOffered = computed(() => props.service?.mode !== MediaServiceMode.PEER);

	/**
	 * Whether this gateway would be reading the files off disk or over the connection.
	 *
	 * Read live from the form rather than from the saved row, so that typing a local
	 * root makes the warning below disappear as somebody fixes the thing it warns about.
	 */
	const filesHere = computed(() =>
		Boolean(model.localRoot?.trim()) || props.service?.mode === MediaServiceMode.LOCAL);

	/**
	 * What turning it on actually does, named at the moment somebody does it.
	 *
	 * The level comes from the gateway setting rather than being spelled out here: the
	 * switch grants `defaultShareVisibility`, whatever that is set to, so a sentence
	 * saying "shared" in the abstract would be true and useless — somebody is entitled
	 * to read "my peers and theirs" before they agree to it, and that sentence has to
	 * change when they change the setting.
	 */
	const sharingHint = computed(() => {
		const visibility
			= settingsStore.settings?.defaultShareVisibility ?? ShareVisibility.FRIENDS_OF_FRIENDS;
		const level = t(`share.visibility_value.${visibility}`);

		return filesHere.value
			? t('service.field.shared_hint', { level })
			: t('service.field.shared_hint_relayed', { level });
	});

	// The hint names a level held in the settings, so they have to be in hand. Failure
	// is not fatal: the computed above falls back to what the gateway ships with, which
	// is what an unreachable settings route would have answered anyway.
	onMounted(() => {
		if (!settingsStore.loaded) {
			void settingsStore.load().catch(() => undefined);
		}
	});

	/**
	 * The folder browser over `localRoot`, which is a directory on *this* gateway.
	 *
	 * Only the local side gets one: `remoteRoot` is a path inside the media server's
	 * own container and nothing here can see it, so offering the same icon next to it
	 * would list our directories for a field that is about theirs — the exact mix-up
	 * the two fields exist to keep apart.
	 */
	const browsingLocalRoot = ref(false);

	/**
	 * The directory the server itself says everything it holds is under.
	 *
	 * The left-hand side of the mapping, taken from the server rather than typed: the
	 * longest directory prefix common to every library it reported. With one library
	 * that is the library's own folder; with `/data/media/shows` and `/data/media/films`
	 * it is `/data/media`, which is exactly what `remoteRoot` is for — one statement
	 * instead of one path per library and one chance per library to get it wrong.
	 *
	 * Null when the server reported no path at all, which is the ordinary answer for a
	 * peer and for a Jellyfin reached with a key that cannot see the library settings.
	 */
	const serverRoot = computed(() => {
		const paths = (probe.value?.libraries ?? []).flatMap(library => library.paths);

		if (paths.length === 0) {
			return null;
		}

		const segments = paths.map(path => path.split('/'));
		const shared: string[] = [];

		for (let index = 0; index < segments[0].length; index += 1) {
			const part = segments[0][index];

			if (!segments.every(one => one[index] === part)) {
				break;
			}

			shared.push(part);
		}

		// A single shared segment is the empty root: every absolute path starts with
		// one, and `/` as a remote root would match every path in existence and derive
		// the whole filesystem into the local root.
		return shared.length > 1 ? shared.join('/') : null;
	});

	/** A probe answer stops describing what is in the form as soon as it changes. */
	watch(() => [model.baseUrl, model.token, model.type], () => {
		probe.value = null;
	});

	function request (): CreateMediaServiceRequest {
		return {
			name: model.name,
			type: model.type,
			shared: model.shared,
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
	 * What a probe needs, and nothing else.
	 *
	 * Separate from `request()` on purpose. A probe answers "do I reach this server
	 * with these credentials"; a name, a priority or a root mapping say nothing about
	 * whether it answers, and the route rightly declares none of them. Sending the
	 * whole form made it refuse six fields by name — for a body the very next request
	 * would have accepted verbatim — and the honest reading of that refusal is that
	 * the caller was sending something the route does not handle, not that the route
	 * was too strict.
	 */
	function probeRequest (): ProbeMediaServiceRequest {
		return {
			type: model.type,
			baseUrl: model.baseUrl,
			...(model.token ? { token: model.token } : {}),
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
				: await servicesStore.probe(probeRequest());
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
			<v-col cols="12">
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

		<div v-if="sharingOffered" class="service-form_sharing mt-2">
			<v-switch
				v-model="model.shared"
				color="primary"
				data-test="service-shared"
				hide-details
				:label="$t('service.field.shared')"
			/>

			<!--
				Stated, not blocked. Sharing a service whose files this gateway does not
				hold works — the bytes are read from the media server and passed on — and
				it costs this connection, which is the one thing nothing else on the
				screen would say. Shown only while the switch is on, because a consequence
				of a thing somebody has not done is noise.
			-->
			<p
				v-if="model.shared"
				class="text-caption text-medium-emphasis"
				data-test="service-shared-hint"
			>
				{{ sharingHint }}
			</p>
		</div>

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

					<!--
						What the server itself answered, offered rather than typed. This is
						the half of the mapping nobody should have to remember, and getting
						it wrong is invisible until a transfer lands somewhere the server
						never scans.
					-->
					<v-btn
						v-if="serverRoot && serverRoot !== model.remoteRoot"
						class="mt-1"
						data-test="service-remote-root-suggestion"
						density="compact"
						prepend-icon="mdi-server"
						size="small"
						variant="text"
						@click="model.remoteRoot = serverRoot"
					>
						{{ $t('service.field.remote_root_reported', { path: serverRoot }) }}
					</v-btn>
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

					<!--
						An existing service can be asked where its own folders are, so the
						dialog shows both sides of the mapping at once. A registration that
						has not been saved yet has no identifier to ask about; the reported
						paths from the probe above are what somebody reads instead.
					-->
					<DirectoryPicker
						v-model="browsingLocalRoot"
						:path="model.localRoot"
						:service-id="service?.id ?? null"
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
