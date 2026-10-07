import type { IndexerQuery } from './indexer.interface';

/**
 * The words a search is actually made of, spelled once.
 *
 * One function because the question is asked twice and the two answers used to differ:
 * the indexer built `Lanterns S01E08` and sent it, while the screen was told the search
 * had been `Lanterns S01` — on the very line that exists so somebody can see what was
 * asked and correct it when nothing comes back. A person reading that is being told the
 * gateway did something other than what it did.
 *
 * A season and no episode is a search of the season, which is what a pack is. The caller
 * has to name the season: without one there is no coordinate to spell, and asking for a
 * pack of nothing in particular is asking for the bare title — which silently turns
 * "find me the rest of this season" into "find me anything called this".
 */
/**
 * A parenthesis at the end of a title, and everything in it.
 *
 * Repeated rather than greedy, so `Scrubs (2026) (HD - VOST)` loses both and a title that
 * really contains a bracket in the middle keeps it.
 */
const TRAILING_BRACKET = /\s*\([^()]*\)\s*$/;

/**
 * The title as a release name would carry it, not as a media server files it.
 *
 * A server's title is a shelf label: Jellyfin publishes `Scrubs (2026)` to tell its own
 * users which Scrubs this is, and a library flavoured by language comes out as
 * `Scrubs (HD - VOST)`. Neither spelling exists in any release name on any tracker — what
 * exists is `Scrubs.2026.S01E01` or `Scrubs.S01E01` — so sending the brackets is sending
 * words that cannot match, on a search whose whole job is to match words.
 *
 * Measured on the owner's gateway: the new Scrubs went out as `Scrubs (2026)`, and he
 * said what the right answer was — "il devrait chercher Scrubs tout court".
 *
 * Broader is the safe direction here and the reason is structural: the words only ever
 * narrow a search that the identifiers and the season-and-episode parameters have already
 * narrowed. A title that keeps too much finds nothing and reports no fault, which reads
 * exactly like a show no tracker carries.
 *
 * Never to nothing. A title that is only a bracket is somebody's odd library, and an
 * empty search asks the tracker for everything it has.
 */
export const releaseTitle = (title: string): string => {
	let kept = title.trim();

	while (TRAILING_BRACKET.test(kept)) {
		const shorter = kept.replace(TRAILING_BRACKET, '').trim();

		if (shorter === '') {
			return kept;
		}

		kept = shorter;
	}

	return kept;
};

export const searchTerms = (query: IndexerQuery): string => {
	const parts = [query.term.trim()];

	if (query.seasonNumber !== null && query.seasonNumber !== undefined) {
		const season = String(query.seasonNumber).padStart(2, '0');
		const episode = query.episodeNumber;

		parts.push(
			query.seasonPack === true || episode === null || episode === undefined
				? `S${season}`
				: `S${season}E${String(episode).padStart(2, '0')}`,
		);
	}

	return parts.filter((part) => part !== '').join(' ');
};
