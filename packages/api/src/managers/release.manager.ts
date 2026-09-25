import { basename, dirname, join, resolve } from 'node:path';
import {
	ErrorKey,
	EventName,
	GrabState,
	isIndexerSuggestion,
	MediaKind,
	PEER_SUGGESTION_PREFIX,
	PeerTrust,
	PlacementStrategy,
	ReleaseKind,
	ReleaseSearchKind,
	SyncState,
	type CoveragePlan,
	type CoverageStep,
	type EpisodeRef,
	type GrabRequest,
	type MediaGroup,
	type PeerCopy,
	type Release,
	type ReleaseGrab as ReleaseGrabView,
	type ReleaseGroup,
	type ReleaseSearchQuery,
	type ReleaseSearchResult,
	type DownloadClientSettings,
	type Settings,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	HttpException,
	Injectable,
	Logger,
	NotFoundException,
	OnApplicationBootstrap,
} from '@nestjs/common';
import type { ReleaseGrab as GrabEntity, MediaItem as MediaItemEntity } from '@/entities';
import { MediaItemRepository, PeerRepository, ReleaseGrabRepository } from '@/repositories';
import {
	CacheService,
	DownloadClientRegistry,
	EventGatewayService,
	FileMoveService,
	FilesystemService,
	followToMagnet,
	isInside,
	releaseBytes,
	groupReleases,
	IndexerRegistry,
	NamingService,
	orderGroupsByPreference,
	orderSuggestions,
	parseReleaseName,
	PeerSuggestionService,
	pinnedFolderOf,
	PlacementService,
	resolveReleasePreference,
	SettingsService,
	mappedLocalPath,
	type SuggestionHolding,
} from '@/services';
import { LandingManager } from './landing.manager';
import { LibraryManager } from './library.manager';
import { MediaGroupManager } from './media-group.manager';

/**
 * The tag our downloads carry in the client, and the one thing that keeps this feature
 * from touching anything that is not ours.
 *
 * A torrent client is somebody's own tool as often as it is ours: theirs holds the
 * Linux ISOs and last week's album alongside whatever the gateway put there. Every
 * listing is filtered on this category, so nothing else is ever tracked, reported, or —
 * far worse — copied into a media library.
 */
/**
 * A failure as somebody reading the row will understand it.
 *
 * `String(error)` on a Nest exception yields its class name twice — a row that failed a
 * duplicate add read `ConflictException: Conflict Exception`, which says neither what
 * was refused nor by whom, and the reason had to be reproduced in a lab to be learnt.
 * The key and the detail are already in the payload; this is only putting them where the
 * row is read.
 */
const reasonOf = (error: unknown): string => {
	if (error instanceof HttpException) {
		const payload = error.getResponse();

		if (typeof payload === 'object' && payload !== null && 'key' in payload) {
			const held = payload as { key?: unknown; detail?: unknown };
			const detail = typeof held.detail === 'string' ? ` (${held.detail})` : '';

			return `${String(held.key)}${detail}`;
		}
	}

	return error instanceof Error && error.message !== '' ? error.message : String(error);
};

const CATEGORY = 'media-center-sync';

/** How long a search stays grabbable. A release has no identity outside its search. */
const SEARCH_TTL_SECONDS = 1_800;

/** How often the client is asked where its downloads have got to. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Finding a copy nobody we know holds, and bringing it home.
 *
 * Every other source in this product is somebody's library — ours, a friend's — and
 * answers "where is the copy I know about". This one answers the other question, the
 * one a household actually starts from: nobody has season three.
 *
 * It is one manager rather than two because the two halves are useless apart. A search
 * whose results cannot be grabbed is a list of names; a grab with nothing to file it
 * against is a torrent client. What makes it a feature is the line from a media in our
 * catalogue, through an indexer that has never heard of it, to a file in the library
 * named the way that library names things — and that line is a decision at every step,
 * which is what a manager is for.
 */
/**
 * The first of these links that is, or leads to, a magnet.
 *
 * Tried in order and never trusted by field name: `magnetUrl` holding an http link is
 * what Prowlarr actually answers. Null when neither leads anywhere, which is honest
 * rather than defeatist — some trackers serve `.torrent` bytes at a URL the client can
 * fetch for itself, and the caller still passes the download link on.
 */
const resolveMagnet = async (
	magnetUrl: string | null,
	downloadUrl: string | null,
): Promise<string | null> => {
	for (const link of [magnetUrl, downloadUrl]) {
		if (link === null || link === '') {
			continue;
		}

		if (link.startsWith('magnet:')) {
			return link;
		}

		const followed = await followToMagnet(link);

		if (followed !== null) {
			return followed;
		}
	}

	return null;
};

@Injectable()
export class ReleaseManager implements OnApplicationBootstrap {
	private readonly _logger = new Logger(ReleaseManager.name);
	private _polling: NodeJS.Timeout | null = null;

	public constructor(
		private readonly _grabs: ReleaseGrabRepository,
		private readonly _items: MediaItemRepository,
		private readonly _indexers: IndexerRegistry,
		private readonly _clients: DownloadClientRegistry,
		private readonly _settings: SettingsService,
		/**
		 * Holds the last search, because a release has no existence outside one.
		 *
		 * An indexer's results are not rows in anybody's database: they are what a
		 * tracker said a minute ago. Persisting them would be a second catalogue to keep
		 * in step with reality, and reality here is a list that changes hourly. So a
		 * grab names a release from the search it came from, and a search that has
		 * expired answers "search again" rather than grabbing something else.
		 */
		private readonly _cache: CacheService,
		private readonly _naming: NamingService,
		private readonly _placement: PlacementService,
		private readonly _libraries: LibraryManager,
		/**
		 * Asked what is missing under a media, which is the question every line of the
		 * search is scored against.
		 *
		 * The grouped view and not the raw rows: an episode is held when *any* copy of
		 * ours holds it, and that is a fact about the match graph rather than about one
		 * server's table. Reading the rows here would call an episode missing because the
		 * Plex row has no file, while it sits on the Jellyfin next to it.
		 */
		private readonly _groups: MediaGroupManager,
		private readonly _filesystem: FilesystemService,
		private readonly _mover: FileMoveService,
		private readonly _events: EventGatewayService,
		/**
		 * The other half of what could satisfy a media: the copies our peers already hold.
		 *
		 * See `peer-suggestions.ts` for why this is not a second peer system. It reads
		 * nothing over the wire — the holdings are already in the index — so a friend being
		 * asleep costs an offer that is not there rather than a search that hangs.
		 */
		private readonly _suggestions: PeerSuggestionService,
		/**
		 * Read for one field: whether a peer was introduced by a friend or invited by us.
		 *
		 * The repository rather than `PeerManager`, because the whole of the question is
		 * one column and pulling in the manager that owns links, invitations and relays
		 * would couple a search screen to all of it. `MediaGroupManager` reads it the same
		 * way and for the same field.
		 */
		private readonly _peers: PeerRepository,
		/**
		 * Tells the media server a file has arrived, and re-reads our own index after.
		 *
		 * A manager rather than the repository under it, because recording a landing is
		 * three things — the row, the rescan request, the delayed re-read — and a grab
		 * that wrote only the row would be a file nobody ever looks for. See
		 * `_announceLanding`.
		 */
		private readonly _landings: LandingManager,
	) {}

	/**
	 * The poll loop, started once and never restarted.
	 *
	 * A timer rather than a subscription, because a torrent client has nothing to
	 * subscribe to: qBittorrent has no webhook worth the name and no event stream, so
	 * asking is the only way to find out. Five seconds is fast enough that a progress
	 * bar moves and slow enough that a client on a busy machine is not the thing making
	 * it busy.
	 *
	 * It does nothing at all when no client is configured, which is the ordinary case
	 * for most gateways: the settings are read on every pass rather than at boot, so
	 * configuring one takes effect without a restart.
	 */
	public onApplicationBootstrap(): void {
		this._polling = setInterval(() => {
			void this.poll().catch((error: unknown) => {
				// Swallowed on purpose. A client that is down must not take the timer with
				// it, or the first outage ends downloads for good until somebody restarts
				// the gateway — and nothing would say why.
				this._logger.debug(`Download poll failed: ${String(error)}`);
			});
		}, POLL_INTERVAL_MS);

		// Node keeps the process alive for a pending timer, which makes a container
		// refuse to stop and the test suite hang on its last file.
		this._polling.unref?.();
	}

	/**
	 * Everything that could satisfy a media, from the trackers and from the peers.
	 *
	 * The terms are built from the media rather than from what is on screen: an episode
	 * is searched for by its *series* title and coordinate, because that is what is in
	 * every release name and its own title is in none of them. `term` overrides it
	 * entirely, for the ordinary case of a show the trackers know under another name.
	 *
	 * Two sources answer, and only one of them is asked. The indexer is a request over
	 * the network that can fail and is named when it does; the peer copies are read out of
	 * the index this gateway already keeps, so they cost a query and cannot fail on their
	 * own. That asymmetry is why an indexer that is down still returns a useful screen:
	 * the thing a friend holds is there whether or not a tracker answered.
	 */
	public async search(query: ReleaseSearchQuery): Promise<ReleaseSearchResult> {
		const settings = await this._settings.get();
		const indexer = settings.indexer;

		if (indexer === null || !indexer.enabled) {
			throw new ConflictException(ErrorKey.INDEXER_NOT_CONFIGURED);
		}

		const item = query.itemId === undefined ? null : await this._require(query.itemId);
		const asked = await this._terms(item, query);

		if (asked.term.trim() === '') {
			throw new BadRequestException(ErrorKey.RELEASE_NOT_FOUND);
		}

		const failed: { indexer: string; error: string }[] = [];
		let releases: Release[] = [];

		try {
			releases = await this._indexers.get(indexer.type).search(indexer, asked);
		} catch (error: unknown) {
			// Named rather than swallowed, and never turned into an empty list: "nothing
			// found" and "nobody answered" are opposite answers, and a screen that shows
			// the first for the second sends somebody hunting for a better search term
			// while their key is wrong.
			failed.push({ indexer: indexer.type, error: String(error) });
		}

		const sizes = await this._sizesHeld(item);
		const marked = releases.map((release) => ({
			...release,
			// A release whose size matches a file we hold to the byte is the file we
			// hold. It is a guess and it is labelled as one — the row is still grabbable,
			// it simply sinks to the bottom of the list.
			heldAlready: release.size !== null && sizes.has(release.size),
		}));

		await this._remember(marked);

		const { missing, known, holdings } = item === null
			? {
				missing: [] as EpisodeRef[],
				known: new Set<string>(),
				// Free text names no media, so there is no gap to match a holding against.
				// A peer's catalogue could be searched by title, and deliberately is not:
				// it would answer copies of something nobody has said is the same media,
				// which is the guess the correlation graph exists to avoid making.
				holdings: [] as SuggestionHolding[],
			}
			: await this._coverageOf(item.id);

		/*
		 * The household's order, not the trackers'.
		 *
		 * Seeders are the only order this gateway can produce on its own and they are
		 * the wrong one for everybody: the best-seeded release of an episode is
		 * routinely a 720p re-encode from a group nobody would choose. Resolved most
		 * specific first — this media, then its shelf, then the household — and a level
		 * replaces the one above it whole rather than merging, so an override can be
		 * described and cancelled without reading two other screens.
		 */
		const categoryKeys = await this._libraries.categoryKeysByLibrary();
		const categoryKey = item === null ? null : (categoryKeys.get(item.libraryId) ?? null);
		const { preference } = resolveReleasePreference({
			global: settings.releasePreferences.global,
			// `?? null` and not the bare index: `undefined` at a level has to fall
			// through, or a category with no opinion would shadow the household's.
			category: categoryKey === null
				? null
				: (settings.releasePreferences.byCategory[categoryKey] ?? null),
			media: item?.overrides?.releasePreference ?? null,
		});

		const groups = orderGroupsByPreference(groupReleases(marked), preference).map((group) => ({
			...group,
			fills: fillsOf(group, missing),
			// Episodes no server here has ever reported. See `_coverageOf`.
			brings: known.size === 0 ? [] : newIn(group, known),
		}));

		return {
			query: [asked.term, asked.seasonNumber === null || asked.seasonNumber === undefined
				? ''
				: `S${String(asked.seasonNumber).padStart(2, '0')}`].filter(Boolean).join(' '),
			// One list, tracker and peer together. The rule that puts a copy that exists
			// above a copy that is claimed is in `orderSuggestions`, with the reasoning.
			suggestions: orderSuggestions(
				await this._peerCopies(item, holdings),
				groups,
			),
			missing,
			failed,
		};
	}

	/**
	 * The offers that come out of what we already index, rather than out of a tracker.
	 *
	 * Nothing is asked of anybody: a peer that holds a season has already been scanned
	 * into this gateway's catalogue, and the rows are sitting there. Reading them costs one
	 * query for the peer trusts and no network at all — which is what makes a peer
	 * suggestion appear on a screen whose indexer just timed out.
	 */
	private async _peerCopies(
		item: MediaItemEntity | null,
		holdings: SuggestionHolding[],
	): Promise<PeerCopy[]> {
		if (item === null || holdings.length === 0) {
			return [];
		}

		const peers = await this._peers.find();

		return this._suggestions.copiesFor({
			holdings,
			title: item.title,
			friendsOfFriends: new Set(
				peers.filter((peer) => peer.trust === PeerTrust.FRIEND_OF_FRIEND).map((peer) => peer.id),
			),
		});
	}

	/**
	 * A way of covering every gap, made of as few releases as possible.
	 *
	 * The answer to "I am short four episodes of this season", which is the question
	 * somebody actually arrives with. One pack covering all four beats four singles —
	 * one torrent, one connection, one thing to watch — and four singles beat a pack
	 * when no pack exists, which on an older show is most of the time.
	 *
	 * Greedy, and deliberately not cleverer than that. The optimal cover of a set is a
	 * famously hard problem and the input here is twenty releases against twelve
	 * episodes: taking the line that fills the most, then the next, is within a hair of
	 * optimal on inputs that size and is a rule somebody reading the plan can follow.
	 * Ties go to the better seeded, because the alternative to a download that finishes
	 * is not a smaller download.
	 *
	 * What it cannot cover is *named*. A plan that silently dropped two episodes would
	 * be a plan somebody presses and then discovers was never going to work.
	 *
	 * **Tracker releases only, and that is a decision rather than an omission.** A plan is
	 * one press that hands every step to the download client, and a peer copy is not
	 * something a download client can be handed — mixing them would make one button do two
	 * unrelated things to two unrelated machines, and the failure would be silent on
	 * whichever half went to the wrong one. The peer copies are on the list above instead,
	 * sorted above every release, and the plan says which of the episodes it could not
	 * cover a peer is holding — see `ReleasePlan.vue`. Taking the friend's copy first and
	 * planning the rest is then two presses, which is one more than ideal and none of them
	 * ambiguous.
	 */
	public async plan(query: ReleaseSearchQuery): Promise<CoveragePlan> {
		const found = await this.search(query);
		const uncovered = new Map(found.missing.map((one) => [keyOf(one), one]));
		const steps: CoverageStep[] = [];

		// Held copies are not candidates: a release of something already on the disk
		// fills nothing, whatever its name claims.
		const candidates = found.suggestions
			.filter(isIndexerSuggestion)
			.map((one) => one.release)
			.filter((group) => group.fills.length > 0);

		while (uncovered.size > 0) {
			const scored = candidates
				.map((group) => ({
					group,
					covers: group.fills.filter((one) => uncovered.has(keyOf(one))),
				}))
				.filter((one) => one.covers.length > 0)
				.sort(
					(left, right) =>
						right.covers.length - left.covers.length ||
						(right.group.seeders ?? 0) - (left.group.seeders ?? 0),
				);

			const best = scored[0];

			if (best === undefined) {
				break;
			}

			steps.push({
				releaseId: best.group.releases[0].id,
				title: best.group.title,
				kind: best.group.kind,
				size: best.group.size,
				seeders: best.group.seeders,
				covers: best.covers,
				// A pack taken for fewer episodes than it holds. The client is told to
				// fetch those files and to leave the rest at zero, so the disk pays for
				// what was asked for rather than for the whole season.
				partial:
					best.group.coverage.wholeSeason ||
					best.group.coverage.wholeSeries ||
					best.group.coverage.episodeNumbers.length > best.covers.length,
			});

			for (const one of best.covers) {
				uncovered.delete(keyOf(one));
			}
		}

		return { steps, uncovered: [...uncovered.values()] };
	}

	/**
	 * The episodes under a media that no copy of ours holds.
	 *
	 * Read off the grouped view rather than the rows, because an episode is held when
	 * *any* copy of ours holds it: the raw rows would call an episode missing for
	 * having no file on the Plex table while it sits on the Jellyfin beside it.
	 *
	 * Two levels, which is the whole shape of a media tree — a series has seasons and a
	 * season has episodes — and a film answers for itself.
	 */
	public async missingUnder(itemId: string): Promise<EpisodeRef[]> {
		return (await this._coverageOf(itemId)).missing;
	}

	/**
	 * What is under a media: the gaps, and every coordinate anybody knows about.
	 *
	 * The second list is what makes an indexer more than a way of filling holes. A gap
	 * is an episode some server in the household *has heard of* and nobody holds — but
	 * a season that aired last month exists on no server here, so it is not a gap: there
	 * is no row for it and nothing anywhere says it is absent. Against `missing` alone a
	 * search for a running show can only ever offer what we already knew we wanted.
	 *
	 * Knowing every coordinate is what lets a release announce itself as something new.
	 * Episode four of a season nobody has is not a hole in our catalogue; it is a fact
	 * about the world our catalogue has not caught up with, and those are different
	 * sentences on the screen.
	 */
	/**
	 * The trackers the configured indexer knows, for a screen that has to name one.
	 *
	 * Suggestions and nothing else: the order somebody writes accepts any value, because a
	 * tracker this gateway has never heard of is still a tracker they may prefer. What it
	 * prevents is the quiet failure — `Generation-Free` typed for `Generation-Free (API)`
	 * is a preference that matches nothing and orders nothing, and no screen would say so.
	 *
	 * An empty list when nothing is configured or the indexer will not answer, never a
	 * refusal: this feeds a settings screen that has plenty else to show.
	 */
	public async trackers(): Promise<string[]> {
		const settings = await this._settings.get();
		const indexer = settings.indexer;

		if (indexer === null || indexer.enabled === false) {
			return [];
		}

		try {
			return await this._indexers.get(indexer.type).trackers(indexer);
		} catch {
			return [];
		}
	}

	private async _coverageOf(
		itemId: string,
	): Promise<{ missing: EpisodeRef[]; known: Set<string>; holdings: SuggestionHolding[] }> {
		const group = await this._groups.group(itemId);
		const known = new Set<string>();
		/*
		 * The copies of each gap, collected on the same walk.
		 *
		 * Deliberately here and not in a second pass: the walk is already two levels of
		 * `groupChildren` over up to five hundred rows each, and asking for the same tree
		 * again to read a field it has already answered would double the cost of every
		 * search on a series. The group view carries the sources with it — that is what a
		 * group *is* — so a gap and the machines that hold it are read at once.
		 */
		const holdings: SuggestionHolding[] = [];

		if (group.kind === MediaKind.MOVIE || group.kind === MediaKind.EPISODE) {
			const ref = refOf(group);

			known.add(keyOf(ref));

			if (group.sync === SyncState.MISSING) {
				holdings.push({ ref, sources: group.sources });
			}

			return {
				missing: group.sync === SyncState.MISSING ? [ref] : [],
				known,
				holdings,
			};
		}

		const missing: EpisodeRef[] = [];
		const children = await this._groups.groupChildren(itemId, { limit: 500 });

		const take = (one: MediaGroup): void => {
			if (one.kind !== MediaKind.EPISODE) {
				return;
			}

			const ref = refOf(one);

			known.add(keyOf(ref));

			if (one.sync === SyncState.MISSING) {
				missing.push(ref);
				holdings.push({ ref, sources: one.sources });
			}
		};

		for (const child of children.items) {
			if (child.kind === MediaKind.EPISODE) {
				take(child);

				continue;
			}

			for (const episode of (await this._groups.groupChildren(child.id, { limit: 500 })).items) {
				take(episode);
			}
		}

		return { missing, known, holdings };
	}

	/**
	 * Hand a release to the download client, and remember what it is for.
	 *
	 * The remembering is the point. A torrent client knows it is fetching
	 * `Spartacus.S03E08.1080p-GRP` and has never heard of the media it belongs to, so
	 * without this row nothing could ever file the file when it lands — it would sit in
	 * the download folder for ever, complete, with nothing coming to collect it.
	 */
	public async grab(request: GrabRequest): Promise<ReleaseGrabView> {
		/*
		 * A peer copy is not something a download client can be given, and this is where
		 * that is said out loud.
		 *
		 * The search answers two kinds of row and only one of them belongs here. Handing a
		 * peer copy to qBittorrent would be a magnetless add: the client takes nothing,
		 * reports nothing, and every screen says the release was handed over while no byte
		 * ever moves — the exact silent success this whole feature keeps producing. It
		 * would also *almost* work by accident, because a peer identifier is not in the
		 * release cache and the recall below would answer nothing; refusing on the prefix
		 * instead means the guard is a rule somebody can read rather than a coincidence
		 * that a caching change can remove.
		 *
		 * The right action for one of these is a sync run over `PeerCopy.itemIds`, through
		 * the transfer machinery that moves every other byte in this product.
		 */
		if (request.releaseId.startsWith(PEER_SUGGESTION_PREFIX)) {
			throw new BadRequestException(ErrorKey.RELEASE_NOT_GRABBABLE);
		}

		const settings = await this._settings.get();
		const client = settings.downloadClient;

		if (client === null || !client.enabled) {
			throw new ConflictException(ErrorKey.DOWNLOAD_CLIENT_NOT_CONFIGURED);
		}

		/*
		 * Before a byte is fetched, not after.
		 *
		 * The mapping is the whole difficulty of this feature: a client in its own
		 * container writes to `/downloads` while the gateway reaches the same directory
		 * at `/share/torrents`. Getting it wrong succeeds at every step — the torrent
		 * completes, the client is happy — and the file is never filed, with nothing
		 * anywhere reporting a fault. So every local root is probed, and one that cannot
		 * be read refuses the grab rather than the placement an hour later.
		 */
		const roots = client.rootMappings ?? [];

		if (roots.length === 0) {
			throw new ConflictException({
				key: ErrorKey.DOWNLOAD_PATH_UNREADABLE,
				detail: 'no root mapping is configured for the download client',
			});
		}

		for (const mapping of roots) {
			if (!(await this._filesystem.rights(mapping.localRoot)).readable) {
				/*
				 * The path, named, because the refusal is otherwise unactionable.
				 *
				 * This refusal is about **our** side of the mapping and it reads as being
				 * about the client: somebody who has just been told the download client
				 * cannot read a path goes and looks at the download client, where everything
				 * is fine. What cannot be read is the folder *this gateway* was told the
				 * client's downloads appear at — a directory the container does not mount,
				 * or a spelling that does not exist — and saying which one turns an evening
				 * into a minute.
				 */
				throw new ConflictException({
					key: ErrorKey.DOWNLOAD_PATH_UNREADABLE,
					detail: `this gateway cannot read ${mapping.localRoot}, `
						+ `where it was told ${mapping.remoteRoot} appears`,
				});
			}
		}

		const item = await this._require(request.itemId);
		const release = await this._recall(request.releaseId);

		if (release === null) {
			throw new NotFoundException(ErrorKey.RELEASE_NOT_FOUND);
		}

		/*
		 * A grab for part of a release is added stopped, and that is the whole of partial
		 * fetching. A torrent's file list does not exist until the client has its
		 * metadata, so "take two episodes out of this pack" can only be said afterwards —
		 * and by then a running torrent has already started paying for the other eight.
		 * The poll loop chooses the files and starts it; see `_choose`.
		 */
		const partial = (request.wanted?.length ?? 0) > 0;
		/*
		 * Resolved here, from where the link makes sense.
		 *
		 * An indexer's download link commonly points back at the indexer, built from the
		 * `Host` of the request that asked for it — so a search made by this gateway
		 * yields `http://localhost:9696/…`. Handed to a client in its own container,
		 * `localhost` is the client: it fetches nothing, adds nothing and reports no
		 * error, and every screen says the release was handed over. See `followToMagnet`.
		 *
		 * **And the field called `magnetUrl` is not necessarily a magnet.** A real Prowlarr
		 * puts one of its own http links in it — the field names what it leads to, not what
		 * it is — so trusting the name skipped the whole guard above and handed the client
		 * exactly the link the guard exists to resolve. Found by grabbing through the lab:
		 * the client answered, took nothing, and the only trace was a refusal several
		 * layers away saying it had accepted something and added no torrent.
		 *
		 * So both fields are tried, and only a string that really begins `magnet:` is
		 * passed on as one.
		 */
		const magnetUrl = await resolveMagnet(release.magnetUrl, release.downloadUrl);
		/*
		 * No magnet means a file, and the file is fetched here rather than by the client.
		 *
		 * The same trap as the magnet above, on the other branch and just as silent: the
		 * link an indexer hands out is built from the `Host` of the request that asked, so
		 * a client in its own container resolving `localhost:9696` reaches itself, takes
		 * nothing, and reports nothing. Half the private trackers serve a `.torrent` rather
		 * than a magnet, so this is not an edge — it is the other half of every search.
		 */
		const torrentFile = magnetUrl !== null || release.downloadUrl === null
			? null
			: await releaseBytes(release.downloadUrl);

		const clientId = await this._clients.get(client.type).grab(client, {
			magnetUrl,
			downloadUrl: release.downloadUrl,
			torrentFile,
			title: release.title,
			savePath: await this._savePathFor(client),
			category: CATEGORY,
			paused: partial,
		});

		const grab = await this._grabs.save(
			this._grabs.create({
				plannedPath: await this.plannedDirectory(
					item,
					settings,
					request.libraryId ?? null,
					request.folder ?? null,
				),
				itemId: item.id,
				title: release.title,
				indexer: release.indexer,
				state: GrabState.SENT,
				clientId,
				bytesDone: 0,
				bytesTotal: release.size ?? 0,
				// Where somebody said it should go, if anybody did. Null is the ordinary
				// case and means the placement chain decides.
				targetLibraryId: request.libraryId ?? null,
				targetFolder: request.folder ?? null,
				// Said rather than deduced: a whole-release grab and a partial one look
				// identical on their first pass, and guessing wrong chooses files on a
				// torrent nobody paused.
				partial,
				// What it was taken for. One entry for a single episode, several for a
				// pack — and the file each one turns out to be is filled in once the
				// client can say what is inside.
				placements: (request.wanted ?? [refOf({
					id: item.id,
					seasonNumber: item.seasonNumber,
					episodeNumber: item.episodeNumber,
					title: item.title,
				})]).map((one) => ({ ...one, fileName: null, targetPath: null })),
			}),
		);

		this._logger.log(`Grabbed ${release.title} for ${item.title}`);
		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));

		return toGrabView(grab);
	}

	/**
	 * Send a torrent somewhere else, before it is filed.
	 *
	 * The same answer a redirected transfer takes — a library, optionally a folder — and
	 * refused once the file is in the library: at that point it is a file like any
	 * other, and moving it is the media's business rather than this row's.
	 *
	 * Nothing is copied here. The destination is read when the download finishes, so
	 * changing it before then costs one row write, whatever the torrent is doing.
	 */
	public async setDestination(
		id: string,
		libraryId: string | null,
		folder: string | null,
	): Promise<ReleaseGrabView> {
		const grab = await this._grabs.findOne({ where: { id } });

		if (grab === null) {
			throw new NotFoundException(ErrorKey.GRAB_NOT_FOUND);
		}

		if (grab.state === GrabState.PLACED) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		grab.targetLibraryId = libraryId;
		grab.targetFolder = folder;

		await this._grabs.save(grab);
		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));

		return toGrabView(grab);
	}

	/**
	 * Put a failed download back in the queue, once whatever failed it has been repaired.
	 *
	 * The case this is for, from the gateway it happened on: a root mapping named a folder
	 * the client could not write, every grab failed, and the mapping was then corrected —
	 * at which point there was nothing to press. The torrents were still in the client,
	 * most of them finished, and the only way back was to search for the same release and
	 * grab it a second time.
	 *
	 * It re-opens the row rather than re-sending anything, which is the whole point: the
	 * client still holds the torrent, so the next poll reads its state and carries on from
	 * there. A torrent that finished while the row said `failed` is filed within seconds;
	 * one still downloading resumes its progress; one somebody removed from the client is
	 * cancelled, which is the truth about it.
	 *
	 * Refused on a row with no client identifier, because there is nothing to go back to:
	 * the grab failed before the client ever took it, and what that needs is a new grab
	 * rather than a retry of a download that never started.
	 */
	public async retry(id: string): Promise<ReleaseGrabView> {
		const grab = await this._grabs.findOne({ where: { id } });

		if (grab === null) {
			throw new NotFoundException(ErrorKey.GRAB_NOT_FOUND);
		}

		if (grab.state !== GrabState.FAILED && grab.state !== GrabState.CANCELLED) {
			throw new ConflictException(ErrorKey.GRAB_NOT_RETRYABLE);
		}

		if (grab.clientId === null) {
			throw new ConflictException({
				key: ErrorKey.GRAB_NOT_RETRYABLE,
				detail: 'the download client never took this one, so there is nothing to resume',
			});
		}

		grab.state = GrabState.DOWNLOADING;
		grab.error = null;

		await this._grabs.save(grab);
		this._logger.log(`Retrying ${grab.title}, which the client still holds as ${grab.clientId}`);
		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));

		return toGrabView(grab);
	}

	/** What has been grabbed, newest first — or only what belongs to one media. */
	public async downloads(itemId?: string): Promise<ReleaseGrabView[]> {
		const rows = itemId === undefined
			? await this._grabs.findRecent()
			: await this._grabs.findForItem(itemId);

		return rows.map((row) => toGrabView(row));
	}

	/**
	 * Ask the client where everything has got to, and file what has arrived.
	 *
	 * One request for every download rather than one each: a client with thirty
	 * torrents would otherwise be asked thirty times every five seconds, which is a
	 * poll loop that costs more than the download.
	 */
	public async poll(): Promise<void> {
		const live = await this._grabs.findLive();

		if (live.length === 0) {
			return;
		}

		const settings = await this._settings.get();
		const client = settings.downloadClient;

		if (client === null || !client.enabled) {
			return;
		}

		/*
		 * The rows this poll is about, asked for by name.
		 *
		 * By hash rather than by our category, because a torrent the client already held
		 * when it was grabbed is filed under the category its owner gave it — and a poll
		 * that asked only about ours never saw it. The grab then sat on `sent` while the
		 * download it was following ran to completion and nothing was ever filed. The
		 * category is still what a grab is *made* under; it is not what identifies one.
		 */
		const tracked = live
			.map((grab) => grab.clientId)
			.filter((id): id is string => id !== null);

		if (tracked.length === 0) {
			return;
		}

		const statuses = new Map(
			(await this._clients.get(client.type).statuses(client, CATEGORY, tracked)).map((one) => [
				one.clientId,
				one,
			]),
		);

		for (const grab of live) {
			const status = grab.clientId === null ? undefined : statuses.get(grab.clientId);

			if (status === undefined) {
				/*
				 * The client has never heard of it. Somebody removed it from the client, or
				 * it was never accepted — and either way it is not coming, so the row says
				 * so rather than sitting on `downloading` for ever.
				 *
				 * Only for a row that was already downloading: one just sent has not
				 * necessarily appeared in the client's list yet, and cancelling it on the
				 * first poll would cancel every grab a second after making it.
				 */
				if (grab.state === GrabState.DOWNLOADING) {
					await this._settle(grab, GrabState.CANCELLED, null);
				}

				continue;
			}

			// Stopped and waiting to be told what to fetch. Until the files are chosen
			// nothing is downloading, so this comes before every other reading of the
			// status — a torrent with no bytes yet is not a torrent that has failed.
			if (grab.state === GrabState.SENT && this._awaitsChoice(grab)) {
				await this._choose(grab, client);

				continue;
			}

			/*
			 * The client has given up on it, and says so in its own words.
			 *
			 * Without this the row stays on `downloading` at zero bytes for ever, which is
			 * what a production gateway did: qBittorrent had the torrent in `error` because
			 * the save path it was handed was not one it could write into, every screen said
			 * the download was in progress, and the only place the truth existed was the
			 * client's own log. A failure nobody is told about is the same defect as an
			 * operation that succeeds while doing nothing.
			 *
			 * After the choice branch on purpose: a stopped torrent waiting for its files
			 * has no bytes yet, and that is not a failure.
			 */
			if (status.failed) {
				await this._settle(
					grab,
					GrabState.FAILED,
					status.failedReason ?? `the download client reports ${status.state}`,
				);

				continue;
			}

			grab.bytesDone = status.bytesDone;
			grab.bytesTotal = status.bytesTotal || grab.bytesTotal;

			if (!status.complete) {
				grab.state = GrabState.DOWNLOADING;
				await this._grabs.save(grab);
				this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab, status.rate));

				continue;
			}

			grab.state = GrabState.FETCHED;
			// Translated into our spelling here and stored that way, so no later reader
			// has to remember to do it — and the one that forgets finds nothing and
			// reports nothing.
			grab.sourcePath = this._localise(status, client);
			await this._grabs.save(grab);

			await this._place(grab, settings);
		}
	}

	/** A partial grab whose files have not been chosen yet. */
	private _awaitsChoice(grab: GrabEntity): boolean {
		return grab.partial && (grab.placements ?? []).every((one) => one.fileName === null);
	}

	/**
	 * Tell the client which files to fetch, then let it run.
	 *
	 * The file list is asked for and may not be there yet: a magnet has no metadata for
	 * the first seconds of its life, and the honest answer to that is to come back on
	 * the next pass rather than to guess. Nothing is downloading meanwhile, which is the
	 * point of having added it stopped.
	 *
	 * Each file is matched to an episode by reading its *own* name — not the torrent's.
	 * A pack is called `Show.S02.1080p-GRP` and says nothing about which file is which;
	 * the files inside carry `S02E04`, which is the only thing that can tell them apart.
	 *
	 * A file nothing matches is left out. The alternative — taking the largest, or
	 * taking them in order — files episode four as episode one on the first pack whose
	 * extras sort before its episodes, and nothing anywhere reports it.
	 */
	private async _choose(grab: GrabEntity, client: DownloadClientSettings): Promise<void> {
		if (grab.clientId === null) {
			return;
		}

		const driver = this._clients.get(client.type);
		const files = await driver.files(client, grab.clientId);

		if (files.length === 0) {
			return;
		}

		const placements = [...(grab.placements ?? [])];
		const wanted: number[] = [];

		for (const file of files) {
			const parsed = parseReleaseName(basename(file.name), true);
			const episode = parsed.coverage.episodeNumbers[0] ?? null;
			const match = placements.find(
				(one) =>
					one.fileName === null &&
					one.episodeNumber === episode &&
					(one.seasonNumber === parsed.coverage.seasonNumber ||
						parsed.coverage.seasonNumber === null),
			);

			if (match === undefined) {
				continue;
			}

			match.fileName = file.name;
			wanted.push(file.index);
		}

		if (wanted.length === 0) {
			/*
			 * The pack holds nothing we asked for, which is a mislabelled release rather
			 * than a fault of ours. Failed rather than started: starting it would fetch a
			 * whole season to file none of it.
			 */
			await this._settle(grab, GrabState.FAILED, 'none of the wanted episodes are in this release');

			return;
		}

		await driver.selectFiles(client, grab.clientId, wanted);
		await driver.start(client, grab.clientId);

		grab.placements = placements;
		grab.state = GrabState.DOWNLOADING;
		await this._grabs.save(grab);

		this._logger.log(
			`${grab.title}: fetching ${wanted.length} of ${files.length} files`,
		);
		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));
	}

	/**
	 * Copy what the client fetched into the library, named the way that library names
	 * things.
	 *
	 * **Copied and never moved.** The torrent is still seeding, and a file moved out
	 * from under a client is a torrent that errors and a ratio that stops — which is
	 * somebody's account on a private tracker. The cost is the disk space, for as long
	 * as they choose to keep seeding, and that is their decision rather than ours.
	 *
	 * The same placement and naming as everything else. A file that arrived by torrent
	 * is a file, and the day it is filed by a second rule is the day a library has two
	 * conventions in it.
	 */
	private async _place(grab: GrabEntity, settings: Settings): Promise<void> {
		try {
			const item = await this._items.findOne({ where: { id: grab.itemId } });

			if (item === null || grab.sourcePath === null) {
				throw new Error('the media or the downloaded file is gone');
			}

			/*
			 * A pack taken for several episodes is several files, and every one of them has
			 * to be filed.
			 *
			 * This used to file the largest file and stop, which is right for "this release
			 * for this episode" and quietly wrong for everything the coverage plan does: a
			 * run of three episodes under one info hash arrived, one episode was filed, two
			 * sat in the download folder for ever, and the row said `placed`. Nothing
			 * reported it — the copy that did happen succeeded — and the season stayed
			 * incomplete with a finished download next to it.
			 *
			 * `_choose` has already worked out which file answers which episode, so the
			 * names are on the row. When they are not — a whole-release grab, where nobody
			 * named anything — the largest file is still the answer.
			 */
			const named = (grab.placements ?? []).filter((one) => one.fileName !== null);

			if (named.length > 0) {
				await this._placeEach(grab, settings);

				return;
			}

			const source = await this._largestFile(grab.sourcePath);

			if (source === null) {
				throw new Error(`nothing playable under ${grab.sourcePath}`);
			}

			const libraries = await this._libraries.placementLibraries();
			const categoryKeys = await this._libraries.categoryKeysByLibrary();
			const show = await this._showFacts(item);
			/*
			 * This download's folder, and failing that the one pinned on the media itself.
			 *
			 * Two answers to the same question, asked in the order they were given: a folder
			 * named for this download is about this download, while a folder pinned in the
			 * correction dialog is about the media for ever — so a one-off choice wins over
			 * a standing one, and both win over the rule.
			 */
			const folder = grab.targetFolder ?? await this._pinnedFolder(item);
			const target = await this._placement.resolve({
				kind: item.kind as MediaKind,
				categoryKey: categoryKeys.get(item.libraryId) ?? null,
				settings: folder
					// A folder somebody named outranks every rule, which is what naming one
					// means. Expressed through the fixed-path strategy rather than a branch
					// of its own, so a chosen folder and a configured one are placed by one
					// code path and cannot disagree.
					? { ...settings, placement: PlacementStrategy.FIXED_PATH, fixedPath: folder }
					: settings,
				libraries,
				// Consulted after an existing copy and before the category, exactly as a
				// run's preferred library is: it decides where something new goes and
				// never splits a show across two folders.
				preferredLibraryId: grab.targetLibraryId,
				relativeName: (root: string) =>
					this._naming.render(
						settings.namingOrder,
						{
							kind: item.kind as MediaKind,
							title: item.title,
							year: item.year,
							seasonNumber: item.seasonNumber,
							episodeNumber: item.episodeNumber,
							// The show, not the episode — see `_showFacts`. Null here filed
							// an episode in a folder named after the episode.
							seriesTitle: show?.title ?? null,
							seriesYear: show?.year ?? null,
							// The release's own name, so `SOURCE` keeps what the tracker
							// called it — which is what a library full of scene names wants.
							sourcePath: source,
						},
						{ libraryRoot: root, siblingPath: null },
					),
				requiredBytes: 0,
			});

			await this._placement.prepare(target);

			// Said on the row while it happens, because it is not instant: a season pack
			// is tens of gigabytes across two filesystems, and a line that sat on
			// "fetched" for twenty minutes with nothing moving is a line somebody
			// reasonably reads as stuck. The bytes are the copy's, not the torrent's —
			// the state says which of the two is being counted.
			grab.bytesDone = 0;
			grab.bytesTotal = 0;
			grab.targetPath = target.path;

			await this._mover.move({
				source,
				destination: target.path,
				reserveBytes: settings.diskReserveBytes,
				// A copy, not a move: see the doc block above.
				keepSource: true,
				onProgress: (progress) => {
					grab.bytesDone = progress.bytesDone;
					grab.bytesTotal = progress.bytesTotal;

					this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab, progress.rate));
				},
			});

			grab.state = GrabState.PLACED;
			grab.targetPath = target.path;
			grab.error = null;
			await this._grabs.save(grab);

			this._logger.log(`Placed ${grab.title} at ${target.path}`);
			this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));

			await this._announceLanding(grab, item.id, target.libraryId, target.path, grab.bytesTotal);
		} catch (error: unknown) {
			// The bytes are still on the disk and the row says where, so this is
			// recoverable by hand — which is the whole reason the failure is recorded
			// rather than retried for ever.
			await this._settle(grab, GrabState.FAILED, reasonOf(error));
		}
	}

	/**
	 * One copy per episode the pack was taken for, each filed as that episode.
	 *
	 * Filed against the episode's own row rather than the row the grab was made from, so
	 * the naming has a season and an episode number to render and the file lands where a
	 * sync would have put it. Anything else would file three episodes under the show's
	 * own name, three times.
	 *
	 * Sequential and not parallel: two copies across the same two filesystems take the
	 * same total time and make the progress on the row meaningless, and the row is the
	 * only thing anybody watching has.
	 *
	 * An episode whose file cannot be found is skipped and named in the error, and the
	 * ones that did arrive keep their place: a season two files short is worth having,
	 * and saying nothing about the two is what leaves somebody waiting for them.
	 */
	private async _placeEach(grab: GrabEntity, settings: Settings): Promise<void> {
		if (grab.sourcePath === null) {
			throw new Error('the downloaded file is gone');
		}

		// The client spells a file relative to the directory everything lands in, which is
		// the parent of the folder this torrent produced.
		const root = dirname(grab.sourcePath);
		const placements = [...(grab.placements ?? [])];
		const libraries = await this._libraries.placementLibraries();
		const categoryKeys = await this._libraries.categoryKeysByLibrary();
		const missing: string[] = [];

		let placed = 0;
		let base = 0;

		grab.bytesDone = 0;
		grab.bytesTotal = 0;

		for (const placement of placements) {
			if (placement.fileName === null) {
				missing.push(placement.title);
				continue;
			}

			const source = await this._fileNamed(placement.fileName, grab.sourcePath, root);

			if (source === null) {
				missing.push(placement.title);
				continue;
			}

			const episode = await this._items.findOne({ where: { id: placement.itemId } });

			if (episode === null) {
				missing.push(placement.title);
				continue;
			}

			const show = await this._showFacts(episode);
			// See the single-file placement above: this download's folder first, then the
			// one pinned on the media, then the rule.
			const folder = grab.targetFolder ?? await this._pinnedFolder(episode);
			const target = await this._placement.resolve({
				kind: episode.kind as MediaKind,
				categoryKey: categoryKeys.get(episode.libraryId) ?? null,
				settings: folder
					? { ...settings, placement: PlacementStrategy.FIXED_PATH, fixedPath: folder }
					: settings,
				libraries,
				preferredLibraryId: grab.targetLibraryId,
				relativeName: (libraryRoot: string) =>
					this._naming.render(
						settings.namingOrder,
						{
							kind: episode.kind as MediaKind,
							title: episode.title,
							year: episode.year,
							seasonNumber: episode.seasonNumber,
							episodeNumber: episode.episodeNumber,
							seriesTitle: show?.title ?? null,
							seriesYear: show?.year ?? null,
							sourcePath: source,
						},
						{ libraryRoot, siblingPath: null },
					),
				requiredBytes: 0,
			});

			await this._placement.prepare(target);

			await this._mover.move({
				source,
				destination: target.path,
				reserveBytes: settings.diskReserveBytes,
				// A copy, as everywhere here: the torrent is still seeding.
				keepSource: true,
				onProgress: (progress) => {
					// Across the whole pack rather than per file, because what somebody is
					// watching is one line for one download.
					grab.bytesDone = base + progress.bytesDone;
					grab.bytesTotal = base + progress.bytesTotal;

					this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab, progress.rate));
				},
			});

			placement.targetPath = target.path;
			base = grab.bytesDone;
			placed += 1;
			// Saved as each one lands, so a failure halfway leaves a row that says which
			// files are already in the library rather than none of them.
			grab.placements = placements;
			grab.targetPath = target.path;
			await this._grabs.save(grab);

			// Announced here rather than at the end, where the destination of each file is
			// no longer in hand: a landing is about one file in one library, and the pack's
			// files can be resolved into different ones.
			await this._announceLanding(grab, episode.id, target.libraryId, target.path, 0);
		}

		if (placed === 0) {
			throw new Error(`none of the wanted files are under ${grab.sourcePath}`);
		}

		grab.state = GrabState.PLACED;
		grab.error = missing.length === 0
			? null
			: `filed ${placed} of ${placements.length}; nothing found for ${missing.join(', ')}`;
		await this._grabs.save(grab);

		this._logger.log(`Placed ${placed} file(s) of ${grab.title}`);
		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));

	}

	/**
	 * Tell the media server a file has arrived, and arrange to look ourselves.
	 *
	 * The half of a grab that was never written. A pull from a peer has done this from
	 * the start — `LandingManager` asks the destination's server to rescan and re-reads
	 * our own index once it has had time — and a torrent did none of it: the file was
	 * copied into the library and nobody was told. On a server that scans on a schedule
	 * the file stayed invisible until the small hours, unidentified, with **no metadata
	 * and no poster**, while our own screens went on calling the media missing.
	 *
	 * That is where artwork comes from for a torrent, and the only place it can: a
	 * `.torrent` carries no poster beside it, unlike a peer's copy, so the media server
	 * identifying the file is the whole of the mechanism.
	 *
	 * Never fatal. The bytes are in the library and the row says so; a media server that
	 * will not answer is a thing to log, not a reason to report a placement that happened
	 * as a failure.
	 */
	private async _announceLanding(
		grab: GrabEntity,
		itemId: string,
		libraryId: string | null,
		path: string,
		bytes: number,
	): Promise<void> {
		try {
			await this._landings.recordFile({
				itemId,
				// No transfer behind it, which is the whole difference: there is no queue
				// row to paint, and `LandingManager` skips that half on its own.
				transferId: null,
				libraryId,
				path,
				bytes,
				contentId: null,
				title: grab.title,
			});
		} catch (error: unknown) {
			this._logger.warn(`${grab.title} was placed but could not be announced: ${reasonOf(error)}`);
		}
	}

	/**
	 * The show an episode belongs to, which is what its folder is named after.
	 *
	 * Without it an episode is filed under its own title: three episodes of one season
	 * land in three folders called *Dulcinea*, *The Big Empty* and *Remember the Cant*,
	 * each with a `Season 01` inside it. The same mistake was found in a sync once, one
	 * show in four folders, and the fix there is the fix here — the naming service takes a
	 * `seriesTitle` precisely because an episode's own title is never the show's.
	 *
	 * The **series'** year and never the season's or the episode's: a media server dates
	 * an episode by when it aired, so building the folder from that gives one folder per
	 * season. A season's title is the fallback for a show row nothing reported, which is
	 * better than the episode's own.
	 */
	/**
	 * The folder the client is told to write into, asked of the client itself.
	 *
	 * In order: what somebody configured here, then the client's own default, then the
	 * first root mapping's remote root.
	 *
	 * The middle one is the fix and it is worth the extra call. A root mapping is a
	 * translation between two spellings of the same directory, not a claim that either
	 * end is writable — and handing its remote side over as the folder to write into is
	 * what told a production client to write into `/home/elewendyl`. It answered
	 * `Permission denied`, the torrent sat in `error` at zero bytes, and the gateway went
	 * on reporting a download in progress. The client's own default cannot have that
	 * problem: it is where it writes everything else.
	 *
	 * A mapping that covers none of it is said out loud rather than left to be discovered
	 * when the copy fails: the download will work and the filing will not, and that is a
	 * sentence worth having in the log before anybody goes looking.
	 */
	private async _savePathFor(client: DownloadClientSettings): Promise<string> {
		const configured = client.savePath?.trim();

		if (configured) {
			return configured;
		}

		const own = await this._clients.get(client.type).defaultSavePath(client);

		if (own === null) {
			return client.rootMappings?.[0]?.remoteRoot ?? '';
		}

		if (mappedLocalPath(own, client.rootMappings ?? []) === null) {
			this._logger.warn(
				`${client.baseUrl} writes into ${own}, which none of this client's root mappings `
				+ 'translate — the downloads will run and the gateway will not be able to file them',
			);
		}

		return own;
	}

	/**
	 * Where a file for this media would go today, for a screen that has to prefill a field.
	 *
	 * The same chain that places it, asked without placing anything: the correction dialog
	 * offers a folder to pin, and a folder field that opened blank made somebody type a
	 * path the gateway had already worked out — or, worse, invent one beside the folder
	 * the series is already in. A series we hold keeps its folder, which is exactly what
	 * `BESIDE_EXISTING` answers here.
	 *
	 * Null rather than a refusal when nothing can be worked out: the field then opens
	 * empty, which is the honest state, and the rule decides at placement as it always
	 * did.
	 */
	public async plannedFolderFor(itemId: string, libraryId: string | null): Promise<string | null> {
		const item = await this._require(itemId);

		return this.plannedDirectory(item, await this._settings.get(), libraryId, null);
	}

	/**
	 * Where a download is expected to land, worked out before it has landed.
	 *
	 * The same chain that will place it, run against the same libraries — a prediction and
	 * never a decision, because it is run again with the bytes in hand and the disk it
	 * answered against may have filled since. Nothing reads the answer to place anything.
	 *
	 * It exists because the queue had nothing to say for the whole length of a download:
	 * `targetPath` is written at the end and `targetFolder` only when somebody chose one,
	 * so a torrent running for six hours showed a library name at best — and "where is
	 * this going to end up" is the question somebody asks while it is still running.
	 *
	 * Null on any failure at all, and the caller draws nothing. A prediction that refused
	 * a download would be a prediction nobody asked for turning into a fault.
	 */
	public async plannedDirectory(
		item: MediaItemEntity,
		settings: Settings,
		libraryId: string | null,
		folder: string | null,
	): Promise<string | null> {
		try {
			const libraries = await this._libraries.placementLibraries();
			const categoryKeys = await this._libraries.categoryKeysByLibrary();
			const show = await this._showFacts(item);
			const pinned = folder ?? await this._pinnedFolder(item);
			const target = await this._placement.resolve({
				kind: item.kind as MediaKind,
				categoryKey: categoryKeys.get(item.libraryId) ?? null,
				settings: pinned
					? { ...settings, placement: PlacementStrategy.FIXED_PATH, fixedPath: pinned }
					: settings,
				libraries,
				preferredLibraryId: libraryId,
				relativeName: (root: string) =>
					this._naming.render(
						settings.namingOrder,
						{
							kind: item.kind as MediaKind,
							title: item.title,
							year: item.year,
							seasonNumber: item.seasonNumber,
							episodeNumber: item.episodeNumber,
							// The show and not the episode, or the folder is named after one
							// episode — the same trap `_showFacts` exists for.
							seriesTitle: show?.title ?? null,
							seriesYear: show?.year ?? null,
							// No file yet, which costs nothing here: the directory comes from
							// the hierarchy above the file rather than from its name.
							sourcePath: null,
						},
						{ libraryRoot: root, siblingPath: null },
					),
				requiredBytes: 0,
			});

			return target.directory;
		} catch (error: unknown) {
			this._logger.debug?.(`Could not work out where ${item.title} would go: ${reasonOf(error)}`);

			return null;
		}
	}

	/**
	 * The folder pinned in the correction dialog for the show this file belongs to.
	 *
	 * Asked of the top of the tree, because that is where somebody pins it: the dialog
	 * offers the field on a series or a film, and every episode of that series is filed
	 * inside the one folder. Reading it off the episode would find nothing and place the
	 * file by the rule, which is the bug this exists to prevent.
	 */
	private async _pinnedFolder(item: MediaItemEntity): Promise<string | null> {
		return pinnedFolderOf(await this._items.topAncestor(item));
	}

	private async _showFacts(
		item: MediaItemEntity,
	): Promise<{ title: string; year: number | null } | null> {
		if (item.kind !== MediaKind.EPISODE || item.parentId === null) {
			return null;
		}

		const season = await this._items.findOne({ where: { id: item.parentId } });
		const show = season?.parentId === null || season?.parentId === undefined
			? null
			: await this._items.findOne({ where: { id: season.parentId } });
		const title = show?.title ?? season?.title ?? null;

		return title === null ? null : { title, year: show?.year ?? null };
	}

	/**
	 * Where one of the client's file names actually is on our disk.
	 *
	 * The client spells a file relative to the directory everything lands in, so a
	 * multi-file torrent says `Torrent.Name/episode.mkv` — but a single-file torrent says
	 * just `episode.mkv` while its content path is the file itself, and some clients
	 * answer the second spelling for a folder too. Both are tried rather than guessed at
	 * from the shape of the torrent, because getting it wrong here files nothing and
	 * reports a file that is missing when it is not.
	 *
	 * Every candidate is checked to be inside the download directory first: the name is
	 * the client's string, and a `..` in it would file into a directory nothing here
	 * chose.
	 */
	private async _fileNamed(
		fileName: string,
		contentPath: string,
		root: string,
	): Promise<string | null> {
		for (const candidate of [resolve(root, fileName), resolve(contentPath, fileName)]) {
			if (!isInside(candidate, root)) {
				continue;
			}

			if ((await this._filesystem.rights(candidate)).readable) {
				return candidate;
			}
		}

		return null;
	}

	/**
	 * The file worth filing out of what a torrent produced.
	 *
	 * A torrent is a folder as often as it is a file, and that folder holds the video
	 * beside a sample, a screenshot, an `.nfo` and sometimes the whole thing again in
	 * another container. The largest file is the one people mean, every time, and any
	 * rule cleverer than that — extensions, names — is a rule that is wrong on somebody's
	 * library.
	 */
	private async _largestFile(path: string): Promise<string | null> {
		const rights = await this._filesystem.rights(path);

		if (!rights.readable) {
			return null;
		}

		const found = await this._filesystem.largestFileUnder(path);

		return found;
	}

	/** Writes a final state once, with its reason, and says so on the stream. */
	private async _settle(
		grab: GrabEntity,
		state: GrabState,
		error: string | null,
	): Promise<void> {
		grab.state = state;
		grab.error = error;
		await this._grabs.save(grab);

		if (error !== null) {
			this._logger.warn(`${grab.title}: ${error}`);
		}

		this._events.emit(EventName.RELEASE_GRAB, toGrabView(grab));
	}

	/**
	 * Where the client wrote it, as this gateway reaches it.
	 *
	 * `contentPath` rather than `savePath`, because the first names the folder or file
	 * the torrent produced and the second names the directory everything lands in —
	 * filing from the second would copy the largest file of the whole download folder,
	 * which is somebody else's torrent as often as it is ours.
	 */
	private _localise(
		status: { savePath: string | null; contentPath: string | null; name: string },
		client: DownloadClientSettings,
	): string {
		const reported =
			status.contentPath ?? join(status.savePath ?? savePathOf(client), status.name);
		// The same translation a media service's paths go through, because it is the
		// same statement: one row per disk, the client's prefix and ours.
		const mapped = mappedLocalPath(reported, client.rootMappings ?? []);

		// A client that reports a path outside the root it was told to write into is
		// answering about somebody else's torrent, or has been reconfigured since. Its
		// own spelling is kept so the failure names a path somebody can go and look at.
		return mapped ?? reported;
	}

	/**
	 * The terms an indexer is asked for, built from the media.
	 *
	 * An episode is searched for by its series' title, because that is what release
	 * names carry — its own title appears in none of them. A season is searched for by
	 * the series' title too, with the coordinate and no episode, which is what makes a
	 * pack come back rather than one file.
	 *
	 * **The kind is asked for and only guessed as a last resort.** It picks the Newznab
	 * categories, so getting it wrong is a search that succeeds and finds nothing: a film
	 * asked for under television answers an empty list and reports no fault, which reads
	 * exactly like a film no tracker carries. A media says which it is; a free-text search
	 * has nothing to read it off, which is why the caller may say — and why the interface
	 * always does. What is left when nobody said anything is television, because a query
	 * with a season in it is the only one that can arrive here unlabelled from an older
	 * client.
	 */
	private async _terms(
		item: MediaItemEntity | null,
		query: ReleaseSearchQuery,
	): Promise<{ term: string; seasonNumber?: number | null; episodeNumber?: number | null; seasonPack?: boolean; kind: ReleaseSearchKind }> {
		if (item === null) {
			return {
				term: query.term ?? '',
				seasonNumber: query.seasonNumber ?? null,
				episodeNumber: query.episodeNumber ?? null,
				seasonPack: query.seasonPack,
				kind: query.kind ?? ReleaseSearchKind.SHOW,
			};
		}

		const show = await this._showTitleOf(item);
		const isShow = item.kind !== MediaKind.MOVIE && item.kind !== MediaKind.COLLECTION;

		return {
			term: query.term?.trim() || show,
			seasonNumber: query.seasonNumber ?? item.seasonNumber,
			episodeNumber: query.seasonPack === true ? null : (query.episodeNumber ?? item.episodeNumber),
			seasonPack: query.seasonPack,
			// Said beats derived, for the same reason a typed term beats the media's title:
			// a media the servers have filed as the wrong kind is an ordinary thing to have
			// to search around, and the whole point of the field is to be able to.
			kind: query.kind ?? (isShow ? ReleaseSearchKind.SHOW : ReleaseSearchKind.MOVIE),
		};
	}

	/** The title release names carry: the show's for anything under one, its own otherwise. */
	private async _showTitleOf(item: MediaItemEntity): Promise<string> {
		let current: MediaItemEntity | null = item;

		// Two hops at most, which is the whole shape of a media tree. A walk with no
		// bound would follow a cycle in a corrupt parent chain for as long as the
		// request lasted.
		for (let depth = 0; depth < 2 && current?.parentId; depth += 1) {
			const parent: MediaItemEntity | null = await this._items.findOne({
				where: { id: current.parentId },
			});

			if (parent === null) {
				break;
			}

			current = parent;
		}

		return current?.title ?? item.title;
	}

	/**
	 * The exact byte counts of every copy we hold of this media.
	 *
	 * Size and nothing else, because it is the only thing a tracker and a filesystem
	 * both report about a file without either having been asked to agree on anything. A
	 * fingerprint would be better and is not available: the file is on somebody else's
	 * machine and has not been downloaded yet.
	 */
	private async _sizesHeld(item: MediaItemEntity | null): Promise<Set<number>> {
		if (item === null) {
			return new Set();
		}

		const sizes = new Set<number>();

		if (item.file?.size) {
			sizes.add(item.file.size);
		}

		for (const child of await this._items.find({ where: { parentId: item.id } })) {
			if (child.file?.size) {
				sizes.add(child.file.size);
			}
		}

		return sizes;
	}

	/** Keeps the last search grabbable, one entry per release. */
	private async _remember(releases: Release[]): Promise<void> {
		await Promise.all(
			releases.map((release) =>
				this._cache.set(`release:${release.id}`, release, SEARCH_TTL_SECONDS),
			),
		);
	}

	private _recall(id: string): Promise<Release | null> {
		return this._cache.get<Release>(`release:${id}`);
	}

	private async _require(itemId: string): Promise<MediaItemEntity> {
		const item = await this._items.findOne({ where: { id: itemId } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return item;
	}
}

/**
 * What a release group would fill, out of what is missing.
 *
 * A pack claims its whole season and a name that spells its episodes claims exactly
 * those — and the difference decides whether a line is worth anything at all. A release
 * that fills nothing is still shown: "you already have this one" is an answer, and a
 * list that hid it would look like a search that found less than it did.
 */
const fillsOf = (group: ReleaseGroup, missing: EpisodeRef[]): EpisodeRef[] => {
	const { coverage } = group;

	if (coverage.wholeSeries) {
		return missing;
	}

	if (coverage.wholeSeason) {
		return missing.filter((one) => one.seasonNumber === coverage.seasonNumber);
	}

	if (coverage.episodeNumbers.length > 0) {
		return missing.filter(
			(one) =>
				one.seasonNumber === coverage.seasonNumber &&
				one.episodeNumber !== null &&
				coverage.episodeNumbers.includes(one.episodeNumber),
		);
	}

	// A film, or a name nothing could be read off. The first fills the one thing there
	// is to fill; the second claims nothing, because a guess here grabs the wrong file.
	return group.kind === ReleaseKind.MOVIE ? missing : [];
};

/**
 * Where the client is told to write.
 *
 * The first mapping's remote root unless somebody named something else: a client
 * already configured to put everything in one folder needs no second opinion from us,
 * and a path we invent is a path nothing maps back.
 */
const savePathOf = (client: DownloadClientSettings): string =>
	client.savePath?.trim() || client.rootMappings?.[0]?.remoteRoot || '';

/**
 * The episodes a release names that nobody here has ever reported.
 *
 * Not a gap and not a mistake: a show that is still running puts out an episode and no
 * server in the household knows it exists until one of them indexes it. Against the
 * missing list alone those rows look like releases of nothing, which is exactly
 * backwards — they are the only rows carrying news.
 *
 * A pack claims a season rather than an enumeration, so it can only be said to bring
 * something new when the season itself is unknown here. Claiming more would put a
 * number on screen that nothing supports.
 */
const newIn = (group: ReleaseGroup, known: Set<string>): { seasonNumber: number | null; episodeNumber: number | null }[] => {
	const { coverage } = group;

	if (coverage.episodeNumbers.length > 0) {
		return coverage.episodeNumbers
			.map((episodeNumber) => ({ seasonNumber: coverage.seasonNumber, episodeNumber }))
			.filter((one) => !known.has(`${one.seasonNumber ?? ''}:${one.episodeNumber ?? ''}`));
	}

	if (coverage.wholeSeason && coverage.seasonNumber !== null) {
		const seen = [...known].some((key) => key.startsWith(`${coverage.seasonNumber}:`));

		return seen ? [] : [{ seasonNumber: coverage.seasonNumber, episodeNumber: null }];
	}

	return [];
};

/** A media's coordinate, which is what a plan and a partial grab are keyed on. */
const keyOf = (one: EpisodeRef): string => `${one.seasonNumber ?? ''}:${one.episodeNumber ?? ''}`;

const refOf = (group: { id: string; seasonNumber: number | null; episodeNumber: number | null; title: string }): EpisodeRef => ({
	itemId: group.id,
	seasonNumber: group.seasonNumber,
	episodeNumber: group.episodeNumber,
	title: group.title,
});

/**
 * The wire shape.
 *
 * The rate is the client's and is not stored: it is true for one second and a column
 * holding it would be a number that is wrong whenever nothing is polling.
 */
const toGrabView = (grab: GrabEntity, rate = 0): ReleaseGrabView => ({
	id: grab.id,
	itemId: grab.itemId,
	title: grab.title,
	indexer: grab.indexer,
	state: grab.state,
	clientId: grab.clientId,
	bytesDone: Number(grab.bytesDone ?? 0),
	bytesTotal: Number(grab.bytesTotal ?? 0),
	rate,
	savePath: grab.sourcePath,
	targetPath: grab.targetPath,
	targetLibraryId: grab.targetLibraryId,
	targetFolder: grab.targetFolder,
	plannedPath: grab.plannedPath ?? null,
	placements: grab.placements ?? [],
	error: grab.error,
	createdAt: grab.createdAt.toISOString(),
	updatedAt: grab.updatedAt.toISOString(),
});
