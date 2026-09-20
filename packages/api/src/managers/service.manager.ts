import {
	ErrorKey,
	EventName,
	LibraryKind,
	MediaServiceStatus,
	type CreateMediaServiceRequest,
	type MediaCompanions,
	type Library,
	type MediaService,
	type MediaServiceProbe,
	type MediaServiceType,
	type UpdateMediaServiceRequest,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Library as LibraryEntity, MediaItem, MediaService as MediaServiceEntity } from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
	applyOverride,
	detectCompanions,
	FingerprintService,
	normalizeTitle,
	toLocalPath,
	EventGatewayService,
	HandlerRegistry,
	QualityService,
	type MediaServiceHandler,
	type NormalisedLibrary,
	type NormalisedMediaItem,
	type ServiceConnection,
} from '@/services';
import { LibraryManager } from './library.manager';
import { toLibrary, toMediaService } from './mappers';
import { MediaManager } from './media.manager';

/**
 * How many times one reconciliation may climb the tree.
 *
 * Episode to season to series is two hops, and the third is slack for a service that
 * models one level more. It is a ceiling rather than a `while`: a far end answering
 * with a cycle — an item claiming its own child as its parent — would otherwise hang
 * a scan with no error anywhere.
 */
const PARENT_HOPS = 3;

/** Testing a connection that nothing has registered yet. */
export interface ProbeRequest {
	type: MediaServiceType;
	baseUrl: string;
	token?: string;
	username?: string;
	password?: string;
}

/**
 * Registering media services, and keeping the index of what they hold.
 *
 * Two things are worth knowing before reading it.
 *
 * The first is that a probe is offered before a service is registered. That is what
 * lets the form say the token is wrong while somebody is still typing it, instead of
 * after they have saved a service that does not work and have to guess which of the
 * four fields they got wrong.
 *
 * The second is that a scan and a refresh are the same walk with different reach, and
 * both run detached from the request that asked for them. A full scan of a large
 * library takes minutes; a request that waited for it would time out in a proxy
 * somewhere in the middle, leaving the scan running and the caller with nothing.
 */
@Injectable()
export class ServiceManager {
	private readonly _logger = new Logger(ServiceManager.name);

	/**
	 * Indexing passes in flight, by service.
	 *
	 * A second scan of the same service while the first is running would have two
	 * walks writing the same rows, and the loser's stale-item pass would delete what
	 * the winner had just written.
	 */
	private readonly _indexing = new Map<string, Promise<void>>();

	public constructor(
		private readonly _services: MediaServiceRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _items: MediaItemRepository,
		private readonly _fingerprints: FingerprintService,
		private readonly _matches: MediaMatchRepository,
		private readonly _handlers: HandlerRegistry,
		private readonly _quality: QualityService,
		private readonly _media: MediaManager,
		private readonly _events: EventGatewayService,
		private readonly _libraryManager: LibraryManager,
	) {}

	public async list(): Promise<MediaService[]> {
		const services = await this._services.findByPriority();

		return Promise.all(services.map((service) => this._present(service)));
	}

	public async read(id: string): Promise<MediaService> {
		return this._present(await this._require(id));
	}

	/**
	 * Register a service.
	 *
	 * The duplicate check is on the base URL and the owning peer together, which is
	 * the pair the unique index carries. The same address on two different peers is
	 * two different machines — everybody's Jellyfin is on `http://jellyfin:8096` —
	 * while the same address twice on ours is the same server registered twice, and
	 * that produces two of everything it holds.
	 */
	public async create(request: CreateMediaServiceRequest): Promise<MediaService> {
		const baseUrl = this._normaliseUrl(request.baseUrl);

		if ((await this._services.findByBaseUrl(baseUrl, null)) !== null) {
			throw new ConflictException(ErrorKey.SERVICE_DUPLICATE);
		}

		const probe = await this._probe({ ...request, baseUrl });

		const service = await this._services.save(
			this._services.create({
				name: request.name,
				type: request.type,
				// Absent means shared, for the same reason the gateway's default
				// visibility is a real level rather than silence: a service registered
				// and quietly invisible shows a friend an empty shelf, and they read
				// that as a link that failed rather than as a switch nobody flipped.
				shared: request.shared ?? true,
				baseUrl,
				token: request.token ?? null,
				username: request.username ?? null,
				password: request.password ?? null,
				authProvider: request.authProvider ?? false,
				priority: request.priority ?? 100,
				remoteRoot: this._normaliseRoot(request.remoteRoot),
				localRoot: this._normaliseRoot(request.localRoot),
				status: this._statusOf(probe),
				version: probe.version,
				lastProbeAt: new Date(),
			}),
		);

		await this._adoptLibraries(service, probe.libraries);

		// Re-read rather than presented from the row saved above. Adopting the
		// libraries derives whether we hold the files, and the object in hand still
		// carries the answer from before that ran — a service registered with its root
		// mapping would be reported remote in the very response that created it.
		return this._present(await this._require(service.id));
	}

	/**
	 * Change a registration.
	 *
	 * A field that is not sent is not changed, and that matters most for the secrets:
	 * a form that shows no token because tokens are never returned would otherwise
	 * clear the stored one every time somebody renames a service.
	 */
	public async update(id: string, patch: UpdateMediaServiceRequest): Promise<MediaService> {
		const service = await this._requireWithSecrets(id);

		/*
		 * A peer's registration is not editable, and the refusal lives here rather than
		 * in the screen that declines to offer the form.
		 *
		 * Nothing this shape carries means anything for one: their files are on their
		 * machine, so a root mapping stored here could never resolve while making the
		 * service look configured; the link authenticates by key fingerprint, so there
		 * is no token; and the address is `peer://<uuid>`, not something anybody types.
		 * Renaming, the hop limit, forbidding reading, removing and banning are all peer
		 * routes — this row follows the peer rather than being configured beside it.
		 */
		if (service.peerId !== null) {
			throw new ConflictException(ErrorKey.SERVICE_PEER_NOT_EDITABLE);
		}

		const nextUrl = patch.baseUrl === undefined ? service.baseUrl : this._normaliseUrl(patch.baseUrl);

		if (nextUrl !== service.baseUrl) {
			const clash = await this._services.findByBaseUrl(nextUrl, service.peerId);

			if (clash !== null && clash.id !== service.id) {
				throw new ConflictException(ErrorKey.SERVICE_DUPLICATE);
			}
		}

		service.name = patch.name ?? service.name;
		service.type = patch.type ?? service.type;
		// Never re-defaulted on an edit. A patch sent for an unrelated field must not
		// start sharing something somebody deliberately turned off.
		service.shared = patch.shared ?? service.shared;
		service.baseUrl = nextUrl;
		service.token = patch.token ?? service.token;
		service.username = patch.username ?? service.username;
		service.password = patch.password ?? service.password;
		service.authProvider = patch.authProvider ?? service.authProvider;
		service.priority = patch.priority ?? service.priority;

		const rootsMoved =
			(patch.remoteRoot !== undefined && this._normaliseRoot(patch.remoteRoot) !== service.remoteRoot)
			|| (patch.localRoot !== undefined && this._normaliseRoot(patch.localRoot) !== service.localRoot);

		if (patch.remoteRoot !== undefined) {
			service.remoteRoot = this._normaliseRoot(patch.remoteRoot);
		}

		if (patch.localRoot !== undefined) {
			service.localRoot = this._normaliseRoot(patch.localRoot);
		}

		const saved = await this._services.save(service);

		// A corrected mapping is worthless until something re-reads it, and the next
		// thing that would have is a scan somebody may not run for a day. Correcting a
		// path and seeing the libraries still pointing at the old one is how people
		// conclude the field does nothing.
		// Re-derives whether the files are ours, in both directions: a service
		// registered before anybody mapped its folders becomes a destination here, and
		// one whose mapping is withdrawn stops being one.
		if (rootsMoved) {
			await this._libraryManager.applyRootMapping(saved);
		}

		// Re-probed whenever anything that decides reachability moved, so the status on
		// screen is about the registration as it stands and not as it was saved.
		if (patch.baseUrl !== undefined || patch.token !== undefined || patch.password !== undefined) {
			await this.probe(saved.id);
		}

		return this._present(await this._require(saved.id));
	}

	public async remove(id: string): Promise<void> {
		const service = await this._require(id);

		// The rows a foreign key cannot reach: a match names services on both sides, and
		// only one of them cascades.
		await this._matches.deleteForService(service.id);
		await this._services.delete({ id: service.id });
	}

	/** Test a connection nobody has registered. Answers, never throws. */
	public probeUnregistered(request: ProbeRequest): Promise<MediaServiceProbe> {
		return this._probe(request);
	}

	/**
	 * Test a registered connection and record what it said.
	 *
	 * The status is written even when the probe failed — that is the whole point of
	 * the column, and a service that has gone offline is something the interface has
	 * to be able to show without asking again itself.
	 */
	public async probe(id: string): Promise<MediaServiceProbe> {
		const service = await this._requireWithSecrets(id);
		const probe = await this._probe({
			type: service.type,
			baseUrl: service.baseUrl,
			token: service.token ?? undefined,
			username: service.username ?? undefined,
			password: service.password ?? undefined,
		});
		const status = this._statusOf(probe);
		const at = new Date();

		await this._services.setStatus(service.id, status, probe.version, at);

		this._events.emit(EventName.SERVICE_STATUS, {
			id: service.id,
			status,
			lastProbeAt: at.toISOString(),
		});

		if (probe.reachable && probe.authenticated) {
			await this._adoptLibraries(service, probe.libraries);
		}

		return probe;
	}

	public async libraries(id: string): Promise<Library[]> {
		await this._require(id);

		const libraries = await this._libraries.findByService(id);

		return libraries.map(toLibrary);
	}

	/**
	 * Re-read everything, forgetting the cursor.
	 *
	 * Rare and expensive, and the only thing that notices a file moved, deleted or
	 * re-encoded in place: a refresh only ever sees what a service reports as new.
	 */
	public async scan(id: string): Promise<void> {
		await this._require(id);

		this._start(id, true);
	}

	/** Ask what changed since the cursor. A few dozen rows, every few minutes. */
	public async refresh(id: string): Promise<void> {
		await this._require(id);

		this._start(id, false);
	}

	/**
	 * Fire the indexing pass and return.
	 *
	 * Deliberately not awaited: the caller is an HTTP request that answers `202`, and
	 * the progress goes out on the event stream. The promise is kept so a second call
	 * joins the first instead of starting a competing walk.
	 */
	private _start(serviceId: string, full: boolean): void {
		if (this._indexing.has(serviceId)) {
			return;
		}

		const pass = this._index(serviceId, full)
			.catch((error: unknown) => {
				this._logger.error(`Indexing ${serviceId} failed: ${String(error)}`);
			})
			.finally(() => {
				this._indexing.delete(serviceId);
			});

		this._indexing.set(serviceId, pass);
	}

	private async _index(serviceId: string, full: boolean): Promise<void> {
		const service = await this._requireWithSecrets(serviceId);
		const handler = this._handlers.get(service.type);
		const connection = this._connection(service);
		const libraries = await this._libraries.findByService(service.id);
		const walked: { library: LibraryEntity; itemsSeen: number }[] = [];

		for (const library of libraries) {
			const described = this._describe(library);
			const seen: string[] = [];
			let itemsSeen = 0;

			if (full) {
				for await (const item of handler.scanLibrary(connection, described)) {
					await this._persist(service, library, item);
					seen.push(item.externalId);
					itemsSeen += 1;

					// Every page rather than every row: a frame per episode on a library of
					// forty thousand is thousands of frames for a bar that moves by a pixel.
					if (itemsSeen % 100 === 0) {
						this._progress(service.id, library.id, itemsSeen, false);
					}
				}

				await this._forgetStale(library, seen);
				await this._libraries.setScanCursor(library.id, null);
				await this._libraries.update({ id: library.id }, { lastScanAt: new Date() });
			} else {
				const refresh = await handler.refreshLibrary(connection, described, library.scanCursor);

				for (const item of refresh.items) {
					await this._persist(service, library, item);
					itemsSeen += 1;
				}

				await this._libraries.setScanCursor(library.id, refresh.cursor);
			}

			walked.push({ library, itemsSeen });
		}

		/*
		 * Between the walk and the summaries, and it has to be both.
		 *
		 * After, because a parent may be enumerated at any point — or in another
		 * library of the same service — so nothing can be concluded about a missing
		 * link until the whole service has been read. Before, because `_recompute`
		 * derives the child counts and the quality rollup from `parentId`: run it
		 * first and every season linked here would carry a summary of nothing until
		 * somebody scanned again.
		 */
		await this._reconcileParents(service, handler, connection, libraries);

		for (const { library, itemsSeen } of walked) {
			await this._fingerprint(library);
			await this._recompute(library);
			this._progress(service.id, library.id, itemsSeen, true);
		}

		await this._services.update({ id: service.id }, { lastScanAt: new Date() });
		// Correlation belongs to the media manager: it owns the index and the match
		// rows, and the decision about what two rows are the same media is the same
		// decision whether a scan or a person triggered it.
		await this._media.correlateService(service.id);

		this._progress(service.id, null, 0, true);
	}

	/**
	 * Derive a content identity for the files the gateway can actually read.
	 *
	 * Neither media server publishes one, so without this the only correlation signals
	 * are identifiers and titles — and two libraries that disagree about both are
	 * exactly the case content identity exists for. A library with a `localPath` is one
	 * somebody has told us we can read, which is the whole condition: many households
	 * run a Plex and a Jellyfin over the same disk, and there the fingerprint is three
	 * reads away.
	 *
	 * Only files that have none are read, so this costs something once and nothing
	 * afterwards. Every failure is swallowed: an unreadable file is the normal case for
	 * a library mounted read-only, or half-mounted, or on a NAS that went to sleep, and
	 * none of that should fail a scan.
	 *
	 * The same pass reads what sits beside each file — the `.nfo`, the poster, the
	 * subtitles — because it is already in the directory and the answer cannot be got
	 * any other way: no media server reports whether a description file exists, only
	 * what it managed to read out of one.
	 */
	private async _fingerprint(library: LibraryEntity): Promise<void> {
		if (library.localPath === null || library.localPath === '') {
			return;
		}

		const items = await this._items.findFingerprintable(library.id);
		let done = 0;

		for (const item of items) {
			const path = toLocalPath(library, item.file?.path ?? null);

			if (path === null || item.file === null) {
				continue;
			}

			try {
				const { quickHash, size } = await this._fingerprints.fingerprint(path);

				item.file = {
					...item.file,
					quickHash,
					contentId: this._fingerprints.contentId(quickHash, size),
				};
				item.companions = await this._companionsOf(path);

				await this._items.save(item);
				done += 1;
			} catch {
				continue;
			}
		}

		if (done > 0) {
			this._logger.log(`Fingerprinted ${done} file(s) of library ${library.name}`);
		}
	}

	/**
	 * What sits beside one file, or null when the directory cannot be read.
	 *
	 * Null and "nothing there" are different answers and the interface acts on the
	 * difference — one asks for a scan, the other offers to fetch the companions — so
	 * an unreadable directory must not be reported as an empty one.
	 */
	private async _companionsOf(path: string): Promise<MediaCompanions | null> {
		try {
			return detectCompanions(await readdir(dirname(path)), basename(path));
		} catch {
			return null;
		}
	}

	/**
	 * Write one item, creating it the first time we see it.
	 *
	 * The parent is resolved by looking its external identifier up in our own rows,
	 * which only succeeds when the parent happens to have been written already. That
	 * is a coincidence and nothing here depends on it: the identifier the service
	 * reported is stored on the row, so the link can be made whenever the parent turns
	 * up. Order is not a dependency — `_reconcileParents` closes the gap after the
	 * walk, whichever way round the service listed things.
	 *
	 * Failing here instead would drop the episode entirely, which is a worse answer
	 * than an item that sits at the root until the pass at the end of the scan.
	 */
	private async _persist(
		service: MediaServiceEntity,
		library: LibraryEntity,
		item: NormalisedMediaItem,
	): Promise<MediaItem> {
		const existing = await this._items.findByExternalId(service.id, item.externalId);
		const parent =
			item.parentExternalId === null
				? null
				: await this._items.findByExternalId(service.id, item.parentExternalId);

		const row =
			existing ??
			this._items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: item.externalId,
			});

		row.libraryId = library.id;
		row.parentId = parent?.id ?? row.parentId ?? null;
		/*
		 * The link and the identifier behind it are kept or replaced together.
		 *
		 * A report that names no parent is far more often a thin payload — a refresh
		 * answering with fewer fields than a scan — than a genuine reparenting, and
		 * unfiling a whole season on that basis costs more than keeping a stale link
		 * for one pass. `parentId` already worked this way; letting the identifier
		 * follow a different rule would leave the two describing different parents,
		 * and the reconciliation would then undo what this line just protected.
		 */
		row.parentExternalId = item.parentExternalId ?? row.parentExternalId ?? null;
		row.kind = item.kind;
		row.title = item.title;
		row.normalizedTitle = item.normalizedTitle;
		row.year = item.year;
		row.seasonNumber = item.seasonNumber;
		row.episodeNumber = item.episodeNumber;
		row.externalIds = item.externalIds;
		row.overview = item.overview;
		row.artworkUrl = item.artworkUrl;
		row.file = item.file;
		row.addedAt = item.addedAt === null ? null : new Date(item.addedAt);

		/*
		 * A correction somebody made survives the scan that would otherwise undo it.
		 *
		 * Everything above has just written what the service says, which is exactly what
		 * a rescan is for — and exactly what erases a hand-corrected season number, a
		 * reclassified documentary, a show renamed to what the household actually calls
		 * it. Re-applying here is what makes those corrections stick, and it is the
		 * whole reason the instruction is kept rather than only its result.
		 */
		if (row.overrides !== null && row.overrides !== undefined) {
			row.reported = null;
			applyOverride(row, row.overrides, normalizeTitle);
		}

		return this._items.save(row);
	}

	/**
	 * Make the tree agree with what the items said, whatever order they arrived in.
	 *
	 * This exists because the obvious fix does not work. A child can only be linked to
	 * a parent that already has a row, and no media server offers an enumeration where
	 * that is guaranteed: Jellyfin pages by `SortName` because index paging is only
	 * stable under a stable sort, and alphabetically `Season 1` precedes
	 * `The Expanse`. Sorting by kind instead does not save it either — a refresh
	 * legitimately reports one new episode of a series nobody has ever seen. So the
	 * order is not made right, it is made irrelevant: every row carries the parent it
	 * names, and the link is derived from that afterwards.
	 *
	 * Two steps, cheapest first.
	 *
	 * The first is a single statement per service that links every child whose parent
	 * is already in the index. That is the case that actually happens, and it has to
	 * cost one query rather than one per row: a library of forty thousand episodes
	 * would otherwise turn every scan into forty thousand round trips for a repair
	 * touching a handful of rows.
	 *
	 * The second is for a parent the service never enumerated at all. It is asked for
	 * by identifier, once per distinct missing parent — never once per child, which is
	 * the same forty thousand requests wearing a different hat — and the real row
	 * comes back with the server's own title, year and artwork. Nothing is synthesised
	 * from what a child says about its parent: a made-up row would have to be
	 * recognised and merged the day the real one appears, and there is no need for
	 * either when the server can simply be asked.
	 *
	 * The loop walks up: fetching a season can reveal that its series is missing too.
	 * It is bounded because a service answering with a cycle — by accident or
	 * otherwise — must not hang a scan, and because episode to season to series is the
	 * deepest tree this model has.
	 */
	private async _reconcileParents(
		service: MediaServiceEntity,
		handler: MediaServiceHandler,
		connection: ServiceConnection,
		libraries: LibraryEntity[],
	): Promise<void> {
		const byId = new Map(libraries.map((library) => [library.id, library]));
		const asked = new Set<string>();

		for (let hop = 0; ; hop += 1) {
			const linked = await this._items.linkKnownParents(service.id);

			if (linked > 0) {
				this._logger.log(`Linked ${linked} item(s) of ${service.name} to a parent that came later`);
			}

			if (hop >= PARENT_HOPS) {
				return;
			}

			// Identifiers already asked for are skipped rather than retried: a parent the
			// service does not return stays missing for the whole pass, and asking again
			// on every hop would multiply the requests by the depth of the tree.
			const missing = (await this._items.findUnresolvedParents(service.id)).filter(
				(entry) => !asked.has(entry.parentExternalId),
			);

			if (missing.length === 0) {
				return;
			}

			let fetched = 0;

			for (const entry of missing) {
				asked.add(entry.parentExternalId);

				const library = byId.get(entry.libraryId);

				if (library === undefined) {
					continue;
				}

				/*
				 * A fetch that fails must not fail the scan.
				 *
				 * A server that has gone slow, or that deleted the series after listing
				 * its episodes, leaves the children exactly where they were — present and
				 * unlinked. Showing an episode at the root of a library is a visible
				 * annoyance; losing it because one request timed out is a hole in the
				 * index nobody would think to look for.
				 */
				const parent = await handler
					.getItem(connection, entry.parentExternalId)
					.catch(() => null);

				if (parent === null) {
					continue;
				}

				// Filed in the library its children are in. A parent lives where its
				// children do, and the alternative — asking which library holds it —
				// costs a request per parent to answer a question nothing downstream asks.
				await this._persist(service, library, parent);
				fetched += 1;
			}

			if (fetched === 0) {
				return;
			}

			this._logger.log(`Fetched ${fetched} parent(s) that ${service.name} did not enumerate`);
		}
	}

	/**
	 * Drop what a full scan no longer saw.
	 *
	 * A media service never says that a file is gone; it simply stops listing it.
	 * Comparing what the walk saw against what we hold is the only way to notice, and
	 * it is why a full scan exists at all.
	 */
	private async _forgetStale(library: LibraryEntity, seen: string[]): Promise<void> {
		const stale = await this._items.findStale(library.id, seen);

		if (stale.length === 0) {
			return;
		}

		const removable = await this._withoutLivingChildren(library, stale);

		if (removable.length === 0) {
			return;
		}

		this._logger.log(`${removable.length} items disappeared from ${library.name}`);

		await this._matches.deleteForItems(removable.map((item) => item.id));
		await this._items.remove(removable);
	}

	/**
	 * Of the rows a walk did not report, the ones nothing still hangs from.
	 *
	 * Not every service enumerates every level. One that lists seasons and episodes
	 * but not the series has its series rows fetched by the reconciliation, by
	 * identifier — so they are never in what the walk saw, and the plain rule would
	 * delete them at the very next scan. That is not a cosmetic loss: the children
	 * keep pointing at a row that no longer exists, which makes them neither roots nor
	 * reachable under anything, and a whole show disappears from the library screen
	 * without a single error.
	 *
	 * A show that was genuinely removed still goes: its episodes stopped being
	 * reported too, so they are stale in the same pass and spare nothing.
	 *
	 * Decided in memory over the library's rows, which is the same read `_recompute`
	 * is about to do and the same tradeoff: a query per stale row would be thousands
	 * of round trips for a pass whose whole job is a handful of deletions.
	 */
	private async _withoutLivingChildren(
		library: LibraryEntity,
		stale: MediaItem[],
	): Promise<MediaItem[]> {
		const doomed = new Set(stale.map((item) => item.id));
		const rows = await this._items.find({ where: { libraryId: library.id } });
		const byId = new Map(rows.map((item) => [item.id, item]));

		for (const row of rows) {
			if (doomed.has(row.id)) {
				continue;
			}

			let parentId = row.parentId;

			// Everything above something that survives survives with it, and the climb
			// continues past each row it spares so a grandparent is reached too. Bounded
			// like every other walk up this tree: a service answering with a cycle must
			// not hang a scan.
			for (let hop = 0; hop < PARENT_HOPS && parentId !== null; hop += 1) {
				if (!doomed.delete(parentId)) {
					break;
				}

				parentId = byId.get(parentId)?.parentId ?? null;
			}
		}

		return stale.filter((item) => doomed.has(item.id));
	}

	/**
	 * Recount children and re-summarise quality for a whole library.
	 *
	 * Done in memory over the library's rows rather than with a query per node: a
	 * series page shows the summary of every season, and walking the subtree per
	 * season turns a list of thirty series into thousands of queries. The cost is one
	 * pass holding the library's rows, which is what a scan was doing anyway.
	 */
	private async _recompute(library: LibraryEntity): Promise<void> {
		const items = await this._items.find({ where: { libraryId: library.id } });
		const children = new Map<string, MediaItem[]>();

		for (const item of items) {
			if (item.parentId !== null) {
				children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
			}
		}

		const files = new Map<string, (MediaItem['file'])[]>();
		const collect = (item: MediaItem): MediaItem['file'][] => {
			const cached = files.get(item.id);

			if (cached) {
				return cached;
			}

			const own = item.file === null ? [] : [item.file];
			const below = (children.get(item.id) ?? []).flatMap(collect);
			const all = [...own, ...below];

			files.set(item.id, all);

			return all;
		};

		const changed: MediaItem[] = [];

		for (const item of items) {
			const childCount = (children.get(item.id) ?? []).length;
			const quality = this._quality.summarise(collect(item));
			const next = quality.fileCount === 0 ? null : quality;

			if (item.childCount !== childCount || JSON.stringify(item.quality) !== JSON.stringify(next)) {
				item.childCount = childCount;
				item.quality = next;
				changed.push(item);
			}
		}

		if (changed.length > 0) {
			await this._items.save(changed, { chunk: 200 });
		}

		await this._libraries.setItemCount(library.id, items.length);
	}

	/**
	 * Create or update the library rows a probe reported.
	 *
	 * `localPath`, `writable` and `isDefaultTarget` are never touched: they are what
	 * somebody configured on this side, and a service that renames a library must not
	 * silently take away the path a sync writes to.
	 */
	private async _adoptLibraries(
		service: MediaServiceEntity,
		reported: MediaServiceProbe['libraries'],
	): Promise<void> {
		for (const entry of reported) {
			const existing = await this._libraries.findByExternalId(service.id, entry.externalId);

			if (existing === null) {
				await this._libraries.save(
					this._libraries.create({
						serviceId: service.id,
						externalId: entry.externalId,
						name: entry.name,
						kind: entry.kind ?? LibraryKind.OTHER,
						paths: entry.paths,
					}),
				);

				continue;
			}

			existing.name = entry.name;
			existing.kind = entry.kind ?? existing.kind;
			existing.paths = entry.paths;

			await this._libraries.save(existing);
		}

		// After the rows carry what the service just reported, never before: the
		// mapping is applied to the reported paths, and applying it to the previous
		// ones would derive a directory the service has stopped reading from.
		await this._libraryManager.applyRootMapping(service);
	}

	private async _probe(request: ProbeRequest): Promise<MediaServiceProbe> {
		const handler = this._handlers.find(request.type);

		if (handler === null) {
			return {
				reachable: false,
				authenticated: false,
				type: request.type,
				version: null,
				serverName: null,
				libraries: [],
				error: ErrorKey.SERVICE_HANDLER_UNKNOWN,
			};
		}

		try {
			return await handler.probe({
				id: 'probe',
				type: request.type,
				baseUrl: this._normaliseUrl(request.baseUrl),
				token: request.token ?? null,
				username: request.username ?? null,
				password: request.password ?? null,
			});
		} catch (error) {
			// A probe answers; it does not throw. An unreachable server and a wrong
			// token are both ordinary results the settings screen renders, and turning
			// them into exceptions only moves the mapping somewhere less convenient.
			this._logger.warn(`Probe of ${request.baseUrl} failed: ${String(error)}`);

			return {
				reachable: false,
				authenticated: false,
				type: request.type,
				version: null,
				serverName: null,
				libraries: [],
				error: ErrorKey.SERVICE_UNREACHABLE,
			};
		}
	}

	private _statusOf(probe: MediaServiceProbe): MediaServiceStatus {
		if (!probe.reachable) {
			return MediaServiceStatus.OFFLINE;
		}

		return probe.authenticated ? MediaServiceStatus.ONLINE : MediaServiceStatus.UNAUTHORIZED;
	}

	private _connection(service: MediaServiceEntity): ServiceConnection {
		return {
			id: service.id,
			type: service.type,
			baseUrl: service.baseUrl,
			token: service.token,
			username: service.username,
			password: service.password,
		};
	}

	private _describe(library: LibraryEntity): NormalisedLibrary {
		return {
			externalId: library.externalId,
			name: library.name,
			kind: library.kind,
			paths: library.paths,
		};
	}

	private _progress(
		serviceId: string,
		libraryId: string | null,
		itemsSeen: number,
		done: boolean,
	): void {
		this._events.emit(EventName.SCAN_PROGRESS, {
			serviceId,
			libraryId,
			itemsSeen,
			itemsTotal: null,
			done,
		});
	}

	/**
	 * An emptied root is no mapping, not an empty prefix.
	 *
	 * Stored as `''` it would match the start of every path in existence and derive
	 * the whole filesystem into `localRoot`, which is the one outcome worse than
	 * deriving nothing.
	 */
	private _normaliseRoot(root: string | null | undefined): string | null {
		return root?.trim().replace(/\/+$/, '') || null;
	}

	/** A trailing slash is the same server, and the unique index does not know that. */
	private _normaliseUrl(baseUrl: string): string {
		return baseUrl.trim().replace(/\/+$/, '');
	}

	private async _present(service: MediaServiceEntity): Promise<MediaService> {
		return toMediaService(service, {
			libraryCount: await this._libraries.count({ where: { serviceId: service.id } }),
			itemCount: await this._items.countByService(service.id),
		});
	}

	private async _require(id: string): Promise<MediaServiceEntity> {
		const service = await this._services.findOne({ where: { id } });

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		return service;
	}

	private async _requireWithSecrets(id: string): Promise<MediaServiceEntity> {
		const service = await this._services.findWithSecrets(id);

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		return service;
	}
}
