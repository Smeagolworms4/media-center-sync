import { constants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
	categoryKeyOf,
	ErrorKey,
	LibraryHintKind,
	MediaKind,
	MediaServiceMode,
	PathMatch,
	type CategoryKeyword,
	type Library,
	type LibraryCheck,
	type LibraryHint,
	type MediaCategory,
	type UpdateLibraryRequest,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from '@nestjs/common';
import type {
	CategoryKeyword as CategoryKeywordEntity,
	Library as LibraryEntity,
	MediaService as MediaServiceEntity,
} from '@/entities';
import {
	CategoryKeywordRepository,
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	derivedLocalPath,
	layoutExamples,
	layoutSignals,
	type SeasonRow,
	PathMatchService,
	reachesFiles,
	serviceMode,
	SettingsService,
	type ServiceRootMappings,
} from '@/services';
import { toLibrary } from './mappers';

/**
 * What probing one declared path found, on this side only.
 *
 * `serverPaths` and `match` are left out rather than defaulted: they are the media
 * server's half of the answer, and the callers of `probe` — placement, a transfer
 * about to write, a setting being saved — are asking whether this gateway can write
 * into a directory, which costs a `stat`. Folding the server round trip into that
 * would put an HTTP call on the path that runs per transfer.
 */
export type PathProbe = Omit<
	LibraryCheck,
	'libraryId' | 'name' | 'localPath' | 'derived' | 'serverPaths' | 'match'
>;

/**
 * The key a dismissal is stored under, for one series.
 *
 * Built from the item's identifier and never from its name, because renaming the
 * folder is the most likely thing somebody does straight after reading the hint — and
 * a key derived from the name would bring the hint back at exactly that moment, as if
 * the dismissal had never been saved.
 */
const hintKeyOf = (itemId: string): string => `misread-folder:${itemId}`;

/**
 * The libraries of the registered services, and where the gateway can write them.
 *
 * The whole point of this manager is one failure that reports nothing. A library
 * whose `localPath` does not designate the same directory the media service reads
 * accepts every transfer, writes every file, and leaves the service's library empty —
 * with no error anywhere, because nothing did anything wrong. So the path is probed
 * whenever it is set, and a path that cannot be written is refused at the moment
 * somebody types it rather than discovered on the first sync.
 */
@Injectable()
export class LibraryManager {
	private readonly _logger = new Logger(LibraryManager.name);

	public constructor(
		private readonly _libraries: LibraryRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _keywords: CategoryKeywordRepository,
		/**
		 * Asks the media server whether it can see what the gateway just wrote.
		 *
		 * A service and not something this manager does itself: writing a file and
		 * talking to a Jellyfin is technical capability, and a manager that opened a
		 * `fetch` would be the leak CLAUDE.md names. The decision — which libraries are
		 * worth asking about, and what a refusal means — stays here.
		 */
		private readonly _pathMatch: PathMatchService,
		/**
		 * Read only to notice how a library is shaped, never to browse it.
		 *
		 * A misread folder is a fact about the tree a media server reported, and the tree
		 * lives in the item rows. `MediaManager` owns browsing them; what is asked here is
		 * one projection of season names, because the question is about this manager's
		 * subject — whether a library is organised in a way its server reads wrongly.
		 */
		private readonly _items: MediaItemRepository,
		private readonly _settings: SettingsService,
	) {}

	public async list(serviceId?: string): Promise<Library[]> {
		const libraries =
			serviceId === undefined
				? await this._libraries.find({ order: { name: 'ASC' } })
				: await this._libraries.findByService(serviceId);

		// The services come along because a library's own roots are derived through its
		// service's mappings, and a screen that offers a destination has to name real
		// directories rather than the one the scan happens to translate paths with.
		const services = new Map((await this._services.find()).map((one) => [one.id, one]));

		return Promise.all(
			libraries.map(async (library) => {
				const mapped = toLibrary(library, services.get(library.serviceId));

				return { ...mapped, localRoots: await this._reachableRoots(mapped.localRoots ?? []) };
			}),
		);
	}

	/**
	 * Of the roots a mapping produces, the ones that are actually there.
	 *
	 * A mapping rewrites a prefix — `/media` becomes `/share` — and says nothing about
	 * whether the result exists. A library declaring `/media/FilmsHD2` on a server whose
	 * second disk is mounted somewhere else entirely yields `/share/FilmsHD2`, a
	 * perfectly well-formed path with nothing behind it. Offering it as a destination is
	 * offering a folder no file will ever reach, and the failure would be silent.
	 *
	 * Writable and not merely present, for the same reason every other destination check
	 * is: a directory this gateway can read and not write into accepts a transfer it
	 * cannot finish.
	 *
	 * A handful of `access` calls per library, which is what it costs to answer with
	 * directories rather than with strings.
	 */
	private async _reachableRoots(roots: readonly string[]): Promise<string[]> {
		const reachable: string[] = [];

		for (const root of roots) {
			const probe = await this.probe(root);

			if (probe.exists && probe.writable) {
				reachable.push(root);
			}
		}

		return reachable;
	}

	public async read(id: string): Promise<Library> {
		const library = await this._require(id);

		return toLibrary(library, await this._services.findOne({ where: { id: library.serviceId } }));
	}

	/**
	 * Set where the gateway writes, and whether this library is a default target.
	 *
	 * Setting a path re-probes it, and a path that is not writable is refused. Storing
	 * it anyway and letting `writable` stay false would look like it worked: the
	 * library would appear configured, and the failure would surface hours later as a
	 * transfer that cannot be placed.
	 */
	public async update(id: string, patch: UpdateLibraryRequest): Promise<Library> {
		const library = await this._require(id);

		if (patch.localPath !== undefined) {
			library.localPath = await this._adoptPath(patch.localPath);
			library.writable = library.localPath !== null;
			library.localPathDerived = false;

			if (library.localPath === null) {
				// Clearing the exception falls back to the service's mapping rather than
				// to nothing. That is what "explicit wins" means read backwards: somebody
				// who empties the box is withdrawing their override, and leaving the
				// library with no path at all would silently take it out of every sync
				// until they noticed.
				await this._deriveFor(library, await this._services.findOne({
					where: { id: library.serviceId },
				}));
			}
		}


		if (patch.isDefaultTarget !== undefined) {
			if (patch.isDefaultTarget && !library.writable) {
				// A default target the gateway cannot write to is the same trap one step
				// further on: every sync that falls back to it fails at placement.
				throw new ConflictException(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
			}

			library.isDefaultTarget = patch.isDefaultTarget;
		}

		if (patch.alias !== undefined) {
			// Trimmed to null rather than stored empty: an alias of one space would merge
			// this library with nothing and show a category with no name.
			library.alias = patch.alias?.trim() || null;
		}

		if (patch.position !== undefined) {
			library.position = patch.position;
		}

		const saved = await this._libraries.save(library);

		// One default per kind, cleared after the save so that a failure above leaves
		// the previous default alone rather than none at all.
		if (saved.isDefaultTarget) {
			await this._libraries.clearDefaultTarget(saved.kind, saved.id);
		}

		// A path typed here can be the only mapping a service has — that is what the
		// field is for — so setting one makes the service ours and clearing the last
		// one makes it not. Left out, a service whose only mapping is a library path
		// would stay remote and refuse every transfer aimed at the path somebody had
		// just been allowed to save.
		if (patch.localPath !== undefined) {
			await this.refreshMount(saved.serviceId);
		}

		return toLibrary(saved, await this._services.findOne({ where: { id: saved.serviceId } }));
	}

	/**
	 * Libraries of the same name, seen as one thing.
	 *
	 * A household with two servers has two libraries called `Shows`, and a friend makes
	 * a third. They are one category to the person looking at them, and three bands all
	 * called `Shows` is showing them the plumbing rather than their media. So they merge
	 * on the name somebody would read — the alias when one was set, since that is the
	 * name they chose — compared without case or accents, because `Animes` and `animés`
	 * are not two categories.
	 *
	 * Then the keywords, which is what makes a peer's twenty shelves file themselves.
	 * A library whose folded name is a keyword of one of our categories is read as part
	 * of that category, wherever it sits — our machine, a friend's Jellyfin, a gateway
	 * two hops away. Nothing is written when that happens: the fold is recomputed from
	 * the table on every call, which is what makes a keyword somebody regrets undoable
	 * by deleting it. Writing an `alias` into the rows instead would have been one line
	 * shorter and irreversible, because the value it overwrote is gone and the only way
	 * back would be typing eleven aliases by hand.
	 *
	 * **An alias somebody typed always wins over a keyword.** The rename on the
	 * libraries screen is the repair for a mapping that filed something wrongly, so a
	 * keyword that could override it would make that repair last until the next request.
	 *
	 * **A folded library never names the category, and always counts for its order.**
	 * Those are two different questions and answering both with the anchor was a bug.
	 * Naming is the anchor's, so that a friend's `TV` cannot rebaptise our `Shows` by
	 * being read first — the answer must not depend on which row came back first.
	 * Ordering is each library's own: a category sits at the lowest position among all
	 * the libraries in it, folded or not. Taking the anchor's position too meant that
	 * moving a folded library on the libraries screen did nothing at all, with nothing
	 * on screen to say why — a control that silently ignores half the rows it is
	 * offered on.
	 *
	 * So the name comes from the lowest-positioned library that was *not* folded, and
	 * the position from the lowest of them all. That decides the order categories
	 * appear in, and it is also the answer to which category wins when the same media
	 * is filed in two of them: the first one.
	 */
	public async categories(): Promise<MediaCategory[]> {
		const [libraries, services, keywords] = await Promise.all([
			this._libraries.find(),
			this._services.find(),
			this._keywords.findAllOrdered(),
		]);
		// `serviceMode` and not the mount column alone: a peer-backed service is
		// somebody else's machine however its row reads, and a category counting one of
		// their shelves as ours would offer it as a destination one screen later.
		const local = new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
		const filed = this._filedByKeyword(libraries, keywords);
		const merged = new Map<string, MediaCategory>();
		// The position of the library each category takes its name from, so a folded
		// one can move the band without also renaming it.
		const namedAt = new Map<string, number>();

		for (const library of libraries) {
			const mapped = this._keywordMatch(library, filed);
			const name = mapped?.name ?? (library.alias?.trim() || library.name);
			const kind = mapped?.kind ?? library.kind;
			const position = library.position;
			const names = mapped === undefined;
			const key = categoryKeyOf(name);
			const existing = merged.get(key);

			if (existing === undefined) {
				namedAt.set(key, names ? position : Number.POSITIVE_INFINITY);
				merged.set(key, {
					key,
					name,
					kind,
					position,
					libraryIds: [library.id],
					serviceIds: [library.serviceId],
					itemCount: library.itemCount,
					local: local.has(library.serviceId),
				});

				continue;
			}

			existing.libraryIds.push(library.id);
			existing.itemCount += library.itemCount;
			existing.local = existing.local || local.has(library.serviceId);

			if (!existing.serviceIds.includes(library.serviceId)) {
				existing.serviceIds.push(library.serviceId);
			}

			// Two independent answers. The band moves for any library somebody moved,
			// folded or not; the name only ever changes for one that names.
			if (position < existing.position) {
				existing.position = position;
			}

			if (names && position < (namedAt.get(key) ?? Number.POSITIVE_INFINITY)) {
				// Whichever library somebody put first is the one they meant this
				// category to be — among those entitled to say so.
				namedAt.set(key, position);
				existing.name = name;
				existing.kind = kind;
			}
		}

		return [...merged.values()].sort(
			(left, right) => left.position - right.position || left.name.localeCompare(right.name),
		);
	}

	/**
	 * The keywords, each with the category it files into today and what it catches.
	 *
	 * `categoryKey` is computed rather than stored — see the note on the entity. The
	 * row remembers a library; which category that library reads as is a question with
	 * a different answer after every rename, and storing the answer is how a list ends
	 * up pointing at a category nobody has any more.
	 */
	public async keywords(): Promise<CategoryKeyword[]> {
		const [rows, libraries, categories] = await Promise.all([
			this._keywords.findAllOrdered(),
			this._libraries.find(),
			this.categories(),
		]);
		const keyByLibrary = new Map<string, MediaCategory>();

		for (const category of categories) {
			for (const libraryId of category.libraryIds) {
				keyByLibrary.set(libraryId, category);
			}
		}

		return rows.flatMap((row) => {
			const category = keyByLibrary.get(row.libraryId);

			// A row whose anchor is gone answers nothing rather than an empty category.
			// The cascade removes them, so this only ever fires in the window between a
			// service being unregistered and this request reading the tables.
			if (category === undefined) {
				return [];
			}

			return [{
				id: row.id,
				categoryKey: category.key,
				categoryName: category.name,
				keyword: row.keyword,
				normalized: row.normalized,
				libraryIds: libraries
					.filter((library) => this._foldsTo(library, row.normalized))
					.map((library) => library.id),
			}];
		});
	}

	/**
	 * Plug a name into a category, for every library that ever carries it.
	 *
	 * Refused rather than stored when the name folds to nothing: the folded form is
	 * what matching compares, and an empty one would match every library whose name is
	 * also punctuation — none today, and whichever one somebody adds tomorrow.
	 *
	 * Adding the same keyword to the category that already has it answers the existing
	 * row instead of failing, so a second drop of a shelf that is already mapped is a
	 * no-op rather than an error somebody has to read. Claiming one another category
	 * holds is refused: see `LIBRARY_KEYWORD_TAKEN`.
	 */
	public async addKeyword(categoryKey: string, keyword: string): Promise<CategoryKeyword> {
		const normalized = this._normalizeKeyword(keyword);
		const category = await this._requireCategory(categoryKey);
		const existing = await this._keywords.findByNormalized(normalized);

		if (existing !== null) {
			if (category.libraryIds.includes(existing.libraryId)) {
				return this._oneKeyword(existing.id);
			}

			throw new ConflictException(ErrorKey.LIBRARY_KEYWORD_TAKEN);
		}

		const saved = await this._keywords.save(
			this._keywords.create({
				libraryId: await this._anchorOf(category),
				keyword: keyword.trim(),
				normalized,
			}),
		);

		this._logger.log(`Libraries named ${normalized} now file into ${category.name}`);

		return this._oneKeyword(saved.id);
	}

	/**
	 * Move a keyword to another category.
	 *
	 * Re-anchored rather than deleted and recreated, so the identifier a screen is
	 * holding stays valid — which is what lets the same undo work for a move as for an
	 * addition.
	 */
	public async moveKeyword(id: string, categoryKey: string): Promise<CategoryKeyword> {
		const row = await this._requireKeyword(id);
		const category = await this._requireCategory(categoryKey);

		row.libraryId = await this._anchorOf(category);

		await this._keywords.save(row);

		this._logger.log(`Libraries named ${row.normalized} now file into ${category.name}`);

		return this._oneKeyword(row.id);
	}

	/**
	 * Unplug a keyword.
	 *
	 * This is the undo, and it is exact because nothing was written when the keyword was
	 * added: the libraries it was folding go straight back to reading as their own
	 * names, in the same request.
	 */
	public async removeKeyword(id: string): Promise<void> {
		const row = await this._requireKeyword(id);

		await this._keywords.delete({ id: row.id });

		this._logger.log(`Libraries named ${row.normalized} file on their own name again`);
	}

	/**
	 * Make one category read as the category a destination library belongs to.
	 *
	 * Two mechanisms decide two different things and only one of them had a control.
	 * `Settings.categoryTargets` says where a *new* pull lands; `Library.alias` is what
	 * libraries merge on, and so what makes two shelves one category. Somebody who
	 * pointed `Séries` at their `Shows` library read that as "Séries is Shows here",
	 * saved, and still saw two categories — because nothing had touched an alias. This
	 * is the second half of that sentence: the libraries of `key` take the destination
	 * category's name, and `categories()` then folds them together on its own.
	 *
	 * Three cases write nothing rather than something wrong:
	 *
	 * - a destination whose category cannot be read — an identifier left over from a
	 *   library that has since gone — because the name to adopt would be the empty
	 *   string, and an empty alias is a category with no name rather than no alias;
	 * - a destination already in the category being mapped, which would alias a thing
	 *   to itself and rewrite every row for nothing;
	 * - a destination the gateway cannot write into. A category target says where a
	 *   new pull lands, and a library on a server whose files we do not hold cannot
	 *   receive one, so the mapping that triggered this had no meaning to act on.
	 *
	 * **Every library of the category is renamed, including the ones on servers that
	 * are not ours.** That is the whole purpose of the alias and it is worth stating,
	 * because it was once refused here on the reasoning that folding a friend's shelf
	 * into ours claims their media as filed in our library. It does not. The alias is
	 * local, never leaves this gateway, and changes no one's server — and the category
	 * is what somebody browses, not where anything is written. Saying a friend's `TV`
	 * is our `Séries` is exactly the sentence the field exists to write; where a new
	 * episode of it lands is the destination's answer and is decided, separately, by
	 * the mount. Refusing it left the two shelves side by side with the same media
	 * under two names and no control anywhere that could join them.
	 *
	 * Returns the name the libraries now read as, or null when nothing was touched.
	 */
	public async mergeCategoryInto(key: string, destinationLibraryId: string): Promise<string | null> {
		const categories = await this.categories();
		const destination = categories.find((category) =>
			category.libraryIds.includes(destinationLibraryId),
		);
		const source = categories.find((category) => category.key === key);

		if (destination === undefined || source === undefined || destination.key === source.key) {
			return null;
		}

		const name = destination.name.trim();

		if (name === '') {
			return null;
		}

		const ours = await this._ourServiceIds();
		const libraries = await this._libraries.findByIds([
			destinationLibraryId,
			...source.libraryIds,
		]);
		const target = libraries.find((library) => library.id === destinationLibraryId);

		if (target === undefined || !ours.has(target.serviceId)) {
			return null;
		}

		let renamed = 0;

		for (const library of libraries) {
			if (library.id === destinationLibraryId) {
				continue;
			}

			library.alias = name;

			await this._libraries.save(library);

			renamed += 1;
		}

		if (renamed > 0) {
			this._logger.log(`Category ${key} now reads as ${name}: ${renamed} libraries renamed`);
		}

		return renamed === 0 ? null : name;
	}

	/**
	 * Which category each library belongs to, by library identifier.
	 *
	 * The inverse of `librariesOfCategory`, for the caller that starts from an item
	 * rather than from a category — placement, asking where this one is configured to
	 * go. Derived from `categories()` rather than folded from the name again, so the
	 * key a setting was stored under and the key a placement looks up can never be two
	 * different readings of the same library name.
	 */
	public async categoryKeysByLibrary(): Promise<Map<string, string>> {
		const keys = new Map<string, string>();

		for (const category of await this.categories()) {
			for (const libraryId of category.libraryIds) {
				keys.set(libraryId, category.key);
			}
		}

		return keys;
	}

	/** The libraries behind one merged category, for a query that names it. */
	public async librariesOfCategory(key: string): Promise<string[]> {
		const categories = await this.categories();

		return categories.find((category) => category.key === key)?.libraryIds ?? [];
	}

	/**
	 * What every declared library really looks like from here.
	 *
	 * Read and write are probed separately because they fail for different reasons and
	 * call for different fixes — a readable library the gateway cannot write into is a
	 * permissions problem on this side, and it only ever shows up on the first
	 * transfer otherwise.
	 */
	/**
	 * Whether each library the gateway could write into is actually reachable.
	 *
	 * **Only libraries on our own services.** A peer's library is somebody else's disk
	 * reached over the link: it has no local path by construction, and it can never be
	 * a destination. Probing it reported "does not exist, not readable, not writable"
	 * on every one of them, and the dashboard then asked somebody to go and fix a
	 * thing that is neither broken nor fixable — which is worse than saying nothing,
	 * because a screen that cries wolf about two rows is a screen whose real warnings
	 * stop being read.
	 *
	 * A library on a friend's Jellyfin or Plex is excluded for the same reason: we
	 * have an account on their server, not a path on their disk.
	 */
	/**
	 * What is worth saying about the way this gateway is organised.
	 *
	 * Two things, both silent and both expensive to work out alone:
	 *
	 * - **Nothing is mounted.** `MISSING` means "known elsewhere, not held here", so on
	 *   a gateway where no server has its folders declared every single row reads
	 *   missing — thirty-one thousand of the owner's thirty-one thousand two hundred
	 *   and sixty-five. The definition is right and the screen is unreadable, and the
	 *   one line that explains it is the difference between a bug and a setting.
	 * - **A library root one level too high.** The media server then takes a folder of
	 *   shows for a series and every show under it for a season. The gateway cannot fix
	 *   that and must not try — it mirrors what the server declares — but it can name
	 *   the series and say what to change on the server.
	 *
	 * Both are suspicions rather than verdicts, and both can be dismissed for good; the
	 * mount one disappears on its own the moment a mapping exists, so it is never
	 * offered for dismissal. See `library-layout.ts` for what counts as evidence and
	 * why the bar is where it is.
	 */
	public async hints(): Promise<LibraryHint[]> {
		const services = await this._services.find();
		const dismissed = new Set(await this._settings.getValue('dismissedLibraryHints'));
		const hints: LibraryHint[] = [];

		/*
		 * Only once a service exists, because a gateway nobody has registered anything on
		 * is not misconfigured — it is new, and the setup screen is already saying so. A
		 * peer's service counts as registered and never as mounted: their disks are not
		 * ours, so a gateway whose only services are friends' is one where nothing is held
		 * here, which is exactly what this says.
		 */
		if (
			services.length > 0 &&
			services.every((service) => serviceMode(service) !== MediaServiceMode.LOCAL)
		) {
			hints.push({
				key: 'nothing-mounted',
				kind: LibraryHintKind.NOTHING_MOUNTED,
				itemId: null,
				title: null,
				libraryName: null,
				serviceName: null,
				signals: [],
				examples: [],
				seasonCount: 0,
			});
		}

		hints.push(...(await this._misreadFolders(services, dismissed)));

		return hints;
	}

	/**
	 * The series whose seasons do not look like seasons.
	 *
	 * The season names are read for the whole index in one narrow query and grouped in
	 * memory, because the question is about all of them and a query per series would be
	 * thousands. Only the series that trip a signal are then read in full — a handful,
	 * usually none — so the cost of asking is one projection whatever the answer is.
	 */
	private async _misreadFolders(
		services: MediaServiceEntity[],
		dismissed: ReadonlySet<string>,
	): Promise<LibraryHint[]> {
		const byParent = new Map<string, SeasonRow[]>();

		for (const season of await this._items.findSeasonNames()) {
			byParent.set(season.parentId, [...(byParent.get(season.parentId) ?? []), season]);
		}

		const suspect = new Map<string, SeasonRow[]>();

		for (const [parentId, rows] of byParent) {
			if (layoutSignals(rows).length > 0 && !dismissed.has(hintKeyOf(parentId))) {
				suspect.set(parentId, rows);
			}
		}

		if (suspect.size === 0) {
			return [];
		}

		const libraries = new Map((await this._libraries.find()).map((one) => [one.id, one]));
		const named = new Map(services.map((service) => [service.id, service.name]));
		const seriesById = new Map(
			(await this._items.findByIds([...suspect.keys()])).map((one) => [one.id, one]),
		);

		return [...suspect.entries()].flatMap(([parentId, rows]) => {
			const series = seriesById.get(parentId);

			// A parent the index no longer holds, or one that is not a series at all —
			// a season under a season, which a mis-scraped library does report. Dropped
			// rather than shown with a blank name: a hint whose subject nobody can find
			// on a screen is a hint nobody can act on.
			if (series === undefined || series.kind !== MediaKind.SERIES) {
				return [];
			}

			return [{
				key: hintKeyOf(parentId),
				kind: LibraryHintKind.MISREAD_FOLDER,
				itemId: series.id,
				title: series.title,
				libraryName: libraries.get(series.libraryId)?.name ?? null,
				serviceName: named.get(series.serviceId) ?? null,
				signals: layoutSignals(rows),
				examples: layoutExamples(rows),
				// Every season it has, not only the odd ones: the other signal is about
				// how many a series claims, and a count that had already dropped the
				// numbered ones would measure the wrong thing.
				seasonCount: rows.length,
			}];
		});
	}

	public async check(): Promise<LibraryCheck[]> {
		const services = new Map(
			(await this._services.find()).map((service) => [service.id, service]),
		);
		const libraries = (await this._libraries.find({ order: { name: 'ASC' } })).filter(
			(library) => {
				const service = services.get(library.serviceId);

				return service !== undefined && serviceMode(service) === MediaServiceMode.LOCAL;
			},
		);

		return Promise.all(
			libraries.map(async (library) => {
				const probe = await this.probe(library.localPath);
				// Nobody is asked about a path nothing can be written into: the marker
				// could not be placed, so the server could not be shown anything. That
				// path already carries its own error, and a second warning saying the
				// same thing in other words sends somebody hunting a second problem.
				const match = probe.writable
					? await this._matchOf(library, services.get(library.serviceId))
					: PathMatch.UNKNOWN;

				return {
					libraryId: library.id,
					name: library.name,
					localPath: library.localPath,
					derived: library.localPathDerived,
					...probe,
					serverPaths: library.paths,
					match,
					// The mismatch outranks nothing — a writable path with no other
					// complaint is exactly the case where the failure is invisible — so
					// it fills the error only when the filesystem had nothing to say.
					error: probe.error ?? (match === PathMatch.MISMATCHED
						? ErrorKey.LIBRARY_PATH_MISMATCH
						: null),
				};
			}),
		);
	}

	/**
	 * Ask this library's own service whether it sees what we see.
	 *
	 * The credentials are re-read here rather than carried on the service already in
	 * hand, because `find()` leaves them out — that is the whole point of the
	 * `select: false` on them — and a connection built from that row would talk to
	 * Jellyfin without a token and be told off for it.
	 */
	private async _matchOf(
		library: LibraryEntity,
		service: MediaServiceEntity | undefined,
	): Promise<PathMatch> {
		if (service === undefined || library.paths.length === 0) {
			return PathMatch.UNKNOWN;
		}

		const withSecrets = await this._services.findWithSecrets(service.id);

		if (withSecrets === null) {
			return PathMatch.UNKNOWN;
		}

		return this._pathMatch.verify(
			{
				id: withSecrets.id,
				type: withSecrets.type,
				baseUrl: withSecrets.baseUrl,
				token: withSecrets.token,
				username: withSecrets.username,
				password: withSecrets.password,
			},
			library.localPath,
			library.paths,
		);
	}

	public async probe(localPath: string | null): Promise<PathProbe> {
		if (localPath === null || localPath === '') {
			return {
				exists: false,
				readable: false,
				writable: false,
				freeBytes: null,
				error: ErrorKey.LIBRARY_PATH_UNREADABLE,
			};
		}

		try {
			await access(localPath, constants.F_OK);
		} catch {
			return {
				exists: false,
				readable: false,
				writable: false,
				freeBytes: null,
				error: ErrorKey.LIBRARY_PATH_UNREADABLE,
			};
		}

		const readable = await access(localPath, constants.R_OK).then(
			() => true,
			() => false,
		);
		const writable = await access(localPath, constants.W_OK).then(
			() => true,
			() => false,
		);
		const freeBytes = await statfs(localPath).then(
			(stats) => Number(stats.bavail) * Number(stats.bsize),
			() => null,
		);

		return {
			exists: true,
			readable,
			writable,
			freeBytes,
			error: writable ? null : ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
		};
	}

	/**
	 * Re-apply a service's root mappings to every library under it.
	 *
	 * Called after a probe reports the libraries and after the roots themselves are
	 * changed, because both are moments where the answer moves: a library the service
	 * has just renamed reports a new path, and a corrected mapping is worthless until
	 * something re-reads it.
	 *
	 * A library whose path somebody typed is never touched. That is the whole contract
	 * of `localPath`: it exists for the exceptions the mapping cannot express — a
	 * library bind-mounted somewhere of its own, a symlink the service resolves and we
	 * do not — and a mapping that overwrote them would undo the fix at the next scan,
	 * hours after anybody connected the two events.
	 */
	public async applyRootMapping(service: MediaServiceEntity): Promise<void> {
		for (const library of await this._libraries.findByService(service.id)) {
			await this._deriveFor(library, service);
		}

		await this.refreshMount(service.id);
	}

	/**
	 * Write down whether the gateway reaches this service's files.
	 *
	 * The derivation itself is `reachesFiles`; this is the one place that stores it, so
	 * the column cannot be written two ways. Every path that can move the answer ends
	 * here: registering, probing, changing the root mappings, and setting or clearing a
	 * library's own path.
	 *
	 * Nothing caches it. `serviceMode` reads the row and the row is re-read after every
	 * one of those writes, which is the whole reason a service registered before its
	 * mapping flips the moment the mapping lands instead of at the next restart.
	 *
	 * Written only when it actually changed, so the ordinary case — a scan re-deriving
	 * the same paths on a service that was already ours — does not touch `updatedAt` on
	 * every service on every scan.
	 */
	public async refreshMount(serviceId: string): Promise<boolean> {
		const service = await this._services.findOne({ where: { id: serviceId } });

		if (service === null) {
			return false;
		}

		const mounted = reachesFiles(service, await this._libraries.findByService(serviceId));

		if (mounted === service.filesMounted) {
			return mounted;
		}

		// A targeted update rather than saving the row back. The credentials are
		// `select: false`, so the entity in hand does not carry them, and handing a
		// whole object back to `save` is how a column nobody meant to touch gets
		// rewritten from a value that was never read.
		await this._services.update({ id: serviceId }, { filesMounted: mounted });

		this._logger.log(
			`${service.name} is now ${mounted ? 'ours' : 'reached over HTTP only'}: `
				+ 'its files were re-derived from the mappings',
		);

		return mounted;
	}

	/**
	 * What each keyword folds a library into, keyed by the folded form.
	 *
	 * Resolved through the anchor library's own reading of itself — its alias when it
	 * has one — and never through the anchor's own keywords. One hop, deliberately: a
	 * chain would need a cycle check, and two keywords pointing at each other is a
	 * thing somebody can write.
	 */
	private _filedByKeyword(
		libraries: LibraryEntity[],
		keywords: CategoryKeywordEntity[],
	): Map<string, FiledCategory> {
		const byId = new Map(libraries.map((library) => [library.id, library]));
		const filed = new Map<string, FiledCategory>();

		for (const keyword of keywords) {
			const anchor = byId.get(keyword.libraryId);

			if (anchor === undefined) {
				continue;
			}

			filed.set(keyword.normalized, {
				name: anchor.alias?.trim() || anchor.name,
				kind: anchor.kind,
				position: anchor.position,
			});
		}

		return filed;
	}

	/** What a keyword makes of this library, or nothing when none applies. */
	private _keywordMatch(
		library: LibraryEntity,
		filed: Map<string, FiledCategory>,
	): FiledCategory | undefined {
		return library.alias?.trim() ? undefined : filed.get(categoryKeyOf(library.name));
	}

	/** Whether this library is one the given keyword currently files. */
	private _foldsTo(library: LibraryEntity, normalized: string): boolean {
		return !library.alias?.trim() && categoryKeyOf(library.name) === normalized;
	}

	/**
	 * The folded form a keyword is stored and compared under.
	 *
	 * `categoryKeyOf` answers `library` for a name that folds to nothing, which is a
	 * reasonable key for a category with an unreadable name and a terrible keyword: it
	 * would silently claim every such library. So the fold is checked for content
	 * before the fallback can apply.
	 */
	private _normalizeKeyword(keyword: string): string {
		const stripped = keyword.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

		if (!/[a-z\d]/i.test(stripped)) {
			throw new BadRequestException(ErrorKey.LIBRARY_KEYWORD_INVALID);
		}

		return categoryKeyOf(keyword);
	}

	/**
	 * Which library a category's keywords hang off.
	 *
	 * One of ours first, because that is the shelf that is still here next month: a
	 * peer's library is reachable while the link is, and anchoring a household's
	 * mapping on a friend's row would take the whole list away with the friend. Then
	 * the lowest position — the library somebody put first is the one they meant the
	 * category to be — and the identifier last, so the choice cannot change between two
	 * identical requests.
	 */
	private async _anchorOf(category: MediaCategory): Promise<string> {
		const ours = await this._ourServiceIds();
		const libraries = await this._libraries.findByIds(category.libraryIds);
		const [anchor] = [...libraries].sort(
			(left, right) =>
				Number(ours.has(right.serviceId)) - Number(ours.has(left.serviceId))
				|| left.position - right.position
				|| left.id.localeCompare(right.id),
		);

		if (anchor === undefined) {
			// A category with no library behind it cannot be read, which is what the
			// caller would otherwise discover as a foreign key failure.
			throw new NotFoundException(ErrorKey.LIBRARY_CATEGORY_NOT_FOUND);
		}

		return anchor.id;
	}

	private async _requireCategory(key: string): Promise<MediaCategory> {
		const category = (await this.categories()).find((one) => one.key === key);

		if (category === undefined) {
			throw new NotFoundException(ErrorKey.LIBRARY_CATEGORY_NOT_FOUND);
		}

		return category;
	}

	private async _requireKeyword(id: string): Promise<CategoryKeywordEntity> {
		const row = await this._keywords.findOne({ where: { id } });

		if (row === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_KEYWORD_NOT_FOUND);
		}

		return row;
	}

	/** One keyword read back the way the list reads them, never built by hand. */
	private async _oneKeyword(id: string): Promise<CategoryKeyword> {
		const found = (await this.keywords()).find((one) => one.id === id);

		if (found === undefined) {
			throw new NotFoundException(ErrorKey.LIBRARY_KEYWORD_NOT_FOUND);
		}

		return found;
	}

	/**
	 * The services whose libraries are ours to write into and to rename.
	 *
	 * `serviceMode` rather than the mount column alone, because a service reached
	 * through a peer is somebody else's machine however its row reads — see the note
	 * there, which is the same reason `check()` refuses to probe them.
	 */
	private async _ourServiceIds(): Promise<Set<string>> {
		const services = await this._services.find();

		return new Set(
			services
				.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
				.map((service) => service.id),
		);
	}

	/**
	 * Give one library the path the mapping implies, and probe it.
	 *
	 * Unlike a typed path, a derived one that cannot be written is stored rather than
	 * refused. Refusing would mean a probe of an offline NAS failing a whole scan, and
	 * the point of storing it is that `check()` can then name the directory the
	 * gateway looked at — a mapping that is one character off is invisible otherwise.
	 */
	private async _deriveFor(
		library: LibraryEntity,
		service: ServiceRootMappings | null,
	): Promise<void> {
		if (service === null || (library.localPath !== null && !library.localPathDerived)) {
			return;
		}

		const derived = derivedLocalPath(library.paths, service);

		if (derived === library.localPath) {
			return;
		}

		library.localPath = derived;
		library.localPathDerived = derived !== null;
		library.writable = derived === null ? false : (await this.probe(derived)).writable;

		if (derived !== null && !library.writable) {
			this._logger.warn(
				`Derived ${derived} for library ${library.name}, which is not writable from here`,
			);
		}

		await this._libraries.save(library);
	}

	/** Null clears the path, which makes the library read-only to us again. */
	private async _adoptPath(localPath: string | null): Promise<string | null> {
		if (localPath === null || localPath.trim() === '') {
			return null;
		}

		const candidate = localPath.trim();

		if (!isAbsolute(candidate)) {
			// A relative path resolves against whatever directory the process happens to
			// have been started in, which is not the same one in a container, in a
			// development shell and in a command.
			throw new BadRequestException(ErrorKey.LIBRARY_PATH_UNREADABLE);
		}

		const probe = await this.probe(candidate);

		if (!probe.writable) {
			this._logger.warn(`Refused ${candidate} as a library path: ${probe.error ?? 'not writable'}`);

			throw new ConflictException(probe.error ?? ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		}

		return candidate;
	}

	private async _require(id: string): Promise<LibraryEntity> {
		const library = await this._libraries.findOne({ where: { id } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		return library;
	}
}

/** What a keyword makes a library read as: the anchor category's own identity. */
interface FiledCategory {
	name: string;
	kind: LibraryEntity['kind'];
	position: number;
}
