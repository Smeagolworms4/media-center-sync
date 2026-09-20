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
	 * friend we did not — and how the bytes travel, since a relayed link spends the
	 * upload of the friend who introduced the two ends.
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
		'forbid-reading': [peer: Peer];
		'allow-reading': [peer: Peer];
		'remove': [peer: Peer];
		'ban': [peer: Peer];
		'max-depth': [peer: Peer, maxDepth: number | null];
	}>();

	const STATUS_COLOR: Record<PeerStatus, string> = {
		[PeerStatus.LINKED]: 'state-in-sync',
		[PeerStatus.PENDING]: 'state-outdated',
		[PeerStatus.UNREACHABLE]: 'state-conflict',
	};

	const statusColor = computed(() => STATUS_COLOR[props.peer.status] ?? 'state-unknown');

	/**
	 * They are still a peer and the link is still open — they are simply served
	 * nothing.
	 *
	 * Shown as a state of its own rather than folded into the status chip, because it
	 * is not a state of the link: a peer can be forbidden and connected at the same
	 * time, and that pair is exactly what somebody has to be able to read off the card
	 * to understand what the action did.
	 */
	const forbidden = computed(() => props.peer.readingForbidden);
	const unreachable = computed(() => props.peer.status === PeerStatus.UNREACHABLE);

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

	/*
	 * Met while pulling from a friend of a friend, and not being kept.
	 *
	 * Worth a word on the card rather than hiding: the row really is in the list for
	 * the length of a transfer, and a gateway nobody invited appearing and then
	 * disappearing with nothing to explain it reads as a bug. Read through `?? false`
	 * like the two above, because a peer recorded before this existed carries no field.
	 */
	const discovered = computed(() => props.peer.discovered ?? false);
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

				<!--
					The distance as a number, always, beside the word for it.
					The word is what people recognise and the number is what the source
					order and the reach setting actually compare, so a screen showing only
					the word left "Friend of a friend" standing for two hops and for four
					alike — and the reach limit unexplainable.
				-->
				<v-chip
					v-if="depth > 1"
					:data-depth="depth"
					data-test="peer-depth"
					label
					size="small"
					variant="outlined"
				>
					<v-icon class="mr-1" icon="mdi-arrow-expand-right" size="x-small" />
					{{ $t('peer.depth.hops', { count: depth }, depth) }}
				</v-chip>

				<v-chip
					v-if="forbidden"
					color="state-conflict"
					data-test="peer-reading-forbidden"
					label
					size="small"
					variant="flat"
				>
					<v-icon class="mr-1" icon="mdi-eye-off-outline" size="x-small" />
					{{ $t('peer.reading_forbidden_chip') }}
				</v-chip>

				<v-chip
					v-if="discovered"
					data-test="peer-discovered"
					label
					size="small"
					variant="outlined"
				>
					<v-icon class="mr-1" icon="mdi-timer-sand" size="x-small" />
					{{ $t('peer.discovered_chip') }}
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

			<!--
				Stated, not dressed up. Nothing here is encrypted above the transport, so
				on a relayed link the friend in the middle really does carry the bytes —
				and a card that showed "relayed" without saying what that means would be
				implying a privacy this gateway does not provide.
			-->
			<p v-if="relayed" class="text-caption text-medium-emphasis mt-2 mb-0" data-test="peer-relay-hint">
				{{ $t('peer.relay_hint') }}
			</p>

			<p
				v-if="discovered"
				class="text-caption text-medium-emphasis mt-2 mb-0"
				data-test="peer-discovered-hint"
			>
				{{ $t('peer.discovered_hint') }}
			</p>

			<!--
				Stated on the card, not only in the dialog that set it. The trade is the
				part somebody forgets a week later: the peer is still connected on their
				side and this gateway still reads from theirs, and only what we answer
				is empty.
			-->
			<p v-if="forbidden" class="text-caption mt-2 mb-0" data-test="peer-reading-hint">
				{{ $t('peer.reading_forbidden_hint') }}
			</p>

			<!--
				Why nothing needs pressing. Before links redialled themselves this line
				would have been a lie, and the only cure for an unreachable peer was the
				button below.
			-->
			<p
				v-if="unreachable"
				class="text-caption text-medium-emphasis mt-2 mb-0"
				data-test="peer-unreachable-hint"
			>
				{{ $t('peer.unreachable_hint') }}
			</p>

			<!--
				The limit, said once and without alarm. Two gateways behind two routers
				with no friend in common cannot be connected at all, and there is no
				field anybody could have filled in to change that — so the row says what
				would fix it instead of waiting silently for an attempt that cannot work.
			-->
			<p
				v-if="unreachable"
				class="text-caption text-medium-emphasis mt-1 mb-0"
				data-test="peer-unreachable-port-hint"
			>
				{{ $t('peer.unreachable_port_hint') }}
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

			<!--
				"Try now", not "connect": the gateway dials at startup and redials after a
				drop on its own. What this is for is the person who knows their friend has
				just come back and does not want to wait out a backoff that has grown to a
				quarter of an hour.
			-->
			<v-btn
				v-if="!pending"
				data-test="peer-connect"
				prepend-icon="mdi-lan-connect"
				size="small"
				:title="$t('peer.connect_hint')"
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

			<!--
				One switch, two labels. A pending peer is offered neither: they are served
				nothing already, and forbidding a link nobody has agreed to is a decision
				about a relationship that does not exist yet.
			-->
			<v-btn
				v-if="forbidden"
				data-test="peer-allow-reading"
				prepend-icon="mdi-eye-outline"
				size="small"
				variant="text"
				@click="emit('allow-reading', peer)"
			>
				{{ $t('peer.action.allow_reading') }}
			</v-btn>

			<v-btn
				v-else-if="!pending"
				data-test="peer-forbid-reading"
				prepend-icon="mdi-eye-off-outline"
				size="small"
				variant="text"
				@click="emit('forbid-reading', peer)"
			>
				{{ $t('peer.action.forbid_reading') }}
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
