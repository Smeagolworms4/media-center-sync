<script lang="ts" setup>
	import type { Peer } from '@mcs/shared';
	import { PeerDirection, PeerStatus } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import CopyField from '@/components/common/CopyField.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import Confirm from '@/components/Confirm.vue';
	import InviteDialog from '@/components/peer/InviteDialog.vue';
	import PeerCard from '@/components/peer/PeerCard.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { usePeersStore } from '@/stores/peers';

	defineOptions({ name: 'PeersPage' });

	/**
	 * The linked gateways, and what somebody needs to link to this one.
	 *
	 * Whether direct connections are possible is stated next to the identity rather
	 * than hidden in a diagnostic: a gateway whose port is not forwarded works, but
	 * every transfer goes through a relay whose bandwidth is shared by everybody
	 * using it — and that is better learned here than while wondering why a pull is
	 * slow.
	 */
	const peersStore = usePeersStore();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const inviteOpen = ref(false);
	const renaming = ref<Peer | null>(null);
	const renameValue = ref('');
	const renameBusy = ref(false);
	const removing = ref<Peer | null>(null);
	const removeBusy = ref(false);

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				peersStore.load(),
				peersStore.loadIdentity().catch(() => undefined),
			]);
		} catch {
			failed.value = true;
		}
	}

	onMounted(() => {
		void load();
	});

	const identity = computed(() => peersStore.identity);

	/**
	 * A request waiting on somebody here goes first.
	 *
	 * It is the only row on this page that is a question rather than a fact, and on a
	 * gateway with a dozen peers it would otherwise sit wherever the API happened to
	 * put it.
	 */
	const orderedPeers = computed(() => {
		const incoming = peersStore.peers.filter(
			one => one.status === PeerStatus.PENDING && one.direction === PeerDirection.INCOMING);
		const rest = peersStore.peers.filter(one => !incoming.includes(one));
		return [...incoming, ...rest];
	});

	const connect = tryCallback(async (peer: Peer) => {
		await peersStore.connect(peer.id);
		void notify('peer.connecting');
	});

	const approve = tryCallback(async (peer: Peer) => {
		await peersStore.approve(peer.id);
		void notify('peer.approved');
	});

	const block = tryCallback(async (peer: Peer) => {
		await peersStore.block(peer.id);
		void notify('peer.blocked');
	});

	const unblock = tryCallback(async (peer: Peer) => {
		await peersStore.unblock(peer.id);
		void notify('peer.unblocked');
	});

	function startRename (peer: Peer): void {
		renaming.value = peer;
		renameValue.value = peer.name;
	}

	const confirmRename = tryCallback(async () => {
		if (!renaming.value) {
			return;
		}
		renameBusy.value = true;
		try {
			await peersStore.rename(renaming.value.id, renameValue.value);
			renaming.value = null;
			void notify('peer.renamed');
		} finally {
			renameBusy.value = false;
		}
	});

	const confirmRemove = tryCallback(async () => {
		if (!removing.value) {
			return;
		}
		removeBusy.value = true;
		try {
			await peersStore.remove(removing.value.id);
			removing.value = null;
			void notify('peer.removed');
		} finally {
			removeBusy.value = false;
		}
	});

	async function onLinked (): Promise<void> {
		void notify('peer.linked');
		await load();
	}
</script>

<template>
	<div class="page-container peers">
		<PageHeader
			icon="mdi-account-network-outline"
			:loading="peersStore.loading"
			:subtitle="$t('peer.subtitle')"
			:title="$t('pages.peers')"
		>
			<template #actions>
				<v-btn
					color="primary"
					data-test="peer-invite"
					prepend-icon="mdi-account-plus-outline"
					@click="inviteOpen = true"
				>
					{{ $t('peer.invite.open') }}
				</v-btn>
			</template>
		</PageHeader>

		<v-card v-if="identity" class="peers_identity" data-test="peer-identity">
			<v-card-title class="text-subtitle-1">{{ $t('peer.identity.title') }}</v-card-title>

			<v-card-text>
				<!--
					The node identifier sits first because it is the one somebody is asked
					for when something goes round in circles: a friend of a friend
					propagates what it hears, and a gateway that cannot recognise its own
					name receives its own catalogue back through a third party. It is
					generated once and is deliberately not the fingerprint, which a key
					rotation would change.
				-->
				<template v-if="identity.nodeId">
					<CopyField
						data-test="peer-node-id"
						:label="$t('peer.identity.node_id')"
						:value="identity.nodeId"
						wrap
					/>

					<p class="text-caption text-medium-emphasis mt-1 mb-3">
						{{ $t('peer.identity.node_id_help') }}
					</p>
				</template>

				<CopyField :label="$t('peer.identity.fingerprint')" :value="identity.fingerprint" wrap />

				<CopyField
					class="mt-3"
					:label="$t('peer.identity.rendezvous')"
					:value="identity.rendezvous"
					wrap
				/>

				<CopyField
					v-if="identity.directAddress"
					class="mt-3"
					:label="$t('peer.identity.direct_address')"
					:value="identity.directAddress"
				/>

				<v-alert
					class="mt-4"
					data-test="peer-reachability"
					density="compact"
					:type="identity.directReachable ? 'success' : 'warning'"
					variant="tonal"
				>
					{{ identity.directReachable
						? $t('peer.identity.direct_ok')
						: $t('peer.identity.relay_only') }}
				</v-alert>
			</v-card-text>
		</v-card>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<EmptyState
				v-if="!peersStore.loading && peersStore.peers.length === 0"
				icon="mdi-account-network-outline"
				:text="$t('peer.empty_text')"
				:title="$t('peer.empty_title')"
			>
				<v-btn color="primary" @click="inviteOpen = true">{{ $t('peer.invite.open') }}</v-btn>
			</EmptyState>

			<v-row v-else class="mt-2" data-test="peer-list" density="compact">
				<v-col
					v-for="peer of orderedPeers"
					:key="peer.id"
					cols="12"
					md="6"
				>
					<PeerCard
						:peer="peer"
						@approve="approve"
						@block="block"
						@connect="connect"
						@remove="removing = $event"
						@rename="startRename"
						@unblock="unblock"
					/>
				</v-col>
			</v-row>
		</template>

		<InviteDialog v-model="inviteOpen" @linked="onLinked" />

		<Window
			:max-width="440"
			:model-value="renaming !== null"
			:title="$t('peer.action.rename')"
			@update:model-value="renaming = null"
		>
			<v-text-field
				v-model="renameValue"
				data-test="peer-rename-input"
				:label="$t('peer.name')"
			/>

			<template #actions>
				<v-spacer />

				<v-btn variant="text" @click="renaming = null">{{ $t('actions.cancel') }}</v-btn>

				<v-btn color="primary" :loading="renameBusy" @click="confirmRename">
					{{ $t('actions.save') }}
				</v-btn>
			</template>
		</Window>

		<Confirm
			:loading="removeBusy"
			:model-value="removing !== null"
			:text="$t('peer.remove_confirm', { name: removing?.name ?? '' })"
			:title="$t('peer.remove_title')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>
	</div>
</template>

<style lang="scss">
	.peers {
		&_identity {
			margin-bottom: $cardGap;
		}
	}
</style>
