<script lang="ts" setup>
	import type { Peer } from '@mcs/shared';
	import { PeerDirection, PeerLinkMode, PeerStatus, PeerTrust } from '@mcs/shared';
	import { computed } from 'vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import PeerDepthField from '@/components/peer/PeerDepthField.vue';

	/**
	 * One linked gateway.
	 *
	 * Trust and link mode are shown together because they answer two different
	 * questions people do ask: who this is — somebody we invited, or a friend of a
	 * friend we did not — and how the bytes travel, since a relayed link shares its
	 * bandwidth with everybody else using that rendezvous.
	 */
	const props = defineProps<{
		peer: Peer;
		/** The gateway's own ceiling, so the row can say what "default" resolves to. */
		ceiling: number;
		savingDepth?: boolean;
	}>();

	const emit = defineEmits<{
		'approve': [peer: Peer];
		'connect': [peer: Peer];
		'rename': [peer: Peer];
		'block': [peer: Peer];
		'unblock': [peer: Peer];
		'remove': [peer: Peer];
		'ban': [peer: Peer];
		'max-depth': [peer: Peer, maxDepth: number | null];
	}>();

	const STATUS_COLOR: Record<PeerStatus, string> = {
		[PeerStatus.LINKED]: 'state-in-sync',
		[PeerStatus.PENDING]: 'state-outdated',
		[PeerStatus.UNREACHABLE]: 'state-conflict',
		[PeerStatus.BLOCKED]: 'state-unknown',
	};

	const statusColor = computed(() => STATUS_COLOR[props.peer.status] ?? 'state-unknown');
	const blocked = computed(() => props.peer.status === PeerStatus.BLOCKED);

	/**
	 * A pending link is two different situations wearing one word.
	 *
	 * Incoming is a decision somebody is waiting on *here*, and it needs an accept
	 * and a refusal within reach. Outgoing is a decision waiting on them, and needs
	 * nothing but a line saying so. Showing both as "pending" is how a request sits
	 * unanswered for a week with nobody realising it was theirs to answer.
	 */
	const pending = computed(() => props.peer.status === PeerStatus.PENDING);
	const incoming = computed(() => pending.value && props.peer.direction === PeerDirection.INCOMING);
	const outgoing = computed(() => pending.value && props.peer.direction === PeerDirection.OUTGOING);
	const viaFriend = computed(() => props.peer.trust === PeerTrust.FRIEND_OF_FRIEND);

	/**
	 * What to call the distance, in words somebody recognises.
	 *
	 * There is no third word after "friend of a friend": past the second hop the only
	 * honest label is the number itself. Saying "friend of a friend" for a gateway
	 * three or four introductions away would be a comfortable phrase for a
	 * relationship that is not one.
	 */
	const depth = computed(() => props.peer.depth ?? (viaFriend.value ? 2 : 1));

	/*
	 * Read through `?? null` rather than off the peer, because an older gateway — and
	 * any record written before the handshake existed — carries neither field. A
	 * template that reached straight for `peer.capabilities.length` threw on every
	 * such row, which is a blank peers screen rather than a missing line.
	 *
	 * Null is also the honest reading of an absent version: it means we have never
	 * actually talked to them, which is not the same as their speaking version zero.
	 */
	const protocol = computed(() => props.peer.protocol ?? null);
	const capabilities = computed(() => props.peer.capabilities ?? []);
	const relayed = computed(() => props.peer.linkMode === PeerLinkMode.RELAY);
</script>

<template>
	<v-card
		class="peer-card"
		:class="{ 'peer-card--incoming': incoming }"
		:data-direction="peer.direction ?? ''"
		:data-status="peer.status"
		data-test="peer-row"
		variant="tonal"
	>
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
					:color="incoming ? 'primary' : statusColor"
					data-test="peer-status"
					label
					size="small"
					:variant="incoming ? 'flat' : 'tonal'"
				>
					{{ incoming
						? $t('peer.direction.incoming')
						: (outgoing ? $t('peer.direction.outgoing') : $t(`peer.status.${peer.status}`)) }}
				</v-chip>

				<v-chip data-test="peer-trust" label size="small" variant="tonal">
					<template v-if="depth > 2">
						{{ peer.viaPeerName
							? $t('peer.depth.hops_via', { count: depth, peer: peer.viaPeerName }, depth)
							: $t('peer.depth.hops', { count: depth }, depth) }}
					</template>

					<template v-else>
						{{ viaFriend && peer.viaPeerName
							? $t('peer.trust.friend_of_friend_via', { peer: peer.viaPeerName })
							: $t(`peer.trust.${peer.trust}`) }}
					</template>
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

			<p v-if="incoming" class="text-body-2 mt-2 mb-0" data-test="peer-incoming-hint">
				{{ $t('peer.direction.incoming_hint') }}
			</p>

			<p v-else-if="outgoing" class="text-caption text-medium-emphasis mt-2 mb-0">
				{{ $t('peer.direction.outgoing_hint') }}
			</p>

			<p v-if="relayed" class="text-caption text-medium-emphasis mt-2 mb-0">
				{{ $t('peer.relay_hint') }}
			</p>

			<!--
				What was agreed on the wire, which is the honest answer to "why can I
				not swarm from them". Guarded: a peer recorded before the handshake
				existed has no version, and that is not the same as speaking version
				zero — it means we have never actually talked to them.
			-->
			<p
				v-if="protocol !== null"
				class="text-caption text-medium-emphasis mt-2 mb-0"
				data-test="peer-protocol"
			>
				{{ $t('peer.protocol', { version: protocol }) }}
				<template v-if="capabilities.length > 0">
					· {{ $t('peer.capabilities') }}
					<span data-test="peer-capabilities">{{ capabilities.join(', ') }}</span>
				</template>
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
				v-if="incoming"
				color="primary"
				data-test="peer-approve"
				prepend-icon="mdi-check"
				size="small"
				variant="tonal"
				@click="emit('approve', peer)"
			>
				{{ $t('peer.action.approve') }}
			</v-btn>

			<v-btn
				v-if="!pending"
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
				v-if="!incoming"
				data-test="peer-rename"
				prepend-icon="mdi-rename-outline"
				size="small"
				variant="text"
				@click="emit('rename', peer)"
			>
				{{ $t('peer.action.rename') }}
			</v-btn>

			<v-spacer />

			<!--
				On the row, not in the settings screen: the number is about this friend
				and not about the gateway. A pending peer has agreed to nothing and
				introduces nobody, so there is nothing to limit yet.
			-->
			<PeerDepthField
				v-if="!pending"
				:ceiling="ceiling"
				:peer="peer"
				:saving="savingDepth"
				@update="(one, value) => emit('max-depth', one, value)"
			/>

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
				data-test="peer-ban"
				icon="mdi-cancel"
				size="small"
				:title="$t('peer.action.ban')"
				variant="text"
				@click="emit('ban', peer)"
			/>

			<v-btn
				color="error"
				data-test="peer-remove"
				icon="mdi-delete-outline"
				size="small"
				:title="$t('peer.action.remove')"
				variant="text"
				@click="emit('remove', peer)"
			/>
		</v-card-actions>
	</v-card>
</template>

<style lang="scss">
	.peer-card {
		height: 100%;

		// A request waiting on somebody here is the one card on this page that has to
		// catch the eye; the rest are a list to read at leisure.
		&--incoming {
			outline: 1px solid rgb(var(--v-theme-primary));
		}

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

		// The action row carries a select now, so it wraps rather than squeezing the
		// buttons off the card on a narrow screen.
		.v-card-actions {
			flex-wrap: wrap;
			gap: 4px;
			row-gap: 8px;
		}
	}
</style>
