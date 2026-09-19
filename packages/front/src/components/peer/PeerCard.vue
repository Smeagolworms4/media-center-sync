<script lang="ts" setup>
	import type { Peer } from '@mcs/shared';
	import { PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
	import { computed } from 'vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';

	/**
	 * One linked gateway.
	 *
	 * Trust and link mode are shown together because they answer two different
	 * questions people do ask: who this is — somebody we invited, or a friend of a
	 * friend we did not — and how the bytes travel, since a relayed link shares its
	 * bandwidth with everybody else using that rendezvous.
	 */
	const props = defineProps<{ peer: Peer }>();

	const emit = defineEmits<{
		connect: [peer: Peer];
		rename: [peer: Peer];
		block: [peer: Peer];
		unblock: [peer: Peer];
		remove: [peer: Peer];
	}>();

	const STATUS_COLOR: Record<PeerStatus, string> = {
		[PeerStatus.LINKED]: 'state-in-sync',
		[PeerStatus.PENDING]: 'state-outdated',
		[PeerStatus.UNREACHABLE]: 'state-conflict',
		[PeerStatus.BLOCKED]: 'state-unknown',
	};

	const statusColor = computed(() => STATUS_COLOR[props.peer.status] ?? 'state-unknown');
	const blocked = computed(() => props.peer.status === PeerStatus.BLOCKED);
	const viaFriend = computed(() => props.peer.trust === PeerTrust.FRIEND_OF_FRIEND);
	const relayed = computed(() => props.peer.linkMode === PeerLinkMode.RELAY);
</script>

<template>
	<v-card class="peer-card" :data-status="peer.status" data-test="peer-row" variant="tonal">
		<v-card-item>
			<template #prepend>
				<v-icon :color="statusColor" icon="mdi-server-network" size="28" />
			</template>

			<v-card-title class="peer-card_name">
				<router-link
					class="peer-card_link"
					:to="{ name: 'peer', params: { id: peer.id } }"
				>
					{{ peer.name }}
				</router-link>
			</v-card-title>

			<v-card-subtitle class="text-break-anywhere">{{ peer.fingerprint }}</v-card-subtitle>
		</v-card-item>

		<v-card-text class="peer-card_body">
			<div class="peer-card_chips">
				<v-chip
					:color="statusColor"
					data-test="peer-status"
					label
					size="small"
					variant="tonal"
				>
					{{ $t(`peer.status.${peer.status}`) }}
				</v-chip>

				<v-chip data-test="peer-trust" label size="small" variant="tonal">
					{{ viaFriend && peer.viaPeerName
						? $t('peer.trust.friend_of_friend_via', { peer: peer.viaPeerName })
						: $t(`peer.trust.${peer.trust}`) }}
				</v-chip>

				<v-chip
					v-if="peer.linkMode"
					:color="relayed ? 'state-outdated' : undefined"
					data-test="peer-link-mode"
					label
					size="small"
					variant="tonal"
				>
					{{ $t(`peer.link_mode.${peer.linkMode}`) }}
				</v-chip>
			</div>

			<p v-if="relayed" class="text-caption text-medium-emphasis mt-2 mb-0">
				{{ $t('peer.relay_hint') }}
			</p>

			<p class="text-caption text-medium-emphasis mt-2 mb-0">
				{{ $t('peer.shares', {
					services: peer.serviceCount,
					items: peer.sharedItemCount,
				}) }}
				· {{ $t('peer.last_seen') }} <RelativeDate :date="peer.lastSeenAt" />
			</p>
		</v-card-text>

		<v-card-actions>
			<v-btn
				data-test="peer-connect"
				:disabled="blocked"
				prepend-icon="mdi-lan-connect"
				size="small"
				variant="text"
				@click="emit('connect', peer)"
			>
				{{ $t('peer.action.connect') }}
			</v-btn>

			<v-btn
				data-test="peer-rename"
				prepend-icon="mdi-rename-outline"
				size="small"
				variant="text"
				@click="emit('rename', peer)"
			>
				{{ $t('peer.action.rename') }}
			</v-btn>

			<v-spacer />

			<v-btn
				v-if="blocked"
				data-test="peer-unblock"
				size="small"
				variant="text"
				@click="emit('unblock', peer)"
			>
				{{ $t('peer.action.unblock') }}
			</v-btn>

			<v-btn
				v-else
				data-test="peer-block"
				size="small"
				variant="text"
				@click="emit('block', peer)"
			>
				{{ $t('peer.action.block') }}
			</v-btn>

			<v-btn
				color="error"
				data-test="peer-remove"
				icon="mdi-delete-outline"
				size="small"
				variant="text"
				@click="emit('remove', peer)"
			/>
		</v-card-actions>
	</v-card>
</template>

<style lang="scss">
	.peer-card {
		height: 100%;

		&_link {
			color: inherit;
			text-decoration: none;

			&:hover {
				text-decoration: underline;
			}
		}

		&_chips {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}
	}
</style>
