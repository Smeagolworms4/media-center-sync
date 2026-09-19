<script lang="ts" setup>
	import type { AuthProvider } from '@mcs/shared';
	import { computed, onMounted, reactive, ref } from 'vue';
	import { useRouter } from 'vue-router';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useAuthStore } from '@/stores/auth';

	/**
	 * The sign-in page, and the reference for every other form in this application.
	 *
	 * The shape to copy: `useForm` owns the loading flag, the main error and the
	 * field errors; the component only describes what to render. Nothing here calls
	 * `fetch` or builds a URL — `stores/auth` does that — and no error string is
	 * written by hand, because the API answers with keys and the catalogue decides
	 * the wording.
	 */
	const router = useRouter();
	const authStore = useAuthStore();
	const validators = useValidators();

	const loadingProviders = ref(true);
	const providersError = ref(false);
	const showPassword = ref(false);

	const model = reactive({
		provider: '',
		username: '',
		password: '',
	});

	const providers = computed(() => authStore.providers);
	const selected = computed<AuthProvider | null>(
		() => providers.value.find(one => one.key === model.provider) ?? null);

	/**
	 * A gateway with no provider at all is a real state, not a bug: it happens
	 * before the first media service is registered. Rendering an empty select with
	 * a dead button there would leave somebody with nothing to read and nothing to
	 * press, so that case gets its own explanation.
	 */
	const hasProviders = computed(() => providers.value.length > 0);
	const needsCredentials = computed(() => selected.value?.credentials !== false);

	/** One provider is the common case; a select with a single option is noise. */
	const showProviderChoice = computed(() => providers.value.length > 1);

	const providerIcons: Record<string, string> = {
		jellyfin: 'mdi-jellyfish-outline',
		plex: 'mdi-plex',
		key: 'mdi-key-outline',
	};

	function iconOf (provider: AuthProvider): string {
		return providerIcons[provider.icon] ?? 'mdi-login-variant';
	}

	async function loadProviders (): Promise<void> {
		loadingProviders.value = true;
		providersError.value = false;
		try {
			const loaded = await authStore.loadProviders();
			model.provider = loaded[0]?.key ?? '';
		} catch {
			providersError.value = true;
		} finally {
			loadingProviders.value = false;
		}
	}

	onMounted(() => {
		void loadProviders();
	});

	const form = useForm({
		// Wrong credentials is by far the likeliest failure, so it is the sentence
		// shown when the API answers with something this build cannot translate.
		fallbackError: 'error.auth.invalid_credentials',
		fields: {
			provider: { rules: [validators.required()] },
			username: {
				rules: [validators.required(), validators.maxlength({ max: 180 })],
			},
			password: { rules: [validators.required()] },
		},
		handle: async () => {
			const provider = selected.value;
			if (provider && !provider.credentials) {
				// A redirect flow leaves the application; there is nothing to await.
				window.location.assign(provider.redirectUrl ?? '/');
				return;
			}
			await authStore.login({
				provider: model.provider,
				username: model.username,
				password: model.password,
			});
			await router.push({ name: 'dashboard' });
		},
	});
</script>

<template>
	<div class="login">
		<v-card class="login_card" :elevation="8" :max-width="440" width="100%">
			<v-card-item>
				<v-card-title class="login_title">{{ $t('app.name') }}</v-card-title>
				<v-card-subtitle>{{ $t('app.tagline') }}</v-card-subtitle>
			</v-card-item>

			<v-card-text>
				<div v-if="loadingProviders" class="login_loading text-center py-8">
					<v-progress-circular color="primary" indeterminate size="36" />
				</div>

				<ErrorState v-else-if="providersError" @retry="loadProviders" />

				<EmptyState
					v-else-if="!hasProviders"
					icon="mdi-account-lock-outline"
					:text="$t('auth.no_provider_text')"
					:title="$t('auth.no_provider_title')"
				>
					<v-btn variant="tonal" @click="loadProviders">{{ $t('actions.retry') }}</v-btn>
				</EmptyState>

				<v-form v-else v-form="form" class="login_form">
					<p class="text-body-2 text-medium-emphasis mb-4">{{ $t('auth.subtitle') }}</p>

					<v-select
						v-if="showProviderChoice"
						v-model="model.provider"
						v-bind="form.field('provider')"
						class="login_provider"
						item-title="label"
						item-value="key"
						:items="providers"
						:label="$t('auth.provider')"
					>
						<template #item="{ props: itemProps, item }">
							<v-list-item v-bind="itemProps" :prepend-icon="iconOf(item)" />
						</template>
					</v-select>

					<template v-if="needsCredentials">
						<v-text-field
							v-model="model.username"
							v-bind="form.field('username')"
							autocomplete="username"
							class="login_username"
							:label="$t('auth.username')"
							prepend-inner-icon="mdi-account-outline"
						/>

						<v-text-field
							v-model="model.password"
							v-bind="form.field('password')"
							:append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
							autocomplete="current-password"
							class="login_password"
							:label="$t('auth.password')"
							prepend-inner-icon="mdi-lock-outline"
							:type="showPassword ? 'text' : 'password'"
							@click:append-inner="showPassword = !showPassword"
						/>
					</template>

					<p v-else class="text-body-2 text-medium-emphasis mb-4">
						{{ $t('auth.redirect_hint', { provider: selected?.label ?? '' }) }}
					</p>

					<FormMainError :form="form" />

					<v-btn
						block
						class="login_submit mt-2"
						color="primary"
						:loading="form.loading"
						size="large"
						type="submit"
					>
						{{ needsCredentials ? $t('actions.sign_in') : $t('auth.redirect') }}
					</v-btn>
				</v-form>
			</v-card-text>
		</v-card>
	</div>
</template>

<style lang="scss">
	.login {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: $layoutGutter;

		&_title {
			font-weight: 600;
		}
	}
</style>
