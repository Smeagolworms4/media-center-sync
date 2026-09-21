<script lang="ts" setup>
	import type { DiscoveredServer } from '@mcs/shared';
	import { ConnectionRoute } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import ConnectionRouteChip from '@/components/service/ConnectionRouteChip.vue';

	/**
	 * The servers a Plex account reaches, grouped by whose they are, to tick.
	 *
	 * Grouped because "yours" and "a friend's" are registered differently — a friend's
	 * comes in as somebody else's disk, never a place to pull into — and because the
	 * owner's name is the only thing that tells two friends' servers called "Plex"
	 * apart. A server that is already registered, or that nothing answered for, is
	 * listed and not tickable, with the reason beside it: leaving it out would read as
	 * plex.tv not knowing it, which sends somebody looking for a fault that is not there.
	 */
	const props = defineProps<{
		servers: DiscoveredServer[];
	}>();

	/** The identifiers ticked, in the order they were ticked. */
	const selected = defineModel<string[]>({ required: true });

	const { t } = useI18n();

	const groups = computed(() => {
		const byOwner = new Map<string, { key: string; title: string; servers: DiscoveredServer[] }>();

		for (const server of props.servers) {
			const key = server.owned ? '' : `shared:${server.ownerName ?? ''}`;
			const title = server.owned
				? t('service.discovery.yours')
				: (server.ownerName
					? t('service.discovery.shared_by', { owner: server.ownerName })
					: t('service.discovery.shared_unknown'));
			const group = byOwner.get(key) ?? { key, title, servers: [] };

			group.servers.push(server);
			byOwner.set(key, group);
		}

		// Ours first whatever order the answer came in, so a friend's server can never
		// sit above our own; friends then in the order the API sorted them, by name.
		const all = [...byOwner.values()];
		return [...all.filter(group => group.key === ''), ...all.filter(group => group.key !== '')];
	});

	function selectable (server: DiscoveredServer): boolean {
		return server.reachable && server.registeredServiceId === null;
	}

	function toggle (server: DiscoveredServer, on: boolean): void {
		const without = selected.value.filter(one => one !== server.identifier);
		selected.value = on ? [...without, server.identifier] : without;
	}
</script>

<template>
	<div class="discovered-servers" data-test="discovered-servers">
		<section
			v-for="group of groups"
			:key="group.key"
			class="discovered-servers_group"
			:data-group="group.key === '' ? 'owned' : 'shared'"
			data-test="discovered-group"
		>
			<h4 class="text-subtitle-2 mb-1">{{ group.title }}</h4>

			<v-list class="py-0" density="compact">
				<v-list-item
					v-for="server of group.servers"
					:key="server.identifier"
					class="discovered-servers_row"
					:data-identifier="server.identifier"
					data-test="discovered-server"
				>
					<template #prepend>
						<v-checkbox-btn
							:data-test="`discovered-select-${server.identifier}`"
							density="compact"
							:disabled="!selectable(server)"
							:model-value="selected.includes(server.identifier)"
							@update:model-value="toggle(server, !!$event)"
						/>
					</template>

					<v-list-item-title class="discovered-servers_name">
						{{ server.name }}

						<ConnectionRouteChip class="ml-2" :reachable="server.reachable" :route="server.route" size="x-small" />

						<v-chip
							v-if="server.registeredServiceId"
							class="ml-2"
							color="state-unknown"
							data-test="discovered-registered"
							label
							size="x-small"
							variant="tonal"
						>
							{{ $t('service.discovery.registered') }}
						</v-chip>
					</v-list-item-title>

					<v-list-item-subtitle v-if="server.version || server.baseUrl">
						<span v-if="server.version">{{ $t('service.discovery.version', { version: server.version }) }}</span>
						<span v-if="server.version && server.baseUrl"> · </span>
						<span v-if="server.baseUrl" class="text-break-anywhere">{{ server.baseUrl }}</span>
					</v-list-item-subtitle>

					<v-list-item-subtitle
						v-if="server.reachable && server.route === ConnectionRoute.RELAY"
						class="text-warning"
						data-test="discovered-relay-note"
					>
						{{ $t('service.discovery.route_hint.relay') }}
					</v-list-item-subtitle>

					<v-list-item-subtitle
						v-if="!server.reachable"
						class="text-error"
						data-test="discovered-unreachable-note"
					>
						{{ $t('service.discovery.route_hint.unreachable') }}
					</v-list-item-subtitle>
				</v-list-item>
			</v-list>
		</section>
	</div>
</template>

<style lang="scss">
	.discovered-servers {
		&_group + &_group {
			margin-top: 12px;
		}

		&_name {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			white-space: normal;
		}
	}
</style>
