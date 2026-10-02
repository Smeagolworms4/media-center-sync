import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
	ChunkState,
	ErrorKey,
	EventName,
	lotKeyOf,
	MediaServiceMode,
	PlacedBy,
	TransferErrorKind,
	TransferState,
} from '@mcs/shared';
import type {
	ChangeDestinationRequest,
	HistoryView,
	ResultList,
	Revalidation,
	Transfer,
	TransferChunk,
	TransferLot,
	TransferQueueStats,
	TransferSort,
	TransferVerification,
	UnconfiguredPlacement,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	OnApplicationBootstrap,
} from '@nestjs/common';
import { In, Not } from 'typeorm';
import type { Library as LibraryEntity, Transfer as TransferEntity } from '@/entities';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	RevalidationRepository,
	SyncJobItemRepository,
	TransferChunkRepository,
	TransferRepository,
} from '@/repositories';
import {
	EventGatewayService,
	FileMoveError,
	FileMoveService,
	FilesystemService,
	serviceMode,
	SettingsService,
	TransferEngineService,
	VerificationService,
	derivedLocalRoots,
	isInside,
} from '@/services';
import { LandingManager } from './landing.manager';
import { LibraryManager } from './library.manager';
import { ServiceManager } from './service.manager';
import {
	pageBounds,
	paginate,
	toRevalidation,
	toTransfer,
	toTransferChunk,
} from './mappers';

/**
 * A name, checked to be one.
 *
 * A separator is the dangerous one: `Saison 1/VF` typed into a rename field would create a
 * level of folders nobody asked for and file half a season one directory deeper than the
 * other half, with nothing reporting a fault. `.` and `..` are refused for the same reason
 * one step further — they resolve to a directory above the one being renamed.
 */
const folderName = (name: string): string => {
	const trimmed = name.trim();

	if (
		trimmed === '' ||
		trimmed === '.' ||
		trimmed === '..' ||
		trimmed.includes('/') ||
		trimmed.includes('\\')
	) {
		throw new BadRequestException(ErrorKey.TRANSFER_INVALID_NAME);
	}

	return trimmed;
};

/** Nothing can be done to a transfer that has already finished one way or another. */
const FINISHED = [TransferState.DONE, TransferState.FAILED, TransferState.CANCELLED];

/**
 * The queue, and what can be done to one transfer.
 *
 * Every action here is a state machine question, and each answer is a decision rather
 * than a convenience:
 *
 * - **pause** applies to a queued transfer as much as to a running one. A queued
 *   transfer that could not be paused would start the moment a slot freed, which is
 *   precisely what somebody pressing pause is trying to prevent.
 * - **retry** starts a cancelled or failed transfer over. A cancelled one has had its
 *   partial file deleted, so its pieces are reset rather than resumed — resuming
 *   against bytes that are no longer there writes a file that verifies as corrupt
 *   everywhere at once.
 * - **verify** answers what it found and changes nothing; **repair** acts. Keeping
 *   them apart is what lets somebody ask the question without committing to fetching
 *   nine gigabytes again.
 */
@Injectable()
export class TransferManager implements OnApplicationBootstrap {
	private readonly _logger = new Logger(TransferManager.name);

	public constructor(
		private readonly _transfers: TransferRepository,
		private readonly _chunks: TransferChunkRepository,
		private readonly _revalidations: RevalidationRepository,
		private readonly _items: MediaItemRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _libraries: LibraryRepository,
		/**
		 * The lines of the run this transfer belongs to, kept in step with it.
		 *
		 * A line records where the run decided the file would go. Moving the file and
		 * leaving the line alone gives a run detail that names a path nothing is at —
		 * which is the same quiet wrongness this whole feature exists to remove, one
		 * screen further along.
		 */
		private readonly _lines: SyncJobItemRepository,
		/**
		 * Asked which category a library belongs to, and whether a path can be written.
		 *
		 * A manager rather than the repository because both are decisions that belong to
		 * it: a category is a merge of library names, and a second reading of that merge
		 * here would name a different category than the one the settings were saved under.
		 */
		private readonly _libraryManager: LibraryManager,
		/**
		 * Told when a file moves, because the record of where it landed is keyed on a path.
		 *
		 * `media_landings` holds one row per file the gateway has put in a library and no
		 * media server has indexed yet, and the reconciliation resolves it by content and
		 * then by path. Moving the bytes and leaving that row alone is the one interaction
		 * here that fails silently and badly: the next pass stats the old path, finds
		 * nothing, concludes the file has been deleted and forgets the landing — so the
		 * media goes back to reading `missing`, with a perfectly good copy on the disk, and
		 * the interface offers a download of it. Re-recording is also what asks the *new*
		 * library's media server to look, which nothing else would do.
		 */
		private readonly _landings: LandingManager,
		private readonly _settings: SettingsService,
		private readonly _mover: FileMoveService,
		/**
		 * Asked to remove the folders a moved file left empty behind it.
		 *
		 * The filesystem rather than the mover: moving bytes and tidying a directory are
		 * two capabilities, and the mover deliberately knows nothing about libraries or
		 * roots — which is exactly what says how far up the tidying may go.
		 */
		private readonly _filesystem: FilesystemService,
		private readonly _engine: TransferEngineService,
		private readonly _verification: VerificationService,
		private readonly _events: EventGatewayService,
		/**
		 * Only to hear that a service is going. See `onApplicationBootstrap`: the
		 * service manager is told nothing about transfers, so this is the one direction
		 * the two know each other in, and no cycle is possible.
		 */
		private readonly _serviceManager: ServiceManager,
	) {}

	/**
	 * Stop what a removed service was feeding, at the moment it is removed.
	 *
	 * Registered as a listener rather than called by the service manager, the way the
	 * landing manager asks for rescans: see `ServiceRemovalListener`.
	 */
	public onApplicationBootstrap(): void {
		this._serviceManager.onRemoving(async (serviceId) => {
			await this.cancelFromService(serviceId);
		});
	}

	/**
	 * Cancel every unfinished transfer whose source is an item of this service.
	 *
	 * Without it a queued or running transfer outlives its source, fails later on an
	 * item nobody can find, and reads in the queue as a fault to investigate — or, for
	 * a paused one, fails the day somebody resumes it. Cancelled, not failed, because
	 * nothing went wrong: the source was removed on purpose. The reason is its own kind
	 * so the row says *why* rather than claiming somebody pressed cancel.
	 *
	 * Finished transfers are left alone. They are the history of what was pulled, and
	 * a finished one has nothing left to take from the source anyway.
	 *
	 * One transfer that cannot be stopped does not stop the others.
	 */
	public async cancelFromService(serviceId: string): Promise<number> {
		const live = await this._transfers.findUnfinishedFromService(serviceId);
		let cancelled = 0;

		for (const transfer of live) {
			try {
				await this._engine.cancel(transfer.id, TransferErrorKind.SERVICE_REMOVED);
				cancelled += 1;
			} catch (error: unknown) {
				this._logger.warn(`Could not cancel transfer ${transfer.id}: ${String(error)}`);
			}
		}

		if (cancelled > 0) {
			this._logger.log(`Cancelled ${cancelled} transfer(s) from removed service ${serviceId}`);
		}

		return cancelled;
	}

	/**
	 * One page of the queue.
	 *
	 * `view` is not defaulted. The queue screen asks for the live half, and the
	 * dashboard deliberately does not: it reads the failed transfers it reports out of
	 * this very list, and a route that had started hiding finished rows on its own
	 * would have silenced the only place the home screen says a pull went wrong.
	 */
	public async list(query: {
		page?: number;
		limit?: number;
		state?: TransferState;
		view?: HistoryView;
		sort?: TransferSort;
	}): Promise<ResultList<Transfer>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [transfers, total] = await this._transfers.pageOf({
			page,
			limit,
			state: query.state,
			view: query.view,
			sort: query.sort,
		});

		return paginate(await this._present(transfers), total, page, limit);
	}

	/**
	 * One page of **downloads**, each carrying its files.
	 *
	 * What the queue screen reads. The file-by-file listing above stays for the dashboard
	 * and for anything counting rows, but a household does not think in files: it asked
	 * for a season, and a season is one thing arriving. See `TransferLot` for what it cost
	 * to answer this from a page of files instead, which is what the interface did — and
	 * for why the page size is now a number of downloads rather than a number of rows.
	 */
	public async lots(query: {
		page?: number;
		limit?: number;
		state?: TransferState;
		view?: HistoryView;
		sort?: TransferSort;
	}): Promise<ResultList<TransferLot>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [keys, total] = await this._transfers.pageOfLots({
			page,
			limit,
			state: query.state,
			view: query.view,
			sort: query.sort,
		});
		const presented = await this._present(await this._transfers.findByLotKeys(keys));
		const titles = await this._lotTitles(presented);
		const byKey = new Map<string, Transfer[]>();

		for (const transfer of presented) {
			const key = lotKeyOf(transfer);
			const held = byKey.get(key);

			if (held === undefined) {
				byKey.set(key, [transfer]);
			} else {
				held.push(transfer);
			}
		}

		/*
		 * Built from the keys and not from the grouping, so the page keeps the order the
		 * database put the downloads in. Reading the map's own order would order them by
		 * whichever file happened to come back first, which is creation order — and that is
		 * a different sort from the one that was asked for.
		 */
		const rows = keys.map((key) => {
			const transfers = byKey.get(key) ?? [];

			return {
				key,
				lot: transfers[0]?.lot ?? null,
				title: titles.get(key) ?? transfers[0]?.title ?? '',
				transfers,
			};
		});

		return paginate(rows, total, page, limit);
	}

	/**
	 * What each download is fetching, by lot key.
	 *
	 * The show and not the episode. A download's files are episodes, and a card headed
	 * with the first of them — "Les Schtroumpfs — S01E02 — L'Œuf et les Schtroumpfs" over
	 * twenty files — reads as one episode with something badly wrong about it.
	 *
	 * Resolved by walking the catalogue upwards, in one query per depth for the whole page
	 * rather than per lot: an episode's parent is a season and its parent is the show, so
	 * three rounds cover everything we index. The deepest ancestor every file of the lot
	 * shares is the download; where that is the file itself — a lot of one — the file's own
	 * title is the honest answer and the title of a season nobody is fetching whole is not.
	 */
	private async _lotTitles(transfers: Transfer[]): Promise<Map<string, string>> {
		const chains = await this._ancestries(transfers.map((transfer) => transfer.itemId));
		const byKey = new Map<string, string[][]>();

		/*
		 * Only the files whose media the catalogue still holds, and that is the whole of
		 * this loop's care.
		 *
		 * A file whose row has gone — a scan dropped it, a library was removed — has no
		 * ancestry, and counting it as a chain of its own title shared nothing with the
		 * others: the common ancestor collapsed to nothing and the card took the name of
		 * whichever episode came back first. One missing row renamed a download of a
		 * hundred and four files, which is what it did on the owner's queue.
		 */
		const sizes = new Map<string, number>();

		for (const transfer of transfers) {
			const key = lotKeyOf(transfer);

			// Counted over every file, including the ones skipped below: "is this a
			// download of one thing" is a question about the download and not about how
			// much of it the catalogue still knows.
			sizes.set(key, (sizes.get(key) ?? 0) + 1);

			const chain = chains.get(transfer.itemId);

			if (chain === undefined) {
				continue;
			}

			byKey.set(key, [...(byKey.get(key) ?? []), chain]);
		}

		const titles = new Map<string, string>();

		for (const [key, held] of byKey) {
			const [first, ...rest] = held;
			let depth = first.length;

			for (const other of rest) {
				let index = 0;

				while (index < depth && index < other.length && first[index] === other[index]) {
					index += 1;
				}

				depth = index;
			}

			/*
			 * The root of what they share rather than the deepest of it, once there is more
			 * than one file: twenty episodes of one season share the season, and a card
			 * headed "Saison 1" says less than one headed with the show — the seasons are
			 * the headings inside it. A single file keeps its own name.
			 */
			/*
			 * The root of what they share rather than the deepest of it, once there is more
			 * than one file. A lot of one keeps its own name — there is no show above it to
			 * borrow from — and so does a lot whose files turn out to share nothing, which
			 * happens when one download really does carry two unrelated things.
			 */
			const shared = (sizes.get(key) ?? held.length) === 1 || depth === 0
				? first.at(-1)
				: first.slice(0, depth).at(0);

			if (shared !== undefined && shared !== '') {
				titles.set(key, shared);
			}
		}

		return titles;
	}

	/**
	 * The titles from the top of the catalogue down to each media, by identifier.
	 *
	 * Bounded at four rounds, which is one more than anything we index needs — show,
	 * season, episode — because a cycle in `parentId` would otherwise be an endless loop
	 * in a queue read. A malformed catalogue costs a card headed with less than it could
	 * be; it must not cost the page.
	 */
	private async _ancestries(itemIds: string[]): Promise<Map<string, string[]>> {
		const unique = [...new Set(itemIds)];

		if (unique.length === 0) {
			return new Map();
		}

		const known = new Map<string, { title: string; parentId: string | null }>();
		let wanted = unique;

		for (let round = 0; round < 4 && wanted.length > 0; round += 1) {
			const items = await this._items.find({ where: { id: In(wanted) } });

			for (const item of items) {
				known.set(item.id, { title: item.title, parentId: item.parentId });
			}

			wanted = [
				...new Set(
					items
						.map((item) => item.parentId)
						.filter((parentId): parentId is string => parentId !== null && !known.has(parentId)),
				),
			];
		}

		const chains = new Map<string, string[]>();

		for (const itemId of unique) {
			const chain: string[] = [];
			let at: string | null = itemId;

			while (at !== null && chain.length < 8) {
				const item = known.get(at);

				if (item === undefined) {
					break;
				}

				chain.unshift(item.title);
				at = item.parentId;
			}

			if (chain.length > 0) {
				chains.set(itemId, chain);
			}
		}

		return chains;
	}

	/**
	 * The queue counters.
	 *
	 * The counts come from the database and the rate from the engine, because neither
	 * can answer the other. A rate is measured over a window of the last few seconds
	 * and lives in memory; computed from stored bytes it would be an average since the
	 * transfer started, which is a different number that looks like the same one.
	 */
	public async stats(): Promise<TransferQueueStats> {
		const stored = await this._transfers.queueStats();

		return { ...stored, rate: this._engine.stats().rate };
	}

	public async read(id: string): Promise<Transfer> {
		const transfer = await this._require(id);
		const [presented] = await this._present([transfer]);

		return presented;
	}

	public async chunks(id: string): Promise<TransferChunk[]> {
		await this._require(id);

		const chunks = await this._chunks.findByTransfer(id);

		return chunks.map(toTransferChunk);
	}

	/**
	 * Why a transfer changed its mind.
	 *
	 * Which source was asked, what it said, and what was decided. Without it the queue
	 * shows outcomes nobody can account for — a source dropped, a path followed, a
	 * version abandoned, all of them indistinguishable from a bug.
	 */
	public async revalidations(id: string): Promise<Revalidation[]> {
		await this._require(id);

		const rows = await this._revalidations.findForTransfer(id);
		const names = await this._serviceNames(rows.map((row) => row.sourceServiceId));

		return rows.map((row) => toRevalidation(row, names.get(row.sourceServiceId) ?? ''));
	}

	public async pause(id: string): Promise<Transfer> {
		const transfer = await this._requireLive(id);

		if (transfer.state === TransferState.PAUSED) {
			return this.read(id);
		}

		await this._engine.pause(transfer.id);

		return this.read(id);
	}

	/**
	 * Stop everything that is moving, in one act.
	 *
	 * Pausing a queue row by row is not the same thing and cannot be: by the time the
	 * fourth is paused the engine has started a fifth, so the list somebody is trying
	 * to stop keeps refilling under their hand. The reason people reach for this is
	 * that the disk is filling or the link is needed for something else, and both are
	 * answered by "stop now", not by "stop these six".
	 *
	 * Queued rows are paused too, and that is the point rather than a detail: one left
	 * queued starts the moment a slot frees, which is exactly what pressing pause is
	 * trying to prevent.
	 *
	 * Answers how many it stopped. A failure on one is logged and the rest go on — the
	 * intent is to stop everything that can be stopped, and refusing the lot because of
	 * one row would leave somebody with a queue still running and an error about a
	 * transfer they had not noticed.
	 */
	public async pauseAll(): Promise<number> {
		/*
		 * The state first, the rows second, and in that order on purpose: between the two
		 * the engine may finish a file and ask for the next, and a gate that was not closed
		 * yet would let it through — so the queue somebody just stopped starts one more.
		 */
		await this._settings.update({ queuePaused: true });

		// Everything not already over, which is the same set `_requireLive` guards one row
		// with. A queued transfer counts: left alone it starts the moment a slot frees.
		const live = await this._transfers.find({ where: { state: Not(In(FINISHED)) } });
		let stopped = 0;

		for (const transfer of live) {
			if (transfer.state === TransferState.PAUSED) {
				continue;
			}

			try {
				await this._engine.pause(transfer.id);
				stopped += 1;
			} catch (error: unknown) {
				this._logger.warn(`Could not pause ${transfer.title}: ${String(error)}`);
			}
		}

		if (stopped > 0) {
			this._logger.log(`Paused ${stopped} transfers at once`);
		}

		return stopped;
	}

	/**
	 * Let the queue run again, and everything that was stopped with it.
	 *
	 * The counterpart of `pauseAll`, and it exists for the same reason: resuming used to be
	 * a loop in the browser over the rows it had on screen, so a queue of a hundred and
	 * eighty-seven files resumed twenty of them — and it resumed them one HTTP call at a
	 * time, each of which could refuse, which is where the errors came from.
	 *
	 * Only what is paused. A failed transfer is resumable and deliberately not resumed
	 * here: it stopped for a reason, and starting a hundred failures again because somebody
	 * pressed play is not what they asked.
	 */
	public async resumeAll(): Promise<number> {
		await this._settings.update({ queuePaused: false });

		const paused = await this._transfers.find({ where: { state: TransferState.PAUSED } });
		let started = 0;

		for (const transfer of paused) {
			try {
				await this._engine.resume(transfer.id);
				started += 1;
			} catch (error: unknown) {
				this._logger.warn(`Could not resume ${transfer.title}: ${String(error)}`);
			}
		}

		if (started > 0) {
			this._logger.log(`Resumed ${started} transfers at once`);
		}

		return started;
	}

	/**
	 * One action over a whole download.
	 *
	 * Here rather than as a loop in the interface, and that is the fix rather than a
	 * tidying. A card that pressed pause on twenty files sent twenty requests, each racing
	 * the others and the engine: a file that finished in between answered `409`, one
	 * already paused answered `409`, and what somebody saw for pausing a season was a
	 * column of red notices over a queue that had in fact mostly stopped. One request, one
	 * answer, and a file it does not apply to is skipped rather than refused — pressing
	 * pause on a season that is half done means "stop the rest".
	 *
	 * Answers the download as it stands afterwards, so the card redraws from the truth
	 * instead of from twenty guesses.
	 */
	/**
	 * Take a whole download off the queue, in one act.
	 *
	 * The omission this repairs: the lot's card carried pause, resume and cancel, and every
	 * one of those is hidden once a download has finished — so a landed season offered no
	 * way off the list at all. Archiving it meant unfolding the card and pressing the file
	 * action twenty times, which is precisely the twenty clicks the card exists to abolish.
	 *
	 * **No file is touched**, exactly as for one row: the copies are in the library and
	 * stay there. See `archive` for why a still-running member is cancelled first.
	 *
	 * Not folded into `actOnLot`, because it does not act on the engine and it returns
	 * nothing: the lot is gone, so there is no lot to read back, and a method whose return
	 * type depended on its verb would be worse than two methods.
	 */
	public async archiveLot(key: string): Promise<void> {
		const transfers = await this._transfers.findByLotKeys([key]);

		if (transfers.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		for (const transfer of transfers) {
			try {
				await this.archive(transfer.id);
			} catch (error: unknown) {
				// Passed over for the reason the other lot actions pass over: refusing the
				// whole download because one file would not go leaves somebody with half a
				// season still on the list and an error about a file they never singled out.
				this._logger.warn(`Could not archive ${transfer.title}: ${String(error)}`);
			}
		}
	}

	public async actOnLot(key: string, action: 'pause' | 'resume' | 'cancel'): Promise<TransferLot> {
		const transfers = await this._transfers.findByLotKeys([key]);

		if (transfers.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		for (const transfer of transfers) {
			if (!this._applies(transfer, action)) {
				continue;
			}

			try {
				await (action === 'pause'
					? this._engine.pause(transfer.id)
					: action === 'resume'
						? this._engine.resume(transfer.id)
						: this._engine.cancel(transfer.id));
			} catch (error: unknown) {
				// Logged and passed over: the intent is to act on the download, and refusing
				// the lot over one file leaves somebody with half a season stopped and an
				// error about a file they had not singled out.
				this._logger.warn(`Could not ${action} ${transfer.title}: ${String(error)}`);
			}
		}

		return this.readLot(key);
	}

	/**
	 * Rename the folder one season of a download lands in.
	 *
	 * Asked for, and restricted on purpose: the show's folder is shared with every other
	 * season and with whatever was already filed there, so this renames one directory and
	 * leaves the layout around it alone.
	 *
	 * Built on the same machinery as sending a download elsewhere, which is what makes it
	 * apply to what has already landed: `_sendTo` moves the bytes of a finished file for
	 * real, re-records the landing so the media server is asked to look at the new folder,
	 * and prunes the folder the file left once it is empty. A rename that only rewrote the
	 * planned paths would leave the episodes that arrived last night in `Season 01` and put
	 * tonight's in `Saison 1` — one season in two folders, which is the state somebody
	 * renaming it is trying to get out of.
	 *
	 * Refused when that season's files are not in one folder to begin with: renaming the
	 * folder of whichever came back first would move part of the season and leave the rest.
	 */
	public async renameSeason(
		key: string,
		request: { seasonNumber: number | null; name: string },
	): Promise<TransferLot> {
		const name = folderName(request.name);
		const transfers = await this._transfers.findByLotKeys([key]);

		if (transfers.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		const items = await this._items.find({
			where: { id: In(transfers.map((transfer) => transfer.itemId)) },
		});
		const seasons = new Map(items.map((item) => [item.id, item.seasonNumber ?? null]));
		const wanted = transfers.filter(
			(transfer) => (seasons.get(transfer.itemId) ?? null) === request.seasonNumber,
		);

		if (wanted.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		const folders = new Set(wanted.map((transfer) => dirname(resolve(transfer.targetPath))));

		if (folders.size !== 1) {
			throw new ConflictException(ErrorKey.TRANSFER_FOLDER_NOT_SHARED);
		}

		const [folder] = folders;

		if (basename(folder) === name) {
			// Already called that. Answering the download unchanged beats refusing it.
			return this.readLot(key);
		}

		await this._moveEach(wanted, (path) => join(dirname(dirname(path)), name, basename(path)));

		return this.readLot(key);
	}

	/**
	 * Rename one file of a download, keeping it in its folder.
	 *
	 * The extension is kept when the new name has none: a household that renames
	 * `S01E02.mkv` to `S01E02` would otherwise own a file no media server plays, and
	 * nothing would report a fault — the copy is perfectly intact and simply invisible.
	 */
	public async renameFile(id: string, name: string): Promise<Transfer> {
		const transfer = await this._require(id);
		const wanted = folderName(name);
		const current = resolve(transfer.targetPath);
		const suffix = extname(current);
		const next = extname(wanted) === '' ? `${wanted}${suffix}` : wanted;

		if (basename(current) === next) {
			return this.read(id);
		}

		await this._moveEach([transfer], (path) => join(dirname(path), next));

		return this.read(id);
	}

	/**
	 * Move a set of files to the paths a rule computes, or move none of them.
	 *
	 * Every destination is checked before anything is touched, which is the difference
	 * between a rename and half a rename: a season whose fourth file would land on
	 * something already there stops with an error naming it, rather than four files moved
	 * and eighteen where they were. The same reason `changeJobDestination` plans first.
	 */
	private async _moveEach(
		transfers: TransferEntity[],
		pathOf: (current: string) => string,
	): Promise<void> {
		const planned: { transfer: TransferEntity; library: LibraryEntity; path: string }[] = [];

		for (const transfer of transfers) {
			if (transfer.state === TransferState.PLACING) {
				throw new ConflictException(ErrorKey.TRANSFER_BEING_PLACED);
			}

			const path = pathOf(resolve(transfer.targetPath));

			if (path === resolve(transfer.targetPath)) {
				continue;
			}

			if ((await this._libraryManager.probe(path)).exists) {
				throw new ConflictException(ErrorKey.TRANSFER_TARGET_OCCUPIED);
			}

			/*
			 * A file in no library cannot be renamed, and the refusal names that rather than
			 * failing later: the landing record is written against a library, and inventing
			 * one here would tell a media server to scan a folder it has never heard of. It
			 * is actionable where it is raised — "send it elsewhere" puts the file in a
			 * library, and renaming it then works.
			 */
			if (transfer.targetLibraryId === null) {
				throw new ConflictException(ErrorKey.TRANSFER_DESTINATION_INVALID);
			}

			// The library the file is already in: a rename changes the last components of a
			// path and must never be the operation that moves a file out of its library.
			planned.push({
				transfer,
				library: await this._requireDestination(transfer.targetLibraryId),
				path,
			});
		}

		for (const one of planned) {
			await this._sendTo(one.transfer, one.library, one.path);
		}
	}

	/** One download by its key, as `lots` would have presented it. */
	public async readLot(key: string): Promise<TransferLot> {
		const transfers = await this._transfers.findByLotKeys([key]);

		if (transfers.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		const presented = await this._present(transfers);
		const titles = await this._lotTitles(presented);

		return {
			key,
			lot: presented[0]?.lot ?? null,
			title: titles.get(key) ?? presented[0]?.title ?? '',
			transfers: presented,
		};
	}

	/**
	 * Whether an action means anything for this file.
	 *
	 * The whole point of a lot action: what is already over is left alone, and a resume
	 * takes in a failed file because its verified pieces are still on disk.
	 */
	private _applies(transfer: TransferEntity, action: 'pause' | 'resume' | 'cancel'): boolean {
		if (action === 'resume') {
			return transfer.state === TransferState.PAUSED || transfer.state === TransferState.FAILED;
		}

		if (action === 'pause') {
			return !FINISHED.includes(transfer.state) && transfer.state !== TransferState.PAUSED;
		}

		return transfer.state !== TransferState.DONE && transfer.state !== TransferState.CANCELLED;
	}

	public async resume(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		// A failed transfer is resumable: the pieces it already holds are still on
		// disk and still verified, and the alternative is fetching them again.
		if (transfer.state !== TransferState.PAUSED && transfer.state !== TransferState.FAILED) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		await this._engine.resume(transfer.id);

		return this.read(id);
	}

	public async cancel(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		if (transfer.state === TransferState.DONE) {
			// Cancelling a finished transfer would delete a file that is already in the
			// library and that nothing is going to fetch again.
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		if (FINISHED.includes(transfer.state)) {
			return this.read(id);
		}

		await this._engine.cancel(transfer.id);

		return this.read(id);
	}

	/**
	 * Take a row off the queue, whatever state it is in.
	 *
	 * The queue is a working list, and a working list nobody can take anything off stops
	 * being read: a gateway that has been running for months carries every download it has
	 * ever made, and the twelve rows somebody actually cares about are on page four.
	 * Retention eventually sweeps the finished ones, on a window measured in months — too
	 * slow to be an answer to "I do not want to look at this any more".
	 *
	 * **The file is never touched.** A placed transfer's copy is in the library and stays
	 * there; this forgets the row, not the media. One still running is cancelled first,
	 * because a row deleted under a running worker is a worker writing into a transfer
	 * nothing describes any more — and cancelling is what drops its partial file, which is
	 * the one piece of disk this does remove.
	 *
	 * Its pieces and revalidations go with it. They are rows about a row that no longer
	 * exists, and a chunk table that outlives its transfers is what makes a queue query
	 * slow for reasons nobody can see.
	 */
	public async archive(id: string): Promise<void> {
		const transfer = await this._require(id);

		if (!FINISHED.includes(transfer.state)) {
			// Stops the worker and drops the partial. Its own method rather than a second
			// copy of that decision — see `cancel`.
			await this._engine.cancel(transfer.id);
		}

		await this._chunks.deleteForTransfer(transfer.id);
		await this._transfers.delete({ id: transfer.id });

		this._logger.log(`Archived ${transfer.title}, which was ${transfer.state}`);
		this._events.emit(EventName.TRANSFER_REMOVED, { id: transfer.id });
	}

	/**
	 * Start a finished-badly transfer over.
	 *
	 * Only from `failed` or `cancelled`. Retrying a running one would have two workers
	 * writing the same offsets, and retrying a finished one would fetch a file that is
	 * already in the library.
	 */
	public async retry(id: string): Promise<Transfer> {
		const transfer = await this._require(id);

		if (transfer.state !== TransferState.FAILED && transfer.state !== TransferState.CANCELLED) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		// The pieces go back to pending rather than being kept: a cancelled transfer had
		// its partial file removed, and a failed one may have failed because of what is
		// on disk. Starting from bytes nobody can vouch for is how a repair loop begins.
		await this._chunks.deleteForTransfer(transfer.id);

		transfer.state = TransferState.QUEUED;
		transfer.bytesDone = 0;
		transfer.chunksTotal = 0;
		transfer.error = null;
		transfer.errorKind = null;
		transfer.startedAt = null;
		transfer.finishedAt = null;

		await this._transfers.save(transfer);
		await this._engine.enqueue(transfer.id);

		return this.read(id);
	}

	/**
	 * Re-read what is on disk and report. Writes nothing.
	 *
	 * The report goes out on the event stream as well as back to the caller, because a
	 * verification that comes back clean is worth knowing about even though no state
	 * changed: it says the source was fine and the problem is somewhere else, and that
	 * is invisible if the only signal is a transfer going back to `done`.
	 */
	public async verify(id: string): Promise<TransferVerification> {
		const transfer = await this._require(id);
		const chunks = await this._chunks.findByTransfer(transfer.id);
		const report = await this._verification.verify({
			transferId: transfer.id,
			path: transfer.state === TransferState.DONE ? transfer.targetPath : transfer.workPath,
			chunks: chunks.map((chunk) => ({
				index: chunk.index,
				start: Number(chunk.start),
				end: Number(chunk.end),
				state: chunk.state,
				sourceServiceId: chunk.sourceServiceId,
				checksum: chunk.checksum,
			})),
			expectedSize: Number(transfer.bytesTotal),
		});

		const answer: TransferVerification = {
			transferId: report.transferId,
			ok: report.ok,
			chunksChecked: report.chunksChecked,
			chunksCorrupt: report.chunksCorrupt,
			bytesToRepair: report.bytesToRepair,
			checkedAt: report.checkedAt,
		};

		this._events.emit(EventName.TRANSFER_VERIFIED, answer);

		return answer;
	}

	/**
	 * Verify, then act on what was found.
	 *
	 * Only the pieces that failed come back, and preferably from another source: the
	 * one that served bad bytes once is the least likely to serve good ones now.
	 * Throwing away thirty gigabytes because two megabytes are wrong is what makes
	 * people give up on syncing.
	 */
	public async repair(id: string): Promise<Transfer> {
		const transfer = await this._require(id);
		const chunks = await this._chunks.findByTransfer(transfer.id);
		const report = await this._verification.verify({
			transferId: transfer.id,
			path: transfer.state === TransferState.DONE ? transfer.targetPath : transfer.workPath,
			chunks: chunks.map((chunk) => ({
				index: chunk.index,
				start: Number(chunk.start),
				end: Number(chunk.end),
				state: chunk.state,
				sourceServiceId: chunk.sourceServiceId,
				checksum: chunk.checksum,
			})),
			expectedSize: Number(transfer.bytesTotal),
		});

		if (report.ok) {
			// Nothing to repair is an answer, not a failure: the transfer stays as it is
			// rather than being re-queued for work nobody found.
			return this.read(id);
		}

		for (const index of report.corruptChunks) {
			await this._chunks.updateState(transfer.id, index, {
				state: ChunkState.CORRUPT,
				bytesDone: 0,
			});
		}

		transfer.state = TransferState.REPAIRING;
		transfer.bytesDone = await this._chunks.sumBytesDone(transfer.id);
		transfer.lastVerifiedAt = new Date();
		transfer.finishedAt = null;

		await this._transfers.save(transfer);
		await this._engine.enqueue(transfer.id);

		this._logger.log(
			`Repairing ${report.corruptChunks.length} pieces of ${transfer.title} (${report.bytesToRepair} bytes)`,
		);

		return this.read(id);
	}

	/**
	 * Everything that landed on a step of the placement rule nobody configured.
	 *
	 * The one place any of this is ever mentioned. A file placed by the global default,
	 * the fallback folder or the last-resort walk of whatever is writable produced no
	 * error, no failed transfer and no log line worth reading — the transfer succeeded,
	 * and the only visible consequence is a folder somebody did not plan, found months
	 * later.
	 *
	 * The category is resolved here rather than stored on the row, because it is a merge
	 * of library names: renaming a shelf renames the category, and a name frozen at
	 * planning time would go on naming one that no longer exists. That name is the whole
	 * value of the row — "no destination is set for the category Animés" is something
	 * somebody can act on, and "fallback" is not.
	 */
	public async unconfigured(): Promise<UnconfiguredPlacement[]> {
		const rows = await this._transfers.findUnconfigured();

		if (rows.length === 0) {
			return [];
		}

		const [items, categories, libraries] = await Promise.all([
			this._items.find({ where: { id: In(rows.map((row) => row.itemId)) } }),
			this._libraryManager.categories(),
			this._libraries.find(),
		]);

		const itemsById = new Map(items.map((item) => [item.id, item]));
		const names = new Map(
			libraries.map((library) => [library.id, library.alias?.trim() || library.name]),
		);

		/*
		 * Only files somebody can still do something about.
		 *
		 * Removing a service removes its libraries and leaves the transfers that wrote
		 * into them. Those stay: a finished transfer is history, and the transfers
		 * screen still reads them. But this list asks a question — move the file, or
		 * say where its category goes — and about a library nothing manages any more
		 * there is none left. Listed, such a row sat on the dashboard for ever with no
		 * library, no category and nothing anywhere that could clear it.
		 *
		 * A null library is not the same case and stays: that is the fallback folder,
		 * which belongs to no library by design and is exactly what this list is for.
		 */
		const answerable = rows.filter(
			(row) => row.targetLibraryId === null || names.has(row.targetLibraryId),
		);
		const categoryOf = new Map<string, { key: string; name: string }>();

		for (const category of categories) {
			for (const libraryId of category.libraryIds) {
				categoryOf.set(libraryId, { key: category.key, name: category.name });
			}
		}

		return answerable.map((row) => {
			// The item the bytes come from, whose own library is what the category table
			// is keyed on — the same reading the plan used when it chose this path.
			const item = itemsById.get(row.itemId);
			const category = item === undefined ? undefined : categoryOf.get(item.libraryId);

			return {
				transferId: row.id,
				itemId: row.itemId,
				title: row.title,
				kind: item?.kind ?? '',
				state: row.state,
				targetPath: row.targetPath,
				targetLibraryId: row.targetLibraryId,
				targetLibraryName:
					row.targetLibraryId === null ? null : (names.get(row.targetLibraryId) ?? null),
				placedBy: row.placedBy as PlacedBy,
				categoryKey: category?.key ?? null,
				categoryName: category?.name ?? null,
				placedAt: (row.finishedAt ?? row.createdAt).toISOString(),
			};
		});
	}

	/**
	 * Send a transfer somewhere else, before it lands or after.
	 *
	 * The two cases cost wildly different things and that is worth knowing before
	 * pressing the button:
	 *
	 * - **While it is still downloading** every byte is going into the work file in the
	 *   scratch directory, and `targetPath` is not read until that file is finally moved
	 *   into place. Changing it is one row write. Nothing is copied, nothing is deleted,
	 *   and the download is not interrupted.
	 * - **Once it has landed** the file is in a library and this is a real move of real
	 *   bytes, usually across two filesystems, which is why it goes through the mover
	 *   and reports progress on the same channel the download used.
	 *
	 * A transfer the engine is placing right now is refused rather than queued, and the
	 * alternative was built out on paper before being dropped. The mover can be aborted
	 * with `FILE_MOVE_CANCEL` and resumed, so cancelling the copy in flight and
	 * restarting it towards the new library is buildable — but between the abort being
	 * requested and being observed, the partial on the old path and the bytes already
	 * written are two halves of one film in two libraries, and a crash inside that
	 * window leaves them there with the row naming only the second. A half-moved file is
	 * the outcome this whole area is designed against. Refusing costs somebody the wait
	 * for a copy that was already running, which they can see on the bar, and the answer
	 * has a key of its own — `TRANSFER_BEING_PLACED` — so the screen can say "in a
	 * moment" rather than "no".
	 */
	public async changeDestination(
		id: string,
		request: ChangeDestinationRequest,
	): Promise<Transfer> {
		const transfer = await this._require(id);
		const library = await this._requireDestination(request.libraryId);
		const folder = await this._requireFolder(library, request.folder ?? null);
		const path = await this._destinationPath(transfer, library, folder);

		if (path === resolve(transfer.targetPath) && transfer.targetLibraryId === library.id) {
			// The destination already in force. Answering the transfer unchanged beats
			// refusing it: a list somebody is fixing row by row should not punish them for
			// picking the library a file is already in.
			return this.read(id);
		}

		if (transfer.state === TransferState.PLACING) {
			throw new ConflictException(ErrorKey.TRANSFER_BEING_PLACED);
		}

		if ((await this._libraryManager.probe(path)).exists) {
			// Somebody else's file is there. Landing on it is the loss this whole area
			// exists to prevent, and it would be silent.
			throw new ConflictException(ErrorKey.TRANSFER_TARGET_OCCUPIED);
		}

		await this._sendTo(transfer, library, path);

		return this.read(id);
	}

	/**
	 * Send a whole run somewhere else, files already landed included.
	 *
	 * A run is one piece of work — that is what the queue now draws — and half of it
	 * cannot be somewhere the other half is not. Redirecting a season that was already
	 * five episodes in used to leave those five in the old library: the screen then
	 * showed one batch with one destination while the disk held two, and the series
	 * appeared twice on the media server, with six episodes in one and five in the
	 * other. So the ones that have landed are moved for real and the ones still coming
	 * are simply re-aimed, which is the difference `changeDestination` already draws for
	 * one file.
	 *
	 * **Every file is checked before any file is touched.** A batch that moved four and
	 * then refused the fifth would produce exactly the split this is here to prevent,
	 * and it would produce it at the moment somebody was trying to fix one. So a run
	 * with a file being placed right now, or one file whose new path is occupied, is
	 * refused whole — nothing has moved, and pressing the button again in a minute is a
	 * complete answer.
	 *
	 * **The unit is the lot, not the run.** A run is one press of a button; a lot is one
	 * thing being fetched, and a season is routinely pulled over three nights. Redirecting
	 * by run therefore found tonight's episodes and left the ones that landed last night
	 * where they were — the same split, arrived at from the other direction, and this time
	 * invisible because the two runs were never on screen together. So the run names the
	 * lots and the lots decide what moves. A run whose rows carry no lot — written before
	 * the column existed — is still exactly the run, which is what it was before.
	 *
	 * Folders the run emptied on the way out are removed. See `_pruneBehind`.
	 */
	public async changeJobDestination(
		jobId: string,
		request: ChangeDestinationRequest,
	): Promise<Transfer[]> {
		const transfers = await this._lotsOfRun(jobId);

		if (transfers.length === 0) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		const library = await this._requireDestination(request.libraryId);
		const folder = await this._requireFolder(library, request.folder ?? null);

		const planned: { transfer: TransferEntity; path: string }[] = [];

		for (const transfer of transfers) {
			const path = await this._destinationPath(transfer, library, folder);

			if (path === resolve(transfer.targetPath) && transfer.targetLibraryId === library.id) {
				// Already where it is being sent. Not an error and not work either — and
				// skipping it is what makes pressing the button twice harmless.
				continue;
			}

			if (transfer.state === TransferState.PLACING) {
				throw new ConflictException(ErrorKey.TRANSFER_BEING_PLACED);
			}

			if ((await this._libraryManager.probe(path)).exists) {
				throw new ConflictException(ErrorKey.TRANSFER_TARGET_OCCUPIED);
			}

			planned.push({ transfer, path });
		}

		for (const one of planned) {
			await this._sendTo(one.transfer, library, one.path);
		}

		if (planned.length > 0) {
			// The count can exceed the run: it is the lots the run named that moved, and an
			// earlier run's episodes of the same season are part of them.
			this._logger.log(
				`Sent ${planned.length} file(s) of the lots of run ${jobId} to ${library.name}`,
			);
		}

		return this._present(planned.map((one) => one.transfer));
	}

	/**
	 * Every file of every lot this run carried, the run's own files included.
	 *
	 * The run is only how the question arrives — the queue screen holds a block and the
	 * block's rows name a job. What the block *is* is a lot, so the answer has to widen
	 * from one to the other, and a run that carried three shows widens to three lots
	 * rather than to none.
	 *
	 * The run's own rows stay in the list whatever their lot says, so a row written before
	 * the column existed is still moved with the run it belongs to. Deduplicated by
	 * identifier, because a lot's files are found twice over — once by run and once by
	 * lot — and moving one twice would move it out from under itself.
	 */
	private async _lotsOfRun(jobId: string): Promise<TransferEntity[]> {
		const run = await this._transfers.findByJob(jobId);
		const lots = [
			...new Set(run.map((one) => one.lot).filter((lot): lot is string => lot !== null)),
		];

		if (lots.length === 0) {
			return run;
		}

		const seen = new Set(run.map((one) => one.id));
		const elsewhere = (await this._transfers.findByLots(lots)).filter(
			(one) => !seen.has(one.id),
		);

		return [...run, ...elsewhere];
	}

	/**
	 * Put one file where it has just been told to go, whatever state it was in.
	 *
	 * Shared by the single row and the whole run so that the two cannot drift: the order
	 * of move, retarget and record is load-bearing, and a second copy of it written for
	 * batches is a second place to get it wrong.
	 */
	private async _sendTo(
		transfer: TransferEntity,
		library: LibraryEntity,
		path: string,
	): Promise<void> {
		const landed = transfer.state === TransferState.DONE;
		// Read before the row is rewritten: afterwards `targetLibraryId` names the new
		// library, and the roots the old folders have to be measured against are gone.
		const from = landed ? await this._vacatedRoots(transfer) : null;
		const previous = transfer.targetPath;

		if (landed) {
			await this._moveInPlace(transfer, path);
		}

		await this._retarget(transfer, library, path);

		if (landed) {
			/*
			 * The bytes are somewhere else now, so the record of where they are has to
			 * say so — and it is re-recorded rather than patched in place on purpose.
			 *
			 * `LandingManager.record` writes the path and the library, restarts the grace
			 * period and asks the destination's media server to rescan. All three are
			 * right here: the file is at a path nothing has indexed, the clock on "no
			 * server has taken this" starts again because it is a different folder, and
			 * the server that owns the new library has never been told anything about it.
			 * Rewriting two columns by hand would have kept the first and lost the other
			 * two, and the failure would have been a file sitting unseen in the library
			 * somebody moved it to precisely so it would be seen.
			 *
			 * It runs after `_retarget` because it reads the transfer's new path and
			 * library off the row this has just saved.
			 */
			await this._landings.record(transfer);

			await this._pruneBehind(previous, from ?? []);
		}
	}

	/**
	 * Remove what the file left behind, as far up as it is empty and no further.
	 *
	 * Fetching a season creates `<library>/Scrubs/Season 2` on the way in, and moving it
	 * out again leaves both of those standing with nothing in them. A media server
	 * scanning that library then shows Scrubs with no episodes — which reads as the
	 * library being wrong rather than as leftovers, and is the state somebody redirected
	 * the run to get away from.
	 *
	 * What is *not* done here matters more than what is. Nothing is removed because this
	 * run created it: only because it is empty now. A folder that still holds another
	 * episode, a subtitle somebody put there, artwork, an `.nfo`, or anything that was
	 * already sitting there before the run ever ran, stops the walk where it is. And the
	 * library root itself is never removed, empty or not.
	 *
	 * The roots are the old library's, so the walk cannot climb out of it.
	 */
	private async _pruneBehind(from: string, roots: string[]): Promise<void> {
		if (roots.length === 0) {
			return;
		}

		const removed = await this._filesystem.pruneEmptyFolders(dirname(from), roots);

		if (removed.length > 0) {
			this._logger.log(`Removed ${removed.length} empty folder(s): ${removed.join(', ')}`);
		}
	}

	/**
	 * The roots the folders a transfer is leaving may be tidied within.
	 *
	 * Its own library's, all of them — a shelf is several directories on several disks
	 * and the file sits under one of them — plus the fallback directory, because a file
	 * placed there belongs to no library at all and is precisely the case somebody is
	 * redirecting. Answers nothing for a transfer whose library has since been removed:
	 * without a root there is no boundary, and a walk up from a path with no boundary is
	 * the one version of this that could delete something it should not.
	 */
	private async _vacatedRoots(transfer: TransferEntity): Promise<string[]> {
		const library =
			transfer.targetLibraryId === null
				? null
				: await this._libraries.findOne({ where: { id: transfer.targetLibraryId } });
		const fallback = (await this._settings.get()).defaultTargetPath?.trim();

		const roots = library === null ? [] : await this._localRootsOf(library);

		return [...roots, ...(fallback ? [resolve(fallback)] : [])];
	}

	/**
	 * Move a file that is already in a library, with the screen following along.
	 *
	 * `PLACING` and the progress channel are reused rather than given a state and an
	 * event of their own. The interface already draws both, and a move that reported on
	 * a second channel would be a bar nobody had written a component for — while a move
	 * that reported nothing at all is forty minutes in which the only honest thing the
	 * screen could say is nothing.
	 *
	 * The state goes back to what it was if the move fails, because it did: the file is
	 * still in the library it was in, whole, and leaving the transfer stuck on `placing`
	 * would make a recoverable refusal look like a hung job.
	 */
	private async _moveInPlace(transfer: TransferEntity, path: string): Promise<void> {
		const settings = await this._settings.get();
		const source = transfer.targetPath;

		await this._publishState(transfer, TransferState.PLACING);

		try {
			await this._mover.move({
				source,
				destination: path,
				reserveBytes: settings.diskReserveBytes,
				onProgress: (progress) => {
					this._events.publishProgress({
						id: transfer.id,
						state: TransferState.PLACING,
						bytesDone: progress.bytesDone,
						bytesTotal: progress.bytesTotal,
						rate: progress.rate,
						// No estimate without a rate: a number that swings between two
						// minutes and four hours is worse than none, and the first window
						// has not closed yet.
						etaSeconds:
							progress.rate > 0
								? Math.round((progress.bytesTotal - progress.bytesDone) / progress.rate)
								: null,
						chunksDone: transfer.chunksTotal,
						chunksTotal: transfer.chunksTotal,
						sourceCount: 0,
					});
				},
			});
		} catch (error) {
			await this._publishState(transfer, TransferState.DONE);

			if (error instanceof FileMoveError) {
				throw new ConflictException(error.key);
			}

			throw error;
		}

		transfer.state = TransferState.DONE;
		this._events.flushProgress();
		this._logger.log(`Moved ${transfer.title} from ${source} to ${path}`);
	}

	/** Records the new destination on the transfer, and on the run line that names it. */
	private async _retarget(
		transfer: TransferEntity,
		library: LibraryEntity,
		path: string,
	): Promise<void> {
		transfer.targetPath = path;
		transfer.targetLibraryId = library.id;
		// Somebody chose this one by hand, so it is no longer a destination nobody
		// picked — whatever step the plan had originally reached. Its own value rather
		// than `REQUESTED`: a run that asked for a library asked for all of its items,
		// while this is a correction to one file and no rule underneath it moved, so the
		// next episode of the same show will still land wherever the rules send it.
		transfer.placedBy = PlacedBy.CHOSEN_BY_HAND;

		await this._transfers.save(transfer);

		if (transfer.jobId !== null) {
			const line = await this._lines.findLine(transfer.jobId, transfer.itemId);

			if (line !== null) {
				line.targetPath = path;
				line.targetLibraryId = library.id;
				line.placedBy = PlacedBy.CHOSEN_BY_HAND;

				await this._lines.save(line);
			}
		}

		const [presented] = await this._present([transfer]);

		this._events.emit(EventName.TRANSFER_STATE, presented);
	}

	/**
	 * The library a transfer may be sent to, or the refusal that says why not.
	 *
	 * A library on one of our own services, and one this gateway can write into. That
	 * is the whole rule, and it is the rule the product exists for: a path nothing
	 * scans accepts the file, reports success and produces a folder no media server
	 * will ever show. There is no error to find afterwards, because nothing failed.
	 *
	 * The write is probed rather than read off the library row. The flag is what the
	 * last scan believed, and a disk unmounted since then is exactly the case worth
	 * catching — it costs one `access` against a choice somebody is making by hand.
	 */
	private async _requireDestination(libraryId: string): Promise<LibraryEntity> {
		const library = await this._libraries.findOne({ where: { id: libraryId } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		const service = await this._services.findOne({ where: { id: library.serviceId } });

		// The mount and not the sharing switch: a destination has to be a path the media
		// server actually scans, and whether its libraries are offered to peers says
		// nothing about that. `serviceMode` also keeps a peer-backed row out, which no
		// column test on its own would.
		if (
			service === null
			|| serviceMode(service) !== MediaServiceMode.LOCAL
			|| !library.localPath
		) {
			throw new ConflictException(ErrorKey.TRANSFER_DESTINATION_INVALID);
		}

		if (!(await this._libraryManager.probe(library.localPath)).writable) {
			throw new ConflictException(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		}

		return library;
	}

	/**
	 * Where the file goes inside the new library.
	 *
	 * The layout it already has is kept — `The Expanse/Season 1/S01E02.mkv` stays that,
	 * one library over — because the folders are what a media server groups a series
	 * by, and flattening them to a file name would scatter a season the day somebody
	 * corrected its library.
	 *
	 * The fallback folder is looked at as well as the library, and it is not an
	 * afterthought: a file placed there belongs to no library at all, so without this
	 * every single row this screen exists to fix would be the one case that loses its
	 * folders on the way out. Only a file that sits under neither falls back to its own
	 * name, and then there is genuinely nothing to preserve.
	 */
	/**
	 * The folder somebody chose, once it is shown to be inside the library they chose.
	 *
	 * Refused otherwise, and that refusal is the whole reason a folder can be named at
	 * all: a directory under a root the service declared is a directory that service
	 * scans, while a path somebody typed can be anywhere — and a file written where no
	 * server looks is a transfer that reports success and produces nothing.
	 *
	 * A folder that does not exist yet is accepted. Nothing is created here: the
	 * directory appears when the bytes are written, so a redirection somebody changes
	 * their mind about leaves no empty folders behind.
	 */
	private async _requireFolder(
		library: LibraryEntity,
		folder: string | null,
	): Promise<string | null> {
		if (folder === null || folder.trim() === '') {
			return null;
		}

		const chosen = resolve(folder.trim());
		const reachable = await this._localRootsOf(library);

		if (!reachable.some((root) => isInside(chosen, root))) {
			throw new ConflictException(ErrorKey.TRANSFER_DESTINATION_INVALID);
		}

		return chosen;
	}

	/**
	 * Every directory of this library on our disk, resolved.
	 *
	 * **A library is not a place.** `Series TV` on the owner's gateway is five
	 * directories on five disks, and `localPath` holds exactly one of them — so anything
	 * asking "is this file inside that library" against `localPath` alone answers no for
	 * four fifths of it.
	 *
	 * That is not a near-miss, because of what the callers do with the no. `_requireFolder`
	 * refuses a perfectly good folder; `_destinationPath` reads it as "there is nothing to
	 * preserve" and falls back to `basename()`, which is how a season redirected to
	 * `/share/Animes2/Series` landed as fifty files flat in that directory with no show
	 * folder and no season folder anywhere. The layout was not lost in the move: it was
	 * never looked for, because the file was judged to be outside the library it was in.
	 *
	 * The derivation already existed and was already used ten lines above this, which is
	 * the whole lesson: one caller had it right and the other did not, and nothing made
	 * them share.
	 */
	private async _localRootsOf(library: LibraryEntity): Promise<string[]> {
		const service = await this._services.findOne({ where: { id: library.serviceId } });
		const derived = service?.rootMappings ? derivedLocalRoots(library.paths ?? [], service) : [];
		// A service with no mappings declared yet answers with nothing, and the library's
		// own path is then the only root there is — which is what it was before a library
		// could have several.
		const roots = derived.length > 0 ? derived : [library.localPath].filter(Boolean);

		return (roots as string[]).map((root) => resolve(root));
	}

	private async _destinationPath(
		transfer: TransferEntity,
		library: LibraryEntity,
		folder: string | null = null,
	): Promise<string> {
		const current = resolve(transfer.targetPath);
		const previous =
			transfer.targetLibraryId === null
				? null
				: await this._libraries.findOne({ where: { id: transfer.targetLibraryId } });
		const fallback = (await this._settings.get()).defaultTargetPath?.trim();

		const roots = [
			...(previous === null ? [] : await this._localRootsOf(previous)),
			...(fallback ? [resolve(fallback)] : []),
		];

		// Deepest first, for the same reason `mappedLocalPath` prefers the longest
		// prefix: nested roots are a real setup — `/share/Media` on the NAS and
		// `/share/Media/4k` on a faster disk — and matching the shallower one would keep
		// `4k/…` as part of the layout and recreate it under the chosen folder.
		roots.sort((left, right) => right.length - left.length);

		const root = roots.find((candidate) => isInside(current, candidate)) ?? null;
		const inside = root === null ? basename(current) : relative(root, current);

		// The chosen folder replaces the root and nothing else: the layout below it is
		// kept, so a show still lands under its own folder and its season rather than
		// as a bare file in whatever directory somebody picked.
		return join(folder ?? resolve(library.localPath as string), inside);
	}

	/** Saves a state change and pushes it, so a long move is visible while it runs. */
	private async _publishState(transfer: TransferEntity, state: TransferState): Promise<void> {
		transfer.state = state;

		await this._transfers.save(transfer);

		const [presented] = await this._present([transfer]);

		this._events.emit(EventName.TRANSFER_STATE, presented);
	}

	/**
	 * The wire shape, with the numbers the row cannot carry.
	 *
	 * `kind` comes from the item, which already has it; `chunksDone` is counted per
	 * transfer, and the live figures from the engine for the ones it is running.
	 *
	 * Reading the rate and the source list from the engine rather than from the row is
	 * what makes a page opened mid-transfer show something: the row carries only what
	 * survives a restart, and a listing built from it alone shows every running
	 * transfer at zero bytes per second with no sources until the next pushed frame.
	 * A transfer the engine is not running has no live figures, which is the honest
	 * answer for one that is queued, paused or finished.
	 */
	private async _present(transfers: TransferEntity[]): Promise<Transfer[]> {
		if (transfers.length === 0) {
			return [];
		}

		const items = await this._items.find({
			where: { id: In(transfers.map((transfer) => transfer.itemId)) },
		});
		const kinds = new Map(items.map((item) => [item.id, item.kind as string]));
		// Kept as the whole media rather than another three maps: the numbers, the kind and
		// the parent are all read off it, and a map per field is a map that can fall out of
		// step with the others.
		const byId = new Map(items.map((item) => [item.id, item]));
		// Where each file has got to after its bytes. Read here rather than off the row
		// because a landing outlives nothing: it is deleted the moment a media server
		// indexes the file, so there is no column that could hold it in step.
		const landings = await this._landings.statesByTransfer(
			transfers.map((transfer) => transfer.id),
		);

		return Promise.all(
			transfers.map(async (transfer) =>
				toTransfer(transfer, {
					kind: kinds.get(transfer.itemId),
					seasonNumber: byId.get(transfer.itemId)?.seasonNumber ?? null,
					episodeNumber: byId.get(transfer.itemId)?.episodeNumber ?? null,
					landing: landings.get(transfer.id) ?? null,
					chunksDone: (await this._chunks.countByState(transfer.id))[ChunkState.DONE],
					...(this._engine.progressOf(transfer.id) ?? {}),
				}),
			),
		);
	}

	private async _serviceNames(ids: string[]): Promise<Map<string, string>> {
		const unique = [...new Set(ids)];

		if (unique.length === 0) {
			return new Map();
		}

		const services = await this._services.find({ where: { id: In(unique) } });

		return new Map(services.map((service) => [service.id, service.name]));
	}

	private async _require(id: string): Promise<TransferEntity> {
		const transfer = await this._transfers.findOne({ where: { id } });

		if (transfer === null) {
			throw new NotFoundException(ErrorKey.TRANSFER_NOT_FOUND);
		}

		return transfer;
	}

	private async _requireLive(id: string): Promise<TransferEntity> {
		const transfer = await this._require(id);

		if (FINISHED.includes(transfer.state)) {
			throw new ConflictException(ErrorKey.TRANSFER_NOT_RESUMABLE);
		}

		return transfer;
	}
}
