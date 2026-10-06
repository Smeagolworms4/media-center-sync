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
import { CLIENT_TIMEOUT_MS, INDEXER_TIMEOUT_MS, releaseJson } from './release-http';
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
/** What one tracker can be asked, reduced to the two lists this cares about. */
interface IndexerCapability {
	id: number;
	tvSearchParams: string[];
	movieSearchParams: string[];
}

/** One row of Prowlarr's indexer list, in the parts this reads. */
interface ProwlarrIndexerRow {
	id?: number;
	enable?: boolean;
	capabilities?: { tvSearchParams?: string[]; movieSearchParams?: string[] };
}

/**
 * How long the tracker list is trusted.
 *
 * It changes when somebody adds a tracker, which is not something that happens between
 * two searches. Five minutes is short enough that a tracker added mid-session is used
 * almost at once, and long enough that a season pack's worth of searches costs one call.
 */
const CAPABILITIES_TTL_MS = 5 * 60 * 1000;

const CATEGORIES: Record<ReleaseSearchKind, number[]> = {
	[ReleaseSearchKind.MOVIE]: [2000],
	[ReleaseSearchKind.SHOW]: [5000],
};

/**
 * One request to Prowlarr: which trackers, and how precisely to ask them.
 *
 * `indexerIds` of null means every tracker Prowlarr holds. `byId` carries the catalogue
 * identifiers, `structured` carries the season and episode as parameters; both ride on
 * `tvsearch`, and a tracker that declares neither gets the plain word search.
 */
interface Ask {
	indexerIds: number[] | null;
	byId: boolean;
	structured: boolean;
}

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
	private _capabilities: IndexerCapability[] | null = null;

	private _capabilitiesAt = 0;

	/**
	 * Two asks in parallel, split by what each tracker can actually be asked.
	 *
	 * A text search is the only thing every tracker understands, and it is a blunt one: it
	 * finds what somebody typed, with whatever a release group spelled differently. The
	 * identifier is exact — `tvdbid=81189` is Breaking Bad and nothing else — and six of
	 * nine trackers on a real deployment declare support for it.
	 *
	 * **The capability is read, never assumed**, which is the whole of why this works and
	 * is what Sonarr and Radarr do. An identifier sent to a tracker that ignores it is not
	 * a narrower search, it is a *blank* one: the parameter is dropped and what comes back
	 * is whatever that tracker returns for an empty query. Measured on a live Prowlarr, an
	 * identifier-only search for Breaking Bad answered Formula 1 and Jason Bourne.
	 *
	 * So the trackers are split. The ones that declare the identifier get it; the rest get
	 * the words. Both go out at once and the answers are merged on the release's own
	 * identity, because a tracker that sits in neither half would otherwise be missed and
	 * one that answers both would be counted twice. On that same deployment the pair found
	 * 332 releases where the words alone found 282 — "c'est juste en plus", literally.
	 *
	 * A query with no identifiers, or a Prowlarr that will not list its indexers, falls
	 * back to the single text search this used to be. Degraded, never broken.
	 */
	public async search(settings: IndexerSettings, query: IndexerQuery): Promise<Release[]> {
		const split = await this._split(settings, query);
		const answers = await Promise.all(
			split.map((ask) => this._ask(settings, query, ask)),
		);
		const merged = new Map<string, Release>();

		for (const release of answers.flat()) {
			// The release's own identity, which already carries the tracker it came from —
			// see `_toRelease`. Two trackers reusing a guid stay two releases.
			if (!merged.has(release.id)) {
				merged.set(release.id, release);
			}
		}

		return [...merged.values()];
	}

	/**
	 * Which trackers to ask, and in what form.
	 *
	 * Every ask is *added*, never substituted, and the merge is by release identity — see
	 * `search` — so a tracker answering two ways contributes each release once. That rule
	 * exists because breaking it was the bug: an earlier version sent the identifiers to
	 * the trackers that understood them and the words only to the rest, so a tracker
	 * holding the show under an identifier it does not carry answered nothing, and the
	 * words that would have found it were never sent there.
	 *
	 * The plain text ask therefore always goes out, to everybody. It is the floor: it
	 * needs no declared capability, it reaches a tracker that supports neither of the
	 * other two forms, and it costs one request.
	 *
	 * On top of it, the trackers that declare a coordinate are asked with `season` and
	 * `ep` as parameters — which is the difference between zero results and three hundred
	 * on a show every one of them carries. See `_coordinate`. Those among them that also
	 * declare identifiers get those in the same ask, since both ride on `tvsearch`.
	 */
	private async _split(settings: IndexerSettings, query: IndexerQuery): Promise<Ask[]> {
		// The floor, and the only ask that needs nothing declared.
		const plain: Ask = { indexerIds: null, byId: false, structured: false };
		const ids = this._identifiers(query);
		const coordinate = this._coordinate(query);

		if (Object.keys(ids).length === 0 && Object.keys(coordinate).length === 0) {
			// Nothing to be precise with. One search, every tracker, as it has always been.
			return [plain];
		}

		const indexers = await this._indexers(settings);

		if (indexers === null) {
			// Prowlarr would not say what its trackers take. Asking anyway would send
			// parameters half of them drop, and a dropped parameter is a blank search.
			return [plain];
		}

		const COORDINATE_PARAMS = ['season', 'ep'];
		const withBoth: number[] = [];
		const withCoordinate: number[] = [];
		const withIds: number[] = [];

		for (const indexer of indexers) {
			const params = query.kind === ReleaseSearchKind.MOVIE
				? indexer.movieSearchParams
				: indexer.tvSearchParams;
			const takesIds = Object.keys(ids).length > 0
				&& Object.keys(ids).some((name) => params.includes(name));
			const takesCoordinate = Object.keys(coordinate).length > 0
				&& COORDINATE_PARAMS.every((name) => params.includes(name));

			if (takesIds && takesCoordinate) {
				withBoth.push(indexer.id);
			} else if (takesCoordinate) {
				withCoordinate.push(indexer.id);
			} else if (takesIds) {
				withIds.push(indexer.id);
			}
		}

		return [
			plain,
			...(withBoth.length > 0
				? [{ indexerIds: withBoth, byId: true, structured: true }]
				: []),
			...(withCoordinate.length > 0
				? [{ indexerIds: withCoordinate, byId: false, structured: true }]
				: []),
			...(withIds.length > 0
				? [{ indexerIds: withIds, byId: true, structured: false }]
				: []),
		];
	}

	/**
	 * The season and episode as parameters rather than as words.
	 *
	 * The single most expensive line this indexer ever had. `S01E08` glued onto the title
	 * makes every tracker match that literal string inside a release name; `season=1&ep=8`
	 * lets each one answer from its own index. Measured against a household's ten
	 * trackers, same Prowlarr, same second:
	 *
	 * | asked for      | as words | as parameters |
	 * |----------------|---------:|--------------:|
	 * | Dark S01E08    |      110 |           653 |
	 * | Severance S01E08 |     10 |           319 |
	 * | The Expanse S01E08 |    0 |           333 |
	 *
	 * Zero against three hundred and thirty-three, on a show that every one of those
	 * trackers carries. The screen said "nothing came back, try other words", and the
	 * words were never the problem.
	 *
	 * A season pack asks for the season and names no episode, which is the same
	 * distinction `_terms` draws for the text form.
	 */
	private _coordinate(query: IndexerQuery): Record<string, number> {
		if (query.kind === ReleaseSearchKind.MOVIE) {
			return {};
		}

		if (query.seasonNumber === null || query.seasonNumber === undefined) {
			return {};
		}

		const episode = query.episodeNumber;

		return query.seasonPack === true || episode === null || episode === undefined
			? { season: query.seasonNumber }
			: { season: query.seasonNumber, ep: episode };
	}

	/** The provider identifiers this query carries, under the names Prowlarr uses. */
	private _identifiers(query: IndexerQuery): Record<string, string> {
		const ids = query.externalIds ?? {};

		return {
			...(ids.imdb ? { imdbId: ids.imdb } : {}),
			...(ids.tmdb ? { tmdbId: ids.tmdb } : {}),
			...(ids.tvdb ? { tvdbId: ids.tvdb } : {}),
		};
	}

	private async _ask(
		settings: IndexerSettings,
		query: IndexerQuery,
		ask: Ask,
	): Promise<Release[]> {
		/*
		 * The words go out on every ask, and that is deliberate. A tracker that declares
		 * `tmdbId` and not `tvdbId` would otherwise be sent an identifier it drops and no
		 * words to fall back on — a blank search, on the very ask that was supposed to be
		 * the precise one.
		 */
		const identifiers = ask.byId ? this._identifiers(query) : {};
		const structured = ask.structured ? this._coordinate(query) : {};
		const rows = await releaseJson<ProwlarrRelease[]>(settings.baseUrl, '/api/v1/search', {
			query: {
				// The bare title on a structured ask: the coordinate travels as parameters,
				// and spelling it in the words as well asks the tracker to find `S01E08`
				// written that way in the release name too.
				query: ask.structured ? query.term.trim() : this._terms(query),
				categories: CATEGORIES[query.kind].join(','),
				// `tvsearch` and `movie` carry the identifiers and the coordinate; `search`
				// is the plain one and ignores both.
				type: ask.byId || ask.structured
					? (query.kind === ReleaseSearchKind.MOVIE ? 'movie' : 'tvsearch')
					: 'search',
				...identifiers,
				...structured,
				// Repeated, never joined: Prowlarr refuses `indexerIds=7,12,1` with a 400.
				...(ask.indexerIds === null ? {} : { indexerIds: ask.indexerIds }),
				limit: 200,
			},
			headers: { 'X-Api-Key': settings.apiKey ?? '' },
			timeoutMs: INDEXER_TIMEOUT_MS,
			unreachable: ErrorKey.INDEXER_UNREACHABLE,
			unauthorized: ErrorKey.INDEXER_UNAUTHORIZED,
			timeout: ErrorKey.INDEXER_TIMEOUT,
		});

		// An answer of the wrong shape is an empty search rather than a crash: this is
		// somebody else's API, and a proxy error page is a perfectly ordinary thing to
		// get back from a URL somebody typed.
		return Array.isArray(rows)
			? rows.map((row) => this._toRelease(row, query)).filter((one) => one !== null)
			: [];
	}

	/**
	 * What each tracker says it can be asked, or null when Prowlarr will not say.
	 *
	 * Cached for a few minutes: the list changes when somebody adds a tracker, and asking
	 * for it before every search would be a second round trip on every grab for an answer
	 * that is the same all day. Null rather than an empty list on failure, because the two
	 * mean opposite things to the caller — "ask everybody the old way" against "nobody can
	 * take an identifier".
	 */
	private async _indexers(settings: IndexerSettings): Promise<IndexerCapability[] | null> {
		const now = Date.now();

		if (this._capabilities !== null && this._capabilitiesAt + CAPABILITIES_TTL_MS > now) {
			return this._capabilities;
		}

		try {
			const rows = await releaseJson<ProwlarrIndexerRow[]>(settings.baseUrl, '/api/v1/indexer', {
				headers: { 'X-Api-Key': settings.apiKey ?? '' },
				timeoutMs: INDEXER_TIMEOUT_MS,
				unreachable: ErrorKey.INDEXER_UNREACHABLE,
				unauthorized: ErrorKey.INDEXER_UNAUTHORIZED,
				timeout: ErrorKey.INDEXER_TIMEOUT,
			});

			if (!Array.isArray(rows)) {
				return null;
			}

			this._capabilities = rows
				.filter((row) => typeof row.id === 'number' && row.enable !== false)
				.map((row) => ({
					id: row.id as number,
					tvSearchParams: row.capabilities?.tvSearchParams ?? [],
					movieSearchParams: row.capabilities?.movieSearchParams ?? [],
				}));
			this._capabilitiesAt = now;

			return this._capabilities;
		} catch {
			// The search itself still works without this, so a Prowlarr that will not list
			// its indexers costs precision rather than results.
			return null;
		}
	}

	public async probe(settings: IndexerSettings): Promise<boolean> {
		// The indexer list rather than a search: it is the cheapest call that needs the
		// key, so a wrong key fails here rather than looking like an empty catalogue.
		await releaseJson<unknown>(settings.baseUrl, '/api/v1/indexer', {
			headers: { 'X-Api-Key': settings.apiKey ?? '' },
			unreachable: ErrorKey.INDEXER_UNREACHABLE,
			unauthorized: ErrorKey.INDEXER_UNAUTHORIZED,
			timeout: ErrorKey.INDEXER_TIMEOUT,
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

	public async trackers(settings: IndexerSettings): Promise<string[]> {
		try {
			const rows = await releaseJson<{ name?: unknown; enable?: unknown }[]>(
				settings.baseUrl,
				'/api/v1/indexer',
				{
					headers: { 'X-Api-Key': settings.apiKey ?? '' },
					timeoutMs: CLIENT_TIMEOUT_MS,
					unreachable: ErrorKey.INDEXER_UNREACHABLE,
					unauthorized: ErrorKey.INDEXER_UNAUTHORIZED,
					timeout: ErrorKey.INDEXER_TIMEOUT,
				},
			);

			return (Array.isArray(rows) ? rows : [])
				// Only the ones that can actually answer a search: offering a disabled
				// tracker as a value to prefer would be offering an order that cannot fire.
				.filter((row) => row.enable !== false)
				.map((row) => (typeof row.name === 'string' ? row.name.trim() : ''))
				.filter((name) => name !== '');
		} catch {
			return [];
		}
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
			// Both answered by the manager, the only layer that knows what we hold and what
			// was asked for.
			heldAlready: false,
			offTarget: false,
			flags: Array.isArray(row.indexerFlags)
				? row.indexerFlags
					.filter((flag): flag is string => typeof flag === 'string')
					.map((flag) => flag.trim().toLowerCase())
					.filter((flag) => flag !== '')
				: [],
		};
	}
}
