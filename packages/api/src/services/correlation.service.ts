import {
	MatchStrategy,
	MediaKind,
	MediaServiceMode,
	SyncState,
} from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, MediaMatch as MediaMatchEntity } from '@/entities';
import {
	type MatchPair,
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { breathe } from './breathe';
import { alignAbsoluteNumbering, episodeIdentifierKeys } from './episode-numbering';
import { landingSyncState } from './landing-state';
import {
	identifierValue,
	MatchingService,
	WORK_IDENTIFIERS,
	type MatchCandidate,
	type MatchProposal,
} from './matching.service';
import { serviceMode } from './service-mode';
import { contentKeys, sameContent } from './version';

/**
 * How many rows a correlation reads per statement. See `_wholeCatalogue`.
 *
 * Two thousand: large enough that a catalogue is thirty statements rather than thousands,
 * small enough that one of them is a few tens of milliseconds and not a wall.
 */
const CATALOGUE_PAGE = 2000;

/**
 * How far down a media tree each kind sits, so a pass can take parents first.
 *
 * Only the order matters, not the numbers. A collection is above a film the way a
 * series is above a season, and anything this does not name is scored last — it has no
 * children waiting on it.
 */
const DEPTH_OF: Record<MediaKind, number> = {
	[MediaKind.COLLECTION]: 0,
	[MediaKind.SERIES]: 1,
	[MediaKind.SEASON]: 2,
	[MediaKind.MOVIE]: 3,
	[MediaKind.EPISODE]: 3,
};

/** Everything a correlation pass needs, read once rather than per item. */
interface CorrelationContext {
	threshold: number;
	peers: Map<string, string | null>;
	/** Services whose libraries the gateway can write into. */
	local: Set<string>;
	everything: MediaItemEntity[];
	byContent: Map<string, MediaItemEntity[]>;
	/** Films and series by work identifier; see `_indexByWork`. */
	byWork: Map<string, MediaItemEntity[]>;
	/** Every row by identifier, so a pair worked out elsewhere can be scored. */
	byId: Map<string, MediaItemEntity>;
	/**
	 * The identifiers that name one episode rather than the show it belongs to.
	 *
	 * Worked out per service and per series, because that is the only scope where the
	 * count means anything — see `episodeIdentifierKeys`. It is what lets an identifier
	 * pair `E153` with `S06E12`, and what stops the same rule merging episode 3 with
	 * episode 47 on a library that stamps the show's number onto all four hundred rows.
	 */
	episodeIdentifiers: Map<string, Set<string>>;
	/**
	 * Episodes related across two numbering conventions, both ways round.
	 *
	 * Built once per pass rather than per item, and it has to be: the conversion needs
	 * every episode of both copies of the series in hand at once — the season lengths,
	 * the holes, the totals — and correlation scores one pair at a time. Anything
	 * derived per pair would be a formula, which is exactly what must not decide this.
	 */
	absolutePairs: Map<string, Set<string>>;
	/**
	 * Items whose file the gateway has already put on the disk, and the state that
	 * makes. Read once per pass rather than per item — the table holds one row per
	 * download nobody has indexed yet, which is tens, and a query per item would be
	 * tens of thousands of them to answer a question that is almost always "no".
	 */
	landed: Map<string, SyncState>;
	/**
	 * Every match row already on record, by each of the two items it joins.
	 *
	 * Read once per pass, for the same reason `landed` is: a pass over a real
	 * catalogue is thousands of items, and asking the match table twice per item to
	 * answer a question about a few hundred rows is thousands of queries for nothing.
	 *
	 * It is a snapshot taken before the pass writes anything, and only ever used to
	 * decide about rows that existed when it was taken — which claim a person settled,
	 * and which pair the identifiers now contradict. Nothing here is read back as the
	 * current state of a row this pass has since rewritten.
	 */
	settled: Map<string, MediaMatchEntity[]>;
	/**
	 * Which remote rows each local row is already matched to, parents included.
	 *
	 * The map `MatchingService._seasonEpisodeMatch` asks for, and it was never built —
	 * the option existed, the strategy read it, and no caller ever passed one. So the
	 * check `remoteParents?.has(remote.parentId)` was always false and **the whole
	 * season/episode strategy never once fired**, on any library. Episodes correlated by
	 * identifier, by checksum, by path — never by their place in a show.
	 *
	 * What that cost: a source that enumerates a series by season and episode without
	 * carrying an identifier per episode — which is what a request source is — could
	 * never be joined to the copies on a shelf. Every one of its episodes stayed its own
	 * row, counted as a gap, and a complete series read as a wall of missing ones.
	 *
	 * Grown during the pass as well as read from the record, because a series and its
	 * episodes are correlated in the same one: the strategy needs the parent's pairing to
	 * exist by the time the child is scored, and on a service seen for the first time it
	 * is this pass that creates it. See the ordering in `correlate`.
	 */
	parentMatches: Map<string, Set<string>>;
	/** Every row by the parent it hangs from — see `_underMatchedParentOf`. */
	byParent: Map<string, MediaItemEntity[]>;
}

/**
 * How far a pass has got, for whoever is watching rather than awaiting.
 *
 * A callback rather than an event, because this class has no event gateway and must not
 * acquire one: a worker thread has no sockets, and the whole point of the shape is that
 * the same class runs in both halves. Who turns this into something a browser can see is
 * the caller's business — see `jobs.worker.ts`, which posts it to the gateway.
 */
export type WalkProgress = (done: number, total: number) => void;

/** A person's decision about a pair, which no later pass is allowed to overturn. */
const decidedByHand = (match: MediaMatchEntity): boolean =>
	match.strategy === MatchStrategy.MANUAL || match.confirmedAt !== null;

/**
 * How far below a series the walk that collects its episodes goes.
 *
 * Three is series, season, episode with one level spare. Bounded rather than
 * unbounded because a parent chain that loops — which nothing stops a media server
 * from reporting — would otherwise hang the correlation pass instead of failing
 * somewhere a stack trace could name.
 */
const SUBTREE_DEPTH = 3;

/**
 * The correlation pass, and nothing else.
 *
 * It was twenty-five methods inside `MediaManager`, tangled with browsing, artwork,
 * episode discovery and filing — and that is why it could not be moved off this thread.
 * `better-sqlite3` is synchronous: a pass over sixty thousand rows does not slow the
 * gateway, it *stops* it, and the only cure is to run it somewhere else. A worker thread
 * has no Nest container in it and cannot have one, so the code it runs has to be
 * constructible with `new` from a database connection and nothing more.
 *
 * Which is the whole of the design here. Five dependencies, every one of them either a
 * repository built from a `DataSource` or a pure comparator: the gateway gets this class
 * from its container and the worker builds the same class by hand, and both run the same
 * pass. There is no second implementation to keep in step — the lesson of the three
 * placement repairs that changed nothing, where the prediction and the decision were two
 * pieces of code answering one question.
 *
 * The threshold is a parameter rather than a setting read in here, and that is part of
 * the same rule. Reading it would mean a dependency on `SettingsService`, which needs the
 * cache and the Nest config — none of which a worker has. Who decides the threshold is
 * the gateway's business; applying it is this class's.
 */
@Injectable()
export class CorrelationService {
	private readonly _logger = new Logger(CorrelationService.name);

	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		/**
		 * What the gateway put on the disk and no media server has indexed yet.
		 *
		 * Read here because this is the one place an item's state is written, and it
		 * writes it from scratch every pass. Without this the very first scan after a
		 * download would recompute `missing` over a file sitting in the library folder —
		 * the bug, restored on a timer, and harder to see the second time because
		 * something had briefly shown the right answer.
		 */
		private readonly _landings: MediaLandingRepository,
		private readonly _matching: MatchingService,
	) {}

	/**
	 * Correlate everything one service holds against every other service.
	 *
	 * Candidates come from two places, and both are needed. The normalised title plus
	 * the episode coordinates narrow tens of thousands of rows to a handful, which is
	 * the only thing that makes correlation finish at all — comparing everything with
	 * everything is quadratic. But that lookup is blind to exactly the case that
	 * matters most: two libraries holding the same bytes under names and numbers that
	 * do not agree. So the content identity is indexed too, and an item is compared
	 * with whatever shares its fingerprint whether or not the titles could ever have
	 * met.
	 */
	public async correlate(
		serviceId: string,
		threshold: number,
		onProgress?: WalkProgress,
	): Promise<number> {
		const services = await this._services.find();
		const peers = new Map(services.map((service) => [service.id, service.peerId]));
		const local = new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
		/*
		 * Only the columns this pass reads — see `findForCorrelation`. The whole table is
		 * held in memory here, with six indexes over it, so the three columns nothing in
		 * correlation touches were most of what a scan cost on a catalogue of sixty
		 * thousand rows.
		 */
		const everything = await this._wholeCatalogue();

		/*
		 * A breath between each index. They are synchronous walks of the whole catalogue —
		 * six of them, back to back — and together they are seconds in which nothing else
		 * on this thread can happen. One of them is short; the run of them is not.
		 */
		const byContent = this._indexByContent(everything);

		await breathe(0);

		const byWork = this._indexByWork(everything);

		await breathe(0);
		const landed = new Map(
			(await this._landings.findOpen()).map((landing) => [
				landing.itemId,
				landingSyncState(landing.state),
			]),
		);
		const settled = this._indexMatches(await this._matches.find());
		const parentMatches = CorrelationService._adjacency(
			await this._matches.findAppliedPairs(threshold),
		);
		const byId = new Map(everything.map((item) => [item.id, item]));
		const byParent = this._indexByParent(everything);

		await breathe(0);

		const episodesOfSeries = this._episodesBySeries(everything, byParent);
		const episodeIdentifiers = this._episodeIdentifiers(episodesOfSeries);

		await breathe(0);
		const absolutePairs = this._absolutePairs(
			everything,
			episodesOfSeries,
			{ threshold, peers, byWork },
		);
		const context = {
			threshold,
			peers,
			local,
			everything,
			byContent,
			byWork,
			byId,
			episodeIdentifiers,
			absolutePairs,
			landed,
			settled,
			parentMatches,
			byParent,
		};

		/*
		 * Parents before their children, which is new and is what makes the season and
		 * episode strategy usable on a service seen for the first time. That strategy is
		 * gated on the parent already being paired; correlated in the order the database
		 * happened to return, an episode was routinely scored before its own series had
		 * been, and the gate shut on a pairing this very pass was about to create.
		 */
		const mine = everything
			.filter((item) => item.serviceId === serviceId)
			// `sort` and not `toSorted`: the target this builds for does not declare the
			// latter, and `filter` above has already produced an array of our own.
			.sort((left, right) => DEPTH_OF[left.kind as MediaKind] - DEPTH_OF[right.kind as MediaKind]);
		const touched = new Set<string>();
		let written = 0;

		let walked = 0;

		for (const item of mine) {
			written += await this._correlateItem(item, context, touched);
			walked += 1;

			onProgress?.(walked, mine.length);

			// Correlation is the longest pass of a scan and it was the one with no yield
			// in it: the walk handed the loop back and this did not, so a scan stopped
			// blocking for twenty minutes and started blocking in bursts of ten seconds.
			await breathe(walked);
		}

		/*
		 * The other side of every pair, refreshed in the same pass.
		 *
		 * A match is symmetric and a state is not: scanning one service tells us
		 * something about items on the others, and leaving those alone means the
		 * answer depends on the order the services happened to be scanned in. Measured
		 * against the lab: both servers scanned seconds apart, and the first one
		 * correlated against an index the second had not filled yet — so every one of
		 * its episodes stayed `local_only` while the second one knew about all of
		 * them.
		 *
		 * Their counterparts are not re-collected: one extra pass settles the pairs
		 * this scan created, and going further would be a walk of the whole index
		 * dressed up as an incremental update.
		 */
		const counterparts = everything.filter(
			(item) => item.serviceId !== serviceId && touched.has(item.id),
		);

		let refreshed = 0;

		for (const item of counterparts) {
			await this._correlateItem(item, context, null);
			refreshed += 1;

			await breathe(refreshed);
		}

		return written;
	}

	/**
	 * Every row a correlation needs, read a page at a time.
	 *
	 * One `find` over a catalogue is a single uninterruptible call: TypeORM hydrates tens
	 * of thousands of entities in one go and the server answers nothing for as long as it
	 * lasts — fifteen to twenty-five seconds on a real household, measured. No amount of
	 * yielding around it helps, because there is no "around": it is one call.
	 *
	 * Pages fix that without moving anything off this thread. Each page is a call short
	 * enough to sit between two turns of the event loop, and a breath between them is
	 * where every waiting request gets served. The rows are ordered by id so the pages
	 * tile the table exactly once.
	 */
	private async _wholeCatalogue(): Promise<MediaItemEntity[]> {
		const everything: MediaItemEntity[] = [];

		for (let page = 0; ; page += 1) {
			const rows = await this._items.findForCorrelation(page * CATALOGUE_PAGE, CATALOGUE_PAGE);

			everything.push(...rows);

			if (rows.length < CATALOGUE_PAGE) {
				return everything;
			}

			await breathe(0);
		}
	}

	/**
	 * The rows sitting under a parent this one's parent is already matched to.
	 *
	 * The discovery that was missing, and without it the season-and-episode strategy was
	 * never even consulted: a row has to be *offered* as a candidate before anything can
	 * score it, and the only offer a season or an episode of a request source gets is the
	 * title lookup — it has no file to be found by content and no identifier of its own.
	 *
	 * That lookup compares normalised titles for equality, and the two sides disagree for
	 * an ordinary reason: the provider calls a show "Marvel's Runaways" and the library
	 * calls it "Runaways". The *series* does not care, because it matches on an identifier
	 * both sides carry. Its seasons have none, so they were never put in front of each
	 * other, and a series held in full came out with every season duplicated and counted
	 * missing.
	 *
	 * So when the parent is already paired, its children are the candidates. That is the
	 * same statement the strategy itself makes — "without a matched parent these numbers
	 * say nothing" — applied one step earlier, to deciding who is worth comparing at all.
	 * The numbers then settle it, which is the whole point: a name decides nothing here.
	 */
	private _underMatchedParentOf(
		item: MediaItemEntity,
		context: CorrelationContext,
	): MediaItemEntity[] {
		if (item.parentId === null) {
			return [];
		}

		const siblings: MediaItemEntity[] = [];

		for (const parentId of context.parentMatches.get(item.parentId) ?? []) {
			for (const child of context.byParent.get(parentId) ?? []) {
				/*
				 * The coordinate has to line up, and leaving that out was a real regression:
				 * every season of a show carries the *show's* normalised title, so offering
				 * season one the other seasons as candidates let the title strategy pair all
				 * three into a single season. The title lookup this stands beside has always
				 * constrained the numbers — `findCandidatesForMatch` takes them as
				 * arguments — and this has to as well.
				 *
				 * Null never lines up with anything here. A row with no coordinate is exactly
				 * the one these numbers cannot speak for.
				 */
				const aligned =
					child.seasonNumber !== null
					&& child.seasonNumber === item.seasonNumber
					&& child.episodeNumber === item.episodeNumber;

				// Another service's, always: a row is never a candidate for itself, and two
				// rows of one library are two different media by construction.
				if (aligned && child.serviceId !== item.serviceId && child.kind === item.kind) {
					siblings.push(child);
				}
			}
		}

		return siblings;
	}

	/**
	 * One item against everything else the gateway knows about.
	 *
	 * `touched` collects the far side of each proposal so the caller can settle those
	 * items too; passing null means this call is that settling pass and must not grow
	 * the set.
	 */
	private async _correlateItem(
		item: MediaItemEntity,
		context: CorrelationContext,
		touched: Set<string> | null,
	): Promise<number> {
		const byTitle = await this._items.findCandidatesForMatch(
			item.normalizedTitle,
			item.seasonNumber,
			item.episodeNumber,
			item.serviceId,
		);

		const candidates = new Map<string, MediaItemEntity>();

		for (const candidate of [
			...byTitle,
			...this._sameContentAs(item, context.byContent),
			...this._sameWorkAs(item, context.byWork),
			...this._alignedWith(item, context),
			...this._underMatchedParentOf(item, context),
		]) {
			/*
			 * Every row but this one, its own service included.
			 *
			 * The second of two refusals — the first was in `MatchingService.correlate` —
			 * and lifting only that one changed nothing, because a candidate dropped here
			 * is never scored at all. A household with two cuts of a show on one Jellyfin
			 * had them as two unrelated series through both.
			 */
			if (candidate.id !== item.id) {
				candidates.set(candidate.id, candidate);
			}
		}

		const proposals = this._matching
			.correlate(
				this._candidate(item, context.peers),
				[...candidates.values()].map((candidate) => this._candidate(candidate, context.peers)),
				{
					threshold: context.threshold,
					episodeIdentifiers: context.episodeIdentifiers,
					absolutePairs: context.absolutePairs,
					parentMatches: context.parentMatches,
				},
			)
			.map((proposal) =>
				this._overruleMislabelled(item, candidates.get(proposal.remoteItemId), proposal),
			)
			.map((proposal) => this._respectHumanDecision(item, proposal, context));

		let written = 0;

		for (const proposal of proposals) {
			await this._matches.upsertPair(proposal);
			touched?.add(proposal.remoteItemId);

			// Recorded as it is written, so the episodes scored after this one can see the
			// pairing their own gate depends on. Only applied pairs count: a proposal
			// nobody agreed to must not let four hundred episodes through behind it.
			if (proposal.applied) {
				CorrelationService._link(context.parentMatches, item.id, proposal.remoteItemId);
				CorrelationService._link(context.parentMatches, proposal.remoteItemId, item.id);
			}
			written += 1;
		}

		await this._revokeContradicted(item, context);

		const state = this._landed(
			item,
			this._matching.deriveItemState(proposals, context.local.has(item.serviceId)),
			context,
		);

		if (state !== item.syncState) {
			await this._items.setSyncState([item.id], state);
		}

		return written;
	}

	/**
	 * Two files that are the same bytes under labels that disagree.
	 *
	 * This is neither a match to apply nor a pair to call unrelated. The content is
	 * proof they are the same file; the numbers are proof that one of the two libraries
	 * has it filed wrong, or that two files were swapped. Applying the match silently
	 * would renumber somebody's library on the strength of a guess about which side is
	 * right, and dropping the pair would have the gateway offer to fetch a file it
	 * already holds. So it becomes a conflict carrying the disagreement in words, and a
	 * person decides.
	 *
	 * The reverse — the same numbers over different content — is an ordinary
	 * comparison and goes through the quality comparator like anything else.
	 */
	public labelDisagreement(local: MediaItemEntity, remote: MediaItemEntity): string | null {
		if (!sameContent(local.file, remote.file)) {
			return null;
		}

		if (local.episodeNumber !== remote.episodeNumber) {
			return `content identical, episode numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		if (local.seasonNumber !== remote.seasonNumber) {
			return `content identical, season numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		return null;
	}
	/**
	 * The state a media gets when its bytes are already here and the server is not.
	 *
	 * Applied only over `missing`, and that narrowness is the point. `missing` is the
	 * only derived state the landing contradicts: it means nothing local holds this,
	 * and a file we moved into a library folder an hour ago makes that false. Every
	 * other state — outdated, conflict, in sync — was reached by comparing real copies
	 * and knows more than a landing does; overwriting one of them would replace a fact
	 * with a note about a download.
	 */
	private _landed(
		item: MediaItemEntity,
		derived: SyncState,
		context: CorrelationContext,
	): SyncState {
		// A copy on one of our own services is already held and already says something
		// true about a file that plays; a pull from one of our servers into another is
		// ordinary, and painting its source "waiting for an index" would take a good
		// state off a good copy. `LandingManager` draws the same line, for the same
		// reason, when it writes the state at the moment the file lands.
		if (derived !== SyncState.MISSING || context.local.has(item.serviceId)) {
			return derived;
		}

		return context.landed.get(item.id) ?? derived;
	}

	/**
	 * Turn a scored proposal into a conflict when the labels contradict the bytes.
	 *
	 * The proposal is rewritten rather than dropped so the row still exists: the pair
	 * has to be visible somewhere for anybody to arbitrate it, and a correlation the
	 * gateway silently refused to record is one nobody can act on.
	 */
	private _overruleMislabelled(
		local: MediaItemEntity,
		remote: MediaItemEntity | undefined,
		proposal: MatchProposal,
	): MatchProposal {
		const disagreement = remote === undefined ? null : this.labelDisagreement(local, remote);

		if (disagreement === null) {
			return proposal;
		}

		this._logger.warn(`${local.title}: ${disagreement}`);

		return { ...proposal, state: SyncState.CONFLICT, reason: disagreement };
	}

	/** Every match row filed under both of the items it joins, for lookup by either. */
	/**
	 * Who is matched to whom, both ways round, from the pairs already applied.
	 *
	 * Applied only. A proposal is a question nobody has answered, and letting one gate
	 * the season/episode strategy would mean a doubtful series pairing quietly admitting
	 * four hundred episodes behind it — the same reason `_absolutePairs` reads applied
	 * rows and not proposals.
	 */
	private static _adjacency(matches: MatchPair[]): Map<string, Set<string>> {
		const pairs = new Map<string, Set<string>>();

		for (const match of matches) {
			CorrelationService._link(pairs, match.localItemId, match.remoteItemId);
			CorrelationService._link(pairs, match.remoteItemId, match.localItemId);
		}

		return pairs;
	}

	private _indexMatches(matches: MediaMatchEntity[]): Map<string, MediaMatchEntity[]> {
		const index = new Map<string, MediaMatchEntity[]>();

		for (const match of matches) {
			for (const side of [match.localItemId, match.remoteItemId]) {
				if (side !== null) {
					index.set(side, [...(index.get(side) ?? []), match]);
				}
			}
		}

		return index;
	}

	/** The row already on record for this exact pair, in whichever direction it was written. */
	private _recorded(
		itemId: string,
		otherId: string,
		context: CorrelationContext,
	): MediaMatchEntity | undefined {
		return context.settled
			.get(itemId)
			?.find(
				(match) =>
					(match.localItemId === itemId && match.remoteItemId === otherId) ||
					(match.localItemId === otherId && match.remoteItemId === itemId),
			);
	}

	/**
	 * A pair somebody settled keeps what they said about it.
	 *
	 * The two halves of a match row answer two different questions and only one of them
	 * belongs to a person. *Are these the same media* is `strategy` and `confidence`:
	 * confirming a proposal is precisely the act of overruling the score, and a later
	 * pass that recomputed it would undo the confirmation the next time a scan ran —
	 * silently, because nothing on the screen would say the machine had changed its
	 * mind back. *What is the state of the two copies* is `state` and `reason`, and
	 * that is nobody's opinion: a remote copy re-encoded in 2160p is newer than ours
	 * whoever confirmed the pair, and freezing it would leave a confirmed match
	 * reporting a quality comparison from the day it was confirmed.
	 *
	 * So the human half is restored onto the fresh proposal and the measured half is
	 * let through. Dropping the proposal entirely was the other option and is worse for
	 * exactly that reason: it would have been the shorter code and would have frozen
	 * the sync state of every confirmed pair on the gateway.
	 *
	 * A decision is a person's when the strategy is `MANUAL` or `confirmedAt` is set.
	 * Both are tested rather than either: `confirmMatch` writes the two together, but a
	 * row detached and re-pointed by hand carries the confirmation without the strategy
	 * ever having been rewritten, and reading only the strategy would lose it.
	 */
	private _respectHumanDecision(
		item: MediaItemEntity,
		proposal: MatchProposal,
		context: CorrelationContext,
	): MatchProposal {
		const recorded = this._recorded(item.id, proposal.remoteItemId, context);

		if (recorded === undefined || !decidedByHand(recorded)) {
			return proposal;
		}

		return {
			...proposal,
			strategy: recorded.strategy,
			confidence: recorded.confidence,
			applied: recorded.confidence >= context.threshold || recorded.confirmedAt !== null,
		};
	}

	/**
	 * Unpick the matches this item's identifiers now contradict.
	 *
	 * Reading Plex's `Guid` list only ever helps the pairs correlated *after* the
	 * reading. Everything already on the gateway was decided when a Plex item carried
	 * nothing but its own row key, which meant every Plex-to-Jellyfin pair was decided
	 * on the title — the one strategy that can be confidently wrong. Leaving those rows
	 * alone would have the feature change nothing at all on a catalogue that already
	 * exists, and would leave the wrong ones applied for good.
	 *
	 * So each pass asks the question the other way round: of the pairs already on
	 * record for this item, which ones do the identifiers now say are two different
	 * works? Those are deleted rather than downgraded — a match nothing vouches for is
	 * not a weaker match, it is not a match — and a deleted row is re-proposed by the
	 * very next pass if the evidence ever comes back, which is what makes this safe to
	 * run twice.
	 *
	 * It also drops a pair that nothing supports any anymore, which is not the same
	 * question: two rows can agree on every identifier they carry and still be the same
	 * *series* rather than the same episode. A rule that stops firing has to take its
	 * old rows with it, or a correction ships and changes nothing on exactly the
	 * catalogue that needed it. Only a score of null counts — a pair the rules still
	 * vouch for at any confidence is a pair, and weakening it is the review's business.
	 *
	 * Three things it deliberately does not do. It never revokes a pair where only one
	 * side carries an identifier: the ordinary house has one library that scrapes and
	 * one that does not, and absence is not disagreement — see
	 * `MatchingService.contradicted`. It never touches a decision somebody made by
	 * hand. And it works from the whole match table rather than from the candidates
	 * this pass happened to look at, because a pair whose two titles no longer meet in
	 * the title index would otherwise never be re-examined by anybody.
	 */
	/** Whether the rules, as they stand now, link these two at all. */
	private _scoresNothing(
		mine: MatchCandidate,
		theirs: MatchCandidate,
		context: CorrelationContext,
	): boolean {
		return this._matching.score(mine, theirs, {
			threshold: context.threshold,
			episodeIdentifiers: context.episodeIdentifiers,
			absolutePairs: context.absolutePairs,
		}) === null;
	}

	private async _revokeContradicted(
		item: MediaItemEntity,
		context: CorrelationContext,
	): Promise<void> {
		const recorded = context.settled.get(item.id);

		// The overwhelming majority of a catalogue takes part in no match at all, and
		// this runs once per item on every pass: leaving before the candidate shape is
		// built keeps the whole thing off the hot path.
		if (recorded === undefined) {
			return;
		}

		const mine = this._candidate(item, context.peers);

		for (const match of recorded) {
			const otherId = match.localItemId === item.id ? match.remoteItemId : match.localItemId;
			// The pass's own index, never a fresh one built here: this runs once per item
			// and a map rebuilt from every row each time would turn a walk of a
			// thirty-thousand-item catalogue into a quadratic one.
			const other = otherId === null ? undefined : context.byId.get(otherId);

			if (other === undefined || decidedByHand(match)) {
				continue;
			}

			const theirs = this._candidate(other, context.peers);

			if (this._matching.contradicted(mine, theirs)) {
				this._logger.warn(
					`${item.title}: dropping a match with ${other.title}, their identifiers name two different works`,
				);
			} else if (this._scoresNothing(mine, theirs, context)) {
				/*
				 * Not contradicted, and no longer supported by anything either.
				 *
				 * A rule that stops firing has to take its old rows with it, or a
				 * correction ships and changes nothing on the catalogue that needed it. The
				 * case that forced this: an episode used to be matched on an identifier
				 * shared with every other episode of its show, which is now refused — but
				 * the two sides still name the same *series*, so nothing contradicts them
				 * and the check above kept every wrong pair. A whole show read as held, a
				 * re-scan said the same thing, and the only way out was emptying the
				 * database.
				 *
				 * Only a score of null, never a low one. A pair the rules still vouch for
				 * at any confidence is a pair, and downgrading it is the review's business
				 * rather than this pass's; a deleted row is re-proposed by the very next
				 * pass if the evidence comes back, which is what makes it safe to run
				 * twice.
				 */
				this._logger.warn(
					`${item.title}: dropping a match with ${other.title}, nothing supports it any more`,
				);
			} else {
				continue;
			}

			await this._matches.delete({ id: match.id });
			// Struck off the snapshot as well as the table. A pass settles both halves of
			// every pair it touched, so the far side reaches this loop with the same row
			// still in hand, and without this it would delete an identifier that no longer
			// exists and log the same sentence about the same pair a second time.
			CorrelationService._forget(context.settled, match);
		}
	}

	/** Drop one match row from both of the sides the snapshot filed it under. */
	private static _forget(
		settled: Map<string, MediaMatchEntity[]>,
		match: MediaMatchEntity,
	): void {
		for (const side of [match.localItemId, match.remoteItemId]) {
			const rows = side === null ? undefined : settled.get(side);

			if (side !== null && rows !== undefined) {
				settled.set(side, rows.filter((row) => row.id !== match.id));
			}
		}
	}

	/**
	 * Every item by the parent it hangs from, so a subtree can be walked in memory.
	 *
	 * Built once per pass because the alternative is a query per series, and the
	 * question — "which episodes are under this show" — is asked of every series the
	 * gateway holds.
	 */
	private _indexByParent(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			if (item.parentId !== null) {
				index.set(item.parentId, [...(index.get(item.parentId) ?? []), item]);
			}
		}

		return index;
	}

	/**
	 * The episodes under each series, however deep the service files them.
	 *
	 * Walked down from the series rather than up from each episode, because the depth
	 * is not fixed: most servers put a season between the two and some report episodes
	 * directly under the show. The descent is bounded because a parent chain that loops
	 * — two rows naming each other, which a service has no reason not to report — would
	 * otherwise spin here rather than fail somewhere a stack trace could name it.
	 *
	 * A group is one series on one service by construction, since a row's children are
	 * rows of the same service. That matters: it is the scope the identifier count in
	 * `episodeIdentifierKeys` has to be taken in.
	 */
	private _episodesBySeries(
		items: MediaItemEntity[],
		byParent: Map<string, MediaItemEntity[]>,
	): Map<string, MediaItemEntity[]> {
		const groups = new Map<string, MediaItemEntity[]>();

		for (const series of items) {
			if (series.kind !== MediaKind.SERIES) {
				continue;
			}

			const episodes: MediaItemEntity[] = [];
			let level = byParent.get(series.id) ?? [];

			for (let depth = 0; depth < SUBTREE_DEPTH && level.length > 0; depth += 1) {
				episodes.push(...level.filter((item) => item.kind === MediaKind.EPISODE));
				level = level.flatMap((item) => byParent.get(item.id) ?? []);
			}

			if (episodes.length > 0) {
				groups.set(series.id, episodes);
			}
		}

		return groups;
	}

	/** The `provider:value` keys one row carries that are worth comparing at all. */
	private _identifierKeys(item: MediaItemEntity): string[] {
		return WORK_IDENTIFIERS.map(
			(provider) => [provider, identifierValue(item.externalIds, provider)] as const,
		)
			.filter(([, value]) => value !== null)
			.map(([provider, value]) => `${provider}:${value as string}`);
	}

	private _episodeIdentifiers(
		groups: Map<string, MediaItemEntity[]>,
	): Map<string, Set<string>> {
		const distinctive = new Map<string, Set<string>>();

		for (const episodes of groups.values()) {
			const keys = episodeIdentifierKeys(
				episodes.map((episode) => ({ id: episode.id, keys: this._identifierKeys(episode) })),
			);

			for (const [id, values] of keys) {
				distinctive.set(id, values);
			}
		}

		return distinctive;
	}

	/**
	 * The series this gateway has already decided are the same show, both ways round.
	 *
	 * Worked out in the pass rather than read back from the match table, and that is a
	 * choice worth explaining. The rows are written as the same pass walks, so reading
	 * them would answer with the *previous* pass's conclusions — episodes under a series
	 * matched for the first time would stay unrelated until a second scan happened to
	 * run, and nothing on any screen would say why. Asking the correlation itself costs
	 * one comparison per series, which is a few hundred against the tens of thousands
	 * the pass already does, and gives the answer this pass would give.
	 */
	private _seriesPairs(
		items: MediaItemEntity[],
		context: { threshold: number; peers: Map<string, string | null>; byWork: Map<string, MediaItemEntity[]> },
	): Map<string, Set<string>> {
		const series = items.filter((item) => item.kind === MediaKind.SERIES);
		const byTitle = new Map<string, MediaItemEntity[]>();

		for (const one of series) {
			byTitle.set(one.normalizedTitle, [...(byTitle.get(one.normalizedTitle) ?? []), one]);
		}

		const pairs = new Map<string, Set<string>>();

		for (const one of series) {
			const candidates = new Map<string, MediaItemEntity>();

			for (const candidate of [
				...(byTitle.get(one.normalizedTitle) ?? []),
				...this._sameWorkAs(one, context.byWork),
			]) {
				// Its own service included, for the reason the same test gives above.
				if (candidate.id !== one.id) {
					candidates.set(candidate.id, candidate);
				}
			}

			const proposals = this._matching.correlate(
				this._candidate(one, context.peers),
				[...candidates.values()].map((candidate) => this._candidate(candidate, context.peers)),
				{ threshold: context.threshold },
			);

			for (const proposal of proposals) {
				// Proposed is not matched. A correlation the score did not apply is one
				// nobody has agreed to, and building a numbering conversion on top of it
				// would let a doubtful series pairing quietly renumber four hundred
				// episodes.
				if (proposal.applied) {
					CorrelationService._link(pairs, one.id, proposal.remoteItemId);
					CorrelationService._link(pairs, proposal.remoteItemId, one.id);
				}
			}
		}

		return pairs;
	}

	/**
	 * Episodes related across two numbering conventions, for every matched series.
	 *
	 * Every guard lives in `alignAbsoluteNumbering`; this only decides which two sets of
	 * episodes are handed to it, which is the part that needs the index. Each pair of
	 * series is aligned once — the relation is symmetric, and aligning it twice would
	 * do the same arithmetic to reach the same answer.
	 */
	private _absolutePairs(
		items: MediaItemEntity[],
		groups: Map<string, MediaItemEntity[]>,
		context: { threshold: number; peers: Map<string, string | null>; byWork: Map<string, MediaItemEntity[]> },
	): Map<string, Set<string>> {
		const pairs = new Map<string, Set<string>>();
		const aligned = new Set<string>();

		for (const [seriesId, others] of this._seriesPairs(items, context)) {
			for (const otherId of others) {
				const key = seriesId < otherId ? `${seriesId}|${otherId}` : `${otherId}|${seriesId}`;

				if (aligned.has(key)) {
					continue;
				}

				aligned.add(key);

				const left = groups.get(seriesId) ?? [];
				const right = groups.get(otherId) ?? [];

				for (const pair of alignAbsoluteNumbering(
					left.map((item) => this._numbered(item)),
					right.map((item) => this._numbered(item)),
				)) {
					CorrelationService._link(pairs, pair.absoluteId, pair.splitId);
					CorrelationService._link(pairs, pair.splitId, pair.absoluteId);
				}
			}
		}

		return pairs;
	}

	private _numbered(item: MediaItemEntity): {
		id: string;
		seasonNumber: number | null;
		episodeNumber: number | null;
	} {
		return {
			id: item.id,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
		};
	}

	/**
	 * The rows the numbering alignment paired this one with.
	 *
	 * Added to the candidate set because nothing else would ever bring them together:
	 * the candidate lookup joins on the normalised title and the episode coordinates,
	 * and the whole point of this pair is that neither of those agrees.
	 */
	private _alignedWith(item: MediaItemEntity, context: CorrelationContext): MediaItemEntity[] {
		const related: MediaItemEntity[] = [];

		for (const id of context.absolutePairs.get(item.id) ?? []) {
			const candidate = context.byId.get(id);

			if (candidate !== undefined) {
				related.push(candidate);
			}
		}

		return related;
	}

	private static _link(pairs: Map<string, Set<string>>, from: string, to: string): void {
		const existing = pairs.get(from);

		if (existing === undefined) {
			pairs.set(from, new Set([to]));

			return;
		}

		existing.add(to);
	}

	private _indexByContent(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			for (const key of contentKeys(item.file)) {
				index.set(key, [...(index.get(key) ?? []), item]);
			}
		}

		return index;
	}

	private _sameContentAs(
		item: MediaItemEntity,
		index: Map<string, MediaItemEntity[]>,
	): MediaItemEntity[] {
		return contentKeys(item.file).flatMap((key) => index.get(key) ?? []);
	}

	/**
	 * Films and series by the identifiers that name a work.
	 *
	 * The title lookup only ever puts two copies side by side when their normalised
	 * titles are identical, so a film filed as *Le Fabuleux Destin d'Amélie Poulain* on
	 * one server and *Amélie* on another was never compared at all, however loudly their
	 * IMDb numbers agreed. If the identifier decides the work, it has to be able to
	 * introduce the two copies too.
	 *
	 * Films and series only. A season and an episode routinely carry their series'
	 * identifier rather than their own, so indexing them would make every episode of a
	 * show a candidate for every other — a quadratic walk to be told no — and a season
	 * has no number check in the identifier strategy to stop season one meeting season
	 * two.
	 */
	private _indexByWork(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			for (const key of this._workKeys(item)) {
				index.set(key, [...(index.get(key) ?? []), item]);
			}
		}

		return index;
	}

	private _sameWorkAs(
		item: MediaItemEntity,
		index: Map<string, MediaItemEntity[]>,
	): MediaItemEntity[] {
		return this._workKeys(item).flatMap((key) => index.get(key) ?? []);
	}

	private _workKeys(item: MediaItemEntity): string[] {
		if (item.kind !== MediaKind.MOVIE && item.kind !== MediaKind.SERIES) {
			return [];
		}

		// The kind is part of the key because TMDB and TVDB number films and series
		// separately: film 1399 and series 1399 are two works.
		return WORK_IDENTIFIERS.map((provider) => [provider, identifierValue(item.externalIds, provider)])
			.filter(([, value]) => value !== null)
			.map(([provider, value]) => `${item.kind}:${provider}:${value}`);
	}

	/** `S01E05`, with a question mark where a library told us nothing. */
	private _label(item: MediaItemEntity): string {
		const season = item.seasonNumber === null ? '??' : String(item.seasonNumber).padStart(2, '0');
		const episode = item.episodeNumber === null ? '??' : String(item.episodeNumber).padStart(2, '0');

		return `S${season}E${episode}`;
	}

	private _candidate(
		item: MediaItemEntity,
		peers: Map<string, string | null>,
	): MatchCandidate {
		return {
			id: item.id,
			serviceId: item.serviceId,
			peerId: peers.get(item.serviceId) ?? null,
			parentId: item.parentId,
			kind: item.kind,
			title: item.title,
			normalizedTitle: item.normalizedTitle,
			year: item.year,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
			externalIds: item.externalIds,
			file: item.file,
		};
	}
}
