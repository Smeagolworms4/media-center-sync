<script lang="ts" setup>
	import type { Transfer } from '@mcs/shared';
	import { TransferState } from '@mcs/shared';
	import { computed } from 'vue';
	import { describeTransferError, TransferAction } from '@/composables/useTransferError';

	/**
	 * What can be done to one transfer, right now.
	 *
	 * A failed transfer is offered the action that fits its failure rather than a
	 * retry button that will fail the same way: the mapping lives in
	 * `useTransferError`, so the queue and the detail panel cannot disagree about
	 * what a full disk means.
	 */
	const props = withDefaults(defineProps<{
		transfer: Transfer;
		busy?: boolean;
		compact?: boolean;
	}>(), {
		busy: false,
		compact: false,
	});

	const emit = defineEmits<{ action: [action: TransferAction] }>();

	const RUNNING: Set<TransferState> = new Set([
		TransferState.QUEUED,
		TransferState.CONNECTING,
		TransferState.DOWNLOADING,
		TransferState.VERIFYING,
		TransferState.REPAIRING,
		TransferState.PLACING,
	]);

	const TERMINAL: Set<TransferState> = new Set([
		TransferState.DONE,
		TransferState.CANCELLED,
	]);

	/** The two states a destination cannot be changed in. See `retargetable`. */
	const UNREACHABLE: Set<TransferState> = new Set([
		TransferState.PLACING,
		TransferState.CANCELLED,
	]);

	const running = computed(() => RUNNING.has(props.transfer.state));
	const paused = computed(() => props.transfer.state === TransferState.PAUSED);
	const failed = computed(() => props.transfer.state === TransferState.FAILED);
	const terminal = computed(() => TERMINAL.has(props.transfer.state));

	/** Only a failure has a kind, and only a failure gets the tailored offer. */
	const descriptor = computed(
		() => (failed.value ? describeTransferError(props.transfer.errorKind) : null));

	/**
	 * When somebody may still say where this one is going.
	 *
	 * Offered on almost everything, because the question is worth answering at both
	 * ends of a pull: while a season is downloading it costs one row write, and once it
	 * has landed it is a move the gateway knows how to make. The two exceptions are not
	 * arbitrary —
	 *
	 * - `placing` is the second in which the file is being copied into the library, and
	 *   the gateway refuses to re-point it then rather than leave half a film in each of
	 *   two places. Showing a button that can only answer "not now" is worse than not
	 *   showing one.
	 * - `cancelled` threw its partial away. There are no bytes to send anywhere and
	 *   nothing is going to fetch them again without a retry first.
	 */
	const retargetable = computed(() => !UNREACHABLE.has(props.transfer.state));

	// A failure that already offers it from its own list must not offer it twice: the
	// disk-full row would grow two identical buttons side by side.
	const offeredByFailure = computed(
		() => descriptor.value?.actions.includes(TransferAction.ANOTHER_TARGET) ?? false);

	const ICONS: Record<TransferAction, string> = {
		[TransferAction.PAUSE]: 'mdi-pause',
		[TransferAction.RESUME]: 'mdi-play',
		[TransferAction.RETRY]: 'mdi-refresh',
		[TransferAction.VERIFY]: 'mdi-shield-check-outline',
		[TransferAction.REPAIR]: 'mdi-wrench-outline',
		[TransferAction.ANOTHER_SOURCE]: 'mdi-swap-horizontal',
		[TransferAction.ANOTHER_TARGET]: 'mdi-folder-move-outline',
		[TransferAction.FIX_SERVICE]: 'mdi-key-outline',
		[TransferAction.CANCEL]: 'mdi-close',
	};
</script>

<template>
	<div class="transfer-actions" data-test="transfer-actions">
		<v-btn
			v-if="running"
			data-test="transfer-pause"
			:disabled="busy"
			:icon="compact ? ICONS[TransferAction.PAUSE] : undefined"
			:prepend-icon="compact ? undefined : ICONS[TransferAction.PAUSE]"
			size="small"
			variant="text"
			@click="emit('action', TransferAction.PAUSE)"
		>
			<template v-if="!compact">{{ $t('transfer.action.pause') }}</template>
		</v-btn>

		<!--
			Resume is the filled button on a paused row: pausing is the first thing
			people try, and the way back has to be the obvious one.
		-->
		<v-btn
			v-if="paused"
			color="primary"
			data-test="transfer-resume"
			:disabled="busy"
			:icon="compact ? ICONS[TransferAction.RESUME] : undefined"
			:prepend-icon="compact ? undefined : ICONS[TransferAction.RESUME]"
			size="small"
			variant="tonal"
			@click="emit('action', TransferAction.RESUME)"
		>
			<template v-if="!compact">{{ $t('transfer.action.resume') }}</template>
		</v-btn>

		<v-btn
			v-if="terminal"
			data-test="transfer-verify"
			:disabled="busy"
			:prepend-icon="ICONS[TransferAction.VERIFY]"
			size="small"
			variant="text"
			@click="emit('action', TransferAction.VERIFY)"
		>
			{{ $t('transfer.action.verify') }}
		</v-btn>

		<template v-if="descriptor">
			<v-btn
				v-for="(action, index) of descriptor.actions"
				:key="action"
				:color="index === 0 ? 'primary' : undefined"
				:data-test="`transfer-${action}`"
				:disabled="busy"
				:prepend-icon="ICONS[action]"
				size="small"
				:variant="index === 0 ? 'tonal' : 'text'"
				@click="emit('action', action)"
			>
				{{ $t(`transfer.action.${action}`) }}
			</v-btn>
		</template>

		<v-btn
			v-if="retargetable && !offeredByFailure"
			data-test="transfer-retarget"
			:disabled="busy"
			:icon="compact ? ICONS[TransferAction.ANOTHER_TARGET] : undefined"
			:prepend-icon="compact ? undefined : ICONS[TransferAction.ANOTHER_TARGET]"
			size="small"
			variant="text"
			@click="emit('action', TransferAction.ANOTHER_TARGET)"
		>
			<template v-if="!compact">{{ $t('transfer.action.another_target') }}</template>
		</v-btn>

		<v-btn
			v-if="!terminal && !failed"
			color="error"
			data-test="transfer-cancel"
			:disabled="busy"
			:icon="compact ? ICONS[TransferAction.CANCEL] : undefined"
			:prepend-icon="compact ? undefined : ICONS[TransferAction.CANCEL]"
			size="small"
			variant="text"
			@click="emit('action', TransferAction.CANCEL)"
		>
			<template v-if="!compact">{{ $t('transfer.action.cancel') }}</template>
		</v-btn>
	</div>
</template>

<style lang="scss">
	.transfer-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
</style>
