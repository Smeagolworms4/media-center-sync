import type { ServerDirectory } from '@mcs/shared';
import type { NormalisedLibrary } from './media-handler.interface';

/**
 * Reading a path that belongs to somebody else's machine.
 *
 * `node:path` is the wrong tool here and quietly so: it resolves against *this*
 * process's platform, so `posix.dirname('D:\\Media\\Shows')` answers `.` and a Plex
 * running on Windows loses its whole breadcrumb while nothing throws. These two
 * helpers only ever cut a string at its last separator — they never resolve, never
 * normalise, never join — because the only correct thing to do with a server's path
 * is hand it back exactly as the server spelled it.
 */

/** Either separator, because the far end chooses and we do not get a vote. */
const SEPARATORS = /[/\\]/;

/**
 * The last segment, for a list that would be unreadable as full paths.
 *
 * Falls back to the path itself for a root — `/` has no last segment, and a row with
 * an empty label is a row nobody can click on purpose.
 */
export const serverNameOf = (path: string): string => {
	const trimmed = path.replace(/[/\\]+$/, '');
	const parts = trimmed.split(SEPARATORS);

	return parts.at(-1) || path;
};

/**
 * The directory above, or null when there is nowhere left to go.
 *
 * Null rather than the path itself, so a caller can disable going up instead of
 * offering a step that lands where it started.
 */
export const serverParentOf = (path: string): string | null => {
	const trimmed = path.replace(/[/\\]+$/, '');
	const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

	if (cut < 0) {
		return null;
	}

	// A path directly under a POSIX root cuts to the empty string, and the parent of
	// `/media` is `/` rather than nothing at all.
	const parent = cut === 0 ? '/' : trimmed.slice(0, cut);

	return parent === trimmed ? null : parent;
};

/**
 * The library roots, as `ServerDirectory` rows the picker can show.
 *
 * Shared by every handler that gets its roots from its own library listing, which is
 * all of them that can answer at all: the two differ in how they *walk* a directory,
 * never in what a library root is. A library that declares several paths contributes
 * one row each, because a shelf split across two mounts is two directories somebody
 * may have to map separately.
 */
export const serverRootsOf = (
	libraries: readonly NormalisedLibrary[],
	libraryExternalId?: string | null,
): ServerDirectory[] =>
	libraries
		.filter((library) => !libraryExternalId || library.externalId === libraryExternalId)
		.flatMap((library) =>
			library.paths.map((path) => ({
				path,
				name: serverNameOf(path),
				root: true,
				libraryExternalId: library.externalId,
				libraryName: library.name,
				directory: true,
			})),
		);
