<script lang="ts" setup>
	import type { BannedPeer, Peer } from '@mcs/shared';
	import { DEFAULT_PEER_MAX_DEPTH, PeerDirection, PeerStatus } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import CopyField from '@/components/common/CopyField.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import Confirm from '@/components/Confirm.vue';
	import InviteDialog from '@/components/peer/InviteDialog.vue';
	import PeerCard from '@/components/peer/PeerCard.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { usePeersStore } from '@/stores/peers';
	import { useSettingsStore } from '@/stores/settings';

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
	const settingsStore = useSettingsStore();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const inviteOpen = ref(false);
	const renaming = ref<Peer | null>(null);
	const renameValue = ref('');
	const renameBusy = ref(false);
	const removing = ref<Peer | null>(null);
	const removeBusy = ref(false);
	/**
	 * Which way the reading switch is about to be thrown, and for whom.
	 *
	 * One dialog rather than two, because it is one decision read from two sides.
	 * Holding the peer and the direction together also means the confirmation can name
	 * both without the template guessing from the row's current state, which is what
	 * would be stale for the instant between the call and the answer.
	 */
	const reading = ref<{ peer: Peer; forbid: boolean } | null>(null);
	const readingBusy = ref(false);
	const banning = ref<Peer | null>(null);
	const banBusy = ref(false);
	const banReason = ref('');
	const depthBusy = ref<string | null>(null);
	const unbanning = ref<BannedPeer | null>(null);
	const unbanBusy = ref(false);

	/**
	 * The gateway ceiling, so each row can say what its "default" option resolves to.
	 *
	 * Falls back to the shipped default rather than to nothing: this page is readable
	 * by somebody who may not be allowed to read the settings at all, and a row
	 * labelled "Gateway default ()" is worse than one naming the value it almost
	 * certainly is.
	 */
	const ceiling = computed(() => settingsStore.settings?.peerMaxDepth ?? DEFAULT_PEER_MAX_DEPTH);

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				peersStore.load(),
				// Each of these is useful on its own, and none of them is worth failing
				// the page for: the ban list and the ceiling are context around the
				// peers, not the peers themselves.
				peersStore.loadIdentity().catch(() => undefined),
				peersStore.loadBans().catch(() => undefined),
				settingsStore.load().catch(() => undefined),
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

	function startForbidReading (peer: Peer): void {
		reading.value = { peer, forbid: true };
	}

	function startAllowReading (peer: Peer): void {
		reading.value = { peer, forbid: false };
	}

	const confirmReading = tryCallback(async () => {
		if (!reading.value) {
			return;
		}
		readingBusy.value = true;
		try {
			const { peer, forbid } = reading.value;
			await peersStore.setReadingForbidden(peer.id, forbid);
			reading.value = null;
			void notify(forbid ? 'peer.reading_forbidden' : 'peer.reading_allowed');
		} finally {
			readingBusy.value = false;
		}
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

	function startRemove (peer: Peer): void {
		removing.value = peer;
	}

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

	function startBan (peer: Peer): void {
		banning.value = peer;
		banReason.value = '';
	}

	const confirmBan = tryCallback(async () => {
		if (!banning.value) {
			return;
		}
		banBusy.value = true;
		try {
			await peersStore.ban(banning.value.id, banReason.value || undefined);
			banning.value = null;
			void notify('peer.banned');
		} finally {
			banBusy.value = false;
		}
	});

	const confirmUnban = tryCallback(async () => {
		if (!unbanning.value) {
			return;
		}
		unbanBusy.value = true;
		try {
			await peersStore.unban(unbanning.value.fingerprint);
			unbanning.value = null;
			void notify('peer.unbanned');
		} finally {
			unbanBusy.value = false;
		}
	});

	const setMaxDepth = tryCallback(async (peer: Peer, maxDepth: number | null) => {
		depthBusy.value = peer.id;
		try {
			await peersStore.setMaxDepth(peer.id, maxDepth);
			void notify('peer.max_depth.saved');
		} finally {
			depthBusy.value = null;
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
						:ceiling="ceiling"
						:peer="peer"
						:saving-depth="depthBusy === peer.id"
						@allow-reading="startAllowReading"
						@approve="approve"
						@ban="startBan"
						@connect="connect"
						@forbid-reading="startForbidReading"
						@max-depth="setMaxDepth"
						@remove="startRemove"
						@rename="startRename"
					/>
				</v-col>
			</v-row>
		</template>

		<!--
			Shown only when there is something on it. A permanently visible empty list
			of bans is a screen telling somebody about a decision they have never had
			to make.
		-->
		<v-card v-if="peersStore.bans.length > 0" class="peers_bans mt-6" data-test="peer-bans">
			<v-card-title class="text-subtitle-1">
				<v-icon class="mr-2" icon="mdi-cancel" size="small" />
				{{ $t('peer.bans.title') }}
			</v-card-title>

			<v-card-subtitle class="pb-2">{{ $t('peer.bans.hint') }}</v-card-subtitle>

			<v-list density="compact">
				<v-list-item
					v-for="ban of peersStore.bans"
					:key="ban.fingerprint"
					data-test="peer-ban-row"
				>
					<v-list-item-title>{{ ban.name || ban.fingerprint }}</v-list-item-title>

					<v-list-item-subtitle class="text-break-anywhere">
						<span v-if="ban.name">{{ ban.fingerprint }} · </span>
						<template v-if="ban.reason">{{ ban.reason }} · </template>
						<RelativeDate :date="ban.bannedAt" />
					</v-list-item-subtitle>

					<template #append>
						<v-btn
							data-test="peer-unban"
							size="small"
							variant="text"
							@click="unbanning = ban"
						>
							{{ $t('peer.action.unban') }}
						</v-btn>
					</template>
				</v-list-item>
			</v-list>
		</v-card>

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

		<!--
			Removal alone, with no ban on it any more. The checkbox that used to sit here
			made this dialog explain a decision most people were not making, and it was a
			second way to reach an outcome the ban action already reaches.
		-->
		<Confirm
			:loading="removeBusy"
			:model-value="removing !== null"
			:text="$t('peer.remove_confirm', { name: removing?.name ?? '' })"
			:title="$t('peer.remove_title')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>

		<!--
			The one dialog that has to spell out a consequence, because the consequence
			is counter-intuitive: the link is kept, so the peer sees an empty catalogue
			rather than a closed door, and nothing stops us reading from them.
		-->
		<Confirm
			:loading="readingBusy"
			:model-value="reading !== null"
			:text="reading?.forbid
				? $t('peer.forbid_reading_confirm', { name: reading?.peer.name ?? '' })
				: $t('peer.allow_reading_confirm', { name: reading?.peer.name ?? '' })"
			:title="reading?.forbid ? $t('peer.forbid_reading_title') : $t('peer.allow_reading_title')"
			@cancel="reading = null"
			@confirm="confirmReading"
		/>

		<Confirm
			confirm-color="error"
			:loading="banBusy"
			:model-value="banning !== null"
			:title="$t('peer.ban_title')"
			@cancel="banning = null"
			@confirm="confirmBan"
		>
			<p class="mb-3">{{ $t('peer.ban_confirm', { name: banning?.name ?? '' }) }}</p>

			<v-text-field
				v-model="banReason"
				data-test="peer-ban-reason"
				density="compact"
				hide-details
				:label="$t('peer.ban_reason')"
				:placeholder="$t('peer.ban_reason_hint')"
			/>
		</Confirm>

		<Confirm
			:loading="unbanBusy"
			:model-value="unbanning !== null"
			:text="$t('peer.unban_confirm', { name: unbanning?.name || unbanning?.fingerprint || '' })"
			:title="$t('peer.unban_title')"
			@cancel="unbanning = null"
			@confirm="confirmUnban"
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
