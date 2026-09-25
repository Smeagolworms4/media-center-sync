import {
	IndexerType,
	ReleaseKind,
	ReleaseSearchKind,
	type IndexerSettings,
	type Release,
} from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { ErrorKey } from '@mcs/shared';
import { ReleaseIndexerFor } from './indexer.decorator';
import { parseReleaseName } from './release-name';
import { INDEXER_TIMEOUT_MS, releaseJson } from './release-http';
import type { IndexerQuery, ReleaseIndexer } from './indexer.interface';

/**
 * Prowlarr's own shape, as much of it as is read.
 *
 * Deliberately partial and deliberately all optional: this is somebody else's JSON over
 * a version we do not pin, and a field that disappears in their next release must cost
 * a missing label rather than a search that throws.
 */
interface ProwlarrRelease {
	guid?: string;
	title?: string;
	indexer?: string;
	indexerId?: number;
	size?: number;
	seeders?: number;
	leechers?: number;
	publishDate?: string;
	magnetUrl?: string;
	downloadUrl?: string;
	infoUrl?: string;
	/**
	 * What the tracker said about this one, normalised by Prowlarr into its own words.
	 *
	 * An array of strings — `freeleech`, `internal`, `scene` — and an empty one on every
	 * public tracker, which is why nothing here may read an empty list as a statement.
	 * Verified against a running Prowlarr: the field is always present, often `[]`, and
	 * there is no `downloadVolumeFactor` beside it to fall back on.
	 */
	indexerFlags?: unknown;
}

/**
 * Newznab categories, which is the vocabulary Prowlarr normalises every tracker into.
 *
 * Asking with them rather than with free text is what makes a film search stop
 * returning the soundtrack and the game: `2000` is film and `5000` is television on
 * every indexer Prowlarr speaks to, whatever that tracker calls its own sections.
 */
const CATEGORIES: Record<ReleaseSearchKind, number[]> = {
	[ReleaseSearchKind.MOVIE]: [2000],
	[ReleaseSearchKind.SHOW]: [5000],
};

/**
 * Searching through Prowlarr.
 *
 * One address and one key reach every tracker somebody configured there, which is the
 * whole reason it is the first indexer: speaking Torznab to a list of trackers would be
 * re-implementing the thing that exists to be spoken to once.
 *
 * Nothing here decides anything. It asks, reads what came back, and labels each release
 * from its own name — see `release-name`. Whether a release is worth grabbing depends on
 * the catalogue and the settings, neither of which this layer has heard of.
 */
@Injectable()
@ReleaseIndexerFor(IndexerType.PROWLARR)
export class ProwlarrIndexer implements ReleaseIndexer {
	public async search(settings: IndexerSettings, query: IndexerQuery): Promise<Release[]> {
		const rows = await releaseJson<ProwlarrRelease[]>(settings.baseUrl, '/api/v1/search', {
			query: {
				query: this._terms(query),
				categories: CATEGORIES[query.kind].join(','),
				type: 'search',
				limit: 200,
			},
			headers: { 'X-Api-Key': settings.apiKey ?? '' },
			timeoutMs: INDEXER_TIMEOUT_MS,
			unreachable: ErrorKey.INDEXER_UNREACHABLE,
		});

		// An answer of the wrong shape is an empty search rather than a crash: this is
		// somebody else's API, and a proxy error page is a perfectly ordinary thing to
		// get back from a URL somebody typed.
		return Array.isArray(rows)
			? rows.map((row) => this._toRelease(row, query)).filter((one) => one !== null)
			: [];
	}

	public async probe(settings: IndexerSettings): Promise<boolean> {
		// The indexer list rather than a search: it is the cheapest call that needs the
		// key, so a wrong key fails here rather than looking like an empty catalogue.
		await releaseJson<unknown>(settings.baseUrl, '/api/v1/indexer', {
			headers: { 'X-Api-Key': settings.apiKey ?? '' },
			unreachable: ErrorKey.INDEXER_UNREACHABLE,
		});

		return true;
	}

	/**
	 * The words to search for.
	 *
	 * The coordinate goes in the query rather than in Prowlarr's own `season` and
	 * `episode` parameters, and that is not laziness: those only apply to indexers that
	 * declare the tv-search capability, and the ones that do not silently ignore them
	 * and return the whole show. Spelling `S02E09` into the terms is what every tracker
	 * matches on, because it is what is in the release names.
	 *
	 * A season pack asks for `S02` alone. Asking for `S02E09` and hoping a pack comes
	 * back is how somebody looking for the rest of a season finds one episode of it.
	 */
	private _terms(query: IndexerQuery): string {
		const parts = [query.term.trim()];

		// Without a season there is no coordinate to spell, and asking for a pack of
		// nothing in particular is asking for the bare title — which silently turns
		// "find me the rest of this season" into "find me anything called this". The
		// caller has to name the season; a search that cannot is a search of the show.
		if (query.seasonNumber !== null && query.seasonNumber !== undefined) {
			const season = String(query.seasonNumber).padStart(2, '0');

			if (query.seasonPack === true || query.episodeNumber === null || query.episodeNumber === undefined) {
				parts.push(`S${season}`);
			} else {
				parts.push(`S${season}E${String(query.episodeNumber).padStart(2, '0')}`);
			}
		}

		return parts.filter((part) => part !== '').join(' ');
	}

	private _toRelease(row: ProwlarrRelease, query: IndexerQuery): Release | null {
		const title = row.title?.trim();

		// A row with no name and no way to fetch it is not a release, whatever else it
		// carries: it can be neither shown nor grabbed.
		if (!title || (!row.magnetUrl && !row.downloadUrl)) {
			return null;
		}

		const parsed = parseReleaseName(title, query.kind === ReleaseSearchKind.SHOW);

		return {
			// The tracker's own identifier, so the same release keeps its row across two
			// searches and the list does not jump under somebody's pointer. Prefixed
			// with the indexer because two trackers reuse each other's guids.
			id: `${row.indexerId ?? row.indexer ?? 'prowlarr'}:${row.guid ?? row.downloadUrl ?? title}`,
			title,
			indexer: row.indexer ?? 'Prowlarr',
			size: typeof row.size === 'number' && row.size > 0 ? row.size : null,
			seeders: typeof row.seeders === 'number' ? row.seeders : null,
			leechers: typeof row.leechers === 'number' ? row.leechers : null,
			publishedAt: row.publishDate ?? null,
			magnetUrl: row.magnetUrl ?? null,
			downloadUrl: row.downloadUrl ?? null,
			kind: parsed.kind === ReleaseKind.UNKNOWN && query.kind === ReleaseSearchKind.MOVIE
				? ReleaseKind.MOVIE
				: parsed.kind,
			seasonNumber: parsed.seasonNumber,
			episodeNumber: parsed.episodeNumber,
			quality: parsed.quality,
			source: parsed.source,
			languages: parsed.languages,
			coverage: parsed.coverage,
			// Answered by the manager, which is the only layer that knows what we hold.
			heldAlready: false,
			flags: Array.isArray(row.indexerFlags)
				? row.indexerFlags
					.filter((flag): flag is string => typeof flag === 'string')
					.map((flag) => flag.trim().toLowerCase())
					.filter((flag) => flag !== '')
				: [],
		};
	}
}
