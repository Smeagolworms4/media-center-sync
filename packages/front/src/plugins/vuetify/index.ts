import { SyncState } from '@mcs/shared';
/*
 * Vuetify's base layer, and it is not optional.
 *
 * The Vite plugin auto-imports each component's own stylesheet, which is enough for a
 * component to look roughly right and not enough for it to be right: the shared rules
 * that size an input, place its prefix icon and draw its outline live here. Without
 * this line every field renders oversized, its icon sits above its label, and a stub
 * of the outline is left floating under the box — all of it looking like a theme
 * somebody wrote badly rather than a stylesheet nobody imported.
 *
 * The plugin rewrites this specifier to `src/styles/settings.scss`, which is where the
 * framework variables are overridden.
 */
import 'vuetify/styles';
import { createVuetify, type ThemeDefinition } from 'vuetify';
import { aliases, mdi } from 'vuetify/iconsets/mdi';

export const THEMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * Dark by default.
 *
 * This is a tool people open in the evening, next to a television, to see what
 * their library is missing. A white screen in that room is the first thing they
 * would want to turn off.
 */
export const DEFAULT_THEME: ThemeName = 'dark';

const THEME_STORAGE_KEY = 'mcs.theme';

export function isThemeName (value: unknown): value is ThemeName {
	return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Storage throws in a private window; a viewer who cannot persist still gets a theme. */
export function readStoredTheme (): ThemeName | null {
	try {
		const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		return isThemeName(stored) ? stored : null;
	} catch {
		return null;
	}
}

export function storeTheme (theme: ThemeName): void {
	try {
		window.localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Nothing to do: the choice simply lasts until the tab is closed.
	}
}

/**
 * One theme colour per `SyncState`.
 *
 * The seven states are the vocabulary of the whole interface — a list row, a
 * season header and a transfer card all show the same seven. Declaring their
 * colours here, as theme tokens rather than as literals inside a component, is
 * what guarantees that "amber" never comes to mean two different things on two
 * different screens.
 */
export const SYNC_STATE_COLOR: Record<SyncState, string> = {
	[SyncState.LOCAL_ONLY]: 'state-local-only',
	[SyncState.MISSING]: 'state-missing',
	[SyncState.IN_SYNC]: 'state-in-sync',
	[SyncState.OUTDATED]: 'state-outdated',
	[SyncState.CONFLICT]: 'state-conflict',
	[SyncState.SYNCING]: 'state-syncing',
	[SyncState.UNKNOWN]: 'state-unknown',
};

const dark: ThemeDefinition = {
	dark: true,
	colors: {
		'background': '#101419',
		'surface': '#181D25',
		'surface-light': '#222933',
		'surface-variant': '#2A323E',
		'on-surface-variant': '#C7D0DC',
		'primary': '#5AA9F5',
		'on-primary': '#06121F',
		'secondary': '#8A98AC',
		'on-secondary': '#0B1016',
		'success': '#4FB07C',
		'on-success': '#06120C',
		'warning': '#DCA34A',
		'on-warning': '#1A1205',
		'error': '#E0574E',
		'on-error': '#1E0907',
		'info': '#5AA9F5',
		'on-info': '#06121F',
		'state-local-only': '#3FB8AF',
		'state-missing': '#5AA9F5',
		'state-in-sync': '#4FB07C',
		'state-outdated': '#DCA34A',
		'state-conflict': '#E0574E',
		'state-syncing': '#A78BFA',
		'state-unknown': '#8A98AC',
	},
};

const light: ThemeDefinition = {
	dark: false,
	colors: {
		'background': '#F4F6F9',
		'surface': '#FFFFFF',
		'surface-light': '#EDF1F6',
		'surface-variant': '#DDE3EB',
		'on-surface-variant': '#3B4552',
		'primary': '#1C6FC4',
		'on-primary': '#FFFFFF',
		'secondary': '#54627A',
		'on-secondary': '#FFFFFF',
		'success': '#2E8B57',
		'on-success': '#FFFFFF',
		'warning': '#B07414',
		'on-warning': '#FFFFFF',
		'error': '#C0392B',
		'on-error': '#FFFFFF',
		'info': '#1C6FC4',
		'on-info': '#FFFFFF',
		// Darkened rather than reused: the dark palette is tuned for a dark
		// background and the same hex on white fails contrast for small text.
		'state-local-only': '#1F8B84',
		'state-missing': '#1C6FC4',
		'state-in-sync': '#2E8B57',
		'state-outdated': '#B07414',
		'state-conflict': '#C0392B',
		'state-syncing': '#6D4BD6',
		'state-unknown': '#54627A',
	},
};

export function createAppVuetify () {
	return createVuetify({
		theme: {
			defaultTheme: readStoredTheme() ?? DEFAULT_THEME,
			themes: { dark, light },
		},
		icons: {
			defaultSet: 'mdi',
			aliases,
			sets: { mdi },
		},
		defaults: {
			VCard: { rounded: 'lg' },
			VTextField: { variant: 'outlined', density: 'comfortable' },
			VSelect: { variant: 'outlined', density: 'comfortable' },
			VBtn: { variant: 'flat' },
		},
	});
}

export default createAppVuetify;
