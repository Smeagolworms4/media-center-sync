<script lang="ts" setup>
	import type { Peer, PeerInvite } from '@mcs/shared';
	import { reactive, ref } from 'vue';
	import CopyField from '@/components/common/CopyField.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import Window from '@/components/Window.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { usePeersStore } from '@/stores/peers';

	/**
	 * The two halves of linking two gateways: handing out an invitation, and using
	 * one somebody handed you.
	 *
	 * They live in one dialog because they are one conversation — whoever opens it
	 * has just been told "send me a link" or "here is mine", and which of the two
	 * they are doing is a tab, not a screen.
	 */
	const open = defineModel<boolean>({ default: false });

	const emit = defineEmits<{ linked: [peer: Peer] }>();

	const peersStore = usePeersStore();
	const validators = useValidators();

	const tab = ref<'create' | 'accept'>('create');
	const invite = ref<PeerInvite | null>(null);
	const creating = ref(false);

	const model = reactive({ invite: '', name: '' });

	async function create (): Promise<void> {
		creating.value = true;
		try {
			invite.value = await peersStore.invite();
		} finally {
			creating.value = false;
		}
	}

	const form = useForm({
		fallbackError: 'error.peer.invite_invalid',
		fields: {
			invite: { rules: [validators.required()] },
			name: { rules: [validators.maxlength({ max: 120 })] },
		},
		handle: async () => {
			const peer = await peersStore.accept({
				invite: model.invite.trim(),
				...(model.name ? { name: model.name } : {}),
			});
			emit('linked', peer);
			open.value = false;
			model.invite = '';
			model.name = '';
		},
	});
</script>

<template>
	<Window v-model="open" :max-width="640" :title="$t('peer.invite.title')">
		<div class="invite-dialog" data-test="invite-dialog">
			<v-tabs v-model="tab" class="mb-4" density="compact">
				<v-tab data-test="invite-tab-create" value="create">
					{{ $t('peer.invite.create_tab') }}
				</v-tab>

				<v-tab data-test="invite-tab-accept" value="accept">
					{{ $t('peer.invite.accept_tab') }}
				</v-tab>
			</v-tabs>

			<template v-if="tab === 'create'">
				<p class="text-body-2 text-medium-emphasis">{{ $t('peer.invite.create_hint') }}</p>

				<v-btn
					class="mt-2"
					color="primary"
					data-test="invite-create"
					:loading="creating"
					prepend-icon="mdi-account-plus-outline"
					@click="create"
				>
					{{ $t('peer.invite.create_action') }}
				</v-btn>

				<div v-if="invite" class="invite-dialog_result mt-4">
					<CopyField :label="$t('peer.invite.url')" :value="invite.url" wrap />

					<CopyField class="mt-3" :label="$t('peer.invite.code')" :value="invite.code" wrap />

					<p class="text-caption text-medium-emphasis mt-3 mb-0">
						{{ $t('peer.invite.expires') }}
						<RelativeDate :date="invite.expiresAt" />
						— {{ $t('peer.invite.one_shot') }}
					</p>
				</div>
			</template>

			<template v-else>
				<v-form v-form="form">
					<v-textarea
						v-model="model.invite"
						v-bind="form.field('invite')"
						auto-grow
						data-test="invite-code"
						:label="$t('peer.invite.paste')"
						rows="2"
					/>

					<v-text-field
						v-model="model.name"
						v-bind="form.field('name')"
						data-test="invite-name"
						:hint="$t('peer.invite.name_hint')"
						:label="$t('peer.invite.name')"
						persistent-hint
					/>

					<FormMainError :form="form" />

					<v-btn
						class="mt-4"
						color="primary"
						data-test="invite-accept"
						:loading="form.loading"
						type="submit"
					>
						{{ $t('peer.invite.accept_action') }}
					</v-btn>
				</v-form>
			</template>
		</div>
	</Window>
</template>
