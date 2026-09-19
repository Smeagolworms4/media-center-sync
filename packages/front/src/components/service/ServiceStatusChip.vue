<script lang="ts" setup>
	import { MediaServiceStatus } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * A service's reachability, in the same four words everywhere.
	 *
	 * `unauthorized` is kept apart from `offline` on purpose: one is a server that
	 * is down and will come back, the other is a token to fix, and telling somebody
	 * to wait for the second is how a library stays empty for a week.
	 */
	const props = withDefaults(defineProps<{
		status?: MediaServiceStatus | null;
		size?: string;
	}>(), {
		status: null,
		size: 'small',
	});

	const DESCRIPTORS: Record<MediaServiceStatus, { color: string; icon: string }> = {
		[MediaServiceStatus.ONLINE]: { color: 'state-in-sync', icon: 'mdi-check-circle-outline' },
		[MediaServiceStatus.OFFLINE]: { color: 'state-conflict', icon: 'mdi-lan-disconnect' },
		[MediaServiceStatus.UNAUTHORIZED]: { color: 'state-outdated', icon: 'mdi-key-alert-outline' },
		[MediaServiceStatus.UNKNOWN]: { color: 'state-unknown', icon: 'mdi-help-circle-outline' },
	};

	const status = computed(() => props.status ?? MediaServiceStatus.UNKNOWN);
	const descriptor = computed(() => DESCRIPTORS[status.value] ?? DESCRIPTORS[MediaServiceStatus.UNKNOWN]);
</script>

<template>
	<v-chip
		class="service-status-chip"
		:color="descriptor.color"
		:data-status="status"
		data-test="service-status"
		label
		:prepend-icon="descriptor.icon"
		:size="size"
		variant="tonal"
	>
		{{ $t(`service.status.${status}`) }}
	</v-chip>
</template>
