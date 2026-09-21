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
	 * Linking two gateways, in the three shapes that conversation takes: handing out
	 * an invitation, using one somebody handed you, or pasting a fingerprint.
	 *
	 * They live in one dialog because they are one conversation — whoever opens it
	 * has just been told "send me a link", "here is mine" or "here is my
	 * fingerprint", and which of the three they are doing is a tab, not a screen.
	 *
	 * The fingerprint is not the fallback: it is what a link actually is, and it
	 * puts nothing secret in a chat log and nothing that expires. The code is the
	 * convenience, and the dialog says so rather than implying a code is required.
	 */
	const open = defineModel<boolean>({ default: false });

	const emit = defineEmits<{ linked: [peer: Peer] }>();

	const peersStore = usePeersStore();
	const validators = useValidators();

	const tab = ref<'create' | 'accept' | 'fingerprint'>('create');
	const invite = ref<PeerInvite | null>(null);
	const creating = ref(false);

	const model = reactive({ invite: '', name: '' });
	const addModel = reactive({ fingerprint: '', name: '', address: '' });

	async function create (): Promise<void> {
		creating.value = true;
		try {
			invite.value = await peersStore.invite();
		} finally {
			creating.value = false;
		}
	}

	const addForm = useForm({
		fallbackError: 'error.peer.not_found',
		fields: {
			fingerprint: { rules: [validators.required(), validators.maxlength({ max: 200 })] },
			name: { rules: [validators.maxlength({ max: 120 })] },
			address: { rules: [validators.maxlength({ max: 200 })] },
		},
		handle: async () => {
			const peer = await peersStore.add({
				fingerprint: addModel.fingerprint.trim(),
				...(addModel.name ? { name: addModel.name } : {}),
				...(addModel.address ? { address: addModel.address.trim() } : {}),
			});
			emit('linked', peer);
			open.value = false;
			addModel.fingerprint = '';
			addModel.name = '';
			addModel.address = '';
		},
	});

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

				<v-tab data-test="invite-tab-fingerprint" value="fingerprint">
					{{ $t('peer.add.tab') }}
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

				<div v-if="invite" class="invite-dialog_result mt-4" data-test="invite-result">
					<CopyField :label="$t('peer.invite.url')" :value="invite.url" wrap />

					<CopyField class="mt-3" :label="$t('peer.invite.code')" :value="invite.code" wrap />

					<p class="text-caption text-medium-emphasis mt-3 mb-0" data-test="invite-expiry">
						{{ $t('peer.invite.expires') }}
						<RelativeDate :date="invite.expiresAt" />
						— {{ $t('peer.invite.one_shot') }}
					</p>
				</div>
			</template>

			<template v-else-if="tab === 'accept'">
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

			<template v-else>
				<p class="text-body-2 text-medium-emphasis mb-3">{{ $t('peer.add.hint') }}</p>

				<v-form v-form="addForm">
					<v-text-field
						v-model="addModel.fingerprint"
						v-bind="addForm.field('fingerprint')"
						data-test="peer-fingerprint"
						:hint="$t('peer.add.fingerprint_hint')"
						:label="$t('peer.add.fingerprint')"
						persistent-hint
					/>

					<v-text-field
						v-model="addModel.name"
						v-bind="addForm.field('name')"
						class="mt-3"
						data-test="peer-name"
						:hint="$t('peer.invite.name_hint')"
						:label="$t('peer.invite.name')"
						persistent-hint
					/>

					<v-text-field
						v-model="addModel.address"
						v-bind="addForm.field('address')"
						class="mt-3"
						data-test="peer-address"
						:hint="$t('peer.add.address_hint')"
						:label="$t('peer.add.address')"
						persistent-hint
					/>

					<FormMainError :form="addForm" />

					<v-btn
						class="mt-4"
						color="primary"
						data-test="peer-add"
						:loading="addForm.loading"
						type="submit"
					>
						{{ $t('peer.add.action') }}
					</v-btn>
				</v-form>
			</template>
		</div>
	</Window>
</template>
