<script lang="ts" setup>
	import type { TransferSource } from '@mcs/shared';
	import { TransferTransport } from '@mcs/shared';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';

	/**
	 * Who is feeding this transfer, over what, and how well.
	 *
	 * The aggregate rate is the number people look at and the one that lies: a
	 * source that has stopped serving disappears behind three that have not, and the
	 * transfer merely looks slower than it should. Per source, a dead feed is
	 * obvious — its rate is zero and it is marked unhealthy — and so is the reason a
	 * swarm is faster than the direct link it replaced.
	 */
	withDefaults(defineProps<{
		sources: TransferSource[];
		compact?: boolean;
	}>(), {
		compact: false,
	});

	/**
	 * A transport per icon, because the three ways a friend can feed a file are
	 * three different situations: a direct link to their gateway, the same friend
	 * through a relay whose bandwidth everybody shares, and a swarm of several
	 * peers holding the same copy.
	 */
	const TRANSPORT_ICON: Record<TransferTransport, string> = {
		[TransferTransport.HTTP_RANGE]: 'mdi-web',
		[TransferTransport.PEER_DIRECT]: 'mdi-lan-connect',
		[TransferTransport.PEER_RELAY]: 'mdi-swap-horizontal-circle-outline',
		[TransferTransport.SWARM]: 'mdi-account-group-outline',
	};

	const TRANSPORT_COLOR: Record<TransferTransport, string> = {
		[TransferTransport.HTTP_RANGE]: 'state-unknown',
		[TransferTransport.PEER_DIRECT]: 'state-in-sync',
		[TransferTransport.PEER_RELAY]: 'state-outdated',
		[TransferTransport.SWARM]: 'state-syncing',
	};
</script>

<template>
	<div class="transfer-sources" data-test="transfer-sources">
		<p v-if="sources.length === 0" class="text-caption text-medium-emphasis mb-0">
			{{ $t('transfer.no_source') }}
		</p>

		<ul v-else class="transfer-sources_list">
			<li
				v-for="source of sources"
				:key="`${source.serviceId}-${source.transport}`"
				class="transfer-sources_item"
				:data-healthy="source.healthy"
				data-test="transfer-source"
				:data-transport="source.transport"
			>
				<v-tooltip location="top" :text="$t(`transfer.transport.${source.transport}`)">
					<template #activator="{ props: tooltipProps }">
						<v-icon
							v-bind="tooltipProps"
							:color="source.healthy ? TRANSPORT_COLOR[source.transport] : 'state-conflict'"
							:icon="TRANSPORT_ICON[source.transport]"
							size="18"
						/>
					</template>
				</v-tooltip>

				<span class="transfer-sources_name">
					{{ source.serviceName }}
					<span v-if="source.peerName" class="text-medium-emphasis">
						({{ $t('transfer.via_peer', { peer: source.peerName }) }})
					</span>
				</span>

				<v-spacer />

				<span class="transfer-sources_figure text-caption">
					<Rate :rate="source.rate" />
				</span>

				<span v-if="!compact" class="transfer-sources_figure text-caption text-medium-emphasis">
					<ByteSize :bytes="source.bytesDone" />
				</span>

				<span v-if="!compact" class="transfer-sources_figure text-caption text-medium-emphasis">
					{{ $t('transfer.connections', { count: source.connections }, source.connections) }}
				</span>

				<v-chip
					v-if="!source.healthy"
					color="state-conflict"
					data-test="transfer-source-unhealthy"
					label
					size="x-small"
					variant="tonal"
				>
					{{ $t('transfer.source_unhealthy') }}
				</v-chip>
			</li>
		</ul>
	</div>
</template>

<style lang="scss">
	.transfer-sources {
		&_list {
			margin: 0;
			padding: 0;
			list-style: none;
		}

		&_item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 3px 0;

			& + & {
				border-top: 1px solid rgba(var(--v-theme-on-surface), 0.06);
			}
		}

		&_name {
			@include truncate;
		}

		&_figure {
			white-space: nowrap;
		}
	}
</style>
