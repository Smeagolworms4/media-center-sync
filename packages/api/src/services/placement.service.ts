import { constants } from 'node:fs';
import { access, mkdir, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { ErrorKey, LibraryKind, MediaKind, PlacementStrategy, type Settings } from '@mcs/shared';
import { ConflictException, Injectable, Logger } from '@nestjs/common';

/** A local library, reduced to what placement actually decides on. */
export interface PlacementLibrary {
	id: string;
	name: string;
	kind: LibraryKind;
	/** Where the gateway can write. Null means the library is read-only to us. */
	localPath: string | null;
	writable: boolean;
	isDefaultTarget: boolean;
}

export interface PlacementRequest {
	kind: MediaKind;
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
	/** Chosen by the sync plan, which overrides the global strategy. */
	preferredLibraryId?: string | null;
	/** Refuse a target that cannot hold this. Zero skips the check. */
	requiredBytes?: number;
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
}

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
		const attempts = this._candidates(request);
		const rejected: string[] = [];

		for (const attempt of attempts) {
			// Rendered per candidate, because the name depends on the destination: the
			// gateway files a pulled episode where that library already files the
			// others, and which library that is only becomes known here. A name fixed
			// before this loop would imitate whichever root was tried first.
			const relativeName = this._nameFor(request, attempt.root);
			const directory = dirname(join(attempt.root, this._safeRelative(relativeName)));
			const probe = await this._probe(directory, request.requiredBytes ?? 0);

			if (probe.writable) {
				return {
					libraryId: attempt.library.id,
					libraryName: attempt.library.name,
					directory,
					path: join(attempt.root, this._safeRelative(relativeName)),
					strategy: attempt.strategy,
					fallback: attempt.strategy !== request.settings.placement || attempt.fallback,
					reason: rejected.length > 0 ? rejected.join('; ') : null,
				};
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
	 * The ordered list of things to try.
	 *
	 * Built rather than resolved so that every fallback is visible in one place: a
	 * chain of nested conditionals here is how a placement bug becomes unexplainable.
	 */
	private _candidates(request: PlacementRequest): {
		library: PlacementLibrary;
		root: string;
		strategy: PlacementStrategy;
		fallback: boolean;
	}[] {
		const usable = request.libraries.filter(
			(library) => library.writable && !!library.localPath,
		);

		const attempts: {
			library: PlacementLibrary;
			root: string;
			strategy: PlacementStrategy;
			fallback: boolean;
		}[] = [];

		// An explicit choice by the sync plan outranks the global strategy, because
		// somebody typed it for this run.
		const preferred = usable.find((library) => library.id === request.preferredLibraryId);

		if (preferred) {
			attempts.push({
				library: preferred,
				root: preferred.localPath as string,
				strategy: request.settings.placement,
				fallback: false,
			});
		}

		if (request.settings.placement === PlacementStrategy.BESIDE_EXISTING && request.existingPath) {
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
			// beside, so this silently becomes the default-library case below rather
			// than an error. That is the common case on a first sync, not a fault.
		}

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

		for (const library of this._byPreference(usable, request.kind)) {
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

		return attempts.filter((attempt) => {
			const key = normalize(attempt.root);

			if (seen.has(key)) {
				return false;
			}

			seen.add(key);

			return true;
		});
	}

	/**
	 * Libraries in the order they deserve to be tried.
	 *
	 * The one marked as the default target for the right kind first, then any library
	 * of the right kind, then anything writable at all. The last step matters on a
	 * gateway where nobody has configured the kinds: landing a film in the shows
	 * library is wrong, and losing the transfer is worse.
	 */
	private _byPreference(libraries: PlacementLibrary[], kind: MediaKind): PlacementLibrary[] {
		const wanted = this._libraryKindFor(kind);
		const matching = libraries.filter((library) => library.kind === wanted);
		const rest = libraries.filter((library) => library.kind !== wanted);

		return [
			...matching.filter((library) => library.isDefaultTarget),
			...matching.filter((library) => !library.isDefaultTarget),
			...rest.filter((library) => library.isDefaultTarget),
			...rest.filter((library) => !library.isDefaultTarget),
		];
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

		try {
			const stats = await statfs(current);
			const freeBytes = Number(stats.bavail) * Number(stats.bsize);

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
		} catch {
			// `statfs` fails on some network mounts. Unknown free space is not a reason
			// to refuse a target that is demonstrably writable; the transfer will fail
			// with a disk-full error instead, which is recoverable.
			return { writable: true, freeBytes: null, error: null };
		}
	}
}
