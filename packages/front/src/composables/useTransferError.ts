import { TransferErrorKind } from '@mcs/shared';

/**
 * What the interface offers to do about a failure.
 *
 * `RETRY` is deliberately not the answer to everything: a transfer that stopped
 * because its source is gone, or because the disk is full, will fail the same way
 * on the next attempt, and a button that does that is worse than none — it costs
 * time and teaches people that the interface does not know either.
 */
export enum TransferAction {
	PAUSE = 'pause',
	RESUME = 'resume',
	/** Ask the queue to try again as it is. Only for failures that pass. */
	RETRY = 'retry',
	/** Re-read what is on disk and report, without fetching anything. */
	VERIFY = 'verify',
	/** Re-fetch the pieces that did not match, preferably from another source. */
	REPAIR = 'repair',
	/** Plan the item again so the sources are chosen from scratch. */
	ANOTHER_SOURCE = 'another_source',
	/**
	 * Send this transfer to another library.
	 *
	 * Not a re-plan: the transfer is re-pointed where it stands, which costs one row
	 * write while it is still downloading and a real move of real bytes once the file
	 * has landed. Re-planning would start the item over and fetch everything again,
	 * which is the wrong answer to "the disk it was going to is full".
	 */
	ANOTHER_TARGET = 'another_target',
	/** The source refused us: its credentials are the thing to fix. */
	FIX_SERVICE = 'fix_service',
	CANCEL = 'cancel',
}

export interface TransferErrorDescriptor {
	kind: TransferErrorKind;
	/** i18n key of the short name of the failure. */
	labelKey: string;
	/** i18n key of the sentence explaining what it means. */
	helpKey: string;
	/** Offered actions, the first one being the one that fits. */
	actions: TransferAction[];
}

const ACTIONS: Record<TransferErrorKind, TransferAction[]> = {
	// Nothing holds it at that address any more: retrying reaches the same absence.
	[TransferErrorKind.SOURCE_GONE]: [TransferAction.ANOTHER_SOURCE, TransferAction.CANCEL],
	// The far end answered, and said no. Only its credentials can change that.
	[TransferErrorKind.SOURCE_UNAUTHORIZED]: [
		TransferAction.FIX_SERVICE,
		TransferAction.ANOTHER_SOURCE,
		TransferAction.CANCEL,
	],
	// The one failure a plain retry really does fix.
	[TransferErrorKind.NETWORK]: [TransferAction.RETRY, TransferAction.CANCEL],
	// Pieces are verified individually, so this costs megabytes, not a restart.
	[TransferErrorKind.CHECKSUM_MISMATCH]: [
		TransferAction.REPAIR,
		TransferAction.VERIFY,
		TransferAction.ANOTHER_SOURCE,
	],
	[TransferErrorKind.DISK_FULL]: [TransferAction.ANOTHER_TARGET, TransferAction.CANCEL],
	[TransferErrorKind.PERMISSION_DENIED]: [TransferAction.ANOTHER_TARGET, TransferAction.CANCEL],
	[TransferErrorKind.TARGET_MISSING]: [TransferAction.ANOTHER_TARGET, TransferAction.CANCEL],
	// Somebody stopped it on purpose; starting it again is the only thing to offer.
	[TransferErrorKind.CANCELLED]: [TransferAction.RETRY],
	[TransferErrorKind.UNKNOWN]: [TransferAction.RETRY, TransferAction.VERIFY, TransferAction.CANCEL],
};

function normalize (kind: TransferErrorKind | string | null | undefined): TransferErrorKind {
	const known = Object.values(TransferErrorKind) as string[];
	return typeof kind === 'string' && known.includes(kind)
		? kind as TransferErrorKind
		: TransferErrorKind.UNKNOWN;
}

export function describeTransferError (
	kind: TransferErrorKind | string | null | undefined,
): TransferErrorDescriptor {
	const value = normalize(kind);
	return {
		kind: value,
		labelKey: `transfer.error_kind.${value}`,
		helpKey: `transfer.error_help.${value}`,
		actions: ACTIONS[value],
	};
}

/** One place decides what a failure offers, so two screens never disagree. */
export function useTransferError () {
	return { describeTransferError, TransferAction };
}
