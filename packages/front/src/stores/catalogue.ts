import type { CacheRefreshReasonValue } from '@mcs/shared';
import { EventName } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useEvents } from '@/hooks/useEvents';

/**
 * What the gateway is doing to the catalogue behind the screens.
 *
 * The gateway rebuilds the shared projections — the match graph every library page,
 * every group and the news wall read — after a scan, away from anybody's request. That
 * is the fix for pages that took seconds. This is the other half of it: *saying so*.
 *
 * A rebuild with no sign of it is indistinguishable from a gateway that has hung, and
 * the answers served while it runs are the previous ones — correct, one pass behind.
 * So the screens show a thin bar and keep working, rather than a spinner over nothing
 * or, worse, nothing at all. When it lands, `version` moves and whoever is watching
 * re-reads what they are showing.
 *
 * Deliberately not a copy of the catalogue. The payload would have to be megabytes, to
 * every open tab, for a change that usually touches four rows — and a screen knows what
 * it is displaying far better than this does.
 */
export const useCatalogueStore = defineStore('catalogue', () => {
	const events = useEvents();

	const refreshing = ref(false);
	const reason = ref<CacheRefreshReasonValue | null>(null);
	const startedAt = ref<string | null>(null);
	const lastTookMs = ref<number | null>(null);
	/**
	 * Bumped every time the gateway says the catalogue moved.
	 *
	 * A counter rather than the version string itself: screens watch it to know they
	 * should re-read, and a counter cannot be mistaken for something to display.
	 */
	const generation = ref(0);
	const version = ref<string | null>(null);

	const listening = ref(false);

	/** Start following the stream. Idempotent — several screens calling it is normal. */
	function listen (): void {
		if (listening.value) {
			return;
		}
		listening.value = true;

		events.on(EventName.CACHE_STATE, state => {
			refreshing.value = state.refreshing;
			reason.value = state.reason;
			startedAt.value = state.startedAt;
			if (state.tookMs !== null) {
				lastTookMs.value = state.tookMs;
			}
		});

		events.on(EventName.CATALOGUE_CHANGED, changed => {
			version.value = changed.version;
			generation.value += 1;
		});
	}

	/**
	 * Run something again whenever the catalogue moves, and give back the stopper.
	 *
	 * The shape every screen wanted and each was writing itself: subscribe, compare,
	 * re-read. Centralised so that a screen which forgets to unsubscribe is a bug in one
	 * place rather than in nine.
	 */
	function onChange (handler: () => void): () => void {
		listen();

		return events.store.on(EventName.CATALOGUE_CHANGED, () => {
			handler();
		});
	}

	/** Seconds the last rebuild took, for the tooltip. Null until one has finished. */
	const lastTookSeconds = computed(() =>
		lastTookMs.value === null ? null : Math.round(lastTookMs.value / 100) / 10,
	);

	return {
		refreshing,
		reason,
		startedAt,
		lastTookMs,
		lastTookSeconds,
		generation,
		version,
		listen,
		onChange,
	};
});
