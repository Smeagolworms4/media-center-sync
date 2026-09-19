import { ref, type Ref, watch } from 'vue';

export const VIEW_MODES = ['grid', 'list'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export function isViewMode (value: unknown): value is ViewMode {
	return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * Grid or list, remembered for this browser.
 *
 * Not in the URL, unlike the filters: a filtered view is something somebody sends
 * to a friend, and the friend should see it the way *they* browse. The dense list
 * is a genuine preference — somebody managing four hundred episodes wants rows —
 * so it has to survive a reload, but it is a property of the viewer rather than
 * of the address.
 *
 * Every access is guarded: storage throws in a private window and can be disabled
 * outright, and a library that refuses to render because a preference could not be
 * read would be a spectacular way to lose a page.
 */
export function useViewMode (key: string, fallback: ViewMode = 'grid'): Ref<ViewMode> {
	const read = (): ViewMode => {
		try {
			const stored = window.localStorage.getItem(key);
			return isViewMode(stored) ? stored : fallback;
		} catch {
			return fallback;
		}
	};

	const mode = ref<ViewMode>(read());

	watch(mode, value => {
		try {
			window.localStorage.setItem(key, value);
		} catch {
			// Nothing to do: the choice simply lasts until the tab is closed.
		}
	});

	return mode;
}
