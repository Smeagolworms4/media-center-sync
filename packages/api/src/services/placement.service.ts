import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	type PlacedBy,
	PlacementStrategy,
	type Settings,
} from '@mcs/shared';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { placedByFor } from './placed-by';
import { freeBytesAt } from './space';

/** A local library, reduced to what placement actually decides on. */
export interface PlacementLibrary {
	id: string;
	name: string;
	kind: LibraryKind;
	/** Where the gateway can write. Null means the library is read-only to us. */
	localPath: string | null;
	/** Every directory of this library on our disk. See `Library.localRoots`. */
	localRoots?: string[];
	writable: boolean;
	isDefaultTarget: boolean;
	/**
	 * The merged category this library belongs to, which is the shelf people think in.
	 *
	 * Carried so that a media can land on the shelf it came from without anybody having
	 * configured anything. Derived by the library manager rather than folded again here,
	 * for the reason `PlacementRequest.categoryKey` gives: two foldings of `Animés` give
	 * two keys the day one of them changes.
	 */
	categoryKey?: string | null;
}

export interface PlacementRequest {
	kind: MediaKind;
	/**
	 * The merged category this item belongs to, which is what `categoryTargets` keys on.
	 *
	 * Handed in rather than derived here, because a category is a merge of library
	 * names and that merge belongs to the library manager: folding the name a second
	 * time in this file would give two keys for `Animés` the day one of them changed.
	 * Null when the item's library belongs to no category — there is simply nothing to
	 * look up, and the defaults below apply.
	 */
	categoryKey?: string | null;
	settings: Settings;
	libraries: PlacementLibrary[];
	/** Path inside the destination library, from the naming service. */
	/**
	 * The path inside the chosen library, or a function given that library's root.
	 *
	 * The function form exists because naming and placement are not independent: the
	 * gateway files a pulled episode where that library already files the others, and
	 * which library is chosen is decided right here. A caller that has to name the file
	 * before knowing the destination can only imitate the wrong one.
	 */
	relativeName: string | ((libraryRoot: string) => string);
	/**
	 * Where our own copy of the same series or collection already lives.
	 *
	 * The whole point of `BESIDE_EXISTING`: a library somebody has already tidied
	 * stays tidy, and a new episode lands in the folder its siblings are in rather
	 * than in a second copy of the show elsewhere.
	 */
	existingPath?: string | null;
	/**
	 * The library this pull would rather go to: a plan's standing preference, or the
	 * one a single run named.
	 *
	 * It is consulted **after** `existingPath` and before the configured targets, and
	 * that order is the decision. Above everything it would file the fourth season of a
	 * show into the preferred shelf while the first three stayed where they are, and no
	 * media server shows a series split across two folders as one series — a worse
	 * outcome than landing somewhere unexpected, which is at least whole and visible.
	 * Below the category it would never do anything on the gateways that have a category
	 * table, which is most of them, and a preference nothing ever honours is a field that
	 * lies. So: it decides where genuinely new things go, and never splits a show.
	 */
	preferredLibraryId?: string | null;
	/**
	 * Which kind of decision that preference was, for the record on the transfer.
	 *
	 * The two are told apart on the screen and fixed in two different places — a plan's
	 * preference is changed on the plan, a run's request died with the run — so the
	 * caller says which it meant rather than having it guessed from whether a plan was
	 * involved. Defaults to `REQUESTED`, the narrower reading of the two.
	 */
	preferredBy?: PlacedBy.PLAN_PREFERENCE | PlacedBy.REQUESTED;
	/** Refuse a target that cannot hold this. Zero skips the check. */
	requiredBytes?: number;
	/**
	 * The one file this pull is allowed to land on: the copy it replaces.
	 *
	 * Everything else that already occupies the rendered path is somebody's file, and
	 * the difference is the difference between an upgrade and a loss. Pulling a 2160p
	 * over our own 1080p is what a sync is for and writes the same path on purpose;
	 * pulling an extended cut whose name happens to render identically is the case that
	 * used to destroy the theatrical one at the end of a completed download.
	 */
	replacesPath?: string | null;
	/**
	 * Another name for the same file, when the first one is taken.
	 *
	 * A callback rather than a rule here, because the conventions are the naming
	 * service's: which suffix a media server reads is a naming question, and placement
	 * only knows which paths are free. Without one, an occupied path is refused rather
	 * than guessed at.
	 */
	disambiguate?: (relativeName: string, attempt: number) => string;
	/**
	 * Paths earlier items of the same run already claimed.
	 *
	 * The filesystem cannot answer for them: nothing has been written yet when a plan is
	 * built, so two versions planned in one pass both find the path free and both get
	 * it. The second one would then overwrite the first hours later, which is the same
	 * loss by a slower route.
	 */
	reserved?: Iterable<string>;
}

export interface PlacementTarget {
	libraryId: string;
	libraryName: string;
	/** Absolute directory the file lands in, created if needed. */
	directory: string;
	/** Absolute final path. */
	path: string;
	strategy: PlacementStrategy;
	/** True when the configured strategy could not be honoured. */
	fallback: boolean;
	/** Why the fallback happened, for the transfer's history. */
	reason: string | null;
	/**
	 * Which step of the rule above chose this, in the vocabulary `PlacedBy` fixes.
	 *
	 * Filled here and nowhere else. `strategy` cannot answer it — see `placedByFor`
	 * for why — and a caller that tried would report a configured destination as a
	 * guess, which is the one distinction the interface is built on.
	 */
	placedBy: PlacedBy;
}

/** One destination worth probing, in the order the rules put it. */
interface PlacementAttempt {
	library: PlacementLibrary;
	root: string;
	strategy: PlacementStrategy;
	fallback: boolean;
}

/**
 * How many alternative names are tried before a transfer is refused.
 *
 * Generous enough that a household with a dozen encodes of one film is served, small
 * enough that a bug in a caller's naming callback fails in milliseconds rather than
 * stat-ing the filesystem for ever.
 */
const MAX_NAME_ATTEMPTS = 50;

interface DirectoryProbe {
	writable: boolean;
	freeBytes: number | null;
	error: string | null;
}

/**
 * Decides where a pulled file lands.
 *
 * The rule the whole class obeys: fall back sanely, and refuse rather than guess.
 * There is exactly one situation where guessing is tempting — nothing is writable —
 * and putting the file "somewhere" then means somebody finds forty gigabytes in a
 * container's overlay filesystem a week later, with the media server none the wiser.
 * So the last step is an exception with a key the interface can act on, never a path
 * nobody asked for.
 */
@Injectable()
export class PlacementService {
	private readonly _logger = new Logger(PlacementService.name);

	public async resolve(request: PlacementRequest): Promise<PlacementTarget> {
		const { attempts, skipped } = this._candidates(request);
		/*
		 * Seeded with what never became a candidate at all.
		 *
		 * A configured library that is gone, read-only or unmapped is skipped rather than
		 * allowed to fail a download that has already finished — but the skip has to
		 * travel with the answer, because otherwise somebody whose configured disk is
		 * unplugged has no way of finding out why their file went somewhere else.
		 */
		const rejected: string[] = [...skipped];

		for (const attempt of attempts) {
			// Rendered per candidate, because the name depends on the destination: the
			// gateway files a pulled episode where that library already files the
			// others, and which library that is only becomes known here. A name fixed
			// before this loop would imitate whichever root was tried first.
			const relativeName = this._nameFor(request, attempt.root);
			const directory = dirname(join(attempt.root, this._safeRelative(relativeName)));
			const probe = await this._probe(directory, request.requiredBytes ?? 0);

			if (probe.writable) {
				const free = await this._freePath(request, attempt.root, relativeName);
				const notes = free.note === null ? rejected : [...rejected, free.note];

				const target = {
					libraryId: attempt.library.id,
					libraryName: attempt.library.name,
					directory,
					path: free.path,
					strategy: attempt.strategy,
					// A configured destination that had to be skipped is a fallback
					// however well the one that answered went: the file did not land where
					// the settings said it would.
					fallback:
						skipped.length > 0 ||
						attempt.fallback ||
						attempt.strategy !== request.settings.placement,
					reason: notes.length > 0 ? notes.join('; ') : null,
				};

				return { ...target, placedBy: placedByFor(target, request) };
			}

			rejected.push(`${attempt.library.name}: ${probe.error ?? 'not writable'}`);
			this._logger.warn(`Placement candidate rejected — ${rejected[rejected.length - 1]}`);
		}

		// Nothing left to try. The two cases are told apart because the interface
		// offers different things: freeing space, or fixing a path.
		const outOfSpace = rejected.some((entry) => entry.includes('space'));

		throw new ConflictException({
			key: outOfSpace ? ErrorKey.TRANSFER_NO_SPACE : ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
			detail: rejected.length > 0 ? rejected : 'no local library is writable',
		});
	}

	/**
	 * The first path in this library nothing already holds.
	 *
	 * The check the whole feature turns on, and it did not exist: placement asked
	 * whether the *directory* could be written into and never whether the *file* was
	 * already there, so two versions of one episode — which render the same name —
	 * produced two transfers, the second of which replaced the first at the moment it
	 * finished. Nothing failed, nothing was logged, and the file was gone.
	 *
	 * Two things may legitimately be landed on: the copy this pull replaces, and
	 * nothing else. A reserved path belongs to an earlier item of the same run and is
	 * treated exactly like an existing file, because in an hour it will be one.
	 *
	 * The existing file is never renamed. Moving somebody's file to make room for ours
	 * is the same surprise as overwriting it, one directory listing later — and a media
	 * server that has already indexed it would show a phantom until the next scan.
	 */
	private async _freePath(
		request: PlacementRequest,
		root: string,
		relativeName: string,
	): Promise<{ path: string; note: string | null }> {
		const reserved = new Set([...(request.reserved ?? [])].map((path) => resolve(path)));
		const replaces = request.replacesPath ? resolve(request.replacesPath) : null;
		const wanted = join(root, this._safeRelative(relativeName));

		if (!(await this._occupied(wanted, reserved, replaces))) {
			return { path: wanted, note: null };
		}

		for (let attempt = 1; request.disambiguate && attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
			const candidate = join(
				root,
				this._safeRelative(request.disambiguate(relativeName, attempt)),
			);

			if (candidate === wanted) {
				continue;
			}

			if (!(await this._occupied(candidate, reserved, replaces))) {
				return {
					path: candidate,
					note: `${basename(wanted)} is taken, landing as ${basename(candidate)}`,
				};
			}
		}

		throw new ConflictException({
			key: ErrorKey.TRANSFER_TARGET_OCCUPIED,
			detail: wanted,
		});
	}

	private async _occupied(
		path: string,
		reserved: ReadonlySet<string>,
		replaces: string | null,
	): Promise<boolean> {
		const absolute = resolve(path);

		if (absolute === replaces) {
			return false;
		}

		if (reserved.has(absolute)) {
			return true;
		}

		return access(absolute, constants.F_OK).then(
			() => true,
			() => false,
		);
	}

	private _nameFor(request: PlacementRequest, root: string): string {
		return typeof request.relativeName === 'function'
			? request.relativeName(root)
			: request.relativeName;
	}

	/** Creates the destination directory. Separated so a dry run can skip it. */
	public async prepare(target: PlacementTarget): Promise<void> {
		await mkdir(target.directory, { recursive: true });
	}

	/**
	 * The ordered list of things to try, and what was passed over on the way.
	 *
	 * Built rather than resolved so that every fallback is visible in one place: a
	 * chain of nested conditionals here is how a placement bug becomes unexplainable.
	 * The order is the specification —
	 *
	 * 1. the folder our own copies of this series are already in;
	 * 2. the library the plan prefers, or the one this run explicitly asked for;
	 * 3. the library this category is configured to receive;
	 * 4. the library everything else is configured to receive;
	 * 5. the fixed path, when that strategy is selected;
	 * 6. the fallback folder;
	 * 7. whatever is writable.
	 *
	 * — and each step only ever appends, so a destination that cannot be written into
	 * hands the question to the next one instead of failing the pull.
	 *
	 * Steps one and two used to be the other way round, and swapping them is a
	 * behaviour change worth stating. A preference that outranked the existing copy
	 * filed the fourth season of a show into the preferred shelf while the first three
	 * stayed where they were, and neither media server shows that as one series: a
	 * split show is a worse outcome than a file landing somewhere unexpected, because
	 * the second is whole and visible and the first is neither. Putting the preference
	 * any lower — under the category — would make it dead weight on every gateway with
	 * a category table, which is most of them. Between those two it does exactly what
	 * somebody setting it meant: it decides where new things go.
	 */
	private _candidates(request: PlacementRequest): {
		attempts: PlacementAttempt[];
		skipped: string[];
	} {
		const usable = request.libraries.filter(
			(library) => library.writable && !!library.localPath,
		);

		const attempts: PlacementAttempt[] = [];
		const skipped: string[] = [];

		/*
		 * A series we already hold keeps its own folder, whatever the settings say.
		 *
		 * Unconditional, and that is the defect this fixes: it used to be gated behind
		 * the global strategy being `beside_existing`, so a gateway set to anything else
		 * filed a new episode of a show it already had into a second copy of that show
		 * somewhere else. A season split across two folders is worse than either
		 * destination on its own — neither media server shows it as one series.
		 *
		 * It sits above everything below, including the plan's preference, for the same
		 * reason: those decide where something *new* goes, and an episode of a series we
		 * hold is not new.
		 */
		if (request.existingPath) {
			const host = this._libraryHolding(usable, request.existingPath);

			if (host) {
				attempts.push({
					library: host,
					root: host.localPath as string,
					strategy: PlacementStrategy.BESIDE_EXISTING,
					fallback: false,
				});
			}
			// No local copy, or it lives outside every writable library: nothing to sit
			// beside, so the configured destinations below apply rather than an error.
			// That is the common case on a first sync, not a fault.
		}

		// The plan's standing preference, or the library this one run named. It outranks
		// the settings because somebody chose it for this pull and the settings are what
		// applies when nobody did.
		const preferred = usable.find((library) => library.id === request.preferredLibraryId);

		if (preferred) {
			attempts.push({
				library: preferred,
				root: preferred.localPath as string,
				strategy: request.settings.placement,
				fallback: false,
			});
		}

		// A key whose category has vanished is never reached rather than cleaned up:
		// categories are derived from library names, so one disappears the moment a
		// service is offline, and dropping the row would lose a deliberate choice to a
		// temporary outage.
		const perCategory = request.categoryKey
			? (request.settings.categoryTargets[request.categoryKey] ?? null)
			: null;

		this._pushConfigured(
			request.libraries,
			perCategory,
			`the library configured for "${request.categoryKey}"`,
			attempts,
			skipped,
		);
		this._pushConfigured(
			request.libraries,
			request.settings.defaultTargetLibraryId,
			'the default target library',
			attempts,
			skipped,
		);

		if (request.settings.placement === PlacementStrategy.FIXED_PATH) {
			const fixed = request.settings.fixedPath?.trim();

			if (fixed && isAbsolute(fixed)) {
				const host = this._libraryHolding(usable, fixed) ?? usable[0];

				attempts.push({
					library: host ?? this._syntheticLibrary(fixed),
					root: fixed,
					strategy: PlacementStrategy.FIXED_PATH,
					fallback: false,
				});
			}
			// A relative fixed path is meaningless to a service running elsewhere, and
			// resolving it against the gateway's working directory would put media
			// inside the container. It is dropped, and the defaults below apply.
		}

		// The last nameable answer before guessing: a category nobody answered for, on a
		// gateway with no default library, still has to land somewhere a person chose
		// rather than fail at the end of a completed download.
		const fallbackPath = request.settings.defaultTargetPath?.trim();

		if (fallbackPath && isAbsolute(fallbackPath)) {
			attempts.push({
				library: this._libraryHolding(usable, fallbackPath) ?? this._syntheticLibrary(fallbackPath),
				root: fallbackPath,
				strategy: PlacementStrategy.DEFAULT_LIBRARY,
				fallback: true,
			});
		}

		for (const library of this._byPreference(usable, request.kind, request.categoryKey ?? null)) {
			attempts.push({
				library,
				root: library.localPath as string,
				strategy: PlacementStrategy.DEFAULT_LIBRARY,
				fallback: request.settings.placement !== PlacementStrategy.DEFAULT_LIBRARY,
			});
		}

		// Deduplicate on the root, keeping the first — the earlier attempt carries the
		// strategy that was actually chosen, and re-probing the same directory under a
		// different label would only produce a confusing reason string.
		const seen = new Set<string>();

		return {
			attempts: attempts.filter((attempt) => {
				const key = normalize(attempt.root);

				if (seen.has(key)) {
					return false;
				}

				seen.add(key);

				return true;
			}),
			skipped,
		};
	}

	/**
	 * A library somebody configured as a destination, or the note saying why not.
	 *
	 * Skipped and never thrown. Whatever reaches placement has already been chosen,
	 * queued and in most cases downloaded in full, so a disk that was unplugged this
	 * morning must not turn that into a failure — it has to become "somewhere else, and
	 * here is why". The note is the only thing that tells the difference between a
	 * setting that is being honoured and one that is being quietly ignored.
	 *
	 * Looked up in the full list rather than in the writable one, because "gone" and
	 * "read-only" call for different fixes and a filtered list cannot tell them apart.
	 */
	/**
	 * A configured destination, which names either a library or one of its roots.
	 *
	 * A path is resolved to the library that declares it as a root, never to whatever
	 * library happens to contain it: the guarantee this whole area rests on is that a
	 * pull lands somewhere a media server scans, and a root the service itself declared
	 * is exactly that. A path no library claims is skipped with its reason rather than
	 * written to — which is the difference between a setting that stopped applying and a
	 * gateway quietly filling a folder nothing indexes.
	 */
	private _pushConfigured(
		libraries: PlacementLibrary[],
		choice: string | null,
		label: string,
		attempts: PlacementAttempt[],
		skipped: string[],
	): void {
		if (!choice) {
			return;
		}

		const asRoot = choice.startsWith('/')
			? libraries.find((candidate) => (candidate.localRoots ?? []).includes(choice))
			: undefined;
		const library = asRoot ?? libraries.find((candidate) => candidate.id === choice);

		if (library === undefined) {
			skipped.push(`${label} no longer exists (${choice})`);

			return;
		}

		if (!library.writable) {
			skipped.push(`${label}, ${library.name}, is not writable`);

			return;
		}

		// The root that was named when one was, and the library's own otherwise. A
		// library with several roots had only ever offered the first, which is the whole
		// reason a choice can name one.
		const root = asRoot === undefined ? library.localPath : choice;

		if (!root) {
			skipped.push(`${label}, ${library.name}, has no local path`);

			return;
		}

		attempts.push({
			library,
			root,
			// There is no strategy value for "the library this was configured to go to":
			// the enum names the three answers somebody picks on the settings screen, and
			// adding a fourth is a change to a contract the interface is being rebuilt
			// against. The default-library label is the closest true statement — this is
			// the library that receives by default, for this category.
			strategy: PlacementStrategy.DEFAULT_LIBRARY,
			fallback: false,
		});
	}

	/**
	 * Libraries in the order they deserve to be tried.
	 *
	 * Three bands, not two, and the middle one is the whole point. First the libraries
	 * of exactly the right kind, then the ones whose server said they may hold either,
	 * then everything else writable. Inside each band the library somebody marked as
	 * the default target comes first.
	 *
	 * The last band matters on a gateway where nobody has configured the kinds:
	 * landing a film in the shows library is wrong, and losing the transfer is worse.
	 *
	 * The middle band is what a `MIXED` library gets, and it was worth adding a band
	 * for. A library that declares no content type is the ordinary Jellyfin library —
	 * every one of the seven on the gateway this was measured against — and reading it
	 * as "unknown" put it in the last band, behind a music library and behind a photo
	 * album, as somewhere to put a film it is in fact the only place for. A mixed
	 * library is a worse destination than a film library and a far better one than a
	 * library that named a kind this is not, so it belongs between the two.
	 */
	private _byPreference(
		libraries: PlacementLibrary[],
		kind: MediaKind,
		categoryKey: string | null = null,
	): PlacementLibrary[] {
		const wanted = this._libraryKindFor(kind);
		const exact = libraries.filter((library) => library.kind === wanted);
		const mixed = libraries.filter((library) => library.kind === LibraryKind.MIXED);
		const rest = libraries.filter(
			(library) => library.kind !== wanted && library.kind !== LibraryKind.MIXED,
		);

		/*
		 * The shelf the media came from, first, and this is what makes the default
		 * bearable without anybody configuring anything.
		 *
		 * Three bands of kind alone put `Films` and `Animes - Films` on exactly the same
		 * footing, so a film fell through to whichever happened to come first — the
		 * owner pulled *Casper* from his `Films` shelf and found it under
		 * `Animes/Films`, filed by the last rule in the chain, the one that means
		 * "anything that could take it".
		 *
		 * A category is the shelf people actually think in, and a media pulled from one
		 * belongs on the same one here. It is a preference and never a requirement: a
		 * category with no writable library of its own still falls through the bands
		 * below rather than failing at the end of a completed download.
		 */
		const ownFirst = (band: PlacementLibrary[]): PlacementLibrary[] =>
			categoryKey === null
				? band
				: [
					...band.filter((library) => library.categoryKey === categoryKey),
					...band.filter((library) => library.categoryKey !== categoryKey),
				];

		/*
		 * Preferred first inside each band, so a default target never jumps a band: a
		 * mixed library somebody marked as the default is still not a better home for a
		 * film than the film library next to it.
		 *
		 * And above the category, because the two are not the same kind of statement.
		 * Marking a library as the default target is somebody saying where things go;
		 * the category is this code guessing well in the absence of that. An
		 * inference that overruled a choice would be the screen ignoring the person
		 * again — which is the whole family of defect this release exists to close.
		 */
		const preferredFirst = (band: PlacementLibrary[]): PlacementLibrary[] => [
			...ownFirst(band.filter((library) => library.isDefaultTarget)),
			...ownFirst(band.filter((library) => !library.isDefaultTarget)),
		];

		return [...preferredFirst(exact), ...preferredFirst(mixed), ...preferredFirst(rest)];
	}

	private _libraryKindFor(kind: MediaKind): LibraryKind {
		if (kind === MediaKind.MOVIE || kind === MediaKind.COLLECTION) {
			return LibraryKind.MOVIES;
		}

		return LibraryKind.SHOWS;
	}

	/** The library whose root contains a path, comparing whole path components. */
	private _libraryHolding(
		libraries: PlacementLibrary[],
		path: string,
	): PlacementLibrary | undefined {
		const target = resolve(path);

		return libraries
			.filter((library) => {
				const root = resolve(library.localPath as string);

				// A prefix test on the raw strings would put `/mnt/media2` inside
				// `/mnt/media`, which is exactly the kind of near-miss that puts a
				// transfer on the wrong disk.
				return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
			})
			// The deepest match wins when libraries are nested, because the deeper one
			// is the more specific statement about where these files belong.
			.sort((left, right) => (right.localPath as string).length - (left.localPath as string).length)[0];
	}

	private _syntheticLibrary(path: string): PlacementLibrary {
		// A fixed path outside every registered library is legitimate — it is what
		// somebody typed — but nothing indexes it, so it gets no identifier and the
		// interface shows it as a path rather than as a library.
		return {
			id: '',
			name: path,
			kind: LibraryKind.OTHER,
			localPath: path,
			writable: true,
			isDefaultTarget: false,
		};
	}

	/**
	 * Keep a rendered name inside the library.
	 *
	 * The name comes from a remote service's metadata, which means a title of
	 * `../../etc` is somebody else's input reaching our filesystem. Normalising and
	 * dropping every upward step is not paranoia; it is the only thing between a
	 * hostile peer and an arbitrary write.
	 */
	private _safeRelative(relativeName: string): string {
		const cleaned = normalize(relativeName)
			.split(/[\\/]+/)
			.filter((part) => part !== '' && part !== '.' && part !== '..')
			.join(sep);

		return cleaned === '' ? 'untitled' : cleaned;
	}

	/**
	 * Is this directory usable, and is there room?
	 *
	 * Walks up to the nearest existing ancestor, because the destination folder
	 * usually does not exist yet — the question is whether we may create it, not
	 * whether it is already there.
	 */
	private async _probe(directory: string, requiredBytes: number): Promise<DirectoryProbe> {
		let current = resolve(directory);

		// Walk up only over directories that do not exist yet. Stopping at the first
		// one that does is the whole point: a read-only library whose parent happens to
		// be writable must be rejected, and a loop that kept climbing would find that
		// parent and cheerfully accept the library.
		for (;;) {
			const exists = await access(current, constants.F_OK).then(
				() => true,
				() => false,
			);

			if (exists) {
				break;
			}

			const parent = dirname(current);

			if (parent === current) {
				return { writable: false, freeBytes: null, error: 'no existing ancestor' };
			}

			current = parent;
		}

		try {
			await access(current, constants.W_OK);
		} catch {
			return { writable: false, freeBytes: null, error: `${current} is not writable` };
		}

		if (requiredBytes <= 0) {
			return { writable: true, freeBytes: null, error: null };
		}

		const freeBytes = await freeBytesAt(current);

		if (freeBytes === null) {
			// `statfs` fails on some network mounts. Unknown free space is not a reason
			// to refuse a target that is demonstrably writable; the transfer will fail
			// with a disk-full error instead, which is recoverable.
			return { writable: true, freeBytes: null, error: null };
		}

		// A margin on top of the file itself: the metadata, the `.nfo`, the artwork,
		// and the fact that a filesystem at exactly zero free bytes is a filesystem
		// nothing else on the machine can write to either.
		const margin = Math.max(64 * 1024 * 1024, requiredBytes * 0.01);

		if (freeBytes < requiredBytes + margin) {
			return {
				writable: false,
				freeBytes,
				error: `not enough space (${freeBytes} free, ${requiredBytes} needed)`,
			};
		}

		return { writable: true, freeBytes, error: null };
	}
}
