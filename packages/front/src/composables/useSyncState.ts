import { SyncState } from '@mcs/shared';
import { SYNC_STATE_COLOR } from '@/plugins/vuetify';

/**
 * The icon for each state.
 *
 * Chosen so the shape alone carries the meaning: colour-blind viewers, and
 * anybody glancing at a dense list, should not have to tell amber from green.
 */
export const SYNC_STATE_ICON: Record<SyncState, string> = {
	[SyncState.LOCAL_ONLY]: 'mdi-home-outline',
	[SyncState.MISSING]: 'mdi-cloud-download-outline',
	// An hourglass rather than another cloud or disk: the thing being waited for is
	// time passing on somebody else's scanner, and a shape nobody else in this set
	// uses is what keeps it from reading as a variation on "missing".
	[SyncState.AWAITING_INDEX]: 'mdi-timer-sand',
	[SyncState.NOT_INDEXED]: 'mdi-database-alert-outline',
	[SyncState.IN_SYNC]: 'mdi-check-circle-outline',
	[SyncState.OUTDATED]: 'mdi-arrow-up-bold-circle-outline',
	[SyncState.CONFLICT]: 'mdi-alert-circle-outline',
	[SyncState.SYNCING]: 'mdi-sync',
	[SyncState.UNKNOWN]: 'mdi-help-circle-outline',
};

export interface SyncStateDescriptor {
	state: SyncState;
	icon: string;
	color: string;
	/** i18n key of the short label. */
	labelKey: string;
	/** i18n key of the sentence shown in the tooltip. */
	helpKey: string;
}

/** States that are unknown to this build must still render something. */
function normalize (state: SyncState | string | null | undefined): SyncState {
	const known = Object.values(SyncState) as string[];
	return typeof state === 'string' && known.includes(state) ? state as SyncState : SyncState.UNKNOWN;
}

export function describeSyncState (state: SyncState | string | null | undefined): SyncStateDescriptor {
	const value = normalize(state);
	return {
		state: value,
		icon: SYNC_STATE_ICON[value],
		color: SYNC_STATE_COLOR[value],
		labelKey: `sync.state.${value}`,
		helpKey: `sync.state_help.${value}`,
	};
}

/**
 * One place decides what a state looks like.
 *
 * Every screen that shows a media item shows this, so the day a state changes
 * colour it changes everywhere at once — which is the only way a glance can go on
 * meaning the same thing across the application.
 */
export function useSyncState () {
	return { describeSyncState, SYNC_STATE_ICON, SYNC_STATE_COLOR };
}
