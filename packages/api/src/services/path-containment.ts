import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * Deciding whether a path the interface asked for is one this gateway agreed to show.
 *
 * The whole security of the directory browser is here, and it has exactly one rule:
 * the answer is worked out on the *resolved* path and never on what was typed. A
 * prefix test on raw input is defeated twice over — by `..`, which spells a path
 * outside a root while reading as one inside it, and by a symlink, which spells
 * nothing at all and still lands elsewhere. Both were the reason this module exists
 * rather than a `startsWith` at the call site.
 */

/** What a requested path turned out to be. */
export enum PathVerdict {
	/** Resolved, inside an allowed root, and there. */
	INSIDE = 'inside',
	/** Resolved outside every allowed root. The only answer that is a refusal. */
	OUTSIDE = 'outside',
	/** Inside a root, and nothing exists at it. */
	MISSING = 'missing',
	/**
	 * Inside a root as far as can be told, and the filesystem refused to resolve it.
	 *
	 * An unreadable ancestor — a mount with no traversal right — cannot be told from a
	 * correct path by resolution alone. It is reported rather than folded into
	 * `MISSING` because the two are fixed in different places, and a permission problem
	 * announced as "no such directory" sends somebody to correct a path that is right.
	 */
	UNREADABLE = 'unreadable',
}

export interface ResolvedPath {
	verdict: PathVerdict;
	/** The path after resolution, which is the one anything downstream may touch. */
	path: string;
	/** The allowed root it was found under, or null when it was found under none. */
	root: string | null;
}

/**
 * Containment, compared component by component.
 *
 * `/mnt/media2` is not inside `/mnt/media`, though every string comparison says it
 * is. Both paths must already be resolved: this function deliberately does no
 * resolution of its own, so that no caller can pass raw input and believe it was
 * checked.
 */
export const isInside = (path: string, root: string): boolean => {
	if (path === root) {
		return true;
	}

	return path.startsWith(root.endsWith(sep) ? root : root + sep);
};

/** Resolution refused by the filesystem for a reason other than absence. */
class UnresolvablePath extends Error {}

/**
 * The real path of the deepest ancestor that exists, with the missing tail put back.
 *
 * A path nobody has created yet still has to be placed: somebody types a directory
 * they are about to make, and answering "outside the root" for it would be a lie while
 * answering "inside" without resolving its parents would be the prefix check this
 * module exists to avoid. So the existing part is resolved — symlinks and all — and
 * the part that does not exist is appended to it.
 */
const resolveDeepest = async (wanted: string): Promise<{ path: string; exists: boolean }> => {
	const missing: string[] = [];
	let current = wanted;

	for (;;) {
		try {
			const real = await realpath(current);

			return {
				path: missing.length === 0 ? real : join(real, ...missing.reverse()),
				exists: missing.length === 0,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw new UnresolvablePath();
			}

			const parent = dirname(current);

			// The filesystem root itself does not exist, which cannot happen on a real
			// system and would loop forever if it did.
			if (parent === current) {
				return { path: wanted, exists: false };
			}

			missing.push(basename(current));
			current = parent;
		}
	}
};

/**
 * A root as it really is on disk, so that a root which is itself a symlink still
 * matches the paths found under it.
 *
 * `/media` pointing at `/mnt/media` is an ordinary deployment, and comparing a
 * resolved path against the unresolved root would refuse every directory the gateway
 * was configured to show — a browser that shows nothing, for a configuration that is
 * correct. A root that does not exist keeps its lexical form: it is a mount that has
 * not come up yet, and nothing will be found under it anyway.
 */
const realRoot = async (root: string): Promise<string> => {
	const absolute = resolve(root);

	return realpath(absolute).catch(() => absolute);
};

/**
 * The allowed roots as they really are on disk.
 *
 * Exported because everything that compares a path against the roots has to compare
 * against the same form of them: a resolved path tested against an unresolved root is
 * the near-miss that silently shows nothing at all.
 */
export const resolveRoots = (roots: readonly string[]): Promise<string[]> =>
	Promise.all(roots.map(realRoot));

/**
 * Where a requested path really is, and whether it is somewhere we agreed to look.
 *
 * Containment is decided before existence, and that order is the point: answering
 * "no such directory" for a path outside the roots would turn a read-only browser into
 * a way of mapping the host's filesystem one guess at a time.
 */
export const resolveWithinRoots = async (
	requested: string,
	roots: readonly string[],
): Promise<ResolvedPath> => {
	const allowed = await resolveRoots(roots);
	const wanted = resolve(requested);

	let resolved: { path: string; exists: boolean };

	try {
		resolved = await resolveDeepest(wanted);
	} catch {
		// Resolution was refused. The lexical path is all there is to judge, and it has
		// at least had its `..` collapsed by `resolve`; a symlink hidden behind an
		// unreadable ancestor cannot be followed by anything else either, so the worst
		// this admits is a directory that then fails to be read.
		resolved = { path: wanted, exists: false };

		const blocked = allowed.find((root) => isInside(wanted, root)) ?? null;

		return blocked === null
			? { verdict: PathVerdict.OUTSIDE, path: wanted, root: null }
			: { verdict: PathVerdict.UNREADABLE, path: wanted, root: blocked };
	}

	const root = allowed.find((one) => isInside(resolved.path, one)) ?? null;

	if (root === null) {
		return { verdict: PathVerdict.OUTSIDE, path: resolved.path, root: null };
	}

	return {
		verdict: resolved.exists ? PathVerdict.INSIDE : PathVerdict.MISSING,
		path: resolved.path,
		root,
	};
};
