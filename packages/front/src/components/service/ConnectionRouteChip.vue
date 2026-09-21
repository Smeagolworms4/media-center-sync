<script lang="ts" setup>
	import { ConnectionRoute } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * Which way the gateway reaches a server plex.tv told it about, in the same words
	 * in the add dialog and on the services screen.
	 *
	 * The relay gets its own colour and its own sentence rather than a neutral label.
	 * Plex caps it: browsing a catalogue through it is fine, pulling a film through it
	 * takes all night, and a service that only the relay reaches has to say so where
	 * somebody will read it — before they start a transfer, not after it has crawled.
	 * `unreachable` is the fourth state, for a server none of whose addresses answered.
	 */
	const props = withDefaults(defineProps<{
		route?: ConnectionRoute | null;
		reachable?: boolean;
		size?: string;
	}>(), {
		route: null,
		reachable: true,
		size: 'small',
	});

	type Shown = ConnectionRoute | 'unreachable';

	const DESCRIPTORS: Record<Shown, { color: string; icon: string }> = {
		[ConnectionRoute.LOCAL]: { color: 'state-in-sync', icon: 'mdi-lan' },
		[ConnectionRoute.REMOTE]: { color: 'info', icon: 'mdi-web' },
		[ConnectionRoute.RELAY]: { color: 'warning', icon: 'mdi-transit-connection-variant' },
		unreachable: { color: 'state-conflict', icon: 'mdi-lan-disconnect' },
	};

	const shown = computed<Shown | null>(() => {
		if (!props.reachable) {
			return 'unreachable';
		}
		return props.route;
	});
</script>

<template>
	<v-chip
		v-if="shown"
		class="connection-route-chip"
		:color="DESCRIPTORS[shown].color"
		:data-route="shown"
		data-test="connection-route"
		label
		:prepend-icon="DESCRIPTORS[shown].icon"
		:size="size"
		variant="tonal"
	>
		{{ $t(`service.discovery.route.${shown}`) }}
	</v-chip>
</template>
