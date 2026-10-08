import type { MediaGroup } from '@mcs/shared';
import { useI18n } from 'vue-i18n';

/**
 * How an episode's coordinate is written, `S1E1` or `S1E1-E2`.
 *
 * One place rather than one per component, because the second form is the whole reason
 * this exists and it is easy to forget. A file named `S01E01-E02` is one row holding two
 * episodes, and a screen that wrote only the first number said the household had episode
 * one and said nothing at all about episode two — which is how four shows in this library
 * came to be read as having a hole in them, twice over: once by the gap detection and
 * once by the person looking at the shelf.
 *
 * A key rather than a hand-built string for the same reason every other label is one:
 * the order of the letters and the separator are a translator's business, and Chinese
 * does not write `S1E1`.
 */
export function useEpisodeLabel (): {
	episodeLabel: (group: Pick<MediaGroup, 'seasonNumber' | 'episodeNumber' | 'episodeNumberEnd'>) =>
	string | null;
} {
	const { t } = useI18n();

	/**
	 * Null where there is nothing to write — a film, a series, a season.
	 *
	 * Null rather than an empty string, so a caller has to decide whether to draw the
	 * element at all instead of drawing an empty one.
	 */
	const episodeLabel = (
		group: Pick<MediaGroup, 'seasonNumber' | 'episodeNumber' | 'episodeNumberEnd'>,
	): string | null => {
		const { seasonNumber: season, episodeNumber: episode } = group;

		if (season === null || episode === null) {
			return null;
		}

		// An end equal to or below the start is a parse that went wrong somewhere
		// upstream, and writing `S1E4-E2` would put the mistake on screen rather than
		// fall back to the one thing that is certainly true.
		const last = group.episodeNumberEnd ?? null;

		return last !== null && last > episode
			? t('media.season_episode_range', { season, episode, last })
			: t('media.season_episode', { season, episode });
	};

	return { episodeLabel };
}
