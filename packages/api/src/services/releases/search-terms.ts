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
