<script lang="ts" setup>
	import type { Library, Peer, SharePolicy } from '@mcs/shared';
	import { ShareVisibility } from '@mcs/shared';
	import { computed, reactive, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import FormMainError from '@/components/FormMainError.vue';
	import { useByteSize } from '@/composables/useByteSize';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useSharesStore } from '@/stores/shares';

	/**
	 * What one library exposes.
	 *
	 * The policy always arrives, even for a library nobody has configured: that one
	 * carries `overridden: false` and the gateway default resolved for it. Saying so
	 * on screen is the point — "nobody" chosen by somebody and "nobody" because the
	 * library is not ours to give are opposite states, and a form that shows the same
	 * select for both leaves people guessing which one they are looking at.
	 *
	 * Saving turns a library into an overridden one: from then on it stops moving when
	 * the gateway default moves. Dropping the override is a deletion, which hands the
	 * library back to that default rather than making it private.
	 */
	const props = withDefaults(defineProps<{
		library: Library;
		policy?: SharePolicy | null;
		peers?: Peer[];
	}>(), {
		policy: null,
		peers: () => [],
	});

	const emit = defineEmits<{
		saved: [policy: SharePolicy];
		removed: [libraryId: string];
	}>();

	const { t } = useI18n();
	const sharesStore = useSharesStore();
	const validators = useValidators();
	const { parseByteSize, toByteSizeInput } = useByteSize();

	const model = reactive({
		visibility: props.policy?.visibility ?? ShareVisibility.PRIVATE,
		allowedPeerIds: [...(props.policy?.allowedPeerIds ?? [])],
		deniedPeerIds: [...(props.policy?.deniedPeerIds ?? [])],
		rateLimit: toByteSizeInput(props.policy?.rateLimit ?? 0),
	});

	// Re-seeded when the row underneath changes, which it does after the override is
	// dropped: the library then falls back to the gateway default, and a form still
	// showing what somebody had set would offer to save a value nobody chose.
	watch(() => props.policy, policy => {
		model.visibility = policy?.visibility ?? ShareVisibility.PRIVATE;
		model.allowedPeerIds = [...(policy?.allowedPeerIds ?? [])];
		model.deniedPeerIds = [...(policy?.deniedPeerIds ?? [])];
		model.rateLimit = toByteSizeInput(policy?.rateLimit ?? 0);
	});

	/**
	 * Whether what this shows was chosen for this library or is the default applying.
	 *
	 * Two states now rather than three. The third was "not ours to share", a library on
	 * a service whose files this gateway does not hold: it stayed private whatever the
	 * default said, and could only be shared by agreeing to relay it one library at a
	 * time. That is one switch on the service now, so the answer for every library that
	 * nobody has decided about is the same one — it follows the service, and the
	 * gateway default behind it.
	 */
	const origin = computed(() => (props.policy?.overridden ? 'set' : 'default'));

	const visibilityItems = computed(() => Object.values(ShareVisibility).map(value => ({
		value,
		title: t(`share.visibility_value.${value}`),
	})));

	// The rule chosen is explained under the select rather than inside it: the
	// three of them differ by who is included, and that is a sentence, not a label.
	const visibilityHelp = computed(() => t(`share.visibility_help.${model.visibility}`));
	const shared = computed(() => model.visibility !== ShareVisibility.PRIVATE);

	const form = useForm({
		fallbackError: 'error.general',
		fields: {
			visibility: { rules: [validators.required()] },
			rateLimit: { rules: [validators.byteSize()] },
		},
		handle: async () => {
			const saved = await sharesStore.save(props.library.id, {
				visibility: model.visibility,
				allowedPeerIds: [...model.allowedPeerIds],
				deniedPeerIds: [...model.deniedPeerIds],
				rateLimit: parseByteSize(model.rateLimit) ?? 0,
			});
			emit('saved', saved);
		},
	});

	async function followDefault (): Promise<void> {
		await sharesStore.remove(props.library.id);
		emit('removed', props.library.id);
	}
</script>

<template>
	<v-form v-form="form" class="share-policy-form" data-test="share-policy">
		<p
			class="text-caption text-medium-emphasis mb-3"
			:data-origin="origin"
			data-test="share-origin-note"
		>
			<v-icon
				class="mr-1"
				:icon="origin === 'set' ? 'mdi-account-check-outline' : 'mdi-cog-outline'"
				size="small"
			/>

			{{ $t(`share.origin.${origin}_hint`) }}
		</p>

		<v-select
			v-model="model.visibility"
			v-bind="form.field('visibility')"
			data-test="share-visibility"
			:hint="visibilityHelp"
			item-title="title"
			item-value="value"
			:items="visibilityItems"
			:label="$t('share.visibility')"
			persistent-hint
		/>

		<template v-if="shared">
			<v-select
				v-model="model.allowedPeerIds"
				chips
				class="mt-2"
				closable-chips
				data-test="share-allowed"
				:hint="$t('share.allowed_hint')"
				item-title="name"
				item-value="id"
				:items="peers"
				:label="$t('share.allowed')"
				multiple
				persistent-hint
			/>

			<v-select
				v-model="model.deniedPeerIds"
				chips
				class="mt-4"
				closable-chips
				data-test="share-denied"
				:hint="$t('share.denied_hint')"
				item-title="name"
				item-value="id"
				:items="peers"
				:label="$t('share.denied')"
				multiple
				persistent-hint
			/>

			<v-text-field
				v-model="model.rateLimit"
				v-bind="form.field('rateLimit')"
				class="mt-2"
				data-test="share-rate-limit"
				:hint="$t('share.rate_limit_hint')"
				:label="$t('share.rate_limit')"
				persistent-hint
			/>
		</template>

		<FormMainError :form="form" />

		<div class="share-policy-form_actions mt-4">
			<v-btn
				v-if="policy?.overridden"
				color="error"
				data-test="share-remove"
				variant="text"
				@click="followDefault"
			>
				{{ $t('share.follow_default') }}
			</v-btn>

			<v-spacer />

			<v-btn
				color="primary"
				data-test="share-save"
				:loading="form.loading"
				type="submit"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</div>
	</v-form>
</template>

<style lang="scss">
	.share-policy-form {
		&_actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}
	}
</style>
