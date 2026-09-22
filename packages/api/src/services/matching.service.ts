import {
	MatchStrategy,
	MediaKind,
	SyncState,
	type ExternalIds,
	type MediaFileInfo,
} from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { QualityService } from './quality.service';
import { similarity } from './title-normalizer';

/**
 * The shape correlation works on.
 *
 * Deliberately narrower than the entity: everything here comes out of an index row,
 * and the correlation must not be able to reach a repository, a handler or a service
 * definition. `peerId` is passed in rather than read, because an item knows its
 * service and only the service knows whose machine it is on.
 */
export interface MatchCandidate {
	id: string;
	serviceId: string;
	peerId?: string | null;
	parentId?: string | null;
	kind: MediaKind;
	title: string;
	normalizedTitle: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	externalIds: ExternalIds;
	file: MediaFileInfo | null;
}

export interface MatchOptions {
	/** From the settings. Below it, a correlation is proposed and not applied. */
	threshold: number;
	/**
	 * Parents already correlated, as local identifier to the remote ones.
	 *
	 * This is what makes season and episode numbers usable: `S01E02` is meaningless
	 * on its own and decisive once both sides agree which series they are inside.
	 */
	parentMatches?: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * The identifiers that genuinely name *that* episode, per item.
	 *
	 * `provider:value` keys, and only the ones an item does not share with its
	 * siblings. Media servers routinely stamp every episode of a show with the series'
	 * identifier, so `tvdb` carries an episode's own number on one library and the
	 * show's on the next, and the key name cannot tell them apart. This map is the
	 * answer worked out from the data — see `episodeIdentifierKeys` — and it is what
	 * lets an identifier overrule two numberings that disagree without ever merging
	 * episode 3 with episode 47.
	 *
	 * Absent means "nobody worked it out", and then nothing changes: an episode's
	 * identifiers are believed exactly as far as they were before, which is only where
	 * the numbers agree too.
	 */
	episodeIdentifiers?: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * Episodes the numbering alignment paired, as local identifier to the remote ones.
	 *
	 * Computed per series by `alignAbsoluteNumbering`, which holds every guard: this is
	 * only the conclusion. Nothing is derived here from a number, deliberately — a
	 * formula applied per pair cannot see the season lengths, the holes or the totals
	 * that make the conversion safe, and correlation scoring one pair at a time is
	 * exactly where such a formula would be written by mistake.
	 */
	absolutePairs?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One correlation, before anything has decided to keep it. */
export interface MatchProposal {
	localItemId: string | null;
	remoteItemId: string;
	remoteServiceId: string;
	remotePeerId: string | null;
	strategy: MatchStrategy;
	confidence: number;
	state: SyncState;
	reason: string | null;
	/**
	 * Whether the confidence cleared the settings threshold.
	 *
	 * The row is written either way — a proposed match the person can confirm is far
	 * more useful than a match silently dropped — and only this flag says whether the
	 * gateway may act on it.
	 */
	applied: boolean;
}

/** Below this, two titles are not the same work whatever else agrees. */
const TITLE_FLOOR = 0.62;

/** A title match can never be certain, however perfect the string. */
const TITLE_CEILING = 0.95;

const CONFIDENCE = {
	checksum: 1,
	externalId: 0.98,
	externalIdPartial: 0.9,
	seasonEpisode: 0.95,
	/**
	 * Below `seasonEpisode`, and the gap is the point: there both servers declared the
	 * coordinate, here one of them was computed from the other side's season lengths.
	 * Still well above the default threshold, because the conversion is only allowed to
	 * run once the two sides have been proved to account for the same show end to end.
	 */
	absoluteEpisode: 0.9,
	pathExact: 0.85,
	pathBasename: 0.8,
} as const;

/**
 * The identifiers that name a work, and are therefore proof that two copies are it.
 *
 * IMDb, TMDB and TVDB each allocate one number per work, for the whole world, and
 * every scraper that files a copy under one of them is saying which film or which
 * show it is. TMDB and TVDB number films and series separately, so the same value can
 * name two works of two kinds; that is harmless only because `score` refuses two
 * different kinds before it reads any identifier.
 *
 * Two keys are left out, and each would merge things that are not one work:
 *
 * - `provider` is the row key inside the one service that reported the item — a Plex
 *   rating key, a Jellyfin item identifier, a peer's row. On the owner's own database a
 *   Plex film carried `provider: "5"`, and the fifth row of any other Plex server is
 *   some other film. It identifies nothing across servers and is never compared.
 * - `musicbrainz` is global, but the Jellyfin handler fills it from whichever of the
 *   track, the album or the artist identifier comes first, so two recordings by one
 *   artist can carry the same value. It still correlates, as it always has, but only
 *   where the running time is still allowed to say the two are different things.
 */
export const WORK_IDENTIFIERS: readonly (keyof ExternalIds)[] = ['imdb', 'tmdb', 'tvdb'];

/** Identifiers that correlate without being allowed to overrule the running time. */
const CATALOGUE_IDENTIFIERS: readonly (keyof ExternalIds)[] = ['musicbrainz'];

/**
 * The value one identifier carries, or null when it carries none worth comparing.
 *
 * Zero is rejected along with the empty string: it is what a scraper writes when it
 * has a field and no answer, and since a work identifier now overrules the running
 * time, a placeholder shared by two unrelated films would merge them whatever their
 * lengths.
 */
export const identifierValue = (
	ids: ExternalIds | null | undefined,
	key: keyof ExternalIds,
): string | null => {
	const value = ids?.[key];

	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();

	return trimmed === '' || /^(tt)?0+$/i.test(trimmed) ? null : trimmed;
};

/**
 * Correlates the same media across services.
 *
 * The strategies are tried in order of how much they prove, and the order is the
 * whole design — each one is wrong on its own in a different way:
 *
 * - A checksum is proof of identity and nothing else; it only ever matches a byte
 *   for byte copy, so it finds the files somebody already synced and misses every
 *   re-encode of the same episode.
 * - A provider identifier is what the metadata agents agreed on, which is close to
 *   proof — but libraries carry them inconsistently, an episode often inherits its
 *   series' identifier, and two different cuts of a film share one. That last is
 *   why a work identifier settles which work a copy is and leaves which version it
 *   is to the running time — see `WORK_IDENTIFIERS` and `score`.
 * - Season and episode numbers are exact and meaningless without a parent: every
 *   library on earth has an `S01E02`. They are only usable below a series that has
 *   already been matched some other way, which is why they come after the
 *   identifiers rather than before.
 * - An absolute number converted into season and episode is the last resort under a
 *   series, and the only coordinate here that no server declared. It exists because
 *   anime is routinely published as one continuous run — episode 1 to 291 — while the
 *   same show elsewhere is cut into seasons, so `E153` and `S06E12` looked like two
 *   different things and the gateway called missing what somebody already owned. Every
 *   guard on it lives in `episode-numbering.ts`, where the season lengths of both
 *   copies can be seen at once; this file only reads the conclusion.
 * - A normalised title is the only strategy that works on a library with no
 *   metadata at all, and the only one that can be confidently wrong: remakes, the
 *   two `The Office`s, and anything with a subtitle one library kept and the other
 *   dropped. Hence a score, a year check, and a threshold below which it is
 *   proposed rather than applied.
 * - A path is the weakest of all and still worth having last: two gateways that
 *   sync to each other end up with identical trees, and a matching path then
 *   confirms what nothing else could. It is also the one that matches two unrelated
 *   files called `movie.mkv`, which is why a bare basename scores lowest.
 */
@Injectable()
export class MatchingService {
	public constructor(private readonly _quality: QualityService) {}

	/**
	 * Score one pair, or null when nothing links them.
	 *
	 * Returns the first strategy that fires, never a blend: a correlation the person
	 * can be shown and can undo has to be explainable by one rule, and an averaged
	 * score of five signals explains nothing.
	 */
	public score(
		local: MatchCandidate,
		remote: MatchCandidate,
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		// An episode is never a season and a film is never a series. Kinds that differ
		// are a different node of the tree, whatever their titles say.
		if (local.kind !== remote.kind) {
			return null;
		}

		const checksum = this._checksumMatch(local, remote);

		if (checksum) {
			return checksum;
		}

		/*
		 * The identifier decides the work; the running time decides the version.
		 *
		 * So an identifier that names a work is asked before the duration, not after it.
		 * It used to be the other way round, on the reasoning that two cuts of one film
		 * share one IMDb number and merging them hands the theatrical copy to somebody
		 * who asked for the extended one. The concern is real and that answer to it was
		 * wrong: it made `CONFLICT` — "two versions of one media" — unreachable for a
		 * film, because the pair it describes was never allowed to be a pair. Two cuts
		 * showed as two unrelated cards, and nothing said they were the same film.
		 *
		 * The concern is now answered where the decision is taken. `deriveState` reads
		 * the pair as a conflict from the very difference that used to veto it, and a
		 * conflicting copy is never interchangeable with the other one: a sync neither
		 * counts it as holding the media nor pulls from it (`SyncManager`), and a group
		 * does not call it held (`MediaGroupManager`).
		 */
		const work = this._externalIdMatch(local, remote, WORK_IDENTIFIERS, options);

		if (work) {
			return work;
		}

		// Nothing above agreed, so if the two sides name different works they are
		// different works — whatever the titles, the numbers or the paths go on to say.
		if (this.contradicted(local, remote)) {
			return null;
		}

		if (this._separateCuts(local, remote)) {
			return null;
		}

		const catalogue = this._externalIdMatch(local, remote, CATALOGUE_IDENTIFIERS, options);

		if (catalogue) {
			return catalogue;
		}

		const episode = this._seasonEpisodeMatch(local, remote, options);

		if (episode) {
			return episode;
		}

		/*
		 * Last, because it is the only strategy whose coordinate nobody declared.
		 *
		 * The order over the three episode rules is the owner's and is worth stating
		 * plainly: an identifier that genuinely names the episode decides, whatever the
		 * numbering says; failing that the season and episode numbers decide, which is
		 * the ordinary case and must stay it; and only where neither can — a show
		 * published as one continuous run against the same show cut into seasons — does
		 * the conversion get a say.
		 */
		const absolute = this._absoluteEpisodeMatch(local, remote, options);

		if (absolute) {
			return absolute;
		}

		const title = this._titleMatch(local, remote);

		if (title) {
			return title;
		}

		return this._pathMatch(local, remote);
	}

	/**
	 * Whether the two sides name different works, which is the one thing a title
	 * cannot argue with.
	 *
	 * Two films can share a title — remakes, namesakes, a documentary about the film —
	 * and separating them is exactly what IMDb, TMDB and TVDB numbers are for. So a
	 * pair whose identifiers point at two different works is not a match at any score,
	 * and a title correlation already applied on such a pair is wrong and is revoked
	 * rather than left standing.
	 *
	 * **Absence is not disagreement**, and that is the trap this exists to avoid. The
	 * ordinary case in a real house is one library that scrapes and one that does not:
	 * the Plex copy carries `tt0417299` and the Jellyfin copy carries nothing at all.
	 * Reading that as a contradiction would revoke every correct match somebody has,
	 * so a registry only speaks when **both** sides filled it in.
	 *
	 * Agreement anywhere silences it. A pair that agrees on IMDb and disagrees on TMDB
	 * is one work whose two libraries scraped different TMDB entries — `score` has
	 * already returned an `EXTERNAL_ID` match by the time this is asked, and asking it
	 * first would throw the pair away over the weaker of the two registries.
	 *
	 * **Films and series only, and that restriction is not a simplification.** A season
	 * and an episode routinely carry their *series'* identifier rather than their own,
	 * and which of the two a given library writes is not something the field name says.
	 * So one library stamping every episode of a show with `tvdb:121361` and another
	 * carrying each episode's own number produces a disagreement on every episode of a
	 * series the two servers hold identically — and reading that as "two different
	 * works" would unpick a show that correlates perfectly today, episode by episode,
	 * on the very numbering it is matched by. `MediaManager._workKeys` draws the same
	 * line for the same reason, and the two have to agree: an index that introduces two
	 * copies and a veto that then refuses them would be a pass that does nothing but
	 * churn.
	 */
	public contradicted(local: MatchCandidate, remote: MatchCandidate): boolean {
		if (local.kind !== MediaKind.MOVIE && local.kind !== MediaKind.SERIES) {
			return false;
		}

		return WORK_IDENTIFIERS.some((provider) => {
			const left = identifierValue(local.externalIds, provider);
			const right = identifierValue(remote.externalIds, provider);

			return left !== null && right !== null && left !== right;
		});
	}

	/**
	 * The best remote candidate for one local item, per remote service.
	 *
	 * Per service rather than overall, because holding the same film on three
	 * friends' gateways is the normal case and each of them is a usable source. The
	 * transfer layer picks between them later, on measured rate; correlation only has
	 * to say that they are the same film.
	 */
	public correlate(
		local: MatchCandidate,
		candidates: MatchCandidate[],
		options: MatchOptions,
	): MatchProposal[] {
		const best = new Map<string, MatchProposal>();

		for (const remote of candidates) {
			if (remote.id === local.id || remote.serviceId === local.serviceId) {
				continue;
			}

			const scored = this.score(local, remote, options);

			if (!scored) {
				continue;
			}

			const proposal = this._toProposal(local, remote, scored, options);
			const incumbent = best.get(remote.serviceId);

			if (!incumbent || proposal.confidence > incumbent.confidence) {
				best.set(remote.serviceId, proposal);
			}
		}

		return [...best.values()].sort((left, right) => right.confidence - left.confidence);
	}

	/**
	 * What the icon says for one pair.
	 *
	 * `MISSING` is the case where we have nothing at all; everything else compares
	 * the two files through the quality comparator so that the list and the sync
	 * cannot disagree about what "outdated" means.
	 */
	public deriveState(local: MatchCandidate | null, remote: MatchCandidate): SyncState {
		if (!local) {
			return SyncState.MISSING;
		}

		// A node with no file of its own — a series, a season — is never outdated: its
		// state is an aggregate of its children, computed by whoever holds the tree.
		if (!local.file && !remote.file) {
			return SyncState.IN_SYNC;
		}

		if (!local.file) {
			return SyncState.MISSING;
		}

		if (!remote.file) {
			return SyncState.LOCAL_ONLY;
		}

		// The cut before the quality. A different cut is not a better or a worse copy of
		// this one, it is another version of the work — and asked second, as it was, a
		// 2160p extended cut read `outdated` against a 1080p theatrical one, which is
		// the state a sync set to replace outdated copies acts on by writing over ours.
		// Now that a shared identifier groups two cuts, that ordering would have turned
		// every such pair into a replacement nobody asked for.
		if (this._quality.isConflicting(local.file, remote.file)) {
			return SyncState.CONFLICT;
		}

		return this._quality.compare(remote.file, local.file).order > 0
			? SyncState.OUTDATED
			: SyncState.IN_SYNC;
	}

	/**
	 * The state of an item given everything it correlated with.
	 *
	 * The order of the tests is the order of urgency on screen: something to fetch
	 * beats something to arbitrate, which beats everything being fine.
	 */
	/**
	 * What the icon next to one item should say.
	 *
	 * `heldLocally` is not a detail: an item nobody else has means two opposite things
	 * depending on which side of the gateway it sits. On a service we can write to it
	 * is `LOCAL_ONLY` — we have it, nobody else does. On somebody else's server it is
	 * `MISSING` — they have it, we do not, and that is precisely what a sync exists to
	 * fill. Deriving both from an empty list of matches, as this did, made every remote
	 * item the gateway could fetch look like something it already held.
	 */
	public deriveItemState(proposals: MatchProposal[], heldLocally: boolean): SyncState {
		const applied = proposals.filter((proposal) => proposal.applied);

		if (applied.length === 0) {
			return heldLocally ? SyncState.LOCAL_ONLY : SyncState.MISSING;
		}

		for (const state of [SyncState.MISSING, SyncState.OUTDATED, SyncState.CONFLICT]) {
			if (applied.some((proposal) => proposal.state === state)) {
				return state;
			}
		}

		return SyncState.IN_SYNC;
	}

	private _toProposal(
		local: MatchCandidate,
		remote: MatchCandidate,
		scored: { strategy: MatchStrategy; confidence: number },
		options: MatchOptions,
	): MatchProposal {
		const state = this.deriveState(local, remote);
		const comparison = this._quality.compare(remote.file, local.file);

		return {
			localItemId: local.id,
			remoteItemId: remote.id,
			remoteServiceId: remote.serviceId,
			remotePeerId: remote.peerId ?? null,
			strategy: scored.strategy,
			confidence: Number(scored.confidence.toFixed(4)),
			state,
			// Only worth a sentence when there is something to do about the pair: the
			// remote copy wins, or the two are different cuts somebody has to choose
			// between. "Nothing to say" is a null the interface renders as nothing.
			reason: this._reason(state, local, remote, comparison.reason),
			applied: scored.confidence >= options.threshold,
		};
	}

	private _reason(
		state: SyncState,
		local: MatchCandidate,
		remote: MatchCandidate,
		qualityReason: string | null,
	): string | null {
		if (state === SyncState.OUTDATED) {
			return qualityReason;
		}

		if (state === SyncState.CONFLICT) {
			return `different cut (${this._minutes(remote.file)} there against ${this._minutes(local.file)} here)`;
		}

		return null;
	}

	private _minutes(file: MediaFileInfo | null): string {
		return `${Math.round((file?.durationMs ?? 0) / 60_000)} min`;
	}

	/**
	 * The veto for a pair no work identifier vouches for.
	 *
	 * Asked only once `WORK_IDENTIFIERS` has had its say, and that is the distinction
	 * the whole correlation rests on. Where an IMDb, TMDB or TVDB number agrees, the two
	 * copies are one work and a different running time makes them two versions of it —
	 * a `CONFLICT`, grouped. Where nothing but a normalised title and a year agree, the
	 * running time is the only evidence left against a false merge: a remake, a
	 * namesake, or a documentary sharing a film's title all look identical from there,
	 * and a copy two hours long against one ninety minutes long may genuinely be two
	 * different films. There it stays a veto, because merging on a guess would put a
	 * stranger's film in the group somebody pulls from.
	 *
	 * The test is the duration and nothing else, because the duration is the only field
	 * on a file that says anything about its content: the same cut encoded twice runs
	 * for the same length whatever its codec, its resolution or its size, while an
	 * extended cut, a different regional master and a copy with the credits trimmed all
	 * differ by minutes. `isConflicting` is that rule, already written, already the one
	 * a `CONFLICT` state is derived from — consulting a second heuristic here would let
	 * the list and the correlation disagree about what two versions are.
	 *
	 * Deliberately narrow in three ways. It is asked after the checksum, so two copies
	 * of the same bytes merge before anything looks at a clock. It is not asked of
	 * episodes, where the season and episode numbers are the identity and a recap or a
	 * double-length finale would split a show that correlates perfectly today. And it
	 * says nothing when either side has no duration — the common case for a node with
	 * no file — because refusing to match on a missing field would ungroup a library
	 * that is simply unscanned.
	 *
	 * The fourth narrowing lives in `isConflicting` rather than here, and is worth
	 * knowing about from this side: its proportional rule is floored at half a minute,
	 * because on a short runtime five percent is a fraction of a second and this veto
	 * would then split a film from itself over a second of padding. It did exactly that
	 * to the only pair of duplicate posters in the owner's catalogue.
	 */
	private _separateCuts(local: MatchCandidate, remote: MatchCandidate): boolean {
		if (local.kind === MediaKind.EPISODE) {
			return false;
		}

		return this._quality.isConflicting(local.file, remote.file);
	}

	private _checksumMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const localChecksum = local.file?.checksum;
		const remoteChecksum = remote.file?.checksum;

		if (localChecksum && remoteChecksum && localChecksum === remoteChecksum) {
			return { strategy: MatchStrategy.CHECKSUM, confidence: CONFIDENCE.checksum };
		}

		// The content identifier is the cheap cousin: derived from sampled ranges and
		// the exact size, computed identically on both gateways without talking to each
		// other. It is not proof the way a full hash is, but a collision needs two
		// files of the same byte count agreeing on three sampled windows.
		const localContent = local.file?.contentId;
		const remoteContent = remote.file?.contentId;

		if (localContent && remoteContent && localContent === remoteContent) {
			return { strategy: MatchStrategy.CHECKSUM, confidence: CONFIDENCE.checksum };
		}

		return null;
	}

	private _externalIdMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
		providers: readonly (keyof ExternalIds)[],
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		const agreed = providers.some((provider) => {
			const left = identifierValue(local.externalIds, provider);

			return left !== null && left === identifierValue(remote.externalIds, provider);
		});

		if (!agreed) {
			return null;
		}

		if (local.kind !== MediaKind.EPISODE) {
			return { strategy: MatchStrategy.EXTERNAL_ID, confidence: CONFIDENCE.externalId };
		}

		/*
		 * An identifier that names *this* episode settles it, numbering and all.
		 *
		 * This is the one case where a number check would be wrong rather than merely
		 * cautious: a show published as one continuous run says `E153` where the same
		 * show cut into seasons says `S06E12`, and both copies carry the same episode
		 * identifier. Refusing that pair because the numbers differ is what made the
		 * gateway call missing what somebody already owned.
		 *
		 * It is allowed only for an identifier that was shown to be the episode's own —
		 * one no sibling under the same series on the same service carries. The
		 * alternative, trusting `tvdb` because it is called `tvdb`, merges episode 3 with
		 * episode 47 on the very many libraries that stamp the show's number onto every
		 * episode of it, at full confidence and with nothing on screen to unpick it.
		 */
		if (this._agreesOnAnEpisodeIdentifier(local, remote, providers, options)) {
			return { strategy: MatchStrategy.EXTERNAL_ID, confidence: CONFIDENCE.externalId };
		}

		// Otherwise the identifier may well be the series', which would make every
		// episode of a show match every other. When both sides number themselves, the
		// numbers have to agree.
		const known =
			local.seasonNumber !== null &&
			remote.seasonNumber !== null &&
			local.episodeNumber !== null &&
			remote.episodeNumber !== null;

		if (!known) {
			return {
				strategy: MatchStrategy.EXTERNAL_ID,
				confidence: CONFIDENCE.externalIdPartial,
			};
		}

		if (
			local.seasonNumber !== remote.seasonNumber ||
			local.episodeNumber !== remote.episodeNumber
		) {
			return null;
		}

		return { strategy: MatchStrategy.EXTERNAL_ID, confidence: CONFIDENCE.externalId };
	}

	/**
	 * Whether an identifier both sides agree on is one that names the episode on both.
	 *
	 * Both, and not either. An identifier that is distinctive here and shared by four
	 * hundred rows there is the show's number on that server, and believing it because
	 * our side happened to be tidy would merge our episode 3 with whichever of their
	 * four hundred rows the candidate lookup handed over first.
	 */
	private _agreesOnAnEpisodeIdentifier(
		local: MatchCandidate,
		remote: MatchCandidate,
		providers: readonly (keyof ExternalIds)[],
		options: MatchOptions,
	): boolean {
		const localKeys = options.episodeIdentifiers?.get(local.id);
		const remoteKeys = options.episodeIdentifiers?.get(remote.id);

		if (localKeys === undefined || remoteKeys === undefined) {
			return false;
		}

		return providers.some((provider) => {
			const value = identifierValue(local.externalIds, provider);

			if (value === null || value !== identifierValue(remote.externalIds, provider)) {
				return false;
			}

			const key = `${provider}:${value}`;

			return localKeys.has(key) && remoteKeys.has(key);
		});
	}

	/**
	 * One side numbers the show straight through, the other cuts it into seasons.
	 *
	 * Everything that makes this safe happened before the call: `alignAbsoluteNumbering`
	 * has the season lengths of both copies in hand, and only pairs episodes once the
	 * two sides are shown to use different conventions and to account for the same show
	 * end to end. All that is left here is to refuse the pair when the two copies carry
	 * episode identifiers that contradict each other, which is the one piece of evidence
	 * the alignment cannot see: it works on numbers, and a pair of numbers can line up
	 * perfectly while two identifiers say these are different episodes.
	 *
	 * Only identifiers proved to be the episodes' own can veto. A series identifier
	 * stamped on every row differs between two servers that scraped from two providers,
	 * and letting that count as a contradiction would switch the whole feature off on
	 * exactly the libraries that need it.
	 */
	private _absoluteEpisodeMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		if (local.kind !== MediaKind.EPISODE) {
			return null;
		}

		if (!options.absolutePairs?.get(local.id)?.has(remote.id)) {
			return null;
		}

		const localKeys = options.episodeIdentifiers?.get(local.id);
		const remoteKeys = options.episodeIdentifiers?.get(remote.id);
		const contradicted =
			localKeys !== undefined &&
			remoteKeys !== undefined &&
			WORK_IDENTIFIERS.some((provider) => {
				const left = identifierValue(local.externalIds, provider);
				const right = identifierValue(remote.externalIds, provider);

				return (
					left !== null &&
					right !== null &&
					left !== right &&
					localKeys.has(`${provider}:${left}`) &&
					remoteKeys.has(`${provider}:${right}`)
				);
			});

		return contradicted
			? null
			: { strategy: MatchStrategy.ABSOLUTE_EPISODE, confidence: CONFIDENCE.absoluteEpisode };
	}

	private _seasonEpisodeMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
		options: MatchOptions,
	): { strategy: MatchStrategy; confidence: number } | null {
		if (local.kind !== MediaKind.EPISODE && local.kind !== MediaKind.SEASON) {
			return null;
		}

		if (local.seasonNumber === null || local.seasonNumber !== remote.seasonNumber) {
			return null;
		}

		if (local.kind === MediaKind.EPISODE && local.episodeNumber !== remote.episodeNumber) {
			return null;
		}

		if (local.kind === MediaKind.EPISODE && local.episodeNumber === null) {
			return null;
		}

		// Without a matched parent these numbers say nothing: every library has an
		// `S01E02`, and matching on it alone would correlate the second episode of
		// every series with the second episode of every other.
		const remoteParents = local.parentId
			? options.parentMatches?.get(local.parentId)
			: undefined;

		if (!remote.parentId || !remoteParents?.has(remote.parentId)) {
			return null;
		}

		return { strategy: MatchStrategy.SEASON_EPISODE, confidence: CONFIDENCE.seasonEpisode };
	}

	private _titleMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const score = similarity(local.normalizedTitle, remote.normalizedTitle);

		if (score < TITLE_FLOOR) {
			return null;
		}

		// Episodes are not matched on their titles alone: half a library has none, and
		// the ones that do repeat `Pilot` and `Part One` across every series there is.
		if (local.kind === MediaKind.EPISODE) {
			if (
				local.seasonNumber === null ||
				local.episodeNumber === null ||
				local.seasonNumber !== remote.seasonNumber ||
				local.episodeNumber !== remote.episodeNumber
			) {
				return null;
			}
		}

		let confidence = Math.min(score, TITLE_CEILING);

		if (local.year !== null && remote.year !== null) {
			if (local.year === remote.year) {
				confidence = Math.min(confidence + 0.05, TITLE_CEILING);
			} else if (Math.abs(local.year - remote.year) <= 1) {
				// One year apart is a release-date disagreement between two metadata
				// agents — a festival date against a cinema date — and it happens
				// constantly. It costs a little confidence, not the match.
				confidence -= 0.1;
			} else {
				// The same title several years apart is a remake, and pulling the 2010
				// version over the 1978 one because they share a name is exactly the
				// kind of wrong a person never forgives.
				confidence -= 0.4;
			}
		}

		if (confidence <= 0) {
			return null;
		}

		return { strategy: MatchStrategy.NORMALIZED_TITLE, confidence };
	}

	private _pathMatch(
		local: MatchCandidate,
		remote: MatchCandidate,
	): { strategy: MatchStrategy; confidence: number } | null {
		const localPath = local.file?.path;
		const remotePath = remote.file?.path;

		if (!localPath || !remotePath) {
			return null;
		}

		if (localPath === remotePath) {
			return { strategy: MatchStrategy.PATH, confidence: CONFIDENCE.pathExact };
		}

		const localName = this._basename(localPath);
		const remoteName = this._basename(remotePath);

		// A basename of `movie.mkv` or `01.mkv` matches half the internet. Requiring
		// some length is a blunt guard and a sufficient one: real release names are
		// long, and the two files that collide under this rule were named by the same
		// careless hand anyway.
		if (localName === remoteName && localName.length >= 12) {
			return { strategy: MatchStrategy.PATH, confidence: CONFIDENCE.pathBasename };
		}

		return null;
	}

	private _basename(path: string): string {
		const cut = path.replace(/\\/g, '/');
		const index = cut.lastIndexOf('/');

		return (index === -1 ? cut : cut.slice(index + 1)).toLowerCase();
	}
}
