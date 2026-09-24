<script lang="ts" setup>
	import { MediaRequestState } from '@mcs/shared';

	/**
	 * How far along an ask is, in one word and one colour.
	 *
	 * The source folds two lives into this scale — a person approves or declines, and
	 * the media behind it is then processed and becomes available — and the colours
	 * follow the sync vocabulary the rest of the interface already uses, so that
	 * "nothing left to do" is the same green on this screen as on a library shelf.
	 */
	defineProps<{ state: MediaRequestState }>();

	const COLOR: Record<MediaRequestState, string> = {
		[MediaRequestState.PENDING]: 'state-unknown',
		[MediaRequestState.APPROVED]: 'state-outdated',
		[MediaRequestState.DECLINED]: 'state-conflict',
		[MediaRequestState.PROCESSING]: 'state-syncing',
		[MediaRequestState.PARTIAL]: 'state-outdated',
		[MediaRequestState.AVAILABLE]: 'state-in-sync',
		[MediaRequestState.UNKNOWN]: 'state-unknown',
	};
</script>

<template>
	<v-chip
		:color="COLOR[state]"
		:data-state="state"
		data-test="request-state"
		label
		size="small"
		variant="tonal"
	>
		{{ $t(`request.state.${state}`) }}
	</v-chip>
</template>
