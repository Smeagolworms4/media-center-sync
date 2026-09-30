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
		[TransferAction.ARCHIVE]: 'mdi-archive-outline',
	};
</script>

<template>
	<!--
		Every button keeps its label, and in compact form keeps it as a tooltip rather than
		losing it. Inside a download the rows are drawn tight — a season is fifty-two of them
		— so the labels come off, and what that leaves is a row of unexplained icons: an
		archive box, a shield and a folder with an arrow, guessed at by whoever is deciding
		which one not to press. The tooltip and the label are the same string, so the two can
		never come to say different things.

		Disabled rather than omitted when the label is on the button: a tooltip repeating the
		word next to it is noise that follows the pointer around.

		`v-if` sits on the tooltip and not on the button inside it. On the button it would
		leave a tooltip wrapped around nothing, which Vuetify mounts and positions all the
		same.

		The label's `v-if` sits on a `#default` template, and that is not cosmetic: a
		`<template v-if>` with no slot name compiles to a default slot that always exists and
		merely renders nothing, and `v-btn` draws no icon at all when it has a default slot.
		The compact buttons were laid out at full size, focusable, announced to a screen
		reader — and blank.
	-->
	<div class="transfer-actions" data-test="transfer-actions">
		<v-tooltip
			v-if="running"
			:disabled="!compact"
			location="top"
			:text="$t('transfer.action.pause')"
		>
			<template #activator="{ props: tip }">
				<v-btn
					data-test="transfer-pause"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.PAUSE] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.PAUSE]"
					size="small"
					variant="text"
					v-bind="tip"
					@click="emit('action', TransferAction.PAUSE)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.pause') }}</template>
				</v-btn>
			</template>
		</v-tooltip>

		<!--
			Resume is the filled button on a paused row: pausing is the first thing
			people try, and the way back has to be the obvious one.
		-->
		<v-tooltip
			v-if="paused"
			:disabled="!compact"
			location="top"
			:text="$t('transfer.action.resume')"
		>
			<template #activator="{ props: tip }">
				<v-btn
					color="primary"
					data-test="transfer-resume"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.RESUME] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.RESUME]"
					size="small"
					variant="tonal"
					v-bind="tip"
					@click="emit('action', TransferAction.RESUME)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.resume') }}</template>
				</v-btn>
			</template>
		</v-tooltip>

		<!--
			Offered on every row, in every state, because that is the point: a queue nobody
			can take anything off stops being read. It is quiet — text, no colour — since it
			is the one action here that is about the list rather than about the download.
		-->
		<v-tooltip :disabled="!compact" location="top" :text="$t('transfer.action.archive')">
			<template #activator="{ props: tip }">
				<v-btn
					data-test="transfer-archive"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.ARCHIVE] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.ARCHIVE]"
					size="small"
					variant="text"
					v-bind="tip"
					@click="emit('action', TransferAction.ARCHIVE)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.archive') }}</template>
				</v-btn>
			</template>
		</v-tooltip>

		<v-tooltip
			v-if="terminal"
			:disabled="!compact"
			location="top"
			:text="$t('transfer.action.verify')"
		>
			<template #activator="{ props: tip }">
				<v-btn
					data-test="transfer-verify"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.VERIFY] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.VERIFY]"
					size="small"
					variant="text"
					v-bind="tip"
					@click="emit('action', TransferAction.VERIFY)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.verify') }}</template>
				</v-btn>
			</template>
		</v-tooltip>

		<!--
			What a failure offers, which is the one place the buttons are not fixed: a full
			disk offers another library, an unreachable source offers another source. Compact
			like the rest, because a failed row inside a season is still a row in a list of
			fifty-two.
		-->
		<template v-if="descriptor">
			<v-tooltip
				v-for="(action, index) of descriptor.actions"
				:key="action"
				:disabled="!compact"
				location="top"
				:text="$t(`transfer.action.${action}`)"
			>
				<template #activator="{ props: tip }">
					<v-btn
						:color="index === 0 ? 'primary' : undefined"
						:data-test="`transfer-${action}`"
						:disabled="busy"
						:icon="compact ? ICONS[action] : undefined"
						:prepend-icon="compact ? undefined : ICONS[action]"
						size="small"
						:variant="index === 0 ? 'tonal' : 'text'"
						v-bind="tip"
						@click="emit('action', action)"
					>
						<template v-if="!compact" #default>{{ $t(`transfer.action.${action}`) }}</template>
					</v-btn>
				</template>
			</v-tooltip>
		</template>

		<v-tooltip
			v-if="retargetable && !offeredByFailure"
			:disabled="!compact"
			location="top"
			:text="$t('transfer.action.another_target')"
		>
			<template #activator="{ props: tip }">
				<v-btn
					data-test="transfer-retarget"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.ANOTHER_TARGET] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.ANOTHER_TARGET]"
					size="small"
					variant="text"
					v-bind="tip"
					@click="emit('action', TransferAction.ANOTHER_TARGET)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.another_target') }}</template>
				</v-btn>
			</template>
		</v-tooltip>

		<v-tooltip
			v-if="!terminal && !failed"
			:disabled="!compact"
			location="top"
			:text="$t('transfer.action.cancel')"
		>
			<template #activator="{ props: tip }">
				<v-btn
					color="error"
					data-test="transfer-cancel"
					:disabled="busy"
					:icon="compact ? ICONS[TransferAction.CANCEL] : undefined"
					:prepend-icon="compact ? undefined : ICONS[TransferAction.CANCEL]"
					size="small"
					variant="text"
					v-bind="tip"
					@click="emit('action', TransferAction.CANCEL)"
				>
					<template v-if="!compact" #default>{{ $t('transfer.action.cancel') }}</template>
				</v-btn>
			</template>
		</v-tooltip>
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
