import { constants } from 'node:fs';
import { access, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { DirectoryEntry } from '@mcs/shared';
import { isInside, resolveRoots } from './path-containment';

/**
 * Reading directories off the gateway's own filesystem, and nothing else.
 *
 * A technical capability in the strict sense: it is told which directory to read and
 * which roots the answer may not leave, and it decides none of that itself. Whether a
 * caller is allowed to ask is the manager's business, and the containment rule lives
 * in `path-containment` so that the route and this listing share one definition of
 * "inside".
 */

/**
 * How many directories one listing will ever return.
 *
 * A media root with a flat folder per episode reaches tens of thousands of entries,
 * and the honest answer — all of them — is a response nothing renders, over a request
 * that holds the event loop on `access` calls while it builds it. Five hundred is far
 * more than anybody scrolls before typing, and the answer says when it was reached so
 * that a shortened list is never mistaken for a complete one.
 */
export const MAX_DIRECTORY_ENTRIES = 500;

export interface ListOptions {
	/**
	 * Roots the answer may not leave, already resolved — `resolveRoots` gives them.
	 *
	 * Resolved, because an entry is compared against them after its own symlinks have
	 * been followed, and a root left unresolved would match nothing under a `/media`
	 * that is itself a link: a browser that shows an empty directory for a deployment
	 * that is perfectly correct.
	 */
	roots: readonly string[];
	/**
	 * Show dot directories.
	 *
	 * Off by default because `.config`, `.cache` and a hundred `.git` directories are
	 * never what somebody is looking for when they are pointing at a media folder —
	 * and a flag is cheaper than a filter somebody has to scroll past every time.
	 */
	includeHidden?: boolean;
	limit?: number;
}

export interface DirectoryScan {
	entries: DirectoryEntry[];
	/** True when the cap was reached and there were still entries left to look at. */
	truncated: boolean;
	limit: number;
}

/** Whether this gateway can read a path, write into it, or neither. */
export interface PathRights {
	readable: boolean;
	writable: boolean;
}

@Injectable()
export class FilesystemService {
	/**
	 * The directories directly under one directory.
	 *
	 * Directories only. The question a path field asks is "which folder", and listing
	 * files alongside them would offer an answer that every consumer of the field then
	 * has to refuse.
	 *
	 * Throws whatever the filesystem threw — the manager turns an `EACCES` into the
	 * key that says so, which is a decision and not this layer's to make.
	 */
	public async list(directory: string, options: ListOptions): Promise<DirectoryScan> {
		const limit = options.limit ?? MAX_DIRECTORY_ENTRIES;

		// Read the whole directory and sort it before capping: taking the first five
		// hundred names the filesystem happens to hand back would give a different
		// arbitrary subset on every call, and somebody looking for a folder they can
		// see in a terminal would conclude the browser is broken.
		const found = await readdir(directory, { withFileTypes: true });
		const names = found
			.map((entry) => entry.name)
			.filter((name) => options.includeHidden === true || !name.startsWith('.'))
			.sort((left, right) => left.localeCompare(right));

		const entries: DirectoryEntry[] = [];
		let seen = 0;

		for (const name of names) {
			if (entries.length >= limit) {
				break;
			}

			seen += 1;

			const path = join(directory, name);
			const entry = await this._directoryEntry(path, name, options.roots);

			if (entry !== null) {
				entries.push(entry);
			}
		}

		return {
			entries,
			// Deliberately over-reports rather than under-reports: what was left
			// unexamined may well have held no directory at all, and "there may be more"
			// costs a line of interface while "that is all of it" costs somebody the
			// folder they were looking for.
			truncated: seen < names.length,
			limit,
		};
	}

	/**
	 * Remove the folders a file has just left, for as long as they are empty.
	 *
	 * Moving a season to another library empties `<old>/Scrubs/Season 2` and then
	 * `<old>/Scrubs`, and leaving those behind leaves a media server showing a series
	 * with no episodes in it — which is worse than a stale file, because it looks like
	 * the library rather than like rubbish.
	 *
	 * **Emptiness is the only test, and it is deliberately the only one.** A directory
	 * that still holds anything at all is kept and the walk stops there — whether what
	 * it holds arrived with this run, was already there before it, or was put there
	 * afterwards by somebody else. Asking instead "did we create this folder" would have
	 * meant recording it at placement time and trusting that record months later, and
	 * getting it wrong deletes somebody's files. Emptiness cannot be wrong: there is
	 * nothing in there to lose.
	 *
	 * A root is never removed, even when it is empty. An empty library is a library; an
	 * absent one is a mount that looks broken, and the next scan reports it as such.
	 *
	 * Refusals are not raised. This runs after the bytes are safely at their new path,
	 * and failing the move somebody asked for because a directory could not be tidied
	 * would undo a success to report a triviality. Answers the folders it removed, so a
	 * caller can log what it did.
	 */
	public async pruneEmptyFolders(from: string, roots: readonly string[]): Promise<string[]> {
		const allowed = await resolveRoots(roots);
		// The walk is compared against resolved roots, so it has to be resolved too — a
		// library reached through a symlinked `/media` would otherwise match no root and
		// prune nothing at all, silently.
		const start = await realpath(resolve(from)).catch(() => null);

		if (start === null) {
			return [];
		}

		const removed: string[] = [];
		let current = start;

		while (allowed.some((root) => root !== current && isInside(current, root))) {
			const entries = await readdir(current).catch(() => null);

			if (entries === null || entries.length > 0) {
				break;
			}

			try {
				await rmdir(current);
			} catch {
				break;
			}

			removed.push(current);
			current = dirname(current);
		}

		return removed;
	}

	/**
	 * The biggest file at or under a path, which is the one a download actually meant.
	 *
	 * A torrent is a folder as often as it is a file, and that folder holds the video
	 * beside a sample, a screenshot, an `.nfo` and sometimes the whole thing again in
	 * another container. The largest is what people mean, every time. Any rule cleverer
	 * than that — a list of extensions, a name pattern — is a rule that is wrong on
	 * somebody's library, and being wrong here means filing the sample.
	 *
	 * Bounded at three levels, which covers `Show/Season 1/episode.mkv` and stops a
	 * walk from following a symlink loop for as long as the request lasts.
	 */
	public async largestFileUnder(path: string): Promise<string | null> {
		const root = await stat(path).catch(() => null);

		if (root === null) {
			return null;
		}

		if (root.isFile()) {
			return path;
		}

		let best: { path: string; size: number } | null = null;
		let frontier = [path];

		for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
			const next: string[] = [];

			for (const directory of frontier) {
				const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

				for (const entry of entries) {
					const child = join(directory, entry.name);
					// `stat` rather than the dirent's own type, so a symlinked file counts as
					// the file it points at — which is what a client that hard-links its
					// completed downloads produces.
					const stats = await stat(child).catch(() => null);

					if (stats === null) {
						continue;
					}

					if (stats.isDirectory()) {
						next.push(child);
					} else if (stats.isFile() && (best === null || stats.size > best.size)) {
						best = { path: child, size: stats.size };
					}
				}
			}

			frontier = next;
		}

		return best?.path ?? null;
	}

	/** What this gateway may do with a path, asked of the filesystem rather than guessed. */
	public async rights(path: string): Promise<PathRights> {
		const [readable, writable] = await Promise.all([
			this._can(path, constants.R_OK),
			this._can(path, constants.W_OK),
		]);

		return { readable, writable };
	}

	/**
	 * One entry, or null when it is not a directory the browser may offer.
	 *
	 * A symlink is resolved and dropped when it leaves the roots. Showing it would
	 * offer a directory that the route then refuses to open, which reads as a bug; and
	 * a listing is the one place where a link out is visible enough to be worth
	 * hiding, since the containment check would catch the click anyway.
	 */
	private async _directoryEntry(
		path: string,
		name: string,
		roots: readonly string[],
	): Promise<DirectoryEntry | null> {
		// `stat` rather than the dirent's own type: a dirent says "symlink" and stops
		// there, and a symlink to a directory is a directory to everybody who uses it.
		const stats = await stat(path).catch(() => null);

		if (stats === null || !stats.isDirectory()) {
			return null;
		}

		const real = await realpath(path).catch(() => null);

		if (real === null || !roots.some((root) => isInside(real, root))) {
			return null;
		}

		const rights = await this.rights(path);

		return { name, path, ...rights };
	}

	private _can(path: string, mode: number): Promise<boolean> {
		return access(path, mode).then(
			() => true,
			() => false,
		);
	}
}
