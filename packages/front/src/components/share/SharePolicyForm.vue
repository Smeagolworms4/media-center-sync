<script lang="ts" setup>
	import type { Library, Peer, SharePolicy } from '@mcs/shared';
	import { ShareVisibility } from '@mcs/shared';
	import { computed, reactive } from 'vue';
	import { useI18n } from 'vue-i18n';
	import FormMainError from '@/components/FormMainError.vue';
	import { useByteSize } from '@/composables/useByteSize';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useSharesStore } from '@/stores/shares';

	/**
	 * What one library exposes.
	 *
	 * A library with no policy is private, so the absence of a row here means
	 * "nobody", never "not decided yet" — which is why making a library private
	 * again is a deletion rather than a visibility nobody would notice was missing.
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

	async function makePrivate (): Promise<void> {
		await sharesStore.remove(props.library.id);
		model.visibility = ShareVisibility.PRIVATE;
		emit('removed', props.library.id);
	}
</script>

<template>
	<v-form v-form="form" class="share-policy-form" data-test="share-policy">
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
				v-if="policy"
				color="error"
				data-test="share-remove"
				variant="text"
				@click="makePrivate"
			>
				{{ $t('share.make_private') }}
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
