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
	type NormalisedLibrary,
	type NormalisedMediaItem,
	type ServiceConnection,
} from '@/services';
import { toLibrary, toMediaService } from './mappers';
import { MediaManager } from './media.manager';

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
				scope: request.scope,
				baseUrl,
				token: request.token ?? null,
				username: request.username ?? null,
				password: request.password ?? null,
				authProvider: request.authProvider ?? false,
				priority: request.priority ?? 100,
				status: this._statusOf(probe),
				version: probe.version,
				lastProbeAt: new Date(),
			}),
		);

		await this._adoptLibraries(service, probe.libraries);

		return this._present(service);
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
		const nextUrl = patch.baseUrl === undefined ? service.baseUrl : this._normaliseUrl(patch.baseUrl);

		if (nextUrl !== service.baseUrl) {
			const clash = await this._services.findByBaseUrl(nextUrl, service.peerId);

			if (clash !== null && clash.id !== service.id) {
				throw new ConflictException(ErrorKey.SERVICE_DUPLICATE);
			}
		}

		service.name = patch.name ?? service.name;
		service.type = patch.type ?? service.type;
		service.scope = patch.scope ?? service.scope;
		service.baseUrl = nextUrl;
		service.token = patch.token ?? service.token;
		service.username = patch.username ?? service.username;
		service.password = patch.password ?? service.password;
		service.authProvider = patch.authProvider ?? service.authProvider;
		service.priority = patch.priority ?? service.priority;

		const saved = await this._services.save(service);

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
	 * which works because a handler yields parents before children. When it does not —
	 * a refresh that reports one new episode of a series we have never seen — the item
	 * lands with a null parent and the next full scan puts it in its place. Failing
	 * instead would drop the episode entirely.
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
		if (row.overrides !== null) {
			row.reported = null;
			applyOverride(row, row.overrides, normalizeTitle);
		}

		return this._items.save(row);
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

		this._logger.log(`${stale.length} items disappeared from ${library.name}`);

		await this._matches.deleteForItems(stale.map((item) => item.id));
		await this._items.remove(stale);
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
