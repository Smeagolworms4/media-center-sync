import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import {
	EventName,
	MediaLandingState,
	MediaServiceMode,
	SyncState,
	TransferState,
} from '@mcs/shared';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type {
	Library as LibraryEntity,
	MediaItem as MediaItemEntity,
	MediaLanding as MediaLandingEntity,
	MediaService as MediaServiceEntity,
	Transfer as TransferEntity,
} from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	EventGatewayService,
	HandlerRegistry,
	LANDING_GRACE_MS,
	LANDING_SETTLE_MS,
	landingSyncState,
	RescanOutcome,
	serviceMode,
	SettingsService,
	toLocalPath,
	TransferEngineService,
} from '@/services';
import { toConnection } from './mappers';

/**
 * Asked to re-read one of our own services, once a file has landed in it.
 *
 * A callback rather than an injected `ServiceManager`, and that is not decoration:
 * the service manager already has to call back into this one to reconcile after each
 * pass, so injecting it here would be a cycle Nest resolves only with a `forwardRef`
 * and a note nobody reads. The engine's source resolver is registered the same way,
 * for the same reason.
 */
export type RescanListener = (serviceId: string) => void;

/**
 * One file that has just been put into a library, whoever put it there.
 *
 * Named apart from the transfer it usually comes from because it does not always come
 * from one: a torrent has no row in that table and lands exactly the same way.
 * `transferId` is null then, and the only consequence is that no queue row is painted —
 * which is correct, since there is none.
 */
export interface LandedFile {
	itemId: string;
	transferId: string | null;
	libraryId: string | null;
	path: string;
	bytes: number;
	contentId: string | null;
	/** For the log line, which is read by somebody looking for one file. */
	title: string;
}

/**
 * What the gateway knows the moment a file lands, and nobody else does yet.
 *
 * ## The gap
 *
 * A pull finishes. `FileMoveService` reports the file moved into the library folder,
 * the transfer goes to `DONE`, and that is the end of it — nothing is written down
 * anywhere. Our index still holds one row for that media, the copy on the server we
 * pulled it from, and that row reads `missing` because nothing local holds it. So the
 * library screen, the media page and the dashboard all go on offering a download of a
 * file that is already on the disk, until whenever the media server next scans. People
 * take the offer, and the second copy lands beside the first.
 *
 * This manager is the record of that interval: written the instant the move succeeds,
 * into a table and not into memory, and cleared by our own scan finding a real item
 * for the file.
 *
 * ## How the state ends, which is the whole correctness of it
 *
 * A row that could never be cleared would be worse than the bug it fixes: the media
 * would read "downloaded, waiting" for ever, on a dashboard, with nothing able to
 * contradict it. So there are exactly four exits and every row has to take one.
 *
 * 1. **Our scan finds the item.** The row is deleted. Recognised by content identity
 *    first and by path second — see `_indexed` for why that order, and for what
 *    happens when a media server renames the file on import.
 * 2. **The file leaves the disk.** Somebody deleted it, or moved it. There is nothing
 *    left to wait for, so the row goes and the media honestly reads `missing` again.
 * 3. **The grace period runs out.** After `LANDING_GRACE_MS` the row is marked stale
 *    and the media reads `not_indexed` — a visible, specific statement that the bytes
 *    are here and the server never took them, which is a thing somebody can act on.
 *    It is deliberately not a reversion to `missing`: pulling it again would write the
 *    same bytes to the same path and change nothing.
 * 4. **A stale row is indexed after all, or its file goes.** Exits 1 and 2 keep
 *    applying to stale rows, which is what stops the terminal state from being a
 *    permanent annotation. Fixing the mount and rescanning clears it, with no button
 *    to press and nothing to clean up by hand.
 *
 * Only the third is a decision this brief left open, and the alternatives were
 * rejected out loud: an unbounded wait makes "downloaded, resyncing" a sentence the
 * interface can never take back, and a plain expiry back to `missing` puts the
 * gateway right back to offering a download of a file it can see on its own disk.
 */
@Injectable()
export class LandingManager implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly _logger = new Logger(LandingManager.name);

	private readonly _rescanListeners: RescanListener[] = [];

	/**
	 * Our own follow-up scans, by service, so a second landing in the same library
	 * does not queue a second walk of it.
	 *
	 * Kept so `onModuleDestroy` can clear them: a pending timer holds the event loop
	 * open, which in production delays a shutdown and in the test suite is a worker
	 * that never exits and a failure that names nothing.
	 */
	private readonly _settling = new Map<string, NodeJS.Timeout>();

	public constructor(
		private readonly _landings: MediaLandingRepository,
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _handlers: HandlerRegistry,
		private readonly _settings: SettingsService,
		private readonly _engine: TransferEngineService,
		/**
		 * Told when a landing goes stale, because nothing else will ever say so.
		 *
		 * The state changes on a timer and not in response to anything anybody did: a
		 * file written to a disk no media server looks at sits there, and the moment it
		 * is declared lost is minutes after the last thing that happened. Without a push
		 * the queue only learns it the next time somebody reloads the page — and the one
		 * state that most needs to arrive on its own would be the one that never does.
		 */
		private readonly _events: EventGatewayService,
	) {}

	/**
	 * Follow the queue rather than being told by it.
	 *
	 * The engine reports every state change to whoever registered, which is how this
	 * hears about a finished transfer without the engine knowing that landings exist.
	 * Registering here rather than in a constructor keeps it out of the way of the
	 * container building the graph.
	 */
	public onApplicationBootstrap(): void {
		this._engine.onTransferState((transfer) => this.record(transfer));
	}

	public onModuleDestroy(): void {
		for (const timer of this._settling.values()) {
			clearTimeout(timer);
		}

		this._settling.clear();
	}

	/** Registers whoever knows how to re-read one of our services. See `RescanListener`. */
	public onRescan(listener: RescanListener): void {
		this._rescanListeners.push(listener);
	}

	/**
	 * Write down that a file is on the disk, the moment the move says so.
	 *
	 * Only `DONE`, and that is the whole test: the engine sets it after `_place`
	 * returns an outcome that is neither cancelled nor paused, so it is the one state
	 * that means the bytes are at their final path. A failed transfer left nothing
	 * there, and a cancelled one had its partial removed — recording either would put a
	 * "downloaded" mark on a media nobody holds.
	 *
	 * Everything after the row is written is best effort and says so by not being
	 * awaited by the caller: the media server may be asleep and our own rescan may be
	 * pointless. None of that may undo the fact that the file is there, which is the
	 * one thing this had to persist.
	 */
	public async record(transfer: TransferEntity): Promise<void> {
		if (transfer.state !== TransferState.DONE) {
			return;
		}

		await this.recordFile({
			itemId: transfer.itemId,
			transferId: transfer.id,
			libraryId: transfer.targetLibraryId,
			path: transfer.targetPath,
			bytes: Number(transfer.bytesTotal),
			contentId: transfer.contentId,
			title: transfer.title,
		});
	}

	/**
	 * The same, for a file that arrived by a route with no transfer behind it.
	 *
	 * A torrent is the case this exists for, and it went without any of this for as long
	 * as the feature existed: a grab copied its file into a library and told nobody. No
	 * row said "waiting to be indexed", **no media server was asked to look**, and our own
	 * index was not re-read — so the file sat there until whatever schedule the server
	 * keeps came round, unidentified, with no metadata and no poster, while every screen
	 * showed the media as still missing.
	 *
	 * That is the whole of the owner's "the metadata does not bring the posters": there
	 * was nothing to bring. A torrent carries no artwork beside it, so the artwork can
	 * only come from the media server identifying the file — which it cannot do until
	 * somebody tells it there is a file.
	 */
	public async recordFile(landed: LandedFile): Promise<void> {
		const library =
			landed.libraryId === null
				? null
				: await this._libraries.findOne({ where: { id: landed.libraryId } });

		const existing = await this._landings.findForItem(landed.itemId);
		const landing = await this._landings.save(
			this._landings.create({
				// Kept rather than replaced, so a second pull of the same media updates
				// one row instead of racing a unique index it would lose against.
				...(existing ?? {}),
				itemId: landed.itemId,
				transferId: landed.transferId,
				libraryId: library?.id ?? null,
				path: landed.path,
				bytes: landed.bytes,
				contentId: landed.contentId,
				state: MediaLandingState.WAITING,
				expiresAt: new Date(Date.now() + LANDING_GRACE_MS),
				rescanOutcome: null,
			}),
		);

		await this._paint([landing]);

		this._logger.log(`${landed.title} landed at ${landed.path}, awaiting index`);

		await this._announce(landing, library);
	}

	/**
	 * How far past its last byte each of these transfers has got, by transfer.
	 *
	 * Absent from the map means there is nothing left to wait for: either a media
	 * server indexed the file and `reconcile` deleted the row, or the transfer never
	 * landed anything. Both read the same way on a queue — nothing left to say — and
	 * telling them apart would need a row we deliberately delete once the media server
	 * has caught up.
	 *
	 * Asked for a whole page at once because the caller draws a page at a time, and
	 * because a landing has no column on the transfer that could hold it in step: the
	 * row is gone the moment the file is indexed.
	 */
	public async statesByTransfer(transferIds: string[]): Promise<Map<string, MediaLandingState>> {
		const landings = await this._landings.findForTransfers(transferIds);
		const states = new Map<string, MediaLandingState>();

		for (const landing of landings) {
			// A landing recorded outside a transfer — a file somebody put in the folder
			// themselves — belongs to no row here, and keying it under anything would
			// read one file's state onto another file's line.
			if (landing.transferId === null) {
				continue;
			}

			states.set(landing.transferId, landing.state);
		}

		return states;
	}

	/**
	 * Settle every open landing against what the index now holds.
	 *
	 * Called at the end of an indexing pass, **before** correlation re-derives the item
	 * states: a landing this resolves must be gone by the time the states are computed,
	 * or the media would keep reading `awaiting_index` for a whole refresh cycle after
	 * the item it was waiting for arrived.
	 *
	 * Every open landing is considered rather than only those of the service that was
	 * scanned. It costs a handful of queries — the table holds one row per download
	 * that has not been indexed yet, which is a number in the tens — and scoping it
	 * would strand a landing whose file a *different* service on the same disk was the
	 * one to index, which is the ordinary shape of a household running a Plex and a
	 * Jellyfin over one folder.
	 */
	public async reconcile(): Promise<void> {
		const open = await this._landings.findOpen();

		if (open.length === 0) {
			return;
		}

		const local = await this._localServiceIds();
		// Read once for the whole pass: translating a reported path into ours needs the
		// library that reported it, and reading them per landing would be one query per
		// downloaded file for a table of a dozen rows.
		const libraries = new Map(
			(await this._libraries.find()).map((library) => [library.id, library]),
		);
		const surviving: MediaLandingEntity[] = [];

		for (const landing of open) {
			const indexed = await this._indexed(landing, local, libraries);

			if (indexed !== null) {
				await this._landings.delete({ id: landing.id });
				this._logger.log(`${landing.path} was indexed as ${indexed.title}`);

				continue;
			}

			// Asked after the index and not before: a media server that moves a file
			// into its own layout on import leaves nothing at our path, and dropping the
			// row on that basis alone would forget a landing that had in fact succeeded.
			if (!(await this._onDisk(landing.path))) {
				await this._landings.delete({ id: landing.id });
				this._logger.log(`${landing.path} is gone from the disk; forgetting the landing`);

				continue;
			}

			surviving.push(landing);
		}

		const now = Date.now();

		for (const landing of surviving) {
			if (
				landing.state !== MediaLandingState.WAITING
				|| new Date(landing.expiresAt).getTime() > now
			) {
				continue;
			}

			landing.state = MediaLandingState.STALE;

			await this._landings.save(landing);
			this._pushLanding(landing.transferId, MediaLandingState.STALE);
			this._logger.warn(
				`${landing.path} has been on the disk since ${new Date(landing.createdAt).toISOString()} `
					+ 'and no media server has indexed it',
			);
		}

		await this._paint(surviving);
	}

	/**
	 * Push a landing change onto the transfer it belongs to.
	 *
	 * Named apart from `_announce`, which tells the *media server* to look: these are
	 * two different audiences and folding them would be one method with two reasons to
	 * change.
	 *
	 * The transfer's own row and not a stream of its own: a landing is the tail of a
	 * transfer from everybody's point of view but this class's, and a second channel
	 * would be one the queue screen has no component for.
	 *
	 * A landing with no transfer is skipped rather than broadcast: it belongs to a file
	 * the gateway placed outside the queue, and there is no row on any screen to put it
	 * on.
	 */
	private _pushLanding(transferId: string | null, state: MediaLandingState): void {
		if (transferId === null) {
			return;
		}

		this._events.emit(EventName.TRANSFER_LANDING, { transferId, landing: state });
	}

	/**
	 * Ask the media server to look, and then arrange to look ourselves.
	 *
	 * Both halves are needed and they answer different questions. The media server has
	 * to be told, or on a schedule-only setup the file is invisible to it until the
	 * small hours. And our own index has to be re-read afterwards, or the gateway would
	 * be waiting for a scan that, until this existed, only ever happened when somebody
	 * pressed a button: nothing in the application re-scanned after a file landed.
	 *
	 * Failures are logged and swallowed. A server that will not answer is exactly the
	 * case the landing row exists to survive, and turning it into a thrown error would
	 * take down the transfer that was reporting itself finished.
	 */
	private async _announce(
		landing: MediaLandingEntity,
		library: LibraryEntity | null,
	): Promise<void> {
		if (library === null) {
			// No library means the file went to the fallback folder, which no media
			// server scans. There is nobody to ask and nothing of ours to re-read; the
			// landing will go stale, and that is the correct thing for it to say.
			return;
		}

		const service = await this._services.findWithSecrets(library.serviceId);

		if (service === null) {
			return;
		}

		const outcome = await this._requestRescan(service, library);

		landing.rescanOutcome = outcome;

		await this._landings.save(landing);

		if (outcome === RescanOutcome.UNSUPPORTED) {
			// Nothing was triggered on the far side, so there is nothing to wait for
			// before looking — but looking now would only find what the last pass found.
			// The ordinary periodic refresh is what resolves this one.
			return;
		}

		this._settle(service.id);
	}

	private async _requestRescan(
		service: MediaServiceEntity,
		library: LibraryEntity,
	): Promise<string> {
		const handler = this._handlers.find(service.type);

		if (handler === null) {
			return RescanOutcome.UNSUPPORTED;
		}

		try {
			const outcome = await handler.requestRescan(toConnection(service), {
				externalId: library.externalId,
				name: library.name,
				kind: library.kind,
				paths: library.paths,
			});

			this._logger.log(`Asked ${service.name} to rescan ${library.name} (${outcome})`);

			return outcome;
		} catch (error: unknown) {
			this._logger.warn(`${service.name} refused a rescan of ${library.name}: ${String(error)}`);

			return 'failed';
		}
	}

	/**
	 * Re-read one of our services, once the media server has had time to index.
	 *
	 * Delayed rather than immediate because a refresh fired in the same second as the
	 * request would read the library as it was before it — and then the landing would
	 * wait out the whole periodic cycle for an answer that was a minute away.
	 *
	 * One timer per service, replaced rather than stacked: a season arriving is twenty
	 * landings in the same library within a minute, and twenty walks of it would be
	 * nineteen too many. `unref` keeps a pending scan from holding the process open.
	 */
	private _settle(serviceId: string): void {
		const pending = this._settling.get(serviceId);

		if (pending !== undefined) {
			clearTimeout(pending);
		}

		const timer = setTimeout(() => {
			this._settling.delete(serviceId);

			for (const listener of this._rescanListeners) {
				try {
					listener(serviceId);
				} catch (error: unknown) {
					this._logger.warn(`A rescan listener failed: ${String(error)}`);
				}
			}
		}, LANDING_SETTLE_MS);

		timer.unref?.();

		this._settling.set(serviceId, timer);
	}

	/**
	 * The item one of our own services now holds for this landing, if any.
	 *
	 * Three tests, and the order is the order of how much they prove.
	 *
	 * **Content identity first.** It is computed by our own fingerprinting off the
	 * bytes on the disk, so it is the same value whatever the media server decided to
	 * call the file. That is what stops a server that renames on import — into its own
	 * naming scheme, or simply to strip a release tag — from stranding a row that had
	 * in fact been indexed perfectly.
	 *
	 * **Then the path**, which is the ordinary case and the cheapest: the file is
	 * exactly where we put it, and the only work is translating the path the service
	 * reports into the one the gateway sees. A library with no local path cannot
	 * answer, which is honest — we have no way to tell that its `/media/x` is our
	 * `/mnt/x`.
	 *
	 * **Then an applied match against the source.** This is the one that survives a
	 * server re-containering the file on import, where neither the bytes nor the name
	 * are what we wrote: correlation eventually pairs the new local row with the remote
	 * one we pulled from, on identifiers and episode numbers, and an applied pair is
	 * precisely "our own scan found a real media item for this". It lags by one pass,
	 * since the pairs it reads are written by the correlation that follows this
	 * reconciliation — which costs a refresh interval and never a stranded row.
	 */
	private async _indexed(
		landing: MediaLandingEntity,
		local: Set<string>,
		libraries: Map<string, LibraryEntity>,
	): Promise<MediaItemEntity | null> {
		const isOurs = (item: MediaItemEntity): boolean =>
			local.has(item.serviceId) && item.id !== landing.itemId;

		if (landing.contentId !== null && landing.contentId !== '') {
			const byContent = (await this._items.findByFileHint(landing.contentId)).find(
				(item) => isOurs(item) && item.file?.contentId === landing.contentId,
			);

			if (byContent !== undefined) {
				return byContent;
			}
		}

		const byPath = (await this._items.findByFileHint(basename(landing.path))).find((item) => {
			const library = libraries.get(item.libraryId);

			return (
				isOurs(item)
				&& library !== undefined
				&& toLocalPath(library, item.file?.path ?? null) === landing.path
			);
		});

		if (byPath !== undefined) {
			return byPath;
		}

		return this._matched(landing, local);
	}

	/**
	 * The row an applied correlation has already paired with the copy we pulled from.
	 *
	 * Both directions are read, and that is not belt and braces. `localItemId` on a
	 * match row means "the side the pass was examining" and not "on a service of ours":
	 * a scan of the remote service writes the source copy into that column and ours
	 * into the other, so looking at one side only would find the pair on some scans and
	 * not on others, for no reason anybody could see from the screen.
	 *
	 * The applied test is rebuilt here from the threshold in force now, exactly as
	 * `findAppliedPairs` rebuilds it, because `applied` is not a column. A proposal
	 * below the threshold must not clear a landing: the whole meaning of that state is
	 * that nobody has decided the two are the same media.
	 */
	private async _matched(
		landing: MediaLandingEntity,
		local: Set<string>,
	): Promise<MediaItemEntity | null> {
		const threshold = await this._settings.getValue('matchThreshold');
		const pairs = [
			...(await this._matches.findForRemoteItem(landing.itemId)),
			...(await this._matches.findForLocalItem(landing.itemId)),
		].filter(
			(pair) =>
				pair.state !== SyncState.CONFLICT
				&& (pair.confidence >= threshold || pair.confirmedAt !== null),
		);

		const ids = pairs
			.flatMap((pair) => [pair.localItemId, pair.remoteItemId])
			.filter((id): id is string => id !== null && id !== landing.itemId);

		if (ids.length === 0) {
			return null;
		}

		const items = await this._items.findByIds([...new Set(ids)]);

		return items.find((item) => local.has(item.serviceId) && item.file !== null) ?? null;
	}

	/**
	 * Whether the bytes are still where we put them.
	 *
	 * Any failure that is not "it is not there" counts as still there. A NAS that has
	 * gone to sleep answers `EIO` or times out, and forgetting a perfectly good landing
	 * because a mount blinked would put the media back to `missing` with the file
	 * present — which is the bug, arrived by a different road.
	 */
	private async _onDisk(path: string): Promise<boolean> {
		try {
			await stat(path);

			return true;
		} catch (error: unknown) {
			return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
		}
	}

	/**
	 * Put the landing's state onto the item every screen is already looking at.
	 *
	 * Only for an item on a service whose files we cannot reach. On one of our own the
	 * media is already held and already says so, and overwriting that with "waiting for
	 * an index" would take a perfectly good `in_sync` off a copy that plays — a pull
	 * from one of our servers to another is an ordinary thing to do.
	 */
	private async _paint(landings: MediaLandingEntity[]): Promise<void> {
		if (landings.length === 0) {
			return;
		}

		const local = await this._localServiceIds();
		const items = await this._items.findByIds(landings.map((landing) => landing.itemId));
		const byId = new Map(items.map((item) => [item.id, item]));

		for (const landing of landings) {
			const item = byId.get(landing.itemId);

			if (item === undefined || local.has(item.serviceId)) {
				continue;
			}

			const state = landingSyncState(landing.state);

			if (item.syncState !== state) {
				await this._items.setSyncState([item.id], state);
			}
		}
	}

	private async _localServiceIds(): Promise<Set<string>> {
		const services = await this._services.find();

		return new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
	}
}
