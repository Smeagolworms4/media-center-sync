<script lang="ts" setup>
	import { computed, onMounted, reactive, ref } from 'vue';
	import { useRouter } from 'vue-router';
	import ErrorState from '@/components/common/ErrorState.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useAuthStore } from '@/stores/auth';

	defineOptions({ name: 'SetupPage' });

	/**
	 * The first screen anybody ever sees of this gateway.
	 *
	 * A fresh install has no account at all — deliberately, because shipping
	 * `admin` / `admin` would put a default password on something reachable from a
	 * network, and printing a generated one in the logs assumes somebody reads
	 * logs. So the gateway says it needs claiming and this asks.
	 *
	 * It reads as a welcome rather than as a form because that is what it is: the
	 * product introducing itself, with exactly one thing to do. The three lines
	 * above the fields are what somebody is about to get; everything else can wait
	 * until they are inside.
	 */
	const router = useRouter();
	const authStore = useAuthStore();
	const validators = useValidators();
	const { notify } = useNotifier();

	const PASSWORD_MIN = 8;

	const loading = ref(true);
	const failed = ref(false);
	/** True once the gateway says it has an account, which closes this screen. */
	const claimed = ref(false);
	const showPassword = ref(false);

	const model = reactive({
		displayName: '',
		username: '',
		password: '',
		confirmation: '',
	});

	const version = computed(() => authStore.setupVersion);

	/**
	 * Asked again on arrival rather than trusted from the guard.
	 *
	 * Somebody may have this address open in a second tab while finishing the setup
	 * in the first; the account then exists and the open route is already closed.
	 * Showing them a form whose submit can only fail is worse than sending them to
	 * the screen that will actually let them in.
	 */
	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const state = await authStore.loadSetupState();
			if (state === null) {
				failed.value = true;
				return;
			}
			if (!state.required) {
				// The form is taken down before the navigation rather than after it: a
				// screen offering to create an account on a gateway that already has one
				// is wrong for as long as it is on screen, however briefly.
				claimed.value = true;
				// And the loader with it, before awaiting the navigation rather than in
				// the `finally` after it. A router transition takes several ticks, and
				// until it settles `loading` would still be true — so the one thing this
				// visitor needs, the way in, is behind a spinner for exactly as long as
				// the redirect takes, on the screen that exists to say they do not need
				// this form.
				loading.value = false;
				await router.replace({ name: 'login' });
			}
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	const form = useForm({
		fallbackError: 'setup.failed',
		fields: {
			displayName: { rules: [validators.maxlength({ max: 120 })] },
			username: {
				rules: [validators.required(), validators.maxlength({ max: 255 })],
			},
			password: {
				// The floor is the API's, said here rather than discovered on submit:
				// somebody who has already chosen a password and typed it twice should
				// not be told afterwards that it was never going to be accepted.
				rules: [
					validators.required(),
					validators.minlength({ min: PASSWORD_MIN }),
					validators.maxlength({ max: 255 }),
				],
			},
			confirmation: {
				rules: [
					validators.required(),
					validators.repeatField({ repeat: () => model.password }),
				],
			},
		},
		handle: async () => {
			try {
				await authStore.setup({
					username: model.username,
					password: model.password,
					...(model.displayName ? { displayName: model.displayName } : {}),
				});
			} catch (error) {
				// The open route closes the instant an account exists, and two people
				// unpacking the same gateway is exactly when that happens. "You are not
				// allowed to do that" would be true and useless; what they need is the
				// screen that will let them in.
				const state = await authStore.loadSetupState();
				if (state && !state.required) {
					void notify('setup.already_claimed', 'warning');
					await router.replace({ name: 'login' });
					return;
				}
				throw error;
			}
			// The route answered a session, so this lands inside rather than on the
			// sign-in page: nobody should retype the credentials they just chose.
			await router.push({ name: 'dashboard' });
		},
	});
</script>

<template>
	<div class="setup">
		<v-card class="setup_card" :elevation="8" :max-width="560" width="100%">
			<v-card-item>
				<div class="setup_brand">
					<v-icon color="primary" icon="mdi-sync-circle" size="40" />

					<div>
						<v-card-title class="setup_title">
							{{ $t('setup.welcome', { name: $t('app.name') }) }}
						</v-card-title>

						<v-card-subtitle>{{ $t('setup.tagline') }}</v-card-subtitle>
					</div>
				</div>
			</v-card-item>

			<v-card-text>
				<div v-if="loading" class="setup_loading text-center py-8">
					<v-progress-circular color="primary" indeterminate size="36" />
				</div>

				<ErrorState v-else-if="failed" @retry="load" />

				<div v-else-if="claimed" class="setup_claimed" data-test="setup-claimed">
					<p class="text-body-2 mb-4">{{ $t('setup.already_claimed') }}</p>

					<v-btn color="primary" :to="{ name: 'login' }">{{ $t('actions.sign_in') }}</v-btn>
				</div>

				<template v-else>
					<p class="text-body-2 mb-4">{{ $t('setup.intro') }}</p>

					<v-list class="setup_promises mb-4" density="compact">
						<v-list-item
							v-for="line of ['index', 'friends', 'pull']"
							:key="line"
							class="px-0"
							:title="$t(`setup.promise.${line}`)"
						>
							<template #prepend>
								<v-icon color="primary" icon="mdi-check" size="small" />
							</template>
						</v-list-item>
					</v-list>

					<v-form v-form="form" class="setup_form" data-test="setup-form">
						<p class="text-subtitle-2 mb-1">{{ $t('setup.account') }}</p>

						<p class="text-caption text-medium-emphasis mb-3">{{ $t('setup.account_help') }}</p>

						<v-text-field
							v-model="model.displayName"
							v-bind="form.field('displayName')"
							autocomplete="name"
							data-test="setup-display-name"
							:hint="$t('setup.display_name_hint')"
							:label="$t('setup.display_name')"
							persistent-hint
							prepend-inner-icon="mdi-card-account-details-outline"
						/>

						<v-text-field
							v-model="model.username"
							v-bind="form.field('username')"
							autocomplete="username"
							class="mt-3"
							data-test="setup-username"
							:label="$t('auth.username')"
							prepend-inner-icon="mdi-account-outline"
						/>

						<v-text-field
							v-model="model.password"
							v-bind="form.field('password')"
							:append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
							autocomplete="new-password"
							data-test="setup-password"
							:hint="$t('setup.password_hint', { min: PASSWORD_MIN })"
							:label="$t('auth.password')"
							persistent-hint
							prepend-inner-icon="mdi-lock-outline"
							:type="showPassword ? 'text' : 'password'"
							@click:append-inner="showPassword = !showPassword"
						/>

						<v-text-field
							v-model="model.confirmation"
							v-bind="form.field('confirmation')"
							autocomplete="new-password"
							class="mt-3"
							data-test="setup-confirmation"
							:label="$t('setup.confirmation')"
							prepend-inner-icon="mdi-lock-check-outline"
							type="password"
						/>

						<FormMainError :form="form" />

						<v-btn
							block
							class="setup_submit mt-4"
							color="primary"
							data-test="setup-submit"
							:loading="form.loading"
							size="large"
							type="submit"
						>
							{{ $t('setup.action') }}
						</v-btn>
					</v-form>

					<p class="setup_why text-caption text-medium-emphasis mt-4 mb-0">
						{{ $t('setup.why_no_default') }}
					</p>

					<p v-if="version" class="text-caption text-disabled mt-2 mb-0" data-test="setup-version">
						{{ $t('setup.version', { version }) }}
					</p>
				</template>
			</v-card-text>
		</v-card>
	</div>
</template>

<style lang="scss">
	.setup {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: $layoutGutter;

		&_brand {
			display: flex;
			align-items: center;
			gap: 16px;
		}

		// Vuetify truncates a card title, a subtitle and a list item to one line with
		// an ellipsis. Everything on this screen is a sentence — it is the only screen
		// that has to explain itself — so all three wrap instead of being cut.
		&_title,
		.v-card-subtitle {
			white-space: normal;
		}

		&_title {
			font-weight: 600;
		}

		&_promises {
			background: transparent;

			.v-list-item-title {
				white-space: normal;
				line-height: 1.4;
			}
		}
	}
</style>
